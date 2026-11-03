/**
 * Cordis 投递网关（基础设施层实现）。
 *
 * 负责真正把消息交给运行时，按领域路由规则选择通道：
 * 同团队成员走 `agentTeams.sendMessage`，自己的子代理走 `subagents.sendMessage`，
 * 其余走会话 inbox（必要时冷唤醒 → steer → flush → 确认 inbox 接收）。
 *
 * 官方通道成功即视为送达（inbox acceptance，不等待模型处理）。在线目标在官方
 * 通道拒绝时可以安全回落到 inbox；离线目标的官方通道本身就是负责冷恢复的那条
 * 路径，绕过它会把会话唤醒成缺少父级/团队语义的错误形态，因此直接失败并把消息
 * 留在发送方账本等待重试。
 *
 * 冷唤醒必须带完整模型路由：历史 `request/header` 优先，其次是部署默认模型。
 * 缺少路由时拒绝唤醒——被唤醒 Agent 的首轮会在 prompt 组装阶段失败并吞掉消息。
 *
 * 本文件只保留门面职责：路由决策、生命周期字段（AbortController / 恢复句柄 /
 * 恢复表）与公开签名；通道投递与冷唤醒细节在 `delivery/` 子模块。
 *
 * 生命周期：门面的 AbortController 与调用方 signal 合并后传遍整条投递链，`dispose()`
 * 一置位就在途的 resume / 通道请求全部取消；卸载后才返回的恢复句柄在 `wake` 里
 * 就地释放，不会落进已经清空的集合。
 *
 * @module session-messaging/infrastructure/cordis-delivery-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { AgentHandle, UserMessage } from '../types.ts'
import type { DeliveryGateway, DeliveryOutcome, DeliverySenderFacts } from '../application/ports.ts'
import type { SessionTarget } from '../domain/target.ts'
import { isOwnSubagent, planDelivery } from '../domain/routing.ts'
import { noticeMessage } from '../domain/message.ts'
import { messageOf } from '../domain/util.ts'
import { resolveChannels, trySubagentChannel, tryTeamChannel } from './delivery/channels.ts'
import type { ChannelAttempt } from './delivery/channels.ts'
import { deliverToInbox } from './delivery/inbox.ts'
import type { ResumeEntry, WakeState } from './delivery/shared.ts'

/** 投递网关实现（门面）。 */
export class CordisDeliveryGateway implements DeliveryGateway {
  /** 插件生命周期信号：dispose() 时 abort，合并进每次投递的 signal。 */
  private readonly controller = new AbortController()
  private readonly handles = new Set<AgentHandle>()
  private readonly resumes = new Map<string, ResumeEntry>()
  /** 是否已卸载；卸载后不再接受新投递。 */
  private disposed = false

  /**
   * @param ctx - Cordis 上下文（agents / sessions / 通道服务）。
   * @param log - 日志出口（组合根传入 `ctx.logger.warn` 之类的实现）。
   */
  constructor(
    private readonly ctx: Context,
    private readonly log: (message: string) => void,
  ) {}

  /** @inheritdoc */
  async deliver(
    target: SessionTarget,
    message: UserMessage,
    sender: DeliverySenderFacts,
    signal: AbortSignal,
  ): Promise<DeliveryOutcome> {
    if (this.disposed) throw new Error('插件已卸载，投递已取消')
    // 归档会话不可唤醒：DSH 的归档门禁用 `turn/end blocked` 收口，没有 agent/error，
    // 插件无法把一次“唤醒即丢”的投递判成失败，所以必须提前拒绝。
    if (target.archived === true) {
      throw new Error('目标会话已归档：DSH 归档门禁会拒绝它的模型 step，投递已取消；请先取消归档再发送')
    }
    const active = AbortSignal.any([signal, this.controller.signal])
    const channels = resolveChannels(this.ctx, sender.senderId)
    const decision = planDelivery({
      target,
      senderId: sender.senderId,
      isOwnSubagent: isOwnSubagent(target, sender.senderId),
      ...sender.teamMemberName === undefined ? {} : { teamMemberName: sender.teamMemberName },
      hasSubagentChannel: channels.subagents !== undefined && channels.caller !== undefined,
      hasTeamChannel: channels.teams !== undefined && channels.caller !== undefined
        && sender.teamMemberName !== undefined,
    })
    const attempt: ChannelAttempt = { target, message, signal: active, log: this.log }

    if (decision.route === 'subagent') {
      const outcome = await trySubagentChannel(channels, attempt)
      if (outcome !== undefined) return outcome
    }
    if (decision.route === 'team' && decision.memberName !== undefined) {
      const outcome = await tryTeamChannel(channels, decision.memberName, attempt)
      if (outcome !== undefined) return outcome
    }
    return await deliverToInbox(this.wakeState(), target, message, active)
  }

  /** @inheritdoc */
  notify(agentId: string, text: string, topic: string): void {
    if (this.disposed) return
    const agent = this.ctx.agents.get(agentId)
    if (agent === undefined) return
    try {
      agent.steer(noticeMessage(randomUUID(), text, topic))
    } catch (error) {
      this.log(`[session-messaging] 通知 ${agentId} 失败: ${messageOf(error)}`)
    }
  }

  /** 释放本插件拥有的恢复句柄并停止接收新工作。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
    for (const handle of this.handles) {
      void Promise.resolve(handle.dispose()).catch(() => {})
    }
    this.handles.clear()
    this.resumes.clear()
  }

  /** 把门面持有的可变状态交给 `delivery/` 子模块共享（引用同一份句柄集合与恢复表）。 */
  private wakeState(): WakeState {
    return { ctx: this.ctx, log: this.log, handles: this.handles, resumes: this.resumes }
  }
}
