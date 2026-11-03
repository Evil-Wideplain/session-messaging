/**
 * 冷唤醒的首轮失败探针（基础设施层）。
 *
 * 恢复出的 Agent 可能「醒来成功但首轮被吞」：prompt 组装失败只发 `agent/error`，
 * 归档门禁只在会话日志里以 `turn/end { reason: { kind: 'blocked' } }` 收口。
 * 两种信号都要抓，否则投递会误以为消息已送达（它其实没进历史）。
 *
 * @module dsh-plugin-session-messaging/infrastructure/delivery/failure-probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { WAKE_SETTLE_MS } from './shared.ts'
import type { WakeFailure } from './shared.ts'

/** 创建一个只会在首次错误时 resolve 的探针。 */
export function failureProbe(): WakeFailure {
  let resolve!: (error: Error) => void
  const promise = new Promise<Error | undefined>((done) => { resolve = done })
  return { promise, disposers: [], resolve }
}

/**
 * 在恢复上下文上挂监听，捕获首个失败信号。
 * @param targetId - 目标会话标识（过滤其它会话的 turn/end）。
 * @param failure - 要结束的探针。
 * @returns 传给 `ctx.agents.resume({ setup })` 的安装函数。
 */
export function watchFirstFailure(targetId: string, failure: WakeFailure): (agentCtx: Context) => void {
  return (agentCtx: Context): void => {
    // 宿主（或测试替身）可能不返回释放函数，只有函数才登记。
    const track = (off: () => unknown): void => {
      if (typeof off === 'function') failure.disposers.push(off)
    }
    track(agentCtx.on('agent/error', ({ error }) => {
      if (failure.error === undefined) failure.error = error
      failure.resolve(error)
    }))
    track(agentCtx.on('session/event', (session, event) => {
      if (session.id !== targetId) return
      const reason = (event.data as { readonly reason?: { readonly kind?: string } } | undefined)?.reason
      if (event.type !== 'turn/end' || reason?.kind !== 'blocked') return
      const blocked = new Error('目标会话被归档门禁拒绝（turn/end blocked），消息未进入历史')
      if (failure.error === undefined) failure.error = blocked
      failure.resolve(blocked)
    }))
  }
}

/**
 * 等待首轮错误，但最多等 `WAKE_SETTLE_MS`。
 * @param failure - 错误探针。
 * @returns 首个错误；窗口内没有错误时返回 undefined。
 */
export async function awaitFailure(failure: WakeFailure): Promise<Error | undefined> {
  return await Promise.race([
    failure.promise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), WAKE_SETTLE_MS)
      timer.unref?.()
    }),
  ])
}
