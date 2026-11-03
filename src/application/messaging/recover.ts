/**
 * `recover` 用例：会话启动时重放未确认的出站消息，并惰性过期本会话的入站挂起。
 *
 * 同一会话并发启动只跑一次（按调用方 id 去重）；重放失败保持 queued，
 * 等下一轮启动或人工重试再投。
 *
 * @module dsh-plugin-session-messaging/application/messaging/recover
 */

import { randomUUID } from 'node:crypto'
import { relayMessage } from '../../domain/message.ts'
import type { SessionTarget } from '../../domain/target.ts'
import { messageOf } from '../../domain/util.ts'
import type { Agent } from '../../types.ts'
import type { Caller } from '../ports.ts'
import { mayDeliver, toCaller } from './auth.ts'
import type { MessagingContext } from './deps.ts'
import { expireInbound } from './inbound.ts'

/**
 * 会话启动时恢复：重放未确认的出站消息，并惰性过期本会话的入站挂起。
 * @param ctx - 用例上下文。
 * @param principal - 刚启动的会话（Agent 或已验证的 Caller）。
 */
export async function recoverSessions(ctx: MessagingContext, principal: Caller | Agent): Promise<void> {
  const caller = toCaller(principal)
  const existing = ctx.recoveries.get(caller.identity.id)
  if (existing !== undefined) return existing
  const job = runRecovery(ctx, caller).catch((error: unknown) => {
    const detail = messageOf(error)
    ctx.log(`[session-messaging] ${caller.identity.id} 的账本恢复失败: ${detail}`)
  })
  ctx.recoveries.set(caller.identity.id, job)
  try {
    await job
  } finally {
    ctx.recoveries.delete(caller.identity.id)
  }
}

/** 真正执行一次恢复。 */
async function runRecovery(ctx: MessagingContext, caller: Caller): Promise<void> {
  expireInbound(ctx, caller.identity.id, true)
  const ledger = ctx.outbox(caller.identity.id)
  const pending = ledger.pending()
  if (pending.length === 0) return
  for (const entry of pending) {
    let target: SessionTarget
    try {
      target = await ctx.directory.resolve(entry.targetId, undefined, caller)
    } catch {
      continue
    }
    if (ctx.directory.archivedReason(target) !== undefined) {
      // 归档目标唤醒也只会被 blocked；保持 queued，等取消归档后再重放。
      ctx.log(`[session-messaging] ${entry.targetId} 已归档，跳过重放`)
      continue
    }
    const teammate = target.teamMemberName ?? ctx.directory.teamMemberName(caller, target)
    if (!mayDeliver(ctx, caller, target, teammate)) continue
    // 修复恢复钩子后，历史账本里可能存在「其实已经送达但当时没确认」的记录；
    // 重放前先按 messageId 查目标历史，避免把已送达的消息再发一遍。
    if (await ctx.directory.hasDelivered(entry.targetId, entry.messageId)) {
      ledger.deliver(entry.messageId)
      continue
    }
    if (target.status === 'offline' && teammate === undefined && !ctx.config.allowColdWake) continue
    if (target.status === 'offline' && teammate === undefined && !ctx.directory.archiveStateKnown()) {
      ctx.log(`[session-messaging] 归档状态不可判定，跳过对 ${target.id} 的冷重放`)
      continue
    }
    const message = relayMessage(randomUUID(), entry.text, {
      messageId: entry.messageId,
      senderId: entry.senderId,
      senderName: entry.senderName,
      ...entry.summary === undefined ? {} : { summary: entry.summary },
    })
    try {
      const outcome = await ctx.gateway.deliver(target, message, {
        senderId: entry.senderId,
        ...teammate === undefined ? {} : { teamMemberName: teammate },
      }, AbortSignal.timeout(30_000))
      if (outcome.accepted) ledger.deliver(entry.messageId)
    } catch (error) {
      // 重放失败保持 queued，下一轮启动或人工重试再投。
      const detail = messageOf(error)
      ctx.log(`[session-messaging] 向 ${target.id} 重放失败: ${detail}`)
    }
  }
  ledger.compact()
}
