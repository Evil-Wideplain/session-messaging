/**
 * 跨会话消息用例的依赖与共享状态。
 *
 * 组合根只装配 `MessagingDependencies`；门面把它解析成 `MessagingContext`
 * （补上默认日志与可变状态），再把上下文显式传给 `messaging/` 下的用例函数。
 * 这样用例函数不持有服务实例，也不依赖 Cordis。
 *
 * @module dsh-plugin-session-messaging/application/messaging/deps
 */

import type { ResolvedConfig } from '../../config.ts'
import type { ReviewOutcome } from '../dto.ts'
import type { DuplicateWindow, RateLimiter } from '../guards.ts'
import type { DeliveryGateway, InboundRepository, OutboxRepository, SessionDirectory } from '../ports.ts'

/** 应用服务依赖（由组合根装配）。 */
export interface MessagingDependencies {
  /** 有效配置。 */
  readonly config: ResolvedConfig
  /** 按发送方取（或创建）出站账本。 */
  readonly outbox: (senderId: string) => OutboxRepository
  /** 按目标取（或创建）入站账本。 */
  readonly inbound: (targetId: string) => InboundRepository
  /** 会话目录。 */
  readonly directory: SessionDirectory
  /** 投递网关。 */
  readonly gateway: DeliveryGateway
  /** 可选日志出口（默认静默，便于测试）。 */
  readonly log?: (message: string) => void
}

/** `list` 的默认返回上限。 */
export const LIST_DEFAULT_LIMIT = 50

/** `list` 的返回上限硬顶（与工具层 schema 一致）。 */
export const LIST_MAX_LIMIT = 200

/** 频控窗口长度。 */
export const RATE_WINDOW_MS = 60_000

/** 审批预览的最大字符数。 */
export const PREVIEW_CHARS = 4_000

/**
 * 用例函数共享的上下文：解析后的依赖 + 门面持有的可变状态。
 *
 * 状态容器（Map / 守卫）按引用传递，用例函数直接读写它们；`log` 已补上
 * 静默默认值，因此所有用例都可以无条件调用。
 */
export interface MessagingContext {
  readonly config: ResolvedConfig
  readonly outbox: (senderId: string) => OutboxRepository
  readonly inbound: (targetId: string) => InboundRepository
  readonly directory: SessionDirectory
  readonly gateway: DeliveryGateway
  readonly log: (message: string) => void
  readonly rateLimiter: RateLimiter
  readonly duplicates: DuplicateWindow
  readonly notices: Map<string, number>
  readonly recoveries: Map<string, Promise<void>>
  readonly expiryOutcomes: Map<string, ReviewOutcome[]>
}
