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
 * 本文件只保留门面职责：持有上下文与标题缓存，把投影细节委托给 `directory/`
 * 子模块；公开方法签名不变。
 *
 * @module dsh-plugin-session-messaging/infrastructure/cordis-session-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Caller, SessionDirectory } from '../application/ports.ts'
import { identityOf } from '../domain/authorization.ts'
import type { SessionTarget } from '../domain/target.ts'
import { normalizeAddress, targetName, TargetAmbiguous, TargetNotFound } from '../domain/target.ts'
import { messageAccepted } from '../domain/message.ts'
import { readPersistedSession } from './persisted-session.ts'
import { archiveSnapshot, archivedReason, withArchive } from './directory/archive.ts'
import { coldTarget } from './directory/cold.ts'
import { candidates, liveTarget, liveTitle } from './directory/live.ts'
import type { CandidatesOptions, DirectoryState, TitleCacheEntry } from './directory/shared.ts'
import { teamRoster, teamTarget, withTeam } from './directory/team.ts'

/** Cordis 运行时到领域目标的适配器（门面）。 */
export class CordisSessionDirectory implements SessionDirectory {
  private readonly titles = new Map<string, TitleCacheEntry>()

  /**
   * @param ctx - 携带 agents / sessionQuery / sessionPersistence / sessionTitle / agentTeams 的上下文。
   */
  constructor(private readonly ctx: Context) {}

  /** @inheritdoc */
  async candidates(options: CandidatesOptions): Promise<SessionTarget[]> {
    return await candidates(this.state(), options)
  }

  /** @inheritdoc */
  async resolve(address: string, signal?: AbortSignal, caller?: Caller): Promise<SessionTarget> {
    const raw = address.trim()
    if (raw === '') throw new TargetNotFound(address)
    const state = this.state()
    const archive = archiveSnapshot(state)

    const liveAgent = state.ctx.agents.get(raw)
    if (liveAgent !== undefined) {
      return withArchive(state, withTeam(
        liveTarget(state, liveAgent),
        caller === undefined ? [] : teamRoster(state, caller),
      ), archive)
    }

    // 团队名册先解析：inactive 队友没有在线 Agent，也不一定在冷扫描窗口里。
    if (caller !== undefined) {
      const roster = teamRoster(state, caller)
      const wanted = normalizeAddress(raw)
      const byMember = roster.find(member => member.name === raw
        || member.id === raw
        || (wanted !== '' && normalizeAddress(member.name) === wanted))
      if (byMember !== undefined && byMember.id !== caller.identity.id) {
        return teamTarget(byMember, archive)
      }
    }

    const targets = await this.candidates({
      includeCold: true,
      ...signal === undefined ? {} : { signal },
      ...caller === undefined ? {} : { caller },
    })
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
    const state = this.state()
    const archive = archiveSnapshot(state)
    const live = state.ctx.agents.get(id)
    if (live !== undefined) return withArchive(state, liveTarget(state, live), archive)
    const query = state.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    let records
    try {
      records = await query.listSessions(signal)
    } catch {
      return undefined
    }
    const record = records.find(row => row.header.id === id)
    if (record === undefined) return undefined
    return withArchive(state, coldTarget(record.header, state.titles.get(id)?.title), archive)
  }

  /** @inheritdoc */
  teamMemberName(caller: Caller, target: SessionTarget): string | undefined {
    if (target.teamMemberName !== undefined) return target.teamMemberName
    const member = teamRoster(this.state(), caller).find(row => row.id === target.id)
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
    const state = this.state()
    const agent = state.ctx.agents.get(id)
    if (agent === undefined) return undefined
    return liveTitle(state, agent)
  }

  /** @inheritdoc */
  async hasDelivered(id: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
    const state = this.state()
    const live = state.ctx.agents.get(id)
    if (live !== undefined) {
      return messageAccepted(live.session.ownEvents(), messageId)
    }
    const persistence = state.ctx.get('sessionPersistence')
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
    return archiveSnapshot(this.state()).known
  }

  /** @inheritdoc */
  archivedReason(target: SessionTarget): string | undefined {
    return archivedReason(this.state(), target)
  }

  /** 目录共享状态：上下文 + 标题缓存（传的是同一份 Map 引用）。 */
  private state(): DirectoryState {
    return { ctx: this.ctx, titles: this.titles }
  }
}
