/**
 * 入站挂起账本的用例：惰性过期、容量淘汰、审批通知与挂起写入。
 *
 * 这一组函数都直接作用于目标侧的入站账本与发送方出站账本；过期/淘汰必须
 * 精确结算到具体 messageId，否则会误删尚未到期的挂起消息（静默丢消息）。
 *
 * @module dsh-plugin-session-messaging/application/messaging/inbound
 */

import type { HeldMessage } from '../../domain/held-message.ts'
import { capacityOverflow, holdDeadline } from '../../domain/inbound-policy.ts'
import type { OutboxEntry } from '../../domain/outbox.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { targetName } from '../../domain/target.ts'
import { messageOf } from '../../domain/util.ts'
import type { ReviewOutcome, SendResult } from '../dto.ts'
import type { Caller } from '../ports.ts'
import type { MessagingContext } from './deps.ts'

/**
 * 惰性过期一个目标名下已超时的挂起消息，并通知在线发送方。
 * @param ctx - 用例上下文。
 * @param targetId - 目标会话。
 * @param notifySenders - 是否向在线发送方发提示。
 * @returns 本次结算掉的挂起消息。
 */
export function expireInbound(
  ctx: MessagingContext,
  targetId: string,
  notifySenders: boolean,
): readonly HeldMessage[] {
  const ledger = ctx.inbound(targetId)
  const expired = ledger.expired()
  if (expired.length === 0) return []
  // 只结算真正过期的条目：settle 缺省作用于全部挂起消息，会把尚未到期的
  // 消息一起删掉（发送方收不到 ack，目标再也 review 不到 = 静默丢消息）。
  ledger.settle('expired', expired.map(entry => entry.messageId))
  rememberExpired(ctx, targetId, expired)
  for (const entry of expired) {
    ctx.outbox(entry.senderId).ack(entry.messageId, 'expired')
    if (!notifySenders) continue
    ctx.gateway.notify(entry.senderId,
      `[session-messaging] 你发给目标的消息在 ${new Date(entry.expiresAt).toISOString()} 前未获批准，已过期`,
      'expired-notice')
  }
  return expired
}

/** 暂存过期结果，等目标下一次 review 时报告。 */
function rememberExpired(ctx: MessagingContext, targetId: string, expired: readonly HeldMessage[]): void {
  const existing = ctx.expiryOutcomes.get(targetId) ?? []
  const added: ReviewOutcome[] = expired.map(entry => ({
    messageId: entry.messageId,
    sender: entry.senderName,
    status: 'expired',
    detail: '审批截止时间已过',
  }))
  ctx.expiryOutcomes.set(targetId, [...existing, ...added].slice(-100))
  // 长驻进程里目标可能一直不 review；按插入顺序淘汰最旧的会话缓存。
  while (ctx.expiryOutcomes.size > 100) {
    const oldest = ctx.expiryOutcomes.keys().next().value
    if (oldest === undefined || oldest === targetId) break
    ctx.expiryOutcomes.delete(oldest)
  }
}

/** 取走并清空某目标待报告的过期结果。 */
export function drainExpiryOutcomes(ctx: MessagingContext, targetId: string): ReviewOutcome[] {
  const outcomes = ctx.expiryOutcomes.get(targetId) ?? []
  ctx.expiryOutcomes.delete(targetId)
  return outcomes
}

/** 容量满时淘汰最旧的挂起消息，并通知在线发送方。 */
function enforceCapacity(ctx: MessagingContext, targetId: string): void {
  const ledger = ctx.inbound(targetId)
  const overflow = capacityOverflow(ledger.held(), {
    windowMs: ctx.config.holdExpiryMs,
    maxHeld: ctx.config.maxHeldPerTarget,
  })
  if (overflow.length === 0) return
  // 一次批量结算：逐条重算会把淘汰变成每轮全账本折叠（O(n²)）。
  ledger.settle('expired', overflow.map(entry => entry.messageId))
  for (const oldest of overflow) {
    ctx.outbox(oldest.senderId).ack(oldest.messageId, 'expired')
    ctx.gateway.notify(oldest.senderId,
      '[session-messaging] 目标审批队列已满，你的一条挂起消息被丢弃',
      'capacity-notice')
  }
}

/** 通知在线目标有消息待审批，按配置间隔节流。 */
function notifyHeld(ctx: MessagingContext, target: SessionTarget): void {
  if (target.status === 'offline') return
  const now = Date.now()
  const last = ctx.notices.get(target.id)
  if (last !== undefined && now - last < ctx.config.notifyIntervalMs) return
  ctx.notices.set(target.id, now)
  ctx.gateway.notify(target.id,
    '[session-messaging] 有消息等待你审批。调用 review_session_messages 查看并决定接收或拒绝。',
    'held-notice')
}

/**
 * 走 `hold` 策略：把消息写进目标入站账本等待审批。
 *
 * 目标入站账本是真相源：先写它，再写出站账本。反序时第二步失败会留下
 * 「发送方以为已挂起、目标账本没有记录」的永久孤儿：既不可投递也不可审批，
 * 还会长期占用该目标的未确认配额。
 * @param ctx - 用例上下文。
 * @param caller - 发送方。
 * @param target - 目标会话。
 * @param messageId - 本次消息标识。
 * @param text - 正文。
 * @param summary - 规范化后的摘要。
 * @param senderName - 发送方显示名。
 * @param dedupeKey - 去重键（未启用去重时为 undefined）。
 * @returns `held` 或挂起账本写入失败的 `refused`。
 */
export function holdForApproval(
  ctx: MessagingContext,
  caller: Caller,
  target: SessionTarget,
  messageId: string,
  text: string,
  summary: string | undefined,
  senderName: string,
  dedupeKey: string | undefined,
): SendResult {
  const info = { id: target.id, name: targetName(target) }
  const expiresAt = holdDeadline(
    { windowMs: ctx.config.holdExpiryMs, maxHeld: ctx.config.maxHeldPerTarget },
    Date.now(),
  )
  expireInbound(ctx, target.id, true)
  enforceCapacity(ctx, target.id)
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
  try {
    ctx.inbound(target.id).hold({ ...entry, expiresAt })
  } catch (error) {
    const detail = messageOf(error)
    return { status: 'refused', messageId, target: info, detail: `挂起账本写入失败（${detail}），消息未投递` }
  }
  try {
    ctx.outbox(caller.identity.id).hold(entry)
  } catch (error) {
    // 出站账本只用于 ack 展示与恢复对账，写失败不影响消息本体。
    const detail = messageOf(error)
    ctx.log(`[session-messaging] ${caller.identity.id} 的出站账本写入失败: ${detail}`)
  }
  // 去重窗口只记「已经真正入账」的消息：入账前就 remember 会让一次写盘失败
  // 把后续重试全部判成 duplicate，消息永远发不出去。
  if (dedupeKey !== undefined) ctx.duplicates.remember(dedupeKey, messageId, Date.now())
  notifyHeld(ctx, target)
  return {
    status: 'held',
    messageId,
    target: info,
    expiresAt,
    detail: `已挂起等待目标审批，截止 ${new Date(expiresAt).toISOString()}；`
      + '目标通过 review_session_messages 决定是否接收',
  }
}
