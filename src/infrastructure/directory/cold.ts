/**
 * 冷会话投影（基础设施层）。
 *
 * 冷会话没有在线 Agent，只能从持久化日志短读标题；标题按 30s 缓存，负结果
 * 同样缓存，避免失败读取在每次 list 里重放。批量读取用 `mapLimit` 限并发，
 * 保持候选顺序稳定。
 *
 * @module dsh-plugin-session-messaging/infrastructure/directory/cold
 */

import type { SessionHeader } from '../../types.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { isSubagentSession } from '../../domain/target.ts'
import { foldTitle, readPersistedSession } from '../persisted-session.ts'
import type { DirectoryState } from './shared.ts'
import { TITLE_TTL_MS } from './shared.ts'

/** 把一个持久化会话头投影成领域目标（标题可能来自缓存）。 */
export function coldTarget(header: SessionHeader, title: string | undefined): SessionTarget {
  return {
    id: header.id,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...title === undefined ? {} : { title },
    kind: isSubagentSession(header) ? 'subagent' : 'peer',
    status: 'offline',
  }
}

/**
 * 冷会话标题：带缓存的一次短读。
 * @param state - 目录共享状态。
 * @param id - 会话标识。
 * @param signal - 取消信号。
 * @returns 标题；没有持久化服务或读取失败时返回 undefined。
 */
export async function coldTitle(
  state: DirectoryState,
  id: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const cached = state.titles.get(id)
  if (cached !== undefined && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
  const persistence = state.ctx.get('sessionPersistence')
  if (persistence === undefined) {
    state.titles.set(id, { title: undefined, at: Date.now() })
    return undefined
  }
  let title: string | undefined
  try {
    const view = await readPersistedSession(persistence, id, signal)
    title = foldTitle(view.events)
  } catch {
    title = undefined
  }
  state.titles.set(id, { title, at: Date.now() })
  return title
}

/**
 * 有并发上限的 map：保持输入顺序返回结果。
 * @param items - 待处理项。
 * @param limit - 并发上限。
 * @param fn - 单项处理函数。
 * @returns 与输入等长的结果数组。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}
