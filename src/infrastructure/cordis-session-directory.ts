/**
 * Cordis 会话目录（基础设施层实现）。
 *
 * 把运行时的四类信息——在线 Agent 注册表、冷会话查询、持久化短读、团队名册——
 * 投影成领域目标 `SessionTarget`。标题按 30s 缓存，冷会话扫描有上限并限并发，
 * 避免 list 变成全量日志扫描。
 *
 * 团队名册查询也放这里：它是「这个会话和那个目标是什么关系」的运行时事实，
 * 领域层只消费事实，不碰 Cordis 服务。名册里的 inactive 队友即使没有加载也会
 * 成为可寻址目标，由 team mailbox 冷恢复。
 *
 * 归档状态来自 `workspaceRegistry`。读不到注册表时返回「未知」而不是空集合：
 * 把未知当空会让归档预检静默失效，唤醒归档会话即丢消息。
 *
 * @module dsh-plugin-session-messaging/infrastructure/cordis-session-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionHeader, TeamMemberView, WorkspaceRegistryService } from '../types.ts'
import type { SessionDirectory } from '../application/ports.ts'
import type { Caller } from '../application/ports.ts'
import { identityOf } from '../domain/authorization.ts'
import type { SessionTarget } from '../domain/target.ts'
import {
  isSubagentSession,
  normalizeAddress,
  targetName,
  TargetAmbiguous,
  TargetNotFound,
} from '../domain/target.ts'
import { messageAccepted } from '../domain/message.ts'
import { foldTitle, readPersistedSession } from './persisted-session.ts'

/** 标题缓存时长：`/rename` 随时可能改标题，因此只缓存很短时间。 */
const TITLE_TTL_MS = 30_000

/** 冷会话标题并发读取上限：串行读 200 份日志会让一次 send 卡到几十秒。 */
const COLD_READ_CONCURRENCY = 8

/** 归档集合快照；`known=false` 表示运行时没有可用的 Workspace 注册表。 */
interface ArchiveSnapshot {
  readonly known: boolean
  readonly ids: ReadonlySet<string>
}

/** Cordis 运行时到领域目标的适配器。 */
export class CordisSessionDirectory implements SessionDirectory {
  private readonly titleCache = new Map<string, { title: string | undefined; at: number }>()

  /**
   * @param ctx - 携带 agents / sessionQuery / sessionPersistence / sessionTitle / agentTeams 的上下文。
   */
  constructor(private readonly ctx: Context) {}

