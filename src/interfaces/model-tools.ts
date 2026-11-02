/**
 * 模型工具（接口层）：`list_session_agents`、`send_session_message`、
 * `review_session_messages`。
 *
 * 工具名全部 snake_case，并刻意区别于内置的 `list_agents` / `send_message`
 * （那两个走运行时自己的子代理直连），因为这三个工具走的是本插件自己的
 * 寻址、路由与授权层。
 *
 * 本层只做参数校验与 DTO 投影，业务规则全部在应用服务与领域层。
 *
 * @module dsh-plugin-session-messaging/interfaces/model-tools
 */

import type { ContentBlock, ToolDefinition, ToolExecution } from '../types.ts'
import type { Caller } from '../application/ports.ts'
import { identityOf } from '../domain/authorization.ts'
import type { MessagingService } from '../application/messaging-service.ts'
import type { ReviewAction } from '../application/dto.ts'

/** 拒绝非普通对象参数。 */
function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('参数错误：需要一个对象')
  }
  return args as Record<string, unknown>
}

/** 读取必填字符串参数。 */
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数错误："${key}" 必须是非空字符串`)
  }
  return value
}

/** 读取可选字符串参数。 */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`参数错误："${key}" 必须是字符串`)
  return value
}

/** 读取可选布尔参数。 */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`参数错误："${key}" 必须是布尔值`)
  return value
}

/** 读取可选整数参数并校验闭区间。 */
function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`参数错误："${key}" 必须是 [${minimum}, ${maximum}] 范围内的整数`)
  }
  return value
}

/**
 * 拒绝宿主未拦截的未知顶层参数（宿主不执行 `additionalProperties`）。
 *
 * 多个未知参数时按字典序取第一个报错，保证错误文案稳定可测。
 * @param args - 已确认是普通对象的参数。
 * @param allowed - 该工具声明的顶层参数名。
 */
function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key)).sort()
  const first = unknown[0]
  if (first !== undefined) throw new Error(`参数错误：未知参数 "${first}"`)
}

/**
 * 按字符（码点）截断文本，超出时以省略号结尾。
 * @param text - 原始文本。
 * @param maximum - 最大显示字符数（含省略号）。
 * @returns 截断后的文本。
 */
function clipText(text: string, maximum: number): string {
  const points = [...text]
  if (points.length <= maximum) return text
  return `${points.slice(0, Math.max(maximum - 1, 0)).join('')}…`
}

/** 挂起消息在模型可见渲染里的 preview 上限（字符）。 */
const RENDER_PREVIEW_CHARS = 120

/** 取运行时验证过的调用方；缺失时直接失败。 */
function callerOf(exec: ToolExecution, tool: string): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${tool} 需要调用方 Agent（exec.agent 为空）`)
  }
  return { agent, identity: identityOf(agent) }
}

/** 目标 id/name 对，发送结果与候选共用。 */
const targetSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['id', 'name'],
}

/** 呈现给审批者的一行挂起消息。 */
const heldSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string' },
    sender: { type: 'string' },
    sender_id: { type: 'string' },
    summary: { type: 'string' },
    preview: { type: 'string' },
    created_at: { type: 'integer' },
    expires_at: { type: 'integer' },
  },
  required: ['message_id', 'sender', 'sender_id', 'summary', 'preview', 'created_at', 'expires_at'],
}

/** 一条裁决结果。 */
const outcomeSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string' },
    sender: { type: 'string' },
    status: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['message_id', 'sender', 'status'],
}

/**
 * 构造 `list_session_agents` 工具。
 * @param service - 应用服务。
 * @returns 可注册的工具定义。
 */
