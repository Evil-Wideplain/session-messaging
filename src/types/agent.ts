/**
 * Agent、团队与子代理相关的结构契约（`../types.ts` 的子模块）。
 *
 * 只声明本插件用到的服务切片，真实对象由 Cordis 传入。
 *
 * @module dsh-plugin-session-messaging/types/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Session, SessionId, UserMessage } from './session.ts'

/** 一个在线 Agent 的模型路由选项（恢复时由调用方传入）。 */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly [key: string]: unknown
}

/** 驱动一个会话的在线 Agent。 */
export interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly status: 'idle' | 'running'
  /** 本实例用于请求的模型路由；恢复的 Agent 只有显式传入时才有。 */
  readonly options?: AgentOptions
  /** 把消息排到最近的 step 边界（空闲 Agent 会被唤醒）。 */
  steer(message: UserMessage): void
  /** 排入一个后续 turn（空闲 Agent 会被唤醒）。 */
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
}

/** `ctx.agents.resume` 返回的、由调用方拥有的在线 Agent 句柄。 */
export interface AgentHandle {
  readonly agent: Agent
  dispose(): void | Promise<void>
}

/** 团队名册中的一行。 */
export interface TeamMemberView {
  readonly name: string
  readonly id: SessionId
  readonly role?: 'lead' | 'teammate'
  /** `availability()` 的取值：running / inactive。 */
  readonly status?: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
}

/** Agent Teams 切片（可选实验服务）。 */
export interface AgentTeamsService {
  membership(agent: Agent): { readonly teamId: string } | undefined
  listMembers(agent: Agent): readonly TeamMemberView[]
  sendMessage(agent: Agent, request: {
    readonly target: string
    readonly content: ContentBlock[]
    readonly signal: AbortSignal
  }): Promise<{ readonly messageId: string }>
}

/** 默认模型选择切片（可选；冷唤醒没有历史路由时的兜底）。 */
export interface AgentDefaultModelService {
  currentSelection(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** 子代理切片（可选；只用于调用方自己的可续期子代理）。 */
export interface SubagentsService {
  sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: {
    readonly signal: AbortSignal
  }): Promise<string>
}

/** Agent 预置名册切片（可选；只用于组合被恢复的会话）。 */
export interface AgentPresetsService {
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** 权限预设服务切片（可选；用于让新会话继承调用方的有效权限）。 */
export interface PermissionPresetsService {
  /** 会话当前的有效预设名；无法匹配任何预设时为 `custom`。 */
  current(session: Session): string
  /** 切换会话权限预设；未知名称或 `custom` 会抛错。 */
  set(session: Session, name: string): void
}
