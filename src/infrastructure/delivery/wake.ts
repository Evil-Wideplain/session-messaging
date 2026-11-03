/**
 * 冷唤醒（基础设施层）。
 *
 * 把一个持久化会话恢复成在线 Agent：必须带完整模型路由（历史 request/header 优先，
 * 部署默认模型兜底），并挂载首轮错误探针识别 prompt 组装失败与归档门禁的 blocked
 * 收口。同一目标并发只恢复一次；恢复句柄归本插件所有，失败或未确认送达即放弃重试。
 *
 * 恢复记录按引用计数共享：并发投递拿到同一个 Agent，先结束的一方只减少引用，
 * 不能销毁另一方仍在 steer 或仍在等首轮结果的实例。
 *
 * @module dsh-plugin-session-messaging/infrastructure/delivery/wake
 */

import type { Context } from '@deepseek-ai/cordis'
import { messageOf } from '../../domain/util.ts'
import type { AgentHandle } from '../../types.ts'
import { readPersistedSession } from '../persisted-session.ts'
import { failureProbe, watchFirstFailure } from './failure-probe.ts'
import { wakeOptions } from './model-route.ts'
import type { ResumeEntry, WakeOutcome, WakeResult, WakeState } from './shared.ts'

/**
 * 冷唤醒一个持久化会话，同一目标并发只恢复一次。
 *
 * 每次调用都会给共享记录加一个引用，并在结果里带回该记录；调用方判定结束后
 * 必须 `release()` 一次（成功只是减少引用，失败才销毁句柄）。
 * @param state - 网关共享状态。
 * @param targetId - 目标会话标识。
 * @param signal - 取消信号。
 * @returns 唤醒结果（目标已在线时直接返回它）。
 */
export function wake(state: WakeState, targetId: string, signal: AbortSignal): Promise<WakeResult> {
  const entry = acquireEntry(state, targetId, signal)
  entry.refs += 1
  return entry.job.then((outcome) => ({ ...outcome, entry }))
}

/** 取共享的恢复记录：进行中的复用，已结束且会话仍在线也复用，否则重新唤醒。 */
function acquireEntry(state: WakeState, targetId: string, signal: AbortSignal): ResumeEntry {
  const existing = state.resumes.get(targetId)
  if (existing !== undefined) {
    if (!existing.settled) return existing
    // 之前由本插件恢复的会话一旦结束就不再可用，后续发送要能再次唤醒。
    if (state.ctx.agents.get(targetId) !== undefined) return existing
    state.resumes.delete(targetId)
  }
  const entry: ResumeEntry = { targetId, job: startWake(state, targetId, signal), settled: false, refs: 0 }
  state.resumes.set(targetId, entry)
  entry.job.then(
    (outcome) => {
      entry.settled = true
      if (outcome.handle !== undefined) entry.handle = outcome.handle
      if (outcome.failure !== undefined) entry.failure = outcome.failure
    },
    () => {
      if (state.resumes.get(targetId) === entry) state.resumes.delete(targetId)
    },
  )
  return entry
}

/** 启动一次恢复：带完整模型路由、挂历史预置（失败降级），并校验恢复出的路由。 */
async function startWake(
  state: WakeState,
  targetId: string,
  signal: AbortSignal,
): Promise<WakeOutcome> {
  const live = state.ctx.agents.get(targetId)
  if (live !== undefined) return { agent: live, cold: false }

  const persistence = state.ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('会话持久化未配置，无法唤醒目标会话')
  }
  const view = await readPersistedSession(persistence, targetId, signal)
  const ownEvents = view.events.slice(view.inheritedEventCount)
  const agentOptions = wakeOptions(state, ownEvents)

  const presets = state.ctx.get('agentPresets')
  const presetId = view.header.agentPreset
  const failure = failureProbe()
  const plainSetup = watchFirstFailure(targetId, failure)
  const presetSetup = presets !== undefined && presetId !== undefined
    ? async (agentCtx: Context): Promise<void> => {
      plainSetup(agentCtx)
      await presets.mount(agentCtx, presetId)
    }
    : undefined

  const attempts: (() => Promise<AgentHandle>)[] = []
  if (presetSetup !== undefined) {
    attempts.push(() => state.ctx.agents.resume({
      resumeSessionId: targetId,
      agentOptions,
      setup: presetSetup,
      signal,
    }))
  }
  attempts.push(() => state.ctx.agents.resume({
    resumeSessionId: targetId,
    agentOptions,
    setup: plainSetup,
    signal,
  }))

  let lastError: unknown
  for (const [index, attempt] of attempts.entries()) {
    try {
      const handle = await attempt()
      // 恢复可能在卸载/取消之后才返回：句柄一出现就释放，绝不留在集合里。
      if (signal.aborted) {
        await disposeHandle(state, handle)
        throw cancelledError()
      }
      const route = handle.agent.options
      if (route?.provider === undefined || route.provider === ''
        || route.model === undefined || route.model === '') {
        await disposeHandle(state, handle)
        throw new Error('恢复出的 Agent 没有 provider/model 路由，拒绝用会在首轮吞消息的实例投递')
      }
      state.handles.add(handle)
      if (signal.aborted) {
        state.handles.delete(handle)
        await disposeHandle(state, handle)
        throw cancelledError()
      }
      return { agent: handle.agent, handle, failure, cold: true }
    } catch (error) {
      // 取消不降级重试：下一次 resume 同样会被取消，只会多唤醒一个实例。
      if (signal.aborted) throw cancelledError()
      lastError = error
      state.log(`[session-messaging] 唤醒 ${targetId} 第 ${index + 1}/${attempts.length} 次尝试失败: ${messageOf(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 取消统一文案：门面 dispose 与调用方 abort 都走这里。 */
function cancelledError(): Error {
  return new Error('冷唤醒已取消（插件卸载或调用方中断）')
}

/**
 * 释放一次 acquire 的引用。
 *
 * 只有引用归零才摘掉首轮监听；`dispose` 为真且引用归零时才删除恢复记录并销毁
 * 本插件句柄——并发投递共享同一个实例，先结束的一方不能把它拆掉。
 * @param state - 网关共享状态。
 * @param entry - 唤醒结果里的恢复记录；在线目标没有记录时为 undefined。
 * @param dispose - 是否按「放弃恢复」语义销毁句柄（失败/未确认送达时为 true）。
 */
export async function release(
  state: WakeState,
  entry: ResumeEntry | undefined,
  dispose: boolean,
): Promise<void> {
  if (entry === undefined) return
  if (entry.refs > 0) entry.refs -= 1
  if (entry.refs > 0) return
  const failure = entry.failure
  if (failure !== undefined) {
    for (const off of failure.disposers) {
      if (typeof off === 'function') off()
    }
    delete entry.failure
  }
  if (!dispose) return
  if (state.resumes.get(entry.targetId) === entry) state.resumes.delete(entry.targetId)
  const handle = entry.handle
  if (handle === undefined) return
  delete entry.handle
  // 句柄已被门面 dispose() 统一释放过（集合已清空）时不再二次释放。
  if (!state.handles.delete(handle)) return
  await disposeHandle(state, handle)
}

/** 释放恢复句柄；失败只记录日志。 */
async function disposeHandle(state: WakeState, handle: AgentHandle): Promise<void> {
  try {
    await handle.dispose()
  } catch (error) {
    state.log(`[session-messaging] 释放恢复句柄失败: ${messageOf(error)}`)
  }
}