export function createListTool(service: MessagingService): ToolDefinition {
  return {
    name: 'list_session_agents',
    description:
      'List the sessions you are allowed to message. Each row carries a display name, session id, short id, '
      + 'working directory, whether the workspace matches yours, whether it is running, idle, or offline '
      + '(persisted but not loaded, wakeable by a message), and its kind (peer, subagent, teammate). Address a '
      + 'row by its name or its exact session id in send_session_message. Your own subagents are always listed; '
      + 'include_subagents only adds other sessions\' subagents. Inactive teammates remain addressable. Sessions '
      + 'you may not message are counted in `omitted`; rows omitted only because of `limit` are counted in '
      + '`truncated`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_subagents: {
          type: 'boolean',
          description: 'Include other sessions\' subagents; your own subagents are always listed. Defaults to false.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return, between 1 and 200. Defaults to 50.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                id: { type: 'string' },
                short_id: { type: 'string' },
                cwd: { type: 'string' },
                workspace: { type: 'string' },
                state: { type: 'string' },
                kind: { type: 'string' },
                sendable: { type: 'boolean' },
              },
              required: ['name', 'id', 'short_id', 'cwd', 'workspace', 'state', 'kind', 'sendable'],
            },
          },
          omitted: { type: 'integer' },
          truncated: { type: 'integer' },
        },
        required: ['agents', 'omitted', 'truncated'],
      },
      render: (_args, value) => {
        const result = value as {
          agents: {
            name: string
            id: string
            short_id: string
            cwd: string
            workspace: string
            state: string
            kind: string
            sendable: boolean
          }[]
          omitted: number
          truncated: number
        }
        if (result.agents.length === 0) {
          return [{ type: 'text', text: '当前没有可见、可发消息的会话' } satisfies ContentBlock]
        }
        const lines = result.agents.map(row => {
          const cwd = row.cwd === '' ? '未记录' : row.cwd
          const sendable = row.sendable === false ? '，不可发送' : ''
          return `- ${row.name}（id: ${row.id}，short_id: ${row.short_id}，state: ${row.state}，`
            + `kind: ${row.kind}，workspace: ${row.workspace}，cwd: ${cwd}${sendable}）`
        })
        const hidden = result.omitted > 0 ? `（另有 ${result.omitted} 个会话不可见）` : ''
        const cut = result.truncated > 0 ? `（结果被 limit 截断，另有 ${result.truncated} 行未返回）` : ''
        const suffix = hidden === '' && cut === '' ? '' : `\n${hidden}${cut}`
        return [{ type: 'text', text: `${lines.join('\n')}${suffix}` } satisfies ContentBlock]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['include_subagents', 'limit'])
      const includeSubagents = optionalBoolean(parsed, 'include_subagents') ?? false
      const limit = optionalInteger(parsed, 'limit', 1, 200)
      const caller = callerOf(exec, 'list_session_agents')
      const result = await service.list(caller, {
        includeSubagents,
        ...limit === undefined ? {} : { limit },
        signal: exec.signal,
      })
      return {
        agents: result.agents.map(row => ({
          name: row.name,
          id: row.id,
          short_id: row.shortId,
          cwd: row.cwd,
          workspace: row.workspace,
          state: row.state,
          kind: row.kind,
          sendable: row.sendable,
        })),
        omitted: result.omitted,
        truncated: result.truncated,
      }
    },
  }
}

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
          status: { type: 'string' },
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
        const where = result.target === undefined ? '' : ` 发给 ${result.target.name}`
        const lines = [`${result.status}${where}：${result.detail}（message_id: ${result.message_id}）`]
        if (result.candidates !== undefined && result.candidates.length > 0) {
          lines.push('候选会话（请改用精确 session id）：')
          for (const candidate of result.candidates) {
            lines.push(`- ${candidate.name}（${candidate.id}）`)
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
          const detail = outcome.detail === undefined || outcome.detail === '' ? '' : `：${outcome.detail}`
          if (outcome.status === 'not_found') {
            lines.push(`- 未找到${outcome.message_id === '' ? '' : `（${outcome.message_id}）`}${detail}`)
            continue
          }
          lines.push(`- ${outcome.status} ${outcome.message_id}，来自 ${outcome.sender || '未知会话'}${detail}`)
        }
        if (result.held.length > 0) {
          lines.push(`仍有 ${result.held.length} 条消息挂起：`)
          for (const entry of result.held) {
            const preview = clipText(entry.preview ?? '', RENDER_PREVIEW_CHARS)
            const previewPart = preview === '' ? '' : ` — ${preview}`
            lines.push(
              `- ${entry.sender}：${entry.summary}${previewPart}（截止 ${new Date(entry.expires_at).toISOString()}）`,
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
