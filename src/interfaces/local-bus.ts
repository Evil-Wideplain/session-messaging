/**
 * 本地总线（接口层）：shell 脚本访问本插件的传输入口。
 *
 * 每个系统用户一个端点（POSIX 是 unix socket，Windows 是命名管道），用每会话
 * 独立的 bearer token 鉴权。token 是「连接 = 某个发送方身份」的唯一依据；
 * 它通过 `ctx.shellEnv` 注入 bash/pwsh 环境，因此脚本的身份就是它所在的会话。
 *
 * 协议：一次连接 = 一条 JSON 请求（换行或 EOF 结束）+ 一条 JSON 响应。
 *
 * ```text
 * {"token":"<token>","op":"list","include_subagents":false,"limit":20}
 * {"token":"<token>","op":"send","to":"<name-or-id>","message":"...","summary":"...","dedupe":true}
 * ```
 *
 * bus 只有 list / send；入站审批只能由目标会话自己的模型通过
 * `review_session_messages` 完成，避免 shell 侧绕过审批。
 *
 * 实现要点：
 * - 连接用 `setEncoding('utf8')`：手工 `chunk.toString('utf8')` 会把跨 chunk
 *   的多字节字符解成 U+FFFD，中文正文静默乱码。
 * - 请求参数与工具层同一套校验：静默忽略错类型会让脚本得到「成功但少行」的结果。
 * - 端点归属显式：POSIX 先探测是否有存活宿主，只有 ECONNREFUSED 才清理陈旧文件，
 *   避免第二个宿主抢走端点、第一个宿主的 stop() 又删掉别人的 socket。
 *
 * @module dsh-plugin-session-messaging/interfaces/local-bus
 */

import { randomBytes } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '../types.ts'
import type { MessagingService } from '../application/messaging-service.ts'
import type { Caller } from '../application/ports.ts'
import { identityOf } from '../domain/authorization.ts'
import { busEndpoint, defaultSocketDir, ensurePrivateDir } from '../infrastructure/paths.ts'

/** 单个请求体的硬上限。 */
const MAX_REQUEST_BYTES = 1024 * 1024
/** 单连接空闲预算。 */
const CONNECTION_TIMEOUT_MS = 30_000
/** 一次请求触发的投递工作预算。 */
const REQUEST_TIMEOUT_MS = 25_000
/** 探测既有端点时允许的连接等待。 */
const PROBE_TIMEOUT_MS = 500
/** 工具层允许的 limit 上限，与 model-tools 保持一致。 */
const MAX_LIMIT = 200

/** 一条解析后的总线请求。 */
interface BusRequest {
  readonly token?: unknown
  readonly op?: unknown
  readonly to?: unknown
  readonly message?: unknown
  readonly summary?: unknown
  readonly dedupe?: unknown
  readonly include_subagents?: unknown
  readonly limit?: unknown
}

/** 一条总线响应。 */
interface BusResponse {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** 构造一条 `bad_request` 响应。 */
function badRequest(message: string): BusResponse {
  return { ok: false, error: { code: 'bad_request', message } }
}

/**
 * 每用户一个的总线服务。
 */
export class LocalBus {
  /** 实际使用的端点；正常等于 `busEndpoint(dir)`，被占用时改为进程私有端点。 */
  private endpointPath: string
  /** 端点绝对路径（POSIX socket 文件或 Windows 管道名）。 */
  get endpoint(): string {
    return this.endpointPath
  }

