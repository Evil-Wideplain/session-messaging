/**
 * 官方通道投递（基础设施层）。
 *
 * 运行时若提供 Agent Teams / subagents 服务，就优先用它们投递：官方通道自带
 * 授权与冷恢复语义，绕过它会唤醒成缺少父级/团队语义的错误形态。通道拒绝时
 * 在线目标可以安全回落到 inbox；离线目标必须直接失败——只有官方通道能正确
 * 冷恢复它，回落会把子会话当根会话唤醒。
 *
 * @module session-messaging/infrastructure/delivery/channels
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Caller, DeliveryOutcome } from '../../application/ports.ts'
import type { SessionTarget } from '../../domain/target.ts'
import type { Agent, ContentBlock, UserMessage } from '../../types.ts'
import { messageOf } from '../../domain/util.ts'

/** `ctx.subagents.sendMessage` 的最小结构。 */
export interface SubagentChannel {
  /**
   * 通过官方 subagent 通道投递消息。
   * @param sender - 发送方 Agent（官方通道会据此校验父子关系）。
   * @param targetId - 目标子会话标识。
   * @param content - 消息内容块。
   * @param options - 取消信号。
   * @returns 官方通道返回的消息标识。
   */
  sendMessage(
    sender: Agent,
    targetId: string,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ): Promise<string>
}

/** `ctx.agentTeams.sendMessage` 的最小结构。 */
export interface TeamChannel {
  /**
   * 通过官方团队通道投递消息。
   * @param sender - 发送方 Agent（官方通道会据此校验团队成员身份）。
   * @param request - 目标成员名、内容与取消信号。
   * @returns 官方通道返回的消息标识。
   */
  sendMessage(
    sender: Agent,
    request: { target: string; content: ContentBlock[]; signal: AbortSignal },
  ): Promise<{ messageId: string }>
}

/** 运行时提供的官方通道与已解析的发送方。 */
export interface OfficialChannels {
  /** 发送方 Agent 与身份；发送方不在线时缺失。 */
  readonly caller?: Caller
  /** subagent 官方通道。 */
  readonly subagents?: SubagentChannel
  /** Agent Teams 官方通道。 */
  readonly teams?: TeamChannel
}

/** 一次官方通道投递所需的上下文。 */
export interface ChannelAttempt {
  /** 目标会话。 */
  readonly target: SessionTarget
  /** 已构造好的消息。 */
  readonly message: UserMessage
  /** 取消信号。 */
  readonly signal: AbortSignal
  /** 日志出口。 */
  readonly log: (message: string) => void
}

/**
 * 解析运行时的官方通道。
 * @param ctx - Cordis 上下文。
 * @param senderId - 发送方会话标识。
 * @returns 官方通道与发送方；发送方不在线时全部缺失。
 */
export function resolveChannels(ctx: Context, senderId: string): OfficialChannels {
  const senderAgent = ctx.agents.get(senderId)
  if (senderAgent === undefined) return {}
  const subagents = ctx.get('subagents') as SubagentChannel | undefined
  const teams = ctx.get('agentTeams') as TeamChannel | undefined
  return {
    caller: { agent: senderAgent, identity: { id: senderId } },
    ...subagents === undefined ? {} : { subagents },
    ...teams === undefined ? {} : { teams },
  }
}

/**
 * 通过 subagent 官方通道投递。
 * @param channels - 运行时官方通道。
 * @param attempt - 投递上下文。
 * @returns 送达结果；通道不可用或在线目标被拒时返回 undefined（回落 inbox）。
 * @throws 离线目标被拒时抛错：回落会把已结束的子代理当根会话唤醒。
 */
export async function trySubagentChannel(
  channels: OfficialChannels,
  attempt: ChannelAttempt,
): Promise<DeliveryOutcome | undefined> {
  const { subagents, caller } = channels
  if (subagents === undefined || caller === undefined) return undefined
  try {
    const channelId = await subagents.sendMessage(
      caller.agent,
      attempt.target.id,
      attempt.message.content,
      { signal: attempt.signal },
    )
    return {
      accepted: true,
      route: 'subagent',
      detail: `已通过 subagent 通道送达（${channelId}）`,
    }
  } catch (error) {
    attempt.log(`[session-messaging] subagent 通道拒绝 ${attempt.target.id}: ${messageOf(error)}`)
    // 已结束的子代理只能靠 subagent 通道冷恢复；回落到 inbox 会把它当根会话唤醒。
    if (attempt.target.status === 'offline') {
      throw new Error(`subagent 通道无法冷恢复 ${attempt.target.id}：${messageOf(error)}`)
    }
    return undefined
  }
}

/**
 * 通过 Agent Teams 官方通道投递。
 * @param channels - 运行时官方通道。
 * @param memberName - 目标在发送方团队名册中的成员名。
 * @param attempt - 投递上下文。
 * @returns 送达结果；通道不可用或在线目标被拒时返回 undefined（回落 inbox）。
 * @throws 离线队友被拒时抛错：inactive 队友只能靠 team mailbox 冷恢复。
 */
export async function tryTeamChannel(
  channels: OfficialChannels,
  memberName: string,
  attempt: ChannelAttempt,
): Promise<DeliveryOutcome | undefined> {
  const { teams, caller } = channels
  if (teams === undefined || caller === undefined) return undefined
  try {
    const result = await teams.sendMessage(caller.agent, {
      target: memberName,
      content: attempt.message.content,
      signal: attempt.signal,
    })
    return {
      accepted: true,
      route: 'team',
      detail: `已通过团队邮箱送达（${result.messageId}）`,
    }
  } catch (error) {
    attempt.log(`[session-messaging] 团队通道拒绝 ${attempt.target.id}: ${messageOf(error)}`)
    // inactive 队友只能靠 team mailbox 冷恢复（它会以 Lead 的授权恢复子会话）。
    if (attempt.target.status === 'offline') {
      throw new Error(`团队通道无法冷恢复 ${attempt.target.id}：${messageOf(error)}`)
    }
    return undefined
  }
}
