/**
 * 发送方出站账本的领域模型。
 *
 * 一条消息从 `queued`（已落账、待确认）或 `held`（被接收方挂起审批）开始，
 * 最终收敛到 `delivered` / `expired` / `refused` 三个终态之一。
 * `held` 不参与「发送方重启后重放」——它归接收方的入站账本管。
 *
 * @module dsh-plugin-session-messaging/domain/outbox
 */

/** 一条未确认的出站消息。 */
export interface OutboxEntry {
  /** 转发消息标识。 */
  readonly messageId: string
  /** 发送方会话标识。 */
  readonly senderId: string
  /** 发送方显示名。 */
  readonly senderName: string
  /** 目标会话标识。 */
  readonly targetId: string
  /** 消息正文。 */
  readonly text: string
  /** 可选的一行摘要。 */
  readonly summary?: string
  /** 入账时间戳。 */
  readonly at: number
  /** 仅 `held` 条目有的审批截止时间。 */
  readonly expiresAt?: number
}

/** 终态类型。 */
export type OutboxAck = 'delivered' | 'expired' | 'refused'