  private readonly dir: string
  private server: Server | undefined
  /** 是否真正 listening：只有属主才能清理端点文件，抢端点失败的一方不许删。 */
  private listening = false
  /** 启动过程中被 dispose 时置真：start() 结束时据此自关，避免留下孤儿监听。 */
  private stopped = false
  /** 活动连接；stop 时要主动销毁，否则 server.close 会等到空闲超时。 */
  private readonly sockets = new Set<Socket>()
  /** token → 会话标识。 */
  private readonly tokens = new Map<string, string>()
  /** 会话标识 → token。 */
  private readonly sessionTokens = new Map<string, string>()
  private readonly log: (message: string) => void

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
    this.dir = socketDir ?? defaultSocketDir()
    ensurePrivateDir(this.dir)
    this.endpointPath = busEndpoint(this.dir)
    this.log = message => ctx.logger?.warn?.(message)
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
   * 开始监听。
   *
   * POSIX 上先探测端点：能连上说明有存活宿主，直接失败；只有连不上
   * （ECONNREFUSED/超时）才当作陈旧 socket 文件清理。
   *
   * 端点被别人占着不是错误场景——GUI 与 `dsh headless` 会同时运行，而默认端点
   * 每用户只有一个。此时退让到进程私有端点（同名加进程号），保证本进程里脚本
   * 注入的 socket/token 仍然可用；不去抢、也不共享别人的总线。
   * @throws 私有端点也无法监听时抛错（调用方据此不导出 shellEnv）。
   */
  async start(): Promise<void> {
    try {
      await this.listen(this.endpointPath)
    } catch (error) {
      const fallback = this.fallbackEndpoint()
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[session-messaging] 端点 ${this.endpointPath} 不可用（${detail}），改用进程私有端点 ${fallback}`)
      this.endpointPath = fallback
      await this.listen(this.endpointPath)
    }
    // 启动期间插件已被卸载：立刻关掉，别让一个没人引用的 server 继续监听。
    if (this.stopped) await this.stop()
  }

  /** 进程私有端点：Windows 是同名前缀加进程号，POSIX 是同目录下的 `bus-<pid>.sock`。 */
  private fallbackEndpoint(): string {
    if (process.platform === 'win32') return `${busEndpoint(this.dir)}-${process.pid}`
    return join(this.dir, `bus-${process.pid}.sock`)
  }

  /** 在指定端点上建立监听；失败时清理半成品 server。 */
  private async listen(path: string): Promise<void> {
    if (process.platform !== 'win32') {
      const owned = await this.probeExisting(path)
      if (owned) throw new Error(`端点已被另一个宿主占用（${path}），拒绝抢占`)
      await unlink(path).catch(() => {})
    }
    const server = createServer((socket) => {
      this.sockets.add(socket)
      socket.once('close', () => { this.sockets.delete(socket) })
      this.handle(socket)
    })
    await new Promise<void>((resolve, reject) => {
      // 这个监听器必须在成功路径上显式摘掉：留着的 once 会在之后任意一次服务错误时
      // 触发 server.close()，把正在服务的总线关掉。
      const onListenError = (error: Error): void => {
        server.close()
        reject(error)
      }
      server.once('error', onListenError)
      server.listen(path, () => {
        server.off('error', onListenError)
        resolve()
      })
    })
    this.server = server
    this.listening = true
    server.on('error', (error: Error) => {
      this.log(`[session-messaging] 总线服务错误: ${error.message}`)
    })
    if (process.platform !== 'win32') {
      // 目录是 0700，但 socket 文件默认按 umask 创建；显式收紧到 0600。
      await chmod(path, 0o600).catch(() => {})
    }
  }

  /** 停止监听并清理 POSIX socket 文件。 */
  async stop(): Promise<void> {
    this.stopped = true
    const server = this.server
    const owned = this.listening
    this.server = undefined
    this.listening = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    }
    this.tokens.clear()
    this.sessionTokens.clear()
    // 只有属主可以删端点：start() 失败的一方若也 unlink，会删掉别人正在监听的 socket。
    if (owned && process.platform !== 'win32') {
      await unlink(this.endpoint).catch(() => {})
    }
  }

  /**
   * 探测端点上是否已有存活宿主。
   * @returns 能连上返回 true（端点被占用）。
   */
  private async probeExisting(path: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const probe = createConnection(path)
      const done = (occupied: boolean): void => {
        probe.destroy()
        resolve(occupied)
      }
      probe.once('connect', () => done(true))
      probe.once('error', () => done(false))
      probe.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    })
  }

  /** 处理一条连接：读一条请求、答一次、关闭。 */
  private handle(socket: Socket): void {
    socket.setTimeout(CONNECTION_TIMEOUT_MS)
    // 让 Node 内部用 StringDecoder 跨 chunk 保持 UTF-8 状态；手工逐 chunk
    // toString('utf8') 会把被切断的多字节字符变成 U+FFFD。
    socket.setEncoding('utf8')
    socket.on('timeout', () => {
      this.reply(socket, { ok: false, error: { code: 'timeout', message: '请求超时' } })
    })
    socket.on('error', () => { socket.destroy() })

    let buffer = ''
    let settled = false
    const settle = (response: BusResponse): void => {
      if (settled) return
      settled = true
      this.reply(socket, response)
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      // 上限按字节而不是 UTF-16 码元判断，中文正文才不会被高估 3 倍或低估。
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        settle({ ok: false, error: { code: 'too_large', message: '请求体过大' } })
        return
      }
      const newline = buffer.indexOf('\n')
      const candidate = newline >= 0 ? buffer.slice(0, newline) : buffer
      let request: BusRequest
      try {
        request = JSON.parse(candidate.trim()) as BusRequest
      } catch {
        if (newline >= 0) settle({ ok: false, error: { code: 'bad_request', message: '请求不是合法 JSON' } })
        return
      }
      buffer = ''
      void this.dispatch(request).then(settle, (error: unknown) => {
        settle({
          ok: false,
          error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
        })
      })
    })

    socket.on('end', () => {
      if (buffer.trim() !== '') {
        settle({ ok: false, error: { code: 'bad_request', message: '一次连接只能携带一个 JSON 文档' } })
      }
    })
  }

  /** 写一行响应并关闭连接。 */
  private reply(socket: Socket, response: BusResponse): void {
    const line = `${JSON.stringify(response)}\n`
    socket.end(line, () => { socket.destroy() })
  }

  /** 鉴权并执行一条请求。 */
  private async dispatch(request: BusRequest): Promise<BusResponse> {
    const authorized = this.authorize(request)
    if ('error' in authorized) return { ok: false, error: authorized.error }
    const caller = authorized.caller
    const body = request
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    if (body.op === 'list') {
      if (body.include_subagents !== undefined && typeof body.include_subagents !== 'boolean') {
        return badRequest('"include_subagents" 必须是布尔值')
      }
      const limit = body.limit
      if (limit !== undefined
        && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
        return badRequest(`"limit" 必须是 1..${MAX_LIMIT} 的整数`)
      }
      const result = await this.service.list(caller, {
        includeSubagents: body.include_subagents === true,
        ...limit === undefined ? {} : { limit },
        signal,
      })
      return { ok: true, result }
    }
    if (body.op === 'send') {
      if (typeof body.to !== 'string' || body.to.trim() === '' || typeof body.message !== 'string') {
        return badRequest('"to" 与 "message" 必须是非空字符串')
      }
      if (body.summary !== undefined && typeof body.summary !== 'string') {
        return badRequest('"summary" 必须是字符串')
      }
      if (body.dedupe !== undefined && typeof body.dedupe !== 'boolean') {
        return badRequest('"dedupe" 必须是布尔值')
      }
      const result = await this.service.send(caller, {
        to: body.to,
        message: body.message,
        ...typeof body.summary === 'string' ? { summary: body.summary } : {},
        ...typeof body.dedupe === 'boolean' ? { dedupe: body.dedupe } : {},
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

/**
 * 把总线端点与每会话 token 注册进 bash/pwsh 环境。
 * @param ctx - 携带 `shellEnv` 的上下文。
 * @param bus - 要暴露的总线。
 * @returns 贡献者的释放函数；没有 `shellEnv` 时返回空操作。
 */
export function registerShellEnv(ctx: Context, bus: LocalBus): () => void {
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) return () => {}
  return shellEnv.register({
    name: 'session-messaging',
    variables: {
      DSH_SESSION_MESSAGING_SOCKET: {
        description: '本会话 shell 脚本可用的本地总线端点（list/send）。',
      },
      DSH_SESSION_MESSAGING_TOKEN: {
        description: '本会话总线请求的 bearer token，按密钥对待。',
      },
    },
    resolve(execution: ToolExecution): Record<string, string> {
      const agent = execution.agent
      if (agent === undefined) return {}
      return {
        DSH_SESSION_MESSAGING_SOCKET: bus.endpoint,
        DSH_SESSION_MESSAGING_TOKEN: bus.tokenFor(agent.id),
      }
    },
  })
}
