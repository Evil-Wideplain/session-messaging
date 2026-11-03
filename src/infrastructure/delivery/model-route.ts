/**
 * 冷唤醒的模型路由解析（基础设施层）。
 *
 * 被恢复的 Agent 必须带完整 provider/model：缺路由的实例会在 prompt 组装阶段
 * 失败并把消息吞掉，所以宁可拒绝唤醒、把消息留在发送方账本。历史 `request/header`
 * 是会话原本使用的路由，优先于部署默认模型。
 *
 * @module session-messaging/infrastructure/delivery/model-route
 */

import type { AgentOptions } from '../../types.ts'
import { foldAgentOptions } from '../persisted-session.ts'
import type { WakeState } from './shared.ts'

/**
 * 计算冷唤醒使用的模型路由：历史优先，部署默认兜底；都没有时拒绝唤醒。
 * @param state - 网关共享状态（读取部署默认模型）。
 * @param events - 目标会话自己的事件段（不含 fork 继承前缀）。
 * @returns 可直接传给 `ctx.agents.resume` 的模型路由。
 * @throws 历史与部署默认模型都没有可用路由时抛错。
 */
export function wakeOptions(state: WakeState, events: Parameters<typeof foldAgentOptions>[0]): AgentOptions {
  const folded = foldAgentOptions(events)
  if (typeof folded['provider'] === 'string' && folded['provider'] !== ''
    && typeof folded['model'] === 'string' && folded['model'] !== '') {
    return folded
  }
  const fallback = state.ctx.get('agentDefaultModel')?.currentSelection()
  if (fallback !== undefined && fallback.provider !== '' && fallback.model !== '') {
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort },
    }
  }
  throw new Error(
    '目标会话没有可用的模型路由（历史没有 request/header，部署也没有默认模型）；'
    + '拒绝用会在首轮吞消息的 Agent 唤醒，消息已保留在发送方账本',
  )
}
