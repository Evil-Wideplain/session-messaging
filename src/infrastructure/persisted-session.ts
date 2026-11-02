/**
 * 冷会话短读（基础设施层）。
 *
 * 通过 `SessionPersistenceService` 打开只读句柄，读出会话头与完整事件日志，
 * 再折叠出标题、模型路由等恢复所需信息。这里只做读取，不做缓存。
 *
 * @module dsh-plugin-session-messaging/infrastructure/persisted-session
 */

import type { SessionEvent, SessionHeader, SessionPersistenceService } from '../types.ts'

/** 一个持久化会话的独立视图。 */
export interface PersistedSessionView {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}

/**
 * 读取一个已存会话的头部与完整事件日志。
 *
 * 宿主 `SessionHandle.read()` 的返回值是 `{ eventState, events }`（0.2.x 契约），
 * 早期插件把它当纯数组使用，导致 `foldAgentOptions`/`foldTitle` 静默得到空结果。
 * 这里同时接受两种形状，避免跨宿主版本再次踩坑。
 * @param persistence - 持久化服务。
 * @param id - 会话标识。
 * @param signal - 打开与读取的取消信号。
 * @returns 头部与全部已提交事件。
 */
export async function readPersistedSession(
  persistence: SessionPersistenceService,
  id: string,
  signal?: AbortSignal,
): Promise<PersistedSessionView> {
  const handle = await persistence.open(id, 'read', signal === undefined ? {} : { signal })
  try {
    const read = await handle.read(0, undefined, signal === undefined ? {} : { signal })
    const events = Array.isArray(read)
      ? read
      : (read as { readonly events?: readonly SessionEvent[] }).events ?? []
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  } finally {
    await handle.close()
  }
}

/**
 * 取事件日志里最后一个标题。
 * @param events - 事件日志。
 * @returns 修剪后的标题；没有标题时返回 undefined。
 */
export function foldTitle(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'session/title') continue
    const data = event.data as { title?: unknown } | null
    if (data === null || typeof data !== 'object') continue
    const title = data.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  return undefined
}

/**
 * 取最后一次模型请求的路由配置。
 *
 * 恢复的 Agent 默认没有模型路由；复用历史里的 provider/model 可以让被唤醒的
 * 冷会话继续用它原本的模型，而不是掉到宿主默认。
 * @param events - 持久化事件日志。
 * @returns Agent 选项；没有记录时返回空对象。
 */
export function foldAgentOptions(events: readonly SessionEvent[]): Record<string, unknown> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'request/header') continue
    const data = event.data as { header?: { config?: Record<string, unknown> } } | null
    const config = data?.header?.config
    if (config === undefined || config === null) continue
    const provider = config['provider']
    const model = config['model']
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') continue
    return {
      provider,
      model,
      ...typeof config['reasoningEffort'] === 'string' ? { reasoningEffort: config['reasoningEffort'] } : {},
      ...typeof config['maxTokens'] === 'number' ? { maxTokens: config['maxTokens'] } : {},
    }
  }
  return {}
}
