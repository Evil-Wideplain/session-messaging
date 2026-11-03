/**
 * 团队名册投影（基础设施层）。
 *
 * 团队名册查询放基础设施层：它是「这个会话和那个目标是什么关系」的运行时事实，
 * 领域层只消费事实，不碰 Cordis 服务。名册里的 inactive 队友即使没有加载也会
 * 成为可寻址目标，由 team mailbox 冷恢复。
 *
 * @module session-messaging/infrastructure/directory/team
 */

import type { Caller } from '../../application/ports.ts'
import type { SessionTarget } from '../../domain/target.ts'
import type { TeamMemberView } from '../../types.ts'
import type { ArchiveSnapshot } from './archive.ts'
import type { DirectoryState } from './shared.ts'

/** 调用方所在团队的完整名册；不是团队成员时返回空数组。 */
export function teamRoster(state: DirectoryState, caller: Caller): readonly TeamMemberView[] {
  const teams = state.ctx.get('agentTeams')
  if (teams === undefined) return []
  try {
    if (teams.membership(caller.agent) === undefined) return []
    return teams.listMembers(caller.agent)
  } catch {
    return []
  }
}

/** 把团队名册事实附加到目标上（kind / teamMemberName / 显示名）。 */
export function withTeam(target: SessionTarget, roster: readonly TeamMemberView[]): SessionTarget {
  const member = roster.find(row => row.id === target.id)
  if (member === undefined) return target
  return {
    ...target,
    kind: member.role === 'lead' ? 'peer' : 'teammate',
    teamMemberName: member.name,
    name: member.name,
    ...member.status === 'running' ? { status: 'running' as const } : {},
  }
}

/**
 * 把名册成员投影成目标（没有在线 Agent 时状态为 offline）。
 *
 * 不伪造 cwd：名册只给出身份，不给出工作目录。硬填调用方的 cwd 会让列表把
 * 队友显示成「同 workspace 且可发送」，而真实归属未知。
 * @param member - 名册成员。
 * @param archive - 已读到的归档集合快照。
 * @returns 名册成员对应的领域目标。
 */
export function teamTarget(member: TeamMemberView, archive: ArchiveSnapshot): SessionTarget {
  return {
    id: member.id,
    teamMemberName: member.name,
    name: member.name,
    kind: member.role === 'lead' ? 'peer' : 'teammate',
    status: member.status === 'running' ? 'running' : 'offline',
    ...archive.ids.has(member.id) ? { archived: true } : {},
  }
}

/** 补上名册里尚未出现在候选中的成员（inactive 队友、未加载的 Lead）。 */
export function appendRosterOnly(
  targets: SessionTarget[],
  roster: readonly TeamMemberView[],
  caller: Caller | undefined,
  archive: ArchiveSnapshot,
): void {
  if (caller === undefined) return
  const known = new Set(targets.map(target => target.id))
  for (const member of roster) {
    if (member.id === caller.identity.id) continue
    if (known.has(member.id)) continue
    known.add(member.id)
    targets.push(teamTarget(member, archive))
  }
}
