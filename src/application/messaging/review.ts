/**
 * `review` 用例：目标侧查看或裁决挂起消息。
 *
 * `accept` 会重新做一次授权（发送方可能在挂起期间失去可见性），只有网关确认
 * 送达才结算为 accepted；`refuse` 直接丢弃并给发送方 ack。
 *
 * @module dsh-plugin-session-messaging/application/messaging/review
 */

import { randomUUID } from 'node:crypto'
import { relayMessage } from '../../domain/message.ts'
import { messageOf } from '../../domain/util.ts'
import type { DeliverySenderFacts } from '../ports.ts'
import type { Caller } from '../ports.ts'
import type { ReviewAction, ReviewResult } from '../dto.ts'
import { authDenial, identityCwd, selfTarget, senderFactsCwd } from './auth.ts'
import type { MessagingContext } from './deps.ts'
import { drainExpiryOutcomes, expireInbound } from './inbound.ts'
import { toHeldRow } from './rows.ts'

/**
 * 查看或裁决挂起给当前会话的消息。
 * @param ctx - 用例上下文。
 * @param caller - 目标会话自己的 Agent。
 * @param action - list / accept / refuse。
 * @param messageId - 指定一条，缺省作用于全部挂起消息。
 * @param signal - 取消信号。
 * @returns 仍挂起的消息与本次裁决结果。
 */
export async function reviewMessages(
  ctx: MessagingContext,
  caller: Caller,
  action: ReviewAction,
  messageId: string | undefined,
  signal: AbortSignal,
): Promise<ReviewResult> {
  const ledger = ctx.inbound(caller.identity.id)
  expireInbound(ctx, caller.identity.id, true)
  const outcomes = drainExpiryOutcomes(ctx, caller.identity.id)
  const held = ledger.held().map(entry => toHeldRow(entry))
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

  const reviewer = selfTarget(ctx, caller)
  for (const entry of selected) {
    if (action === 'refuse') {
      ledger.settle('refused', [entry.messageId])
      ctx.outbox(entry.senderId).ack(entry.messageId, 'refused')
      outcomes.push({ messageId: entry.messageId, sender: entry.senderName, status: 'refused' })
      continue
    }
    const senderRow = await ctx.directory.findById(entry.senderId)
    const teammate = senderRow?.teamMemberName
      ?? (senderRow === undefined ? undefined : ctx.directory.teamMemberNameById(entry.senderId, reviewer))
    const denied = senderRow === undefined
      ? '发送方会话已不存在'
      : authDenial(ctx, { id: entry.senderId, ...identityCwd(senderRow) }, reviewer, teammate)
    if (denied !== undefined) {
      ledger.settle('refused', [entry.messageId])
      ctx.outbox(entry.senderId).ack(entry.messageId, 'refused')
      outcomes.push({
        messageId: entry.messageId,
        sender: entry.senderName,
        status: 'denied',
        detail: denied,
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
      const outcome = await ctx.gateway.deliver(reviewer, message, sender, signal)
      if (outcome.accepted) {
        ledger.settle('accepted', [entry.messageId])
        ctx.outbox(entry.senderId).deliver(entry.messageId)
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
        detail: messageOf(error),
      })
    }
  }
  return { held: ledger.held().map(entry => toHeldRow(entry)), outcomes }
}
