/**
 * 跨会话消息应用服务（用例编排）。
 *
 * 只依赖端口接口：会话目录、出站/入站账本、投递网关。领域规则（授权、路由、
 * 消息构造、送达判定、挂起策略）全部委托给 `domain/`，本层负责把用例串起来：
 *
 * - `list`：列出调用方有权访问的会话；
 * - `send`：校验 → 解析 → 授权 → 策略 → 限额/去重 → 挂起或投递；
 * - `review`：目标侧审批（列出/接受/拒绝），接受时重新授权再投递；
 * - `recover`：会话启动时重放未确认出站消息、惰性过期入站挂起。
 *
 * @module dsh-plugin-session-messaging/application/messaging-service
 */

import { createHash, randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.ts'
import type { CallerIdentity } from '../domain/authorization.ts'
import type { Agent } from '../types.ts'
import { authorize, identityOf, sameCwd } from '../domain/authorization.ts'
import type { SessionTarget } from '../domain/target.ts'
import { displayName, targetName, TargetAmbiguous, TargetNotFound } from '../domain/target.ts'
import type { OutboxEntry } from '../domain/outbox.ts'
import type { HeldMessage } from '../domain/held-message.ts'
import { holdDeadline, capacityOverflow } from '../domain/inbound-policy.ts'
import { relayMessage } from '../domain/message.ts'
import type { DeliveryGateway, DeliverySenderFacts, InboundRepository, OutboxRepository, SessionDirectory } from './ports.ts'
import type { Caller } from './ports.ts'
import type {
  HeldRow,
  ListResult,
  ListRow,
  ReviewAction,
  ReviewOutcome,
  ReviewResult,
  SendInput,
  SendResult,
} from './dto.ts'
import { DuplicateWindow, RateLimiter } from './guards.ts'

/** 应用服务依赖（由组合根装配）。 */
export interface MessagingDependencies {
  /** 有效配置。 */
  readonly config: ResolvedConfig
  /** 按发送方取（或创建）出站账本。 */
  readonly outbox: (senderId: string) => OutboxRepository
  /** 按目标取（或创建）入站账本。 */
  readonly inbound: (targetId: string) => InboundRepository
  /** 会话目录。 */
  readonly directory: SessionDirectory
  /** 投递网关。 */
  readonly gateway: DeliveryGateway
  /** 可选日志出口（默认静默，便于测试）。 */
  readonly log?: (message: string) => void
}

const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200
const RATE_WINDOW_MS = 60_000
const PREVIEW_CHARS = 4_000

/**
 * 跨会话消息应用服务。
 */
export class MessagingService {
  private readonly config: ResolvedConfig
  private readonly outbox: (senderId: string) => OutboxRepository
  private readonly inbound: (targetId: string) => InboundRepository
  private readonly directory: SessionDirectory
  private readonly gateway: DeliveryGateway
  private readonly log: (message: string) => void
  private readonly rateLimiter = new RateLimiter(RATE_WINDOW_MS)
  private readonly duplicates: DuplicateWindow
  private readonly notices = new Map<string, number>()
  private readonly recoveries = new Map<string, Promise<void>>()

  /**
   * 已过期但尚未向目标报告的消息。
   *
   * 过期现在可能在目标会话启动的 `recover` 里先发生（会话启动即惰性过期），
   * 若只把结果返回给当次调用，目标之后 `review` 时就看不到这些消息了。
   * 这里按目标暂存一次，下一次 `review` 报告后清空。
   */
  private readonly expiryOutcomes = new Map<string, ReviewOutcome[]>()

  /**
   * @param dependencies - 端口实现与有效配置。
   */
  constructor(dependencies: MessagingDependencies) {
    this.config = dependencies.config
    this.outbox = dependencies.outbox
    this.inbound = dependencies.inbound
    this.directory = dependencies.directory
    this.gateway = dependencies.gateway
    this.log = dependencies.log ?? (() => {})
    this.duplicates = new DuplicateWindow(this.config.dedupeWindowMs)
  }

  /**
   * 列出调用方有权访问的会话。
   * @param caller - 运行时验证过的调用方。
   * @param options - 是否包含子代理、返回上限、取消信号。
   * @returns 允许访问的行，以及被隐藏的可达会话数量。
   */
  async list(
    caller: Caller,
    options: { readonly includeSubagents: boolean; readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<ListResult> {
    const limit = Math.min(Math.max(options.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT)
    const rows = await this.directory.candidates({
      includeCold: true,
      caller,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    const permitted: {
      target: SessionTarget
      teammate: string | undefined
      sendable: boolean
    }[] = []
    let omitted = 0
    for (const target of rows) {
      if (target.id === caller.identity.id) continue
      // 归档会话不可投递：列出它只会诱导无效发送，直接从候选里隐藏。
      if (target.archived === true) {
        omitted += 1
        continue
      }
      const teammate = this.teammateOf(caller, target)
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
      if (!this.mayDeliver(caller, target, teammate)) {
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
      agents: visible.map(entry => this.toListRow(
        caller,
        entry.target,
        entry.teammate !== undefined,
        entry.sendable,
      )),
      omitted,
      truncated: permitted.length - visible.length,
    }
  }

  /**
   * 发送一条消息：投递、挂起等待审批，或拒绝。
   * @param caller - 运行时验证过的调用方。
   * @param input - 地址、正文、可选摘要。
   * @param signal - 调用方取消信号。
   * @returns 稳定的状态描述。
   */
  async send(caller: Caller, input: SendInput, signal: AbortSignal): Promise<SendResult> {
    const messageId = randomUUID()
    const text = input.message
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'refused', messageId, detail: '消息正文为空' }
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.config.maxMessageBytes) {
      return {
        status: 'refused',
        messageId,
        detail: `消息为 ${bytes} 字节，上限为 ${this.config.maxMessageBytes}`,
      }
    }

    // 解析先于授权会变成枚举 oracle：无权调用方可以用标题探测会话是否存在，
    // 并在 ambiguous 回包里拿到不可见会话的 id/显示名。因此解析结果必须先按投递
    // 授权过滤；过滤后为空时与「真的不存在」返回同一文案。
    let target: SessionTarget
    try {
      const resolved = await this.directory.resolve(input.to, signal, caller)
      if (resolved.id === caller.identity.id) {
        return { status: 'self', messageId, detail: '不能给发送方自己发消息' }
      }
      if (!this.mayDeliver(caller, resolved, this.teammateOf(caller, resolved))) {
        return notFoundOf(input.to, messageId)
      }
      target = resolved
    } catch (error) {
      if (error instanceof TargetNotFound) return notFoundOf(input.to, messageId)
      if (!(error instanceof TargetAmbiguous)) throw error
      const candidates = error.candidates.filter(row => this.mayDeliver(caller, row, this.teammateOf(caller, row)))
      if (candidates.length === 0) return notFoundOf(input.to, messageId)
      if (candidates.length > 1) {
        return {
          status: 'ambiguous',
          messageId,
          detail: `"${input.to}" 匹配到多个会话，请改用 session id`,
          candidates: candidates.map(row => ({ id: row.id, name: targetName(row) })),
        }
      }
      const only = candidates[0]
      if (only === undefined) return notFoundOf(input.to, messageId)
      target = only
    }

    const info = { id: target.id, name: targetName(target) }
    // 归档门禁只会把回合以 blocked 收口（没有 agent/error），唤醒投递必然丢消息；
    // 必须在落账/唤醒之前拒绝，不能伪装成 accepted/queued。
    const archived = this.directory.archivedReason(target)
    if (archived !== undefined) {
      return { status: 'refused', messageId, target: info, detail: archived }
    }
    const teammate = this.teammateOf(caller, target)
    // 与解析阶段同一套过滤；这里再判一次是为了覆盖名册在两次读取之间变化的窗口。
    const authDenied = this.authDenial(caller.identity, target, teammate)
    if (authDenied !== undefined) {
      this.log(`[session-messaging] 拒绝向不可见会话投递（${target.id}）：${authDenied}`)
      return notFoundOf(input.to, messageId)
    }
    if (this.config.inbound === 'refuse') {
      return {
        status: 'refused',
        messageId,
        target: info,
        detail: '接收方拒绝所有入站消息（inbound 策略为 refuse）',
      }
    }

    const summary = input.summary?.trim() === '' ? undefined : input.summary?.trim()
    // 去重键包含摘要，并允许调用方显式关闭（dedupe=false）：同一正文配不同摘要、
    // 或「继续/ping」这类同文重发都是不同意图，不能静默丢掉。
    const dedupeKey = input.dedupe === false
      ? undefined
      : this.dedupeKey(caller.identity.id, target.id, text, summary)
    const duplicate = dedupeKey === undefined ? undefined : this.duplicates.find(dedupeKey, Date.now())
    if (duplicate !== undefined) {
      return {
        status: 'duplicate',
        messageId: duplicate,
        target: info,
        detail: `与 ${this.config.dedupeWindowMs}ms 内的同文消息重复，本次不重复投递；如需强制发送请传 dedupe=false`,
      }
    }
    // 频控放在去重之后：命中去重不产生投递，不应消耗发送配额。
    if (!this.rateLimiter.take(`${caller.identity.id}->${target.id}`, this.config.maxPerMinute, Date.now())) {
      return {
        status: 'refused',
        messageId,
        target: info,
        detail: `触发频率限制（每分钟最多 ${this.config.maxPerMinute} 条）`,
      }
    }

    const ledger = this.outbox(caller.identity.id)
    if (ledger.pendingTo(target.id) >= this.config.maxPendingPerTarget) {
      return {
        status: 'refused',
        messageId,
        target: info,
        detail: `该目标名下未确认消息过多（上限 ${this.config.maxPendingPerTarget}）`,
      }
    }

    const senderName = displayName(caller.identity.id, this.directory.titleOf(caller.identity.id))

    if (this.config.inbound === 'hold') {
      const expiresAt = holdDeadline({ windowMs: this.config.holdExpiryMs, maxHeld: this.config.maxHeldPerTarget }, Date.now())
      this.expireInbound(target.id, true)
      this.enforceCapacity(target.id)
      const entry: OutboxEntry = {
        messageId,
        senderId: caller.identity.id,
        senderName,
        targetId: target.id,
        text,
        ...summary === undefined ? {} : { summary },
        at: Date.now(),
        expiresAt,
      }
      // 目标入站账本是真相源：先写它，再写出站账本。反序时第二步失败会留下
      // 「发送方以为已挂起、目标账本没有记录」的永久孤儿：既不可投递也不可审批，
      // 还会长期占用该目标的未确认配额。
      try {
        this.inbound(target.id).hold({ ...entry, expiresAt })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { status: 'refused', messageId, target: info, detail: `挂起账本写入失败（${detail}），消息未投递` }
      }
      try {
        ledger.hold(entry)
      } catch (error) {
        // 出站账本只用于 ack 展示与恢复对账，写失败不影响消息本体。
        const detail = error instanceof Error ? error.message : String(error)
        this.log(`[session-messaging] ${caller.identity.id} 的出站账本写入失败: ${detail}`)
      }
      // 去重窗口只记「已经真正入账」的消息：入账前就 remember 会让一次写盘失败
      // 把后续重试全部判成 duplicate，消息永远发不出去。
      if (dedupeKey !== undefined) this.duplicates.remember(dedupeKey, messageId, Date.now())
      this.notifyHeld(target)
      return {
        status: 'held',
        messageId,
        target: info,
        expiresAt,
        detail: `已挂起等待目标审批，截止 ${new Date(expiresAt).toISOString()}；`
          + '目标通过 review_session_messages 决定是否接收',
      }
    }

    if (target.status === 'offline' && teammate === undefined && !this.config.allowColdWake) {
      return {
        status: 'refused',
        messageId,
        target: info,
        detail: '目标会话未运行且冷唤醒已关闭',
      }
    }
    // 归档状态不可判定时拒绝冷唤醒：唤醒归档会话会被门禁 blocked 收口，消息静默丢失。
    if (target.status === 'offline' && teammate === undefined && !this.directory.archiveStateKnown()) {
      return {
        status: 'refused',
        messageId,
        target: info,
        detail: '无法读取会话归档状态，拒绝冷唤醒目标会话；请等目标在线或修复 Workspace 服务后重试',
      }
    }

    const message = relayMessage(randomUUID(), text, {
      messageId,
      senderId: caller.identity.id,
      senderName,
      ...summary === undefined ? {} : { summary },
    })
    ledger.queue({
      messageId,
      senderId: caller.identity.id,
      senderName,
      targetId: target.id,
      text,
      ...summary === undefined ? {} : { summary },
      at: Date.now(),
    })
    // 排在 durable write 之后：queued 落盘成功才算「已受理」，失败时允许重试。
    if (dedupeKey !== undefined) this.duplicates.remember(dedupeKey, messageId, Date.now())

    try {
      const outcome = await this.gateway.deliver(target, message, {
        senderId: caller.identity.id,
        ...teammate === undefined ? {} : { teamMemberName: teammate },
      }, signal)
      if (outcome.accepted) ledger.deliver(messageId)
      return {
        status: outcome.accepted ? 'accepted' : 'queued',
        messageId,
        target: info,
        detail: outcome.detail,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        status: 'queued',
        messageId,
        target: info,
        detail: `投递失败（${detail}），消息已留在账本等待重试`,
      }
    }
  }

  /**
   * 查看或裁决挂起给当前会话的消息。
   * @param caller - 目标会话自己的 Agent。
   * @param action - list / accept / refuse。
   * @param messageId - 指定一条，缺省作用于全部挂起消息。
   * @param signal - 取消信号。
   * @returns 仍挂起的消息与本次裁决结果。
   */
  async review(
    caller: Caller,
    action: ReviewAction,
    messageId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    const ledger = this.inbound(caller.identity.id)
    this.expireInbound(caller.identity.id, true)
    const outcomes = this.drainExpiryOutcomes(caller.identity.id)
    const held = ledger.held().map(entry => this.toHeldRow(entry))
    if (action === 'list') return { held, outcomes }

    const selected = messageId === undefined
      ? ledger.held()
      : ledger.held().filter(entry => entry.messageId === messageId)
    if (selected.length === 0) {
      return {
        held,
        outcomes: [...outcomes, {
          messageId: messageId ?? '',
          sender: '',
          status: 'not_found',
          detail: messageId === undefined ? '当前没有挂起的消息' : `没有匹配 ${messageId} 的挂起消息`,
        }],
      }
    }

    const reviewer = this.selfTarget(caller)
    for (const entry of selected) {
      if (action === 'refuse') {
        ledger.settle('refused', [entry.messageId])
        this.outbox(entry.senderId).ack(entry.messageId, 'refused')
        outcomes.push({ messageId: entry.messageId, sender: entry.senderName, status: 'refused' })
        continue
      }
      const senderRow = await this.directory.findById(entry.senderId)
      const teammate = senderRow?.teamMemberName
        ?? (senderRow === undefined ? undefined : this.directory.teamMemberNameById(entry.senderId, reviewer))
      const authDenied = senderRow === undefined
        ? '发送方会话已不存在'
        : this.authDenial({ id: entry.senderId, ...identityCwd(senderRow) }, reviewer, teammate)
      if (authDenied !== undefined) {
        ledger.settle('refused', [entry.messageId])
        this.outbox(entry.senderId).ack(entry.messageId, 'refused')
        outcomes.push({
          messageId: entry.messageId,
          sender: entry.senderName,
          status: 'denied',
          detail: authDenied,
        })
        continue
      }
      const message = relayMessage(randomUUID(), entry.text, {
        messageId: entry.messageId,
        senderId: entry.senderId,
        senderName: entry.senderName,
        ...entry.summary === undefined ? {} : { summary: entry.summary },
      })
      const sender: DeliverySenderFacts = {
        senderId: entry.senderId,
        ...senderFactsCwd(senderRow),
        ...teammate === undefined ? {} : { teamMemberName: teammate },
      }
      try {
        const outcome = await this.gateway.deliver(reviewer, message, sender, signal)
        if (outcome.accepted) {
          ledger.settle('accepted', [entry.messageId])
          this.outbox(entry.senderId).deliver(entry.messageId)
          outcomes.push({
            messageId: entry.messageId,
            sender: entry.senderName,
            status: 'accepted',
            detail: outcome.detail,
          })
        } else {
          outcomes.push({
            messageId: entry.messageId,
            sender: entry.senderName,
            status: 'failed',
            detail: outcome.detail,
          })
        }
      } catch (error) {
        outcomes.push({
          messageId: entry.messageId,
          sender: entry.senderName,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { held: ledger.held().map(entry => this.toHeldRow(entry)), outcomes }
  }

  /**
   * 会话启动时恢复：重放未确认的出站消息，并惰性过期本会话的入站挂起。
   * @param caller - 刚启动的会话。
   */
  async recover(principal: Caller | Agent): Promise<void> {
    const caller = toCaller(principal)
    const existing = this.recoveries.get(caller.identity.id)
    if (existing !== undefined) return existing
    const job = this.runRecovery(caller).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[session-messaging] ${caller.identity.id} 的账本恢复失败: ${detail}`)
    })
    this.recoveries.set(caller.identity.id, job)
    try {
      await job
    } finally {
      this.recoveries.delete(caller.identity.id)
    }
  }

  /** 真正执行一次恢复。 */
  private async runRecovery(caller: Caller): Promise<void> {
    this.expireInbound(caller.identity.id, true)
    const ledger = this.outbox(caller.identity.id)
    const pending = ledger.pending()
    if (pending.length === 0) return
    for (const entry of pending) {
      let target: SessionTarget
      try {
        target = await this.directory.resolve(entry.targetId, undefined, caller)
      } catch {
        continue
      }
      if (this.directory.archivedReason(target) !== undefined) {
        // 归档目标唤醒也只会被 blocked；保持 queued，等取消归档后再重放。
        this.log(`[session-messaging] ${entry.targetId} 已归档，跳过重放`)
        continue
      }
      const teammate = target.teamMemberName ?? this.directory.teamMemberName(caller, target)
      if (!this.mayDeliver(caller, target, teammate)) continue
      // 修复恢复钩子后，历史账本里可能存在「其实已经送达但当时没确认」的记录；
      // 重放前先按 messageId 查目标历史，避免把已送达的消息再发一遍。
      if (await this.directory.hasDelivered(entry.targetId, entry.messageId)) {
        ledger.deliver(entry.messageId)
        continue
      }
      if (target.status === 'offline' && teammate === undefined && !this.config.allowColdWake) continue
      if (target.status === 'offline' && teammate === undefined && !this.directory.archiveStateKnown()) {
        this.log(`[session-messaging] 归档状态不可判定，跳过对 ${target.id} 的冷重放`)
        continue
      }
      const message = relayMessage(randomUUID(), entry.text, {
        messageId: entry.messageId,
        senderId: entry.senderId,
        senderName: entry.senderName,
        ...entry.summary === undefined ? {} : { summary: entry.summary },
      })
      try {
        const outcome = await this.gateway.deliver(target, message, {
          senderId: entry.senderId,
          ...teammate === undefined ? {} : { teamMemberName: teammate },
        }, AbortSignal.timeout(30_000))
        if (outcome.accepted) ledger.deliver(entry.messageId)
      } catch (error) {
        // 重放失败保持 queued，下一轮启动或人工重试再投。
        const detail = error instanceof Error ? error.message : String(error)
        this.log(`[session-messaging] 向 ${target.id} 重放失败: ${detail}`)
      }
    }
    ledger.compact()
  }

  /** 目标的团队名册成员名：目标自带优先，否则按名册查询。 */
  private teammateOf(caller: Caller, target: SessionTarget): string | undefined {
    return target.teamMemberName ?? this.directory.teamMemberName(caller, target)
  }

  /** 是否允许向目标投递（不抛错，供 list 过滤）。 */
  private mayDeliver(caller: Caller, target: SessionTarget, teammate: string | undefined): boolean {
    if (target.id === caller.identity.id) return false
    return this.authDenial(caller.identity, target, teammate) === undefined
  }

  /** 授权拒绝说明；允许时返回 undefined。 */
  private authDenial(identity: CallerIdentity, target: SessionTarget, teammate: string | undefined): string | undefined {
    // 团队关系是显式名册授权：名册已经决定谁能联系谁，workspace 策略不覆盖它。
    if (teammate !== undefined) return undefined
    const decision = authorize(identity, target, {
      allowCrossWorkspace: this.config.allowCrossWorkspace,
      allowlist: this.config.allowlist,
      caseInsensitivePaths: this.config.pathCaseInsensitive,
    })
    return decision.allowed ? undefined : decision.reason ?? '没有投递授权'
  }

  /** 构造目标自己的目标视图（审批时作为接收方）。 */
  private selfTarget(caller: Caller): SessionTarget {
    const title = this.directory.titleOf(caller.agent.id)
    return {
      id: caller.agent.id,
      ...caller.identity.cwd === undefined ? {} : { cwd: caller.identity.cwd },
      ...title === undefined ? {} : { title },
      kind: 'peer',
      status: caller.agent.status,
    }
  }

  /** 惰性过期一个目标名下已超时的挂起消息，并通知在线发送方。 */
  private expireInbound(targetId: string, notifySenders: boolean): readonly HeldMessage[] {
    const ledger = this.inbound(targetId)
    const expired = ledger.expired()
    if (expired.length === 0) return []
    // 只结算真正过期的条目：settle 缺省作用于全部挂起消息，会把尚未到期的
    // 消息一起删掉（发送方收不到 ack，目标再也 review 不到 = 静默丢消息）。
    ledger.settle('expired', expired.map(entry => entry.messageId))
    this.rememberExpired(targetId, expired)
    for (const entry of expired) {
      this.outbox(entry.senderId).ack(entry.messageId, 'expired')
      if (!notifySenders) continue
      this.gateway.notify(entry.senderId,
        `[session-messaging] 你发给目标的消息在 ${new Date(entry.expiresAt).toISOString()} 前未获批准，已过期`,
        'expired-notice')
    }
    return expired
  }

  /** 暂存过期结果，等目标下一次 review 时报告。 */
  private rememberExpired(targetId: string, expired: readonly HeldMessage[]): void {
    const existing = this.expiryOutcomes.get(targetId) ?? []
    const added: ReviewOutcome[] = expired.map(entry => ({
      messageId: entry.messageId,
      sender: entry.senderName,
      status: 'expired',
      detail: '审批截止时间已过',
    }))
    this.expiryOutcomes.set(targetId, [...existing, ...added].slice(-100))
    // 长驻进程里目标可能一直不 review；按插入顺序淘汰最旧的会话缓存。
    while (this.expiryOutcomes.size > 100) {
      const oldest = this.expiryOutcomes.keys().next().value
      if (oldest === undefined || oldest === targetId) break
      this.expiryOutcomes.delete(oldest)
    }
  }

  /** 取走并清空某目标待报告的过期结果。 */
  private drainExpiryOutcomes(targetId: string): ReviewOutcome[] {
    const outcomes = this.expiryOutcomes.get(targetId) ?? []
    this.expiryOutcomes.delete(targetId)
    return outcomes
  }

  /** 容量满时淘汰最旧的挂起消息，并通知在线发送方。 */
  private enforceCapacity(targetId: string): void {
    const ledger = this.inbound(targetId)
    const overflow = capacityOverflow(ledger.held(), {
      windowMs: this.config.holdExpiryMs,
      maxHeld: this.config.maxHeldPerTarget,
    })
    if (overflow.length === 0) return
    // 一次批量结算：逐条重算会把淘汰变成每轮全账本折叠（O(n²)）。
    ledger.settle('expired', overflow.map(entry => entry.messageId))
    for (const oldest of overflow) {
      this.outbox(oldest.senderId).ack(oldest.messageId, 'expired')
      this.gateway.notify(oldest.senderId,
        '[session-messaging] 目标审批队列已满，你的一条挂起消息被丢弃',
        'capacity-notice')
    }
  }

  /** 通知在线目标有消息待审批，按配置间隔节流。 */
  private notifyHeld(target: SessionTarget): void {
    if (target.status === 'offline') return
    const now = Date.now()
    const last = this.notices.get(target.id)
    if (last !== undefined && now - last < this.config.notifyIntervalMs) return
    this.notices.set(target.id, now)
    this.gateway.notify(target.id,
      '[session-messaging] 有消息等待你审批。调用 review_session_messages 查看并决定接收或拒绝。',
      'held-notice')
  }

  /** 把目标投影成工具返回行。 */
  private toListRow(
    caller: Caller,
    target: SessionTarget,
    isTeammate: boolean,
    sendable: boolean,
  ): ListRow {
    const workspace = caller.identity.cwd === undefined || target.cwd === undefined
      ? 'unknown'
      : sameCwd(caller.identity.cwd, target.cwd, this.config.pathCaseInsensitive) ? 'same' : 'different'
    return {
      name: targetName(target),
      id: target.id,
      shortId: target.id.startsWith('session-') ? target.id.slice('session-'.length, 'session-'.length + 8) : target.id.slice(0, 8),
      cwd: target.cwd ?? '',
      workspace,
      state: target.status,
      kind: isTeammate ? 'teammate' : target.kind,
      sendable,
    }
  }

  /** 把挂起消息投影成审批返回值。 */
  private toHeldRow(entry: HeldMessage): HeldRow {
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

  /** 相同正文（含摘要）去重键。 */
  private dedupeKey(senderId: string, targetId: string, text: string, summary: string | undefined): string {
    // 用 NUL 分隔，避免 text/summary 拼接时出现边界歧义。
    const digest = createHash('sha1').update(text).update('\u0000').update(summary ?? '').digest('hex')
    return `${senderId}->${targetId}:${digest}`
  }
}

/** 把 Agent 或 Caller 统一成 Caller。 */
function toCaller(principal: Caller | Agent): Caller {
  if ('identity' in principal && 'agent' in principal) return principal
  return { agent: principal, identity: identityOf(principal) }
}

/** 取目标 cwd 作为调用方身份字段，遵循 exactOptionalPropertyTypes。 */
function identityCwd(target: SessionTarget | undefined): { readonly cwd?: string } {
  return target?.cwd === undefined ? {} : { cwd: target.cwd }
}

/** 取目标 cwd 作为投递发送方事实字段（端口字段名是 senderCwd）。 */
function senderFactsCwd(target: SessionTarget | undefined): { readonly senderCwd?: string } {
  return target?.cwd === undefined ? {} : { senderCwd: target.cwd }
}

/** 「没有这个会话」的统一回包：未授权目标也用它，避免暴露会话是否存在。 */
function notFoundOf(address: string, messageId: string): SendResult {
  return { status: 'not_found', messageId, detail: `没有匹配 "${address}" 的会话` }
}

/** 列表排序权重：running、idle、offline。 */
function statusRank(target: SessionTarget): number {
  return target.status === 'running' ? 0 : target.status === 'idle' ? 1 : 2
}
