/**
 * 投递通道路由（领域服务）。
 *
 * 规则：如果运行时已经就某段关系提供了官方通道，就优先使用官方通道——
 * 自己的 continuable 子代理走 subagent 通道，同团队成员走 team mailbox，
 * 其余走会话 inbox。官方通道拥有自己的授权与生命周期语义，绕过去会绕过
 * 那些语义；但官方通道拒绝时必须能回落到 inbox，路由细节不能丢消息。
 *
 * 本模块只做纯决策，不探测服务、不调用通道；「通道是否存在」和「团队成员
 * 名」由应用层以事实形式传入。
 *
 * @module dsh-plugin-session-messaging/domain/routing
 */

import type { SessionTarget } from './target.ts'

/** 一次投递实际使用的通道。 */
export type DeliveryRoute = 'subagent' | 'team' | 'steer'

/** 一次路由决策。 */
export interface RouteDecision {
  /** 选中的通道。 */
  readonly route: DeliveryRoute
  /** team 通道需要的成员名；其他通道缺失。 */
  readonly memberName?: string
}

/** 路由判断所需的事实。 */
export interface DeliveryFacts {
  /** 目标会话。 */
  readonly target: SessionTarget
  /** 发送方会话标识。 */
  readonly senderId: string
  /** 目标是否为发送方自己的直接子代理。 */
  readonly isOwnSubagent: boolean
  /** 目标在发送方团队名册中的成员名；不是团队成员时缺失。 */
  readonly teamMemberName?: string
  /** 运行时是否提供 subagent 官方通道。 */
  readonly hasSubagentChannel: boolean
  /** 运行时是否提供 Agent Teams 官方通道。 */
  readonly hasTeamChannel: boolean
}

/**
 * 决定一次投递走哪条通道。
 * @param facts - 关系与通道可用性事实。
 * @returns 通道（team 通道额外返回成员名）。
 */
export function planDelivery(facts: DeliveryFacts): RouteDecision {
  // 团队关系优先：队友即使同时是 Lead 的子代理，也必须走 team mailbox，
  // 因为只有该通道能按名册冷恢复 inactive 队友并保留团队语义。
  if (facts.teamMemberName !== undefined && facts.hasTeamChannel) {
    return { route: 'team', memberName: facts.teamMemberName }
  }
  if (facts.isOwnSubagent && facts.hasSubagentChannel) {
    return { route: 'subagent' }
  }
  return { route: 'steer' }
}

/** 目标会话是否就是发送方自己的直接子代理。 */
export function isOwnSubagent(target: SessionTarget, senderId: string): boolean {
  return target.kind === 'subagent' && target.parentSession === senderId
}
