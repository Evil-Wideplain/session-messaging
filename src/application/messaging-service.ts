/**
 * 跨会话消息应用服务（用例编排门面）。
 *
 * 只依赖端口接口：会话目录、出站/入站账本、投递网关。领域规则（授权、路由、
 * 消息构造、送达判定、挂起策略）全部委托给 `domain/`，本层负责把用例串起来：
 *
 * - `list`：列出调用方有权访问的会话；
 * - `send`：校验 → 解析 → 授权 → 策略 → 限额/去重 → 挂起或投递；
 * - `review`：目标侧审批（列出/接受/拒绝），接受时重新授权再投递；
 * - `recover`：会话启动时重放未确认出站消息、惰性过期入站挂起。
 *
 * 每个用例的实现拆在 `messaging/` 子模块里；本类只装配一次 `MessagingContext`
 * （依赖按引用 + 可变状态），把它作为显式参数传给用例函数，公开导出与签名保持不变。
 *
 * @module session-messaging/application/messaging-service
 */

import type { Agent } from '../types.ts'
import type { Caller } from './ports.ts'
import type { ListResult, ReviewAction, ReviewOutcome, ReviewResult, SendInput, SendResult } from './dto.ts'
import { DuplicateWindow, RateLimiter } from './guards.ts'
import type { MessagingContext, MessagingDependencies } from './messaging/deps.ts'
import { RATE_WINDOW_MS } from './messaging/deps.ts'
import { listSessions } from './messaging/list.ts'
import { sendMessage } from './messaging/send.ts'
import { reviewMessages } from './messaging/review.ts'
import { recoverSessions } from './messaging/recover.ts'

/**
 * 跨会话消息应用服务。
 */
export class MessagingService {
  /**
   * 用例函数共享的上下文：依赖与可变状态都按引用透传。
   *
   * 构造时装配一次即可：字段全是只读引用（Map 内容才是可变状态），
   * 每次调用重建一个对象只会增加噪声。
   */
  private readonly ctx: MessagingContext

  /**
   * @param dependencies - 端口实现与有效配置。
   */
  constructor(dependencies: MessagingDependencies) {
    const config = dependencies.config
    this.ctx = {
      config,
      outbox: dependencies.outbox,
      inbound: dependencies.inbound,
      directory: dependencies.directory,
      gateway: dependencies.gateway,
      log: dependencies.log ?? (() => {}),
      rateLimiter: new RateLimiter(RATE_WINDOW_MS),
      duplicates: new DuplicateWindow(config.dedupeWindowMs),
      notices: new Map<string, number>(),
      recoveries: new Map<string, Promise<void>>(),
      expiryOutcomes: new Map<string, ReviewOutcome[]>(),
    }
  }

  /**
   * 列出调用方有权访问的会话。
   * @param caller - 运行时验证过的调用方。
   * @param options - 是否包含子代理、返回上限、取消信号。
   * @returns 允许访问的行，以及被隐藏的可达会话数量。
   */
  async list(
    caller: Caller,
    options: { readonly includeSubagents: boolean; readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<ListResult> {
    return listSessions(this.ctx, caller, options)
  }

  /**
   * 发送一条消息：投递、挂起等待审批，或拒绝。
   * @param caller - 运行时验证过的调用方。
   * @param input - 地址、正文、可选摘要。
   * @param signal - 调用方取消信号。
   * @returns 稳定的状态描述。
   */
  async send(caller: Caller, input: SendInput, signal: AbortSignal): Promise<SendResult> {
    return sendMessage(this.ctx, caller, input, signal)
  }

  /**
   * 查看或裁决挂起给当前会话的消息。
   * @param caller - 目标会话自己的 Agent。
   * @param action - list / accept / refuse。
   * @param messageId - 指定一条，缺省作用于全部挂起消息。
   * @param signal - 取消信号。
   * @returns 仍挂起的消息与本次裁决结果。
   */
  async review(
    caller: Caller,
    action: ReviewAction,
    messageId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    return reviewMessages(this.ctx, caller, action, messageId, signal)
  }

  /**
   * 会话启动时恢复：重放未确认的出站消息，并惰性过期本会话的入站挂起。
   * @param principal - 刚启动的会话。
   */
  async recover(principal: Caller | Agent): Promise<void> {
    return recoverSessions(this.ctx, principal)
  }
}
