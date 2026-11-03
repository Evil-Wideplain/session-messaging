/**
 * `list_session_agents` 模型工具：列出调用方可见、可发送的会话。
 *
 * 只做参数校验与 DTO 投影（camelCase → snake_case），可见性判定与排序
 * 全部在应用服务里完成；render 里的会话名/cwd 等来自其他会话，先过
 * `inlineText` 再拼成「一行一条」。
 *
 * @module session-messaging/interfaces/tools/list
 */

import type { ListRow } from '../../application/dto.ts'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '../../application/messaging/deps.ts'
import type { MessagingService } from '../../application/messaging-service.ts'
import type { ContentBlock, ToolDefinition } from '../../types.ts'
import { asObject, callerOf, inlineText, optionalBoolean, optionalInteger, rejectUnknown } from './shared.ts'

/** `workspace` 列的合法取值（与 DTO `ListRow.workspace` 对齐）。 */
const WORKSPACE_RELATIONS: readonly ListRow['workspace'][] = ['same', 'different', 'unknown']

/** `state` 列的合法取值（与 DTO `ListRow.state` 对齐）。 */
const SESSION_STATES: readonly ListRow['state'][] = ['running', 'idle', 'offline']

/** `kind` 列的合法取值（与 DTO `ListRow.kind` 对齐）。 */
const SESSION_KINDS: readonly ListRow['kind'][] = ['peer', 'subagent', 'teammate']

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
          // 范围直接复用应用层常量：服务端 clamp 与工具校验必须是同一个上限。
          minimum: 1,
          maximum: LIST_MAX_LIMIT,
          description: `Maximum rows to return, between 1 and ${LIST_MAX_LIMIT}. Defaults to ${LIST_DEFAULT_LIMIT}.`,
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
                workspace: { type: 'string', enum: WORKSPACE_RELATIONS },
                state: { type: 'string', enum: SESSION_STATES },
                kind: { type: 'string', enum: SESSION_KINDS },
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
          const cwd = row.cwd === '' ? '未记录' : inlineText(row.cwd)
          const sendable = row.sendable === false ? '，不可发送' : ''
          return `- ${inlineText(row.name)}（id: ${inlineText(row.id)}，short_id: ${inlineText(row.short_id)}，`
            + `state: ${inlineText(row.state)}，kind: ${inlineText(row.kind)}，`
            + `workspace: ${inlineText(row.workspace)}，cwd: ${cwd}${sendable}）`
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
      const limit = optionalInteger(parsed, 'limit', 1, LIST_MAX_LIMIT)
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
