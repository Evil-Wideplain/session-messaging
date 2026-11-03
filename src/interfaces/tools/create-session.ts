/**
 * `create_session_agent` 模型工具：创建普通（root）会话并投递首条消息。
 *
 * 新会话是调用方的对等会话（peer），不是子代理；本工具只负责参数校验与
 * 返回值投影，创建/标题/preset/首条消息落库全部在应用服务里完成。
 *
 * prompt 只校验类型（缺失/非字符串才抛参数错误）：空/纯空白是应用层要判定的
 * 业务拒绝，应返回 `status: refused`，而不是让工具抛异常。
 *
 * @module session-messaging/interfaces/tools/create-session
 */

import type { CreateSessionStatus } from '../../application/dto.ts'
import type { SessionCreationService } from '../../application/session-creation-service.ts'
import type { ContentBlock, ToolDefinition } from '../../types.ts'
import {
  asObject,
  callerOf,
  inlineText,
  optionalBoolean,
  optionalString,
  rejectUnknown,
  requiredText,
} from './shared.ts'

/** 创建终态；schema enum 与 DTO `CreateSessionStatus` 对齐。 */
const CREATE_STATUSES: readonly CreateSessionStatus[] = ['accepted', 'refused', 'failed']

/**
 * 构造 `create_session_agent` 工具：创建普通（root）会话并投递首条消息。
 * @param service - 创建会话应用服务。
 * @returns 可注册的工具定义。
 */
export function createCreateSessionAgentTool(service: SessionCreationService): ToolDefinition {
  return {
    name: 'create_session_agent',
    description:
      'Create a new independent root session and deliver the first message into it. The new session is a peer '
      + 'of yours (not a subagent): it appears as its own session and can later be addressed with '
      + 'send_session_message or list_session_agents. The first message is delivered as a session message from '
      + 'you, framed the same way as send_session_message, and starts the new session\'s first turn '
      + 'asynchronously; the call returns once the message is admitted, not when that turn finishes. Use it '
      + 'when the user wants to start a separate conversation or a parallel workstream, not for delegating a '
      + 'one-off subtask (use the official subagent / spawn_teammate tools for that). Statuses: accepted (session '
      + 'created and first message admitted), refused (creation disabled, caller is a subagent, location not '
      + 'allowed, rate limit, empty or oversized prompt), failed (DSH rejected the creation, or the first '
      + 'message could not be admitted; session_id may still be returned so you can retry with '
      + 'send_session_message).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'First message the new session receives; it is framed as a session message from you. '
            + 'An empty or whitespace-only prompt is refused (status refused); prompts over maxMessageBytes '
            + 'are refused too.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the new session. Defaults to your own working directory; '
            + 'creating in a different directory requires allowCrossWorkspace or an allowlist entry. When cwd '
            + 'exactly matches a registered workspace root, the session is grouped into that workspace.',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace: a workspace id (from the GUI session list) or the absolute path of a '
            + 'registered workspace. The session is created in that workspace root and grouped there. Cannot be '
            + 'combined with a different cwd. Creating in another workspace still requires allowCrossWorkspace or '
            + 'an allowlist entry.',
        },
        ensure_workspace: {
          type: 'boolean',
          description: 'Only with cwd or a workspace path: create the directory if missing and register it as a '
            + 'workspace (same effect as adding the folder in the GUI), then create the session inside it. '
            + 'Requires allowCreateWorkspace; registration happens only after the location is authorized.',
        },
        title: {
          type: 'string',
          description: 'Optional session title, written before the first turn starts.',
        },
        agent_preset: {
          type: 'string',
          description: 'Optional Agent preset id for the new session; resolved and mounted by DSH.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: CREATE_STATUSES },
          session_id: { type: 'string' },
          short_id: { type: 'string' },
          cwd: { type: 'string' },
          workspace_id: { type: 'string' },
          title: { type: 'string' },
          agent_preset: { type: 'string' },
          message_id: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['status', 'session_id', 'short_id', 'cwd', 'message_id', 'detail'],
      },
      render: (_args, value) => {
        const result = value as {
          status: 'accepted' | 'refused' | 'failed'
          session_id: string
          short_id: string
          cwd: string
          workspace_id?: string
          title?: string
          agent_preset?: string
          message_id: string
          detail: string
        }
        const detail = inlineText(result.detail)
        if (result.status === 'refused') {
          return [{ type: 'text', text: `拒绝创建会话：${detail}` } satisfies ContentBlock]
        }
        if (result.session_id === '') {
          // detail 已带「创建会话失败：」前缀（应用服务只会在这个分支返回空 session_id）。
          return [{ type: 'text', text: detail } satisfies ContentBlock]
        }
        const name = inlineText(result.title ?? result.short_id)
        const lines = [
          `${result.status === 'accepted' ? '已创建会话' : '会话已创建但首条消息未投递'}「${name}」`
          + `（session_id: ${inlineText(result.session_id)}，short_id: ${inlineText(result.short_id)}，`
          + `cwd: ${inlineText(result.cwd)}）`,
        ]
        if (result.workspace_id !== undefined) lines.push(`workspace_id: ${inlineText(result.workspace_id)}`)
        if (result.agent_preset !== undefined) lines.push(`agent_preset: ${inlineText(result.agent_preset)}`)
        if (detail !== '') lines.push(detail)
        lines.push(`首条消息 message_id: ${inlineText(result.message_id)}`)
        if (result.status === 'accepted') {
          lines.push('新会话会自行跑第一轮；后续可用 send_session_message 以该 session_id 继续投递，'
            + '或用 list_session_agents 查看它的状态。')
        }
        return [{ type: 'text', text: lines.join('\n') } satisfies ContentBlock]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['prompt', 'cwd', 'workspace', 'ensure_workspace', 'title', 'agent_preset'])
      const prompt = requiredText(parsed, 'prompt')
      const cwd = optionalString(parsed, 'cwd')
      const workspace = optionalString(parsed, 'workspace')
      const ensureWorkspace = optionalBoolean(parsed, 'ensure_workspace')
      const title = optionalString(parsed, 'title')
      const agentPreset = optionalString(parsed, 'agent_preset')
      const caller = callerOf(exec, 'create_session_agent')
      const result = await service.create(caller, {
        prompt,
        ...cwd === undefined ? {} : { cwd },
        ...workspace === undefined ? {} : { workspace },
        ...ensureWorkspace === undefined ? {} : { ensureWorkspace },
        ...title === undefined ? {} : { title },
        ...agentPreset === undefined ? {} : { agentPreset },
      }, exec.signal)
      return {
        status: result.status,
        session_id: result.sessionId,
        short_id: result.shortId,
        cwd: result.cwd,
        ...result.workspaceId === undefined ? {} : { workspace_id: result.workspaceId },
        ...result.title === undefined ? {} : { title: result.title },
        ...result.agentPreset === undefined ? {} : { agent_preset: result.agentPreset },
        message_id: result.messageId,
        detail: result.detail,
      }
    },
  }
}
