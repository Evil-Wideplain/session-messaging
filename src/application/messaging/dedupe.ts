/**
 * 发送去重键（应用层）。
 *
 * 去重是「同一发送方对同一目标、窗口内同文」的横切策略：键里必须同时含
 * 双方会话标识与摘要，且用 NUL 分隔各段，避免拼接边界产生歧义
 * （例如正文 "a" + 摘要 "b" 与正文 "ab" 撞成同一个键）。
 *
 * @module dsh-plugin-session-messaging/application/messaging/dedupe
 */

import { createHash } from 'node:crypto'

/**
 * 相同正文（含摘要）的去重键。
 * @param senderId - 发送方会话标识。
 * @param targetId - 目标会话标识。
 * @param text - 正文。
 * @param summary - 规范化后的摘要（未提供时按空串参与摘要）。
 * @returns `sender→target:sha1` 形式的稳定键。
 */
export function dedupeKeyOf(senderId: string, targetId: string, text: string, summary: string | undefined): string {
  const digest = createHash('sha1').update(text).update('\u0000').update(summary ?? '').digest('hex')
  return `${senderId}->${targetId}:${digest}`
}
