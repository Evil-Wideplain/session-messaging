/**
 * 本地总线服务（接口层）。
 *
 * 用每会话独立的 bearer token 鉴权：token 是「连接 = 某个发送方身份」的唯一
 * 依据，它通过 `ctx.shellEnv` 注入 bash/pwsh 环境，因此脚本的身份就是它所在的
 * 会话。端点的监听生命周期在 `listener.ts`，单条连接的读写协议在
 * `connection.ts`，请求参数校验与错误文案在 `protocol.ts`。
 *
 * @module session-messaging/interfaces/bus/server
 */

import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { MessagingService } from '../../application/messaging-service.ts'
import type { Caller } from '../../application/ports.ts'
import { identityOf } from '../../domain/authorization.ts'
import { attachConnection } from './connection.ts'
import { BusListener } from './listener.ts'
import { badRequest, listInputOf, sendInputOf } from './protocol.ts'
import { REQUEST_TIMEOUT_MS } from './protocol.ts'
import type { BusRequest, BusResponse } from './protocol.ts'

/** 每用户一个的总线服务。 */
export class LocalBus {
  private readonly listener: BusListener
  private readonly log: (message: string) => void
  /** token → 会话标识。 */
  private readonly tokens = new Map<string, string>()
  /** 会话标识 → token。 */
  private readonly sessionTokens = new Map<string, string>()

  /** 端点绝对路径（POSIX socket 文件或 Windows 管道名）。 */
  get endpoint(): string {
    return this.listener.endpoint
  }

  /**
   * @param ctx - 携带 Agent 注册表的上下文。
   * @param service - 处理请求的应用服务。
   * @param socketDir - 可选的 POSIX 目录覆盖。
   */
  constructor(
    private readonly ctx: Context,
    private readonly service: MessagingService,
    socketDir?: string,
  ) {
    this.log = message => ctx.logger?.warn?.(message)
    this.listener = new BusListener(socketDir, this.log, socket => this.handle(socket))
  }

  /**
   * 某个会话的稳定 token：后续调用复用同一个。
   * @param sessionId - 会话标识。
   * @returns bearer token。
   */
  tokenFor(sessionId: string): string {
    const existing = this.sessionTokens.get(sessionId)
    if (existing !== undefined) return existing
    const token = randomBytes(32).toString('hex')
    this.sessionTokens.set(sessionId, token)
    this.tokens.set(token, sessionId)
    return token
  }

  /**
   * 开始监听；端点被占用时退让到进程私有端点。
   * @throws 私有端点也无法监听时抛错（调用方据此不导出 shellEnv）。
   */
  async start(): Promise<void> {
    await this.listener.start()
  }

  /** 停止监听、销毁活动连接并清空 token。 */
  async stop(): Promise<void> {
    await this.listener.stop()
    this.tokens.clear()
    this.sessionTokens.clear()
  }

  /** 处理一条连接：读一条请求、答一次、关闭。 */
  private handle(socket: Socket): void {
    attachConnection(socket, request => this.dispatch(request))
  }

  /** 鉴权并执行一条请求。 */
  private async dispatch(request: BusRequest): Promise<BusResponse> {
    const authorized = this.authorize(request)
    if ('error' in authorized) return { ok: false, error: authorized.error }
    const caller = authorized.caller
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    if (request.op === 'list') {
      const input = listInputOf(request)
      if ('ok' in input) return input
      const result = await this.service.list(caller, {
        includeSubagents: input.includeSubagents,
        ...input.limit === undefined ? {} : { limit: input.limit },
        signal,
      })
      return { ok: true, result }
    }
    if (request.op === 'send') {
      const input = sendInputOf(request)
      if ('ok' in input) return input
      const result = await this.service.send(caller, {
        to: input.to,
        message: input.message,
        ...input.summary === undefined ? {} : { summary: input.summary },
        ...input.dedupe === undefined ? {} : { dedupe: input.dedupe },
      }, signal)
      return { ok: true, result }
    }
    return badRequest('未知 op；只支持 "list" 或 "send"')
  }

  /** 把 bearer token 解析成在线调用方。 */
  private authorize(request: BusRequest): { caller: Caller } | { error: { code: string; message: string } } {
    if (typeof request.token !== 'string' || request.token === '') {
      return { error: { code: 'unauthenticated', message: '缺少 token' } }
    }
    const sessionId = this.tokens.get(request.token)
    if (sessionId === undefined) {
      return { error: { code: 'unauthenticated', message: 'token 未知' } }
    }
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      return { error: { code: 'unauthenticated', message: 'token 对应的会话已不在运行' } }
    }
    return { caller: { agent, identity: identityOf(agent) } }
  }
}
