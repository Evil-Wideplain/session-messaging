/**
 * `list` 用例：列出调用方有权访问的会话。
 *
 * 归档会话、他人的子代理（未显式要求时）与无投递授权的会话都计入 `omitted`；
 * 排序权重 running → idle → offline，同权重按显示名排序，超出的行计入
 * `truncated`。
 *
 * @module dsh-plugin-session-messaging/application/messaging/list
 */

import type { SessionTarget } from '../../domain/target.ts'
import { targetName } from '../../domain/target.ts'
import type { ListResult } from '../dto.ts'
import type { Caller } from '../ports.ts'
import { mayDeliver, teammateOf } from './auth.ts'
import type { MessagingContext } from './deps.ts'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from './deps.ts'
import { statusRank, toListRow } from './rows.ts'

/** 参与排序与截断的候选行。 */
interface Candidate {
  readonly target: SessionTarget
  readonly teammate: string | undefined
  readonly sendable: boolean
}

/**
 * 列出调用方有权访问的会话。
 * @param ctx - 用例上下文。
 * @param caller - 运行时验证过的调用方。
 * @param options - 是否包含子代理、返回上限、取消信号。
 * @returns 允许访问的行，以及被隐藏的可达会话数量。
 */
export async function listSessions(
  ctx: MessagingContext,
  caller: Caller,
  options: { readonly includeSubagents: boolean; readonly limit?: number; readonly signal?: AbortSignal },
): Promise<ListResult> {
  const limit = Math.min(Math.max(options.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT)
  const rows = await ctx.directory.candidates({
    includeCold: true,
    caller,
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  const permitted: Candidate[] = []
  let omitted = 0
  for (const target of rows) {
    if (target.id === caller.identity.id) continue
    // 归档会话不可投递：列出它只会诱导无效发送，直接从候选里隐藏。
    if (target.archived === true) {
      omitted += 1
      continue
    }
    const teammate = teammateOf(ctx, caller, target)
    const ownSubagent = target.kind === 'subagent' && target.parentSession === caller.identity.id
    const foreignSubagent = target.kind === 'subagent' && !ownSubagent
    if (foreignSubagent) {
      if (!options.includeSubagents) {
        omitted += 1
        continue
      }
      // 显式要求时才列出其他会话的子代理，并标注不可发送（授权矩阵不允许）。
      permitted.push({ target, teammate, sendable: false })
      continue
    }
    if (!mayDeliver(ctx, caller, target, teammate)) {
      omitted += 1
      continue
    }
    permitted.push({ target, teammate, sendable: true })
  }
  permitted.sort((left, right) => {
    const byState = statusRank(left.target) - statusRank(right.target)
    if (byState !== 0) return byState
    return targetName(left.target).localeCompare(targetName(right.target))
  })
  const visible = permitted.slice(0, limit)
  return {
    agents: visible.map(entry => toListRow(
      ctx,
      caller,
      entry.target,
      entry.teammate !== undefined,
      entry.sendable,
    )),
    omitted,
    truncated: permitted.length - visible.length,
  }
}
