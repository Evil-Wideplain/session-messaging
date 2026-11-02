/**
 * 本插件用到的 DSH 服务的本地结构契约。
 *
 * 插件刻意不在运行时或构建期导入任何 `@deepseek-ai/dsh-*` 包：它是 bundle
 * 插件，必须在不同 alpha 版本之间继续可用，因此只声明自己用到的服务切片，
 * 真实对象由 Cordis 传入。这些结构已对照 0.2.x 源码核对；0.1.3-alpha.1 时期的
 * 核对记录保留在 docs/research/，不再作为当前运行时的依据。
 * 注意：本文件只做类型声明，构建产物里不会留下对 `@deepseek-ai/dsh-*` 的 import。
 *
 * @module dsh-plugin-session-messaging/types
 */

import type { Context } from '@deepseek-ai/cordis'

/** 持久的会话标识（本插件按不透明字符串处理）。 */
export type SessionId = string

/** 一个面向模型的内容块。 */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** 每条 user 消息携带的生产者来源（kind 是开放字符串）。 */
export interface MessageSource {
  readonly kind: string
  readonly form?: string
  readonly [key: string]: unknown
}

/** 本插件唯一产出的消息形状：user 角色文本消息。 */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

/** 一条只追加的会话事件（只声明本插件读取的字段）。 */
export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** 持久的会话元数据。 */
export interface SessionHeader {
  readonly id: SessionId
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly origin?: 'subagent'
  readonly isSeeded?: boolean
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** 一份在线会话日志。 */
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  /** 本会话自己的事件（不含 fork 继承的前缀）。 */
  ownEvents(): readonly SessionEvent[]
}

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

/** 工具执行时看到的上下文。 */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** `ctx.tools.register` 接受的结构形状。 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

/** 工具注册表切片。 */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** Agent 注册表切片。 */
export interface AgentsService {
  list(): Agent[]
  get(id: SessionId): Agent | undefined
  resume(options: {
    readonly resumeSessionId: SessionId
    readonly agentOptions?: Record<string, unknown>
    readonly setup?: (agentCtx: Context) => void | Promise<void>
    readonly signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** 会话存储切片。 */
export interface SessionsService {
  get(id: SessionId): Session | undefined
  /** 刷新会话的持久化写入路径；持久化成功时 resolve true。 */
  flush(session: Session): Promise<boolean>
}

/** 会话标题投影切片。 */
export interface SessionTitleService {
  get(session: Session): { readonly title: string } | undefined
}

/** 持久化会话语料中的一行。 */
export interface SessionRecord {
  readonly header: SessionHeader
  readonly live: boolean
  readonly persisted: boolean
}

/** 对某个会话的只读观察快照。 */
export interface SessionObservation {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: number
}

/** 会话查询切片（冷读 + 语料列举）。 */
export interface SessionQueryService {
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  observeSession(id: SessionId, options?: {
    readonly signal?: AbortSignal
    readonly projectionMode?: 'none'
  }): Promise<SessionObservation>
}

/** 持久化读取句柄。 */
export interface PersistedSessionHandle {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  /** 运行时返回 `{ events, eventState }`；为兼容旧宿主也接受纯事件数组。 */
  read(from: number, to?: number, options?: { readonly signal?: AbortSignal }): Promise<
    | readonly SessionEvent[]
    | { readonly events: readonly SessionEvent[]; readonly eventState?: string }
  >
  close(): Promise<void>
}

/** 会话持久化切片。 */
export interface SessionPersistenceService {
  open(id: SessionId, mode: 'read', options?: { readonly signal?: AbortSignal }): Promise<PersistedSessionHandle>
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

/**
 * Workspace 注册表切片（可选）。
 *
 * DSH 的归档门禁（`ArchivedSessionGate`）会用这份集合拒绝归档会话的模型 step，
 * 被拒的回合以 `turn/end {reason:{kind:"blocked"}}` 收口且不产生 `agent/error`。
 * 投递前必须查这里，不能靠错误探针判断。
 */
export interface WorkspaceRegistryService {
  /** 已归档的会话 id（归档顺序）。 */
  readonly archivedSessionIds: readonly string[]
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

/** shell 环境注册表切片（`ctx.shellEnv`）。 */
export interface ShellEnvRegistry {
  register(contributor: {
    readonly name: string
    readonly variables: Readonly<Record<string, { readonly description: string }>>
    resolve(execution: ToolExecution): Readonly<Record<string, string>>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
    agents: AgentsService
    sessions: SessionsService
    sessionTitle?: SessionTitleService
    sessionQuery?: SessionQueryService
    sessionPersistence?: SessionPersistenceService
    agentTeams?: AgentTeamsService
    subagents?: SubagentsService
    shellEnv?: ShellEnvRegistry
    agentPresets?: AgentPresetsService
    agentDefaultModel?: AgentDefaultModelService
    workspaceRegistry?: WorkspaceRegistryService
  }

  interface Events {
    'agent/created'(payload: { readonly agent: Agent }): void
    'agent/disposed'(payload: { readonly agent: Agent }): void
    'agent/error'(payload: { readonly agent: Agent; readonly error: Error }): void
    /** 会话日志事件；`turn/end` 的 `blocked` 是归档门禁的唯一可观察出口。 */
    'session/event'(session: Session, event: SessionEvent): void
  }
}
