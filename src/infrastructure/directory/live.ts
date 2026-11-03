/**
 * 在线会话与候选列表投影（基础设施层）。
 *
 * 在线 Agent 注册表直接投影成目标；候选列表把在线目标、冷会话与团队名册合并
 * 成一份去重后的列表。冷会话先收集待补标题的会话头，再限并发读标题：保持候选
 * 顺序稳定的同时把串行 200 次整日志读压到 8 路并发。
 *
 * @module session-messaging/infrastructure/directory/live
 */

import type { Agent, SessionHeader } from '../../types.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { isSubagentSession } from '../../domain/target.ts'
import { archiveSnapshot, withArchive } from './archive.ts'
import { coldTarget, coldTitle, mapLimit } from './cold.ts'
import type { CandidatesOptions, DirectoryState } from './shared.ts'
import { COLD_READ_CONCURRENCY } from './shared.ts'
import { appendRosterOnly, teamRoster, withTeam } from './team.ts'

/** 在线会话的实时标题。 */
export function liveTitle(state: DirectoryState, agent: Agent): string | undefined {
  const service = state.ctx.get('sessionTitle')
  if (service === undefined) return undefined
  try {
    return service.get(agent.session)?.title
  } catch {
    return undefined
  }
}

/** 把在线 Agent 投影成领域目标。 */
export function liveTarget(state: DirectoryState, agent: Agent): SessionTarget {
  const header = agent.session.header
  const title = liveTitle(state, agent)
  return {
    id: agent.id,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...title === undefined ? {} : { title },
    kind: isSubagentSession(header) ? 'subagent' : 'peer',
    status: agent.status,
  }
}

/**
 * 列出候选会话（含冷会话；带 caller 时补上团队名册里的 inactive 队友）。
 * @param state - 目录共享状态。
 * @param options - 枚举选项。
 * @returns 候选目标列表（在线在前，冷会话按语料顺序）。
 */
export async function candidates(
  state: DirectoryState,
  options: CandidatesOptions,
): Promise<SessionTarget[]> {
  const roster = options.caller === undefined ? [] : teamRoster(state, options.caller)
  const archive = archiveSnapshot(state)
  const targets: SessionTarget[] = []
  for (const agent of state.ctx.agents.list()) {
    targets.push(withArchive(state, withTeam(liveTarget(state, agent), roster), archive))
  }
  if (!options.includeCold) {
    appendRosterOnly(targets, roster, options.caller, archive)
    return targets
  }

  const query = state.ctx.get('sessionQuery')
  if (query === undefined) {
    appendRosterOnly(targets, roster, options.caller, archive)
    return targets
  }
  let records
  try {
    records = await query.listSessions(options.signal)
  } catch {
    appendRosterOnly(targets, roster, options.caller, archive)
    return targets
  }
  const liveIds = new Set(targets.map(target => target.id))
  const coldLimit = options.coldLimit ?? 200
  // 先收集待补标题的冷会话头，再限并发读取：保持候选顺序稳定的同时把串行
  // 200 次整日志读压到 8 路并发。
  const coldHeaders: SessionHeader[] = []
  for (const record of records) {
    if (coldHeaders.length >= coldLimit) break
    if (record.live || liveIds.has(record.header.id)) continue
    // cwd 缺失的会话也保留：由授权层按「workspace 未知」处理并计入 omitted，
    // 而不是在这里静默消失（否则被隐藏的会话数永远对不上）。
    coldHeaders.push(record.header)
  }
  const titles = await mapLimit(coldHeaders, COLD_READ_CONCURRENCY,
    header => coldTitle(state, header.id, options.signal))
  coldHeaders.forEach((header, index) => {
    const title = titles[index]
    targets.push(withArchive(state, withTeam(coldTarget(header, title), roster), archive))
  })
  appendRosterOnly(targets, roster, options.caller, archive)
  return targets
}