  /** @inheritdoc */
  async candidates(options: {
    readonly includeCold: boolean
    readonly coldLimit?: number
    readonly signal?: AbortSignal
    readonly caller?: Caller
  }): Promise<SessionTarget[]> {
    const roster = options.caller === undefined ? [] : this.teamRoster(options.caller)
    const archive = this.archiveSnapshot()
    const targets: SessionTarget[] = []
    for (const agent of this.ctx.agents.list()) {
      targets.push(this.withArchive(this.withTeam(this.liveTarget(agent), roster), archive))
    }
    if (!options.includeCold) {
      this.appendRosterOnly(targets, roster, options.caller, archive)
      return targets
    }

    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      this.appendRosterOnly(targets, roster, options.caller, archive)
      return targets
    }
    let records
    try {
      records = await query.listSessions(options.signal)
    } catch {
      this.appendRosterOnly(targets, roster, options.caller, archive)
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
      header => this.coldTitle(header.id, options.signal))
    coldHeaders.forEach((header, index) => {
      const title = titles[index]
      targets.push(this.withArchive(this.withTeam(this.coldTarget(header, title), roster), archive))
    })
    this.appendRosterOnly(targets, roster, options.caller, archive)
    return targets
  }

  /** @inheritdoc */
  async resolve(address: string, signal?: AbortSignal, caller?: Caller): Promise<SessionTarget> {
    const raw = address.trim()
    if (raw === '') throw new TargetNotFound(address)
    const archive = this.archiveSnapshot()

    const liveAgent = this.ctx.agents.get(raw)
    if (liveAgent !== undefined) {
      return this.withArchive(this.withTeam(
        this.liveTarget(liveAgent),
        caller === undefined ? [] : this.teamRoster(caller),
      ), archive)
    }

    // 团队名册先解析：inactive 队友没有在线 Agent，也不一定在冷扫描窗口里。
    if (caller !== undefined) {
      const roster = this.teamRoster(caller)
      const wanted = normalizeAddress(raw)
      const byMember = roster.find(member => member.name === raw
        || member.id === raw
        || (wanted !== '' && normalizeAddress(member.name) === wanted))
      if (byMember !== undefined && byMember.id !== caller.identity.id) {
        return this.teamTarget(byMember, archive)
      }
    }

    const targets = await this.candidates({ includeCold: true, ...signal === undefined ? {} : { signal }, ...caller === undefined ? {} : { caller } })
    const wanted = normalizeAddress(raw)
    if (wanted === '') throw new TargetNotFound(address)

    const byId = targets.find(target => target.id === raw)
    if (byId !== undefined) return byId

    const matches = targets.filter(target =>
      normalizeAddress(targetName(target)) === wanted
      || (target.teamMemberName !== undefined && normalizeAddress(target.teamMemberName) === wanted))
    const first = matches[0]
    if (first === undefined) throw new TargetNotFound(address)
    if (matches.length > 1) throw new TargetAmbiguous(address, matches)
    return first
  }

  /**
   * @inheritdoc
   *
   * 走「精确 id」快路径：只按 id 在语料里定位，不读标题、不做全量冷扫描。
   * 审批路径每次接受消息都要查发送方，用 resolve() 会把一次 review 变成 N 次
   * 200 会话扫描。
   */
  async findById(id: string, signal?: AbortSignal): Promise<SessionTarget | undefined> {
    const archive = this.archiveSnapshot()
    const live = this.ctx.agents.get(id)
    if (live !== undefined) return this.withArchive(this.liveTarget(live), archive)
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    let records
    try {
      records = await query.listSessions(signal)
    } catch {
      return undefined
    }
    const record = records.find(row => row.header.id === id)
    if (record === undefined) return undefined
    return this.withArchive(this.coldTarget(record.header, this.titleCache.get(id)?.title), archive)
  }

  /** @inheritdoc */
  teamMemberName(caller: Caller, target: SessionTarget): string | undefined {
    if (target.teamMemberName !== undefined) return target.teamMemberName
    const member = this.teamRoster(caller).find(row => row.id === target.id)
    return member?.name
  }

  /** @inheritdoc */
  teamMemberNameById(agentId: string, target: SessionTarget): string | undefined {
    const agent = this.ctx.agents.get(agentId)
    if (agent === undefined) return undefined
    return this.teamMemberName({ agent, identity: identityOf(agent) }, target)
  }

  /** @inheritdoc */
  titleOf(id: string): string | undefined {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) return undefined
    return this.liveTitle(agent)
  }

  /** @inheritdoc */
  async hasDelivered(id: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
    const live = this.ctx.agents.get(id)
    if (live !== undefined) {
      return messageAccepted(live.session.ownEvents(), messageId)
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    try {
      const view = await readPersistedSession(persistence, id, signal)
      return messageAccepted(view.events.slice(view.inheritedEventCount), messageId)
    } catch {
      return false
    }
  }

  /** @inheritdoc */
  archiveStateKnown(): boolean {
    return this.archiveSnapshot().known
  }

  /** 调用方所在团队的完整名册；不是团队成员时返回空数组。 */
  private teamRoster(caller: Caller): readonly TeamMemberView[] {
    const teams = this.ctx.get('agentTeams')
    if (teams === undefined) return []
    try {
      if (teams.membership(caller.agent) === undefined) return []
      return teams.listMembers(caller.agent)
    } catch {
      return []
    }
  }

  /** 把团队名册事实附加到目标上（kind / teamMemberName / 显示名）。 */
  private withTeam(target: SessionTarget, roster: readonly TeamMemberView[]): SessionTarget {
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
   * 读取当前归档集合。
   *
   * 没有 Workspace 服务时返回「已知为空」：归档门禁由该服务提供，服务不在就没有
   * 门禁可绕；读取抛错则返回 `known=false`（真正无法判定）。两者不能混为一谈——
   * 把「读失败」当「没有归档」会让归档预检静默变成 no-op，唤醒即丢消息。
   */
  private archiveSnapshot(): ArchiveSnapshot {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
    if (registry === undefined) return { known: true, ids: new Set() }
    try {
      return { known: true, ids: new Set(registry.archivedSessionIds) }
    } catch (error) {
      this.ctx.logger?.warn?.(`[session-messaging] 读取归档集合失败: ${String(error)}`)
      return { known: false, ids: new Set() }
    }
  }

  /** 给目标补上归档标记（归档会话仍可解析，但投递必须被拒）。 */
  private withArchive(target: SessionTarget, archive: ArchiveSnapshot): SessionTarget {
    return this.archiveReasonOf(target, archive.ids) === undefined ? target : { ...target, archived: true }
  }

  /** @inheritdoc */
  archivedReason(target: SessionTarget): string | undefined {
    return this.archiveReasonOf(target, this.archiveSnapshot().ids)
  }

  /**
   * 按已读到的归档集合判断目标是否处于归档门禁之下。
   * @param target - 目标会话。
   * @param archived - 已归档会话 id 集合。
   * @returns 面向模型的拒绝原因；未归档返回 undefined。
   */
  private archiveReasonOf(target: SessionTarget, archived: ReadonlySet<string>): string | undefined {
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
      const parent: SessionHeader | undefined = this.ctx.sessions.get(parentId)?.header
      if (parent === undefined) return undefined
      if (parent.origin !== 'subagent' || parent.parentSession === undefined) return undefined
      parentId = parent.parentSession
    }
    return undefined
  }

  /**
   * 把名册成员投影成目标（没有在线 Agent 时状态为 offline）。
   *
   * 不伪造 cwd：名册只给出身份，不给出工作目录。硬填调用方的 cwd 会让列表把
   * 队友显示成「同 workspace 且可发送」，而真实归属未知。
   */
  private teamTarget(member: TeamMemberView, archive: ArchiveSnapshot): SessionTarget {
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
  private appendRosterOnly(
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
      targets.push(this.teamTarget(member, archive))
    }
  }

  /** 把在线 Agent 投影成领域目标。 */
  private liveTarget(agent: Agent): SessionTarget {
    const header = agent.session.header
    const title = this.liveTitle(agent)
    return {
      id: agent.id,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
      ...title === undefined ? {} : { title },
      kind: isSubagentSession(header) ? 'subagent' : 'peer',
      status: agent.status,
    }
  }

  /** 把一个持久化会话头投影成领域目标（标题可能来自缓存）。 */
  private coldTarget(header: SessionHeader, title: string | undefined): SessionTarget {
    return {
      id: header.id,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
      ...title === undefined ? {} : { title },
      kind: isSubagentSession(header) ? 'subagent' : 'peer',
      status: 'offline',
    }
  }

  /** 在线会话的实时标题。 */
  private liveTitle(agent: Agent): string | undefined {
    const service = this.ctx.get('sessionTitle')
    if (service === undefined) return undefined
    try {
      return service.get(agent.session)?.title
    } catch {
      return undefined
    }
  }

  /** 冷会话标题：带缓存的一次短读。 */
  private async coldTitle(id: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const cached = this.titleCache.get(id)
    if (cached !== undefined && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.titleCache.set(id, { title: undefined, at: Date.now() })
      return undefined
    }
    let title: string | undefined
    try {
      const view = await readPersistedSession(persistence, id, signal)
      title = foldTitle(view.events)
    } catch {
      title = undefined
    }
    this.titleCache.set(id, { title, at: Date.now() })
    return title
  }
}

/**
 * 有并发上限的 map：保持输入顺序返回结果。
 * @param items - 待处理项。
 * @param limit - 并发上限。
 * @param fn - 单项处理函数。
 * @returns 与输入等长的结果数组。
 */
async function mapLimit<T, R>(
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
