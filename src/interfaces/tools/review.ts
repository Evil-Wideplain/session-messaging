/**
 * `review_session_messages` 模型工具：入站 `hold` 策略的目标侧审批入口。
 *
 * 目标会话用自己的模型查看/裁决挂起消息；接受时由应用服务重新授权后再投递，
 * 拒绝则丢弃并通知发送方。工具层只做动作白名单校验与 DTO 投影。
 *
 * 本工具的 render 是审批者的决策上下文：sender / summary / preview 全部来自
 * 发送方，必须过 `inlineText` 并限长，否则一条带换行的 summary 就能伪造出
 * 「已 accepted」的结果行或塞进超长指令。
 *
 * @module session-messaging/interfaces/tools/review
 */

import type { MessagingService } from '../../application/messaging-service.ts'
import type { ReviewAction } from '../../application/dto.ts'
import type { ContentBlock, ToolDefinition } from '../../types.ts'
import {
  asObject,
  callerOf,
  heldSchema,
  inlineText,
  optionalString,
  outcomeSchema,
  rejectUnknown,
  requiredString,
  RENDER_PREVIEW_CHARS,
} from './shared.ts'

/** `review_session_messages` 接受的动作。 */
const REVIEW_ACTIONS: readonly ReviewAction[] = ['list', 'accept', 'refuse']

/**
 * 构造 `review_session_messages` 工具：入站 `hold` 策略的目标侧入口。
 * @param service - 应用服务。
 * @returns 可注册的工具定义。
 */
export function createReviewTool(service: MessagingService): ToolDefinition {
  return {
    name: 'review_session_messages',
    description:
      'Inspect or decide messages that other sessions sent to you while your deployment holds inbound messages '
      + 'for approval. Use action "list" to read the held messages (sender, summary, preview, deadline), then '
      + '"accept" or "refuse" — with message_id for one message or without it for all held messages. Accepted '
      + 'messages are delivered into your conversation; refused ones are discarded and the sender is told. '
      + 'Held messages expire automatically after the approval deadline.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'accept', 'refuse'],
          description: 'list to inspect, accept to deliver, refuse to discard.',
        },
        message_id: {
          type: 'string',
          description: 'Optional held message id; omit to apply the action to every held message.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          held: { type: 'array', items: heldSchema },
          outcomes: { type: 'array', items: outcomeSchema },
        },
        required: ['held', 'outcomes'],
      },
      render: (_args, value) => {
        const result = value as {
          held: { sender: string; summary: string; preview?: string; expires_at: number }[]
          outcomes: { sender: string; status: string; message_id: string; detail?: string }[]
        }
        const lines: string[] = []
        for (const outcome of result.outcomes) {
          const flatDetail = inlineText(outcome.detail)
          const detail = flatDetail === '' ? '' : `：${flatDetail}`
          if (outcome.status === 'not_found') {
            const messageId = inlineText(outcome.message_id)
            lines.push(`- 未找到${messageId === '' ? '' : `（${messageId}）`}${detail}`)
            continue
          }
          const sender = inlineText(outcome.sender) || '未知会话'
          lines.push(`- ${inlineText(outcome.status)} ${inlineText(outcome.message_id)}，来自 ${sender}${detail}`)
        }
        if (result.held.length > 0) {
          lines.push(`仍有 ${result.held.length} 条消息挂起：`)
          for (const entry of result.held) {
            const preview = inlineText(entry.preview, RENDER_PREVIEW_CHARS)
            const previewPart = preview === '' ? '' : ` — ${preview}`
            const summary = inlineText(entry.summary, RENDER_PREVIEW_CHARS)
            lines.push(
              `- ${inlineText(entry.sender)}：${summary}${previewPart}`
              + `（截止 ${new Date(entry.expires_at).toISOString()}）`,
            )
          }
        } else if (result.outcomes.length === 0) {
          lines.push('当前没有等待审批的消息')
        }
        return [{ type: 'text', text: lines.join('\n') } satisfies ContentBlock]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['action', 'message_id'])
      const action = requiredString(parsed, 'action') as ReviewAction
      if (!REVIEW_ACTIONS.includes(action)) {
        throw new Error(`参数错误："action" 必须是 ${REVIEW_ACTIONS.join(' / ')} 之一`)
      }
      const messageId = optionalString(parsed, 'message_id')
      const caller = callerOf(exec, 'review_session_messages')
      const result = await service.review(caller, action, messageId, exec.signal)
      return {
        held: result.held.map(entry => ({
          message_id: entry.messageId,
          sender: entry.sender,
          sender_id: entry.senderId,
          summary: entry.summary,
          preview: entry.preview,
          created_at: entry.createdAt,
          expires_at: entry.expiresAt,
        })),
        outcomes: result.outcomes.map(outcome => ({
          message_id: outcome.messageId,
          sender: outcome.sender,
          status: outcome.status,
          ...outcome.detail === undefined ? {} : { detail: outcome.detail },
        })),
      }
    },
  }
}
