/**
 * 会话日志与记录相关的结构契约（`../types.ts` 的子模块）。
 *
 * 插件刻意不在运行时或构建期导入任何 `@deepseek-ai/dsh-*` 包：它是 bundle
 * 插件，必须在不同 alpha 版本之间继续可用，因此只声明自己用到的服务切片，
 * 真实对象由 Cordis 传入。本文件只做类型声明。
 *
 * @module dsh-plugin-session-messaging/types/session
 */

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

/** 会话标题投影切片。 */
export interface SessionTitleService {
  get(session: Session): { readonly title: string } | undefined
}
