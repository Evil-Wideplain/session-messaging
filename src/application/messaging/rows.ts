/**
 * 应用层 DTO 投影：把领域目标与挂起消息翻成工具/总线返回行，以及列表排序权重。
 *
 * 只做字段重命名与派生（short id、workspace 关系、state）、排序权重与统一回包，
 * 不做授权判定。
 *
 * @module session-messaging/application/messaging/rows
 */

import type { HeldMessage } from '../../domain/held-message.ts'
import { sameCwd } from '../../domain/authorization.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { shortIdOf, targetName } from '../../domain/target.ts'
import type { HeldRow, ListRow, SendResult } from '../dto.ts'
import type { Caller } from '../ports.ts'
import type { MessagingContext } from './deps.ts'
import { PREVIEW_CHARS } from './deps.ts'

/** 「没有这个会话」的统一回包：未授权目标也用它，避免暴露会话是否存在。 */
export function notFoundOf(address: string, messageId: string): SendResult {
  return { status: 'not_found', messageId, detail: `没有匹配 "${address}" 的会话` }
}

/** 列表排序权重：running、idle、offline。 */
export function statusRank(target: SessionTarget): number {
  return target.status === 'running' ? 0 : target.status === 'idle' ? 1 : 2
}

/**
 * 把目标投影成工具返回行。
 * @param ctx - 用例上下文（读取路径大小写策略）。
 * @param caller - 调用方（提供自己的 cwd 用于 workspace 关系判断）。
 * @param target - 目标会话。
 * @param isTeammate - 目标是否为调用方团队的成员。
 * @param sendable - 是否允许投递。
 * @returns `list_session_agents` 的一行。
 */
export function toListRow(
  ctx: MessagingContext,
  caller: Caller,
  target: SessionTarget,
  isTeammate: boolean,
  sendable: boolean,
): ListRow {
  const workspace = caller.identity.cwd === undefined || target.cwd === undefined
    ? 'unknown'
    : sameCwd(caller.identity.cwd, target.cwd, ctx.config.pathCaseInsensitive) ? 'same' : 'different'
  return {
    name: targetName(target),
    id: target.id,
    shortId: shortIdOf(target.id),
    cwd: target.cwd ?? '',
    workspace,
    state: target.status,
    kind: isTeammate ? 'teammate' : target.kind,
    sendable,
  }
}

/**
 * 把挂起消息投影成审批返回值。
 * @param entry - 入站账本里的挂起条目。
 * @returns 呈现给目标的一行。
 */
export function toHeldRow(entry: HeldMessage): HeldRow {
  return {
    messageId: entry.messageId,
    sender: entry.senderName,
    senderId: entry.senderId,
    summary: entry.summary ?? '',
    preview: entry.text.length > PREVIEW_CHARS ? `${entry.text.slice(0, PREVIEW_CHARS)}…` : entry.text,
    createdAt: entry.at,
    expiresAt: entry.expiresAt,
  }
}
