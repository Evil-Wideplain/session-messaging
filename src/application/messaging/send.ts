/**
 * `send` 用例：投递、挂起等待审批，或拒绝。
 *
 * 顺序是语义的一部分：解析先于授权会变成枚举 oracle；频控放在去重之后
 * （命中去重不产生投递，不应消耗配额）；挂起分支在 `inbound.ts` 里。
 *
 * @module session-messaging/application/messaging/send
 */

import { randomUUID } from 'node:crypto'
import type { SessionTarget } from '../../domain/target.ts'
import { displayName, TargetAmbiguous, TargetNotFound, targetName } from '../../domain/target.ts'
import { relayMessage } from '../../domain/message.ts'
import { messageOf, nonBlank } from '../../domain/util.ts'
import type { SendInput, SendResult } from '../dto.ts'
import type { Caller } from '../ports.ts'
import { authDenial, coldWakeRefusal, mayDeliver, teammateOf } from './auth.ts'
import { dedupeKeyOf } from './dedupe.ts'
import type { MessagingContext } from './deps.ts'
import { holdForApproval } from './inbound.ts'
import { notFoundOf } from './rows.ts'

/**
 * 发送一条消息：投递、挂起等待审批，或拒绝。
 * @param ctx - 用例上下文。
 * @param caller - 运行时验证过的调用方。
 * @param input - 地址、正文、可选摘要。
 * @param signal - 调用方取消信号。
 * @returns 稳定的状态描述。
 */
export async function sendMessage(
  ctx: MessagingContext,
  caller: Caller,
  input: SendInput,
  signal: AbortSignal,
): Promise<SendResult> {
  const messageId = randomUUID()
  const text = input.message
  if (typeof text !== 'string' || text.trim() === '') {
    return { status: 'refused', messageId, detail: '消息正文为空' }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > ctx.config.maxMessageBytes) {
    return {
      status: 'refused',
      messageId,
      detail: `消息为 ${bytes} 字节，上限为 ${ctx.config.maxMessageBytes}`,
    }
  }

  // 解析先于授权会变成枚举 oracle：无权调用方可以用标题探测会话是否存在，
  // 并在 ambiguous 回包里拿到不可见会话的 id/显示名。因此解析结果必须先按投递
  // 授权过滤；过滤后为空时与「真的不存在」返回同一文案。
  let target: SessionTarget
  try {
    const resolved = await ctx.directory.resolve(input.to, signal, caller)
    if (resolved.id === caller.identity.id) {
      return { status: 'self', messageId, detail: '不能给发送方自己发消息' }
    }
    if (!mayDeliver(ctx, caller, resolved, teammateOf(ctx, caller, resolved))) {
      return notFoundOf(input.to, messageId)
    }
    target = resolved
  } catch (error) {
    if (error instanceof TargetNotFound) return notFoundOf(input.to, messageId)
    if (!(error instanceof TargetAmbiguous)) throw error
    const candidates = error.candidates.filter(row => mayDeliver(ctx, caller, row, teammateOf(ctx, caller, row)))
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
  const archived = ctx.directory.archivedReason(target)
  if (archived !== undefined) {
    return { status: 'refused', messageId, target: info, detail: archived }
  }
  const teammate = teammateOf(ctx, caller, target)
  // 与解析阶段同一套过滤；这里再判一次是为了覆盖名册在两次读取之间变化的窗口。
  const denied = authDenial(ctx, caller.identity, target, teammate)
  if (denied !== undefined) {
    ctx.log(`[session-messaging] 拒绝向不可见会话投递（${target.id}）：${denied}`)
    return notFoundOf(input.to, messageId)
  }
  if (ctx.config.inbound === 'refuse') {
    return {
      status: 'refused',
      messageId,
      target: info,
      detail: '接收方拒绝所有入站消息（inbound 策略为 refuse）',
    }
  }

  const summary = nonBlank(input.summary)
  // 去重键包含摘要，并允许调用方显式关闭（dedupe=false）：同一正文配不同摘要、
  // 或「继续/ping」这类同文重发都是不同意图，不能静默丢掉。
  const dedupeKey = input.dedupe === false
    ? undefined
    : dedupeKeyOf(caller.identity.id, target.id, text, summary)
  const duplicate = dedupeKey === undefined ? undefined : ctx.duplicates.find(dedupeKey, Date.now())
  if (duplicate !== undefined) {
    return {
      status: 'duplicate',
      messageId: duplicate,
      target: info,
      detail: `与 ${ctx.config.dedupeWindowMs}ms 内的同文消息重复，本次不重复投递；如需强制发送请传 dedupe=false`,
    }
  }
  // 频控放在去重之后：命中去重不产生投递，不应消耗发送配额。
  if (!ctx.rateLimiter.take(`${caller.identity.id}->${target.id}`, ctx.config.maxPerMinute, Date.now())) {
    return {
      status: 'refused',
      messageId,
      target: info,
      detail: `触发频率限制（每分钟最多 ${ctx.config.maxPerMinute} 条）`,
    }
  }

  const ledger = ctx.outbox(caller.identity.id)
  if (ledger.pendingTo(target.id) >= ctx.config.maxPendingPerTarget) {
    return {
      status: 'refused',
      messageId,
      target: info,
      detail: `该目标名下未确认消息过多（上限 ${ctx.config.maxPendingPerTarget}）`,
    }
  }

  const senderName = displayName(caller.identity.id, ctx.directory.titleOf(caller.identity.id))

  if (ctx.config.inbound === 'hold') {
    return holdForApproval(ctx, caller, target, messageId, text, summary, senderName, dedupeKey)
  }

  const coldWake = coldWakeRefusal(ctx, target, teammate, info, messageId)
  if (coldWake !== undefined) return coldWake

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
  if (dedupeKey !== undefined) ctx.duplicates.remember(dedupeKey, messageId, Date.now())

  try {
    const outcome = await ctx.gateway.deliver(target, message, {
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
    const detail = messageOf(error)
    return {
      status: 'queued',
      messageId,
      target: info,
      detail: `投递失败（${detail}），消息已留在账本等待重试`,
    }
  }
}
