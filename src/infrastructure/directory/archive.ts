/**
 * 归档状态投影（基础设施层）。
 *
 * 归档状态来自 `workspaceRegistry`。读不到注册表时返回「未知」而不是空集合：
 * 把未知当空会让归档预检静默失效，唤醒归档会话即丢消息。归档门禁按会话血缘
 * 生效，因此子代理要一路向上查到根，而不只看直接父级。
 *
 * @module dsh-plugin-session-messaging/infrastructure/directory/archive
 */

import type { SessionHeader, WorkspaceRegistryService } from '../../types.ts'
import type { SessionTarget } from '../../domain/target.ts'
import type { DirectoryState } from './shared.ts'

/** 归档集合快照；`known=false` 表示运行时没有可用的 Workspace 注册表。 */
export interface ArchiveSnapshot {
  /** 归档集合是否可判定。 */
  readonly known: boolean
  /** 已归档的会话 id。 */
  readonly ids: ReadonlySet<string>
}

/**
 * 读取当前归档集合。
 *
 * 没有 Workspace 服务时返回「已知为空」：归档门禁由该服务提供，服务不在就没有
 * 门禁可绕；读取抛错则返回 `known=false`（真正无法判定）。两者不能混为一谈——
 * 把「读失败」当「没有归档」会让归档预检静默变成 no-op，唤醒即丢消息。
 * @param state - 目录共享状态。
 * @returns 归档集合快照。
 */
export function archiveSnapshot(state: DirectoryState): ArchiveSnapshot {
  const registry = state.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  if (registry === undefined) return { known: true, ids: new Set() }
  try {
    return { known: true, ids: new Set(registry.archivedSessionIds) }
  } catch (error) {
    state.ctx.logger?.warn?.(`[session-messaging] 读取归档集合失败: ${String(error)}`)
    return { known: false, ids: new Set() }
  }
}

/**
 * 给目标补上归档标记（归档会话仍可解析，但投递必须被拒）。
 * @param state - 目录共享状态。
 * @param target - 目标会话。
 * @param archive - 已读到的归档集合快照。
 * @returns 归档时带上 `archived: true` 的目标。
 */
export function withArchive(
  state: DirectoryState,
  target: SessionTarget,
  archive: ArchiveSnapshot,
): SessionTarget {
  return archiveReasonOf(state, target, archive.ids) === undefined ? target : { ...target, archived: true }
}

/**
 * 目标处于归档门禁之下的原因。
 * @param state - 目录共享状态。
 * @param target - 目标会话。
 * @returns 面向模型的拒绝原因；未归档返回 undefined。
 */
export function archivedReason(state: DirectoryState, target: SessionTarget): string | undefined {
  return archiveReasonOf(state, target, archiveSnapshot(state).ids)
}

/**
 * 按已读到的归档集合判断目标是否处于归档门禁之下。
 * @param state - 目录共享状态。
 * @param target - 目标会话。
 * @param archived - 已归档会话 id 集合。
 * @returns 面向模型的拒绝原因；未归档返回 undefined。
 */
export function archiveReasonOf(
  state: DirectoryState,
  target: SessionTarget,
  archived: ReadonlySet<string>,
): string | undefined {
  if (archived.has(target.id)) {
    return `目标会话已归档（${target.id}）：DSH 的归档门禁会拒绝它的模型 step，`
      + '唤醒投递会被 blocked 收口并丢消息；请先取消归档再发送'
  }
  if (target.kind !== 'subagent' || target.parentSession === undefined) return undefined
  // 子代理血脉要一路向上查到根：归档门禁按会话血缘生效，不只是直接父级。
  let parentId: string | undefined = target.parentSession
  const visited = new Set<string>()
  while (parentId !== undefined && !visited.has(parentId)) {
    if (archived.has(parentId)) {
      return `目标子代理属于已归档会话（${parentId}）：归档门禁同样拒绝它的模型 step，请先取消归档再发送`
    }
    visited.add(parentId)
    const parent: SessionHeader | undefined = state.ctx.sessions.get(parentId)?.header
    if (parent === undefined) return undefined
    if (parent.origin !== 'subagent' || parent.parentSession === undefined) return undefined
    parentId = parent.parentSession
  }
  return undefined
}
