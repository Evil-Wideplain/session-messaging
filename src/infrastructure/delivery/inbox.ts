/**
 * inbox 投递与送达判定（基础设施层）。
 *
 * 官方通道不可用时把消息 steer 进目标会话的 inbox；目标离线则先冷唤醒。
 * 「送达」的唯一标准是消息真的进入了目标会话：历史里有 user/message，或仍挂在
 * inbox splice 投影里。1.2s 窗口只用来发现首轮快速失败，不能当送达证据——
 * 晚到的 blocked 收口会让「唤醒即丢」被误判成 accepted。
 *
 * 冷唤醒的恢复记录按引用共享：本模块每次 acquire 后都恰好释放一次，成功只减
 * 引用，失败/未确认送达才按「放弃恢复」销毁句柄。
 *
 * @module session-messaging/infrastructure/delivery/inbox
 */

import type { DeliveryOutcome } from '../../application/ports.ts'
import { messageAccepted } from '../../domain/message.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { messageOf } from '../../domain/util.ts'
import type { Agent, UserMessage } from '../../types.ts'
import { awaitFailure } from './failure-probe.ts'
import type { ResumeEntry, WakeState } from './shared.ts'
import { release, wake } from './wake.ts'

/**
 * 刷新会话日志；splice 已经在事件视图里，刷新失败不影响判定。
 * @param state - 网关共享状态。
 * @param agent - 目标会话的在线 Agent。
 */
export async function flushSession(state: WakeState, agent: Agent): Promise<void> {
  try {
    await state.ctx.sessions.flush(agent.session)
  } catch (error) {
    state.log(`[session-messaging] 刷新 ${agent.id} 的会话日志失败: ${messageOf(error)}`)
  }
}

/**
 * 把消息交给目标会话的 inbox（必要时先冷唤醒），并判定是否真的送达。
 * @param state - 网关共享状态。
 * @param target - 目标会话。
 * @param message - 已构造的消息。
 * @param signal - 取消信号。
 * @returns 送达结果；无法确认进入目标会话时返回 accepted=false，留给账本重试。
 */
export async function deliverToInbox(
  state: WakeState,
  target: SessionTarget,
  message: UserMessage,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  const messageId = String(message.source['messageId'])
  const known = state.ctx.agents.get(target.id)
  const woke = known === undefined ? await wake(state, target.id, signal) : undefined
  const entry: ResumeEntry | undefined = woke?.entry
  const agent = known ?? woke?.agent
  if (agent === undefined) {
    await release(state, entry, true)
    throw new Error(`无法获得目标会话 ${target.id} 的在线 Agent`)
  }
  const evidence = (): boolean => messageAccepted(agent.session.ownEvents(), messageId)
  // 每个 acquire 恰好释放一次：异常路径只减引用（句柄仍归门面统一释放），
  // 失败/未确认送达才走「放弃恢复」。
  let settled = false
  const settle = async (dispose: boolean): Promise<void> => {
    if (settled) return
    settled = true
    await release(state, entry, dispose)
  }
  try {
    agent.steer(message)
    await flushSession(state, agent)

    // 在线目标：steer 不抛错就说明消息已进入它的 inbox（内存里），这与
    // 「第一条事件已经落盘」无关，不能因为 flush 时序把它改成 queued。
    if (known !== undefined) {
      return {
        accepted: true,
        route: 'steer',
        detail: '消息已进入目标会话的 inbox',
      }
    }

    if (woke?.failure !== undefined) {
      const failure = await awaitFailure(woke.failure)
      // 只有「首轮报错且消息没有进入历史」才是真失败；已进入历史就按送达处理。
      if (failure !== undefined && !evidence()) {
        await settle(true)
        throw new Error(`冷唤醒后首轮失败（${failure.message}）；消息已留在发送方账本等待重试`)
      }
    }

    if (!evidence()) {
      // 冷唤醒后既没有报错也没有落账证据：不写 delivered 终态，让恢复流程在
      // 下次启动时重放；恢复句柄一并放弃，允许下次重新唤醒。
      await settle(true)
      return {
        accepted: false,
        route: 'steer',
        detail: '消息未能确认进入目标会话，已保留在发送方账本等待重试',
      }
    }
    await settle(false)
    return {
      accepted: true,
      route: 'steer',
      detail: '已冷唤醒目标会话，消息已进入其会话 inbox',
    }
  } finally {
    await settle(false)
  }
}
