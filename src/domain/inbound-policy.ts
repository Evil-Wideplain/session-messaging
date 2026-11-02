/**
 * 入站审批策略（领域值对象）。
 *
 * 对应 Claude Code 的 `crossSessionInbound` 三态开关：直接接收、挂起等待
 * 目标审批、一律拒绝。挂起窗口与容量上限是策略的一部分，规则本身不落盘。
 *
 * @module dsh-plugin-session-messaging/domain/inbound-policy
 */

/** 入站策略三态。 */
export type InboundMode = 'accept' | 'hold' | 'refuse'

/** 挂起审批的发布时间与容量规则。 */
export interface HoldPolicy {
  /** 审批截止时间窗口（毫秒）。 */
  readonly windowMs: number
  /** 每个目标最多挂起多少条，满了丢最旧。 */
  readonly maxHeld: number
}

/**
 * 计算一条消息的审批截止时间。
 * @param policy - 挂起策略。
 * @param now - 当前时间戳。
 * @returns 截止时间戳。
 */
export function holdDeadline(policy: HoldPolicy, now: number): number {
  return now + policy.windowMs
}

/**
 * 从当前挂起集合里挑出为容纳新消息而必须淘汰的最旧消息。
 *
 * 一次调用返回全部需要淘汰的条目：调用方应批量结算，而不是逐条重算
 * （逐条重算会让淘汰变成 O(n²) 的全账本折叠）。
 * @param held - 当前仍挂起的消息（按到达顺序）。
 * @param policy - 挂起策略。
 * @returns 需要淘汰的最旧条目；未超容量时为空数组。
 */
export function capacityOverflow<T>(held: readonly T[], policy: HoldPolicy): readonly T[] {
  const overflow = held.length - policy.maxHeld + 1
  return overflow <= 0 ? [] : held.slice(0, overflow)
}
