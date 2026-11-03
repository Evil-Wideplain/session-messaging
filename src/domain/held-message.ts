/**
 * 待审批消息（领域实体）与入站账本的领域状态。
 *
 * 「待审批」是一条有生命周期的业务状态：被挂起 → 被接受 / 被拒绝 / 过期。
 * 状态变化由应用层驱动，落盘由基础设施层负责。
 *
 * @module session-messaging/domain/held-message
 */

/** 一条等待目标审批的消息。 */
export interface HeldMessage {
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
  /** 进入挂起状态的时间戳。 */
  readonly at: number
  /** 审批截止时间戳。 */
  readonly expiresAt: number
}

/** 对一条挂起消息做出的裁决。 */
export type HeldVerdict = 'accepted' | 'refused' | 'expired'

/**
 * 判断一条挂起消息是否已过截止时间。
 * @param message - 挂起消息。
 * @param now - 当前时间戳。
 * @returns 已过期返回 true。
 */
export function isExpired(message: HeldMessage, now: number): boolean {
  return message.expiresAt <= now
}
