/**
 * `send_session_message` 模型工具：按显示名或精确 session id 投递一条文本消息。
 *
 * 工具层只把 snake_case 参数翻成应用服务入参，投递路由、授权、去重与审批
 * 策略全部由应用服务决定；返回值把应用层 DTO 再投影回模型的 snake_case 形状。
 * render 的 detail / 目标名 / 候选名都可能带对端可控文本，先过 `inlineText`。
 *
 * @module dsh-plugin-session-messaging/interfaces/tools/send
 */

import type { SendStatus } from '../../application/dto.ts'
import type { MessagingService } from '../../application/messaging-service.ts'
import type { ContentBlock, ToolDefinition } from '../../types.ts'
import {
  asObject,
  callerOf,
  inlineText,
  optionalBoolean,
  optionalString,
  rejectUnknown,
  requiredString,
  targetSchema,
} from './shared.ts'

/** 发送终态；schema enum 与 DTO `SendStatus` 对齐，避免两类取值各自漂移。 */
const SEND_STATUSES: readonly SendStatus[] = [
  'accepted',
  'queued',
  'held',
  'duplicate',
  'not_found',
  'ambiguous',
  'denied',
  'self',
  'refused',
]

/**
 * 构造 `send_session_message` 工具。
 * @param service - 应用服务。
 * @returns 可注册的工具定义。
 */
export function createSendTool(service: MessagingService): ToolDefinition {
  return {
    name: 'send_session_message',
    description:
      'Send a text message to another session, addressed by its display name or exact session id (for example '
      + 'from list_session_agents). Delivery prefers the official channel when one owns the relationship: your '
      + 'own continuable subagent goes through the subagent channel; a team message goes through the team '
      + 'mailbox (addressed by the member name, never the subagent channel); every other target receives the '
      + 'message in its session inbox. A teammate stays addressable by name while inactive. A running target '
      + 'receives it at its nearest step boundary, an idle target starts a new turn, and an offline target is '
      + 'resumed first when cold wake is enabled. If the receiving session holds inbound messages for approval, '
      + 'the result is `held` and the target must call review_session_messages. The call returns delivery '
      + 'status, not the target\'s answer. Statuses: accepted, queued (kept in your durable outbox and replayed '
      + 'when you next start or when the target can be reached again), held (awaiting approval), duplicate '
      + '(same body and summary within the dedupe window; pass dedupe=false to force), refused (limits or inbound '
      + 'policy), not_found (no such session — or you are not authorized to see it), ambiguous, self.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: {
          type: 'string',
          description: 'Target display name from list_session_agents (quotes allowed) or exact session id.',
        },
        message: {
          type: 'string',
          description: 'Text body to deliver. Keep it self-contained: the target sees it as a user message from you.',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line provenance summary shown alongside the message.',
        },
        dedupe: {
          type: 'boolean',
          description: 'Set to false to force delivery even when the same body and summary were sent to this '
            + 'target inside the dedupe window.',
        },
      },
      required: ['to', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: SEND_STATUSES },
          message_id: { type: 'string' },
          detail: { type: 'string' },
          target: targetSchema,
          candidates: {
            type: 'array',
            items: targetSchema,
          },
          expires_at: { type: 'integer' },
        },
        required: ['status', 'message_id', 'detail'],
      },
      render: (_args, value) => {
        const result = value as {
          status: string
          message_id: string
          detail: string
          target?: { id: string; name: string }
          candidates?: { id: string; name: string }[]
          expires_at?: number
        }
        const where = result.target === undefined ? '' : ` 发给 ${inlineText(result.target.name)}`
        const lines = [
          `${inlineText(result.status)}${where}：${inlineText(result.detail)}`
          + `（message_id: ${inlineText(result.message_id)}）`,
        ]
        if (result.candidates !== undefined && result.candidates.length > 0) {
          lines.push('候选会话（请改用精确 session id）：')
          for (const candidate of result.candidates) {
            lines.push(`- ${inlineText(candidate.name)}（${inlineText(candidate.id)}）`)
          }
        }
        if (result.expires_at !== undefined) {
          lines.push(`审批截止：${new Date(result.expires_at).toISOString()}`)
        }
        return [{ type: 'text', text: lines.join('\n') } satisfies ContentBlock]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['to', 'message', 'summary', 'dedupe'])
      const to = requiredString(parsed, 'to')
      const message = requiredString(parsed, 'message')
      const summary = optionalString(parsed, 'summary')
      const dedupe = optionalBoolean(parsed, 'dedupe')
      const caller = callerOf(exec, 'send_session_message')
      const result = await service.send(caller, {
        to,
        message,
        ...summary === undefined ? {} : { summary },
        ...dedupe === undefined ? {} : { dedupe },
      }, exec.signal)
      return {
        status: result.status,
        message_id: result.messageId,
        detail: result.detail,
        ...result.target === undefined ? {} : { target: result.target },
        ...result.candidates === undefined ? {} : { candidates: result.candidates },
        ...result.expiresAt === undefined ? {} : { expires_at: result.expiresAt },
      }
    },
  }
}
