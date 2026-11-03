/**
 * 应用层数据传输对象（DTO）。
 *
 * 这些形状直接对应工具参数/返回值与 bus 响应，不参与领域规则。
 *
 * @module session-messaging/application/dto
 */

/** 一次发送尝试的终态。 */
export type SendStatus =
  | 'accepted'
  | 'queued'
  | 'held'
  | 'duplicate'
  | 'not_found'
  | 'ambiguous'
  | 'denied'
  | 'self'
  | 'refused'

/** 面向模型的会话身份。 */
export interface TargetInfo {
  readonly id: string
  readonly name: string
}

/** `send_session_message` 的返回值。 */
export interface SendResult {
  readonly status: SendStatus
  readonly messageId: string
  readonly detail: string
  readonly target?: TargetInfo
  readonly candidates?: readonly TargetInfo[]
  /** `held` 状态下的审批截止时间。 */
  readonly expiresAt?: number
}

/** `list_session_agents` 的一行。 */
export interface ListRow {
  readonly name: string
  readonly id: string
  readonly shortId: string
  readonly cwd: string
  readonly workspace: 'same' | 'different' | 'unknown'
  readonly state: 'running' | 'idle' | 'offline'
  readonly kind: 'peer' | 'subagent' | 'teammate'
  /**
   * 是否可发送。`include_subagents=true` 时为“仅供了解”而列出的其他会话子代理
   * 会标 false（授权矩阵不允许给对方子代理发消息）。
   */
  readonly sendable: boolean
}

/** `list_session_agents` 的返回值。 */
export interface ListResult {
  readonly agents: readonly ListRow[]
  /** 因策略、归档或他人子代理而隐藏的会话数。 */
  readonly omitted: number
  /** 因 `limit` 截断而未返回的行数。 */
  readonly truncated: number
}

/** 一次发送请求的输入。 */
export interface SendInput {
  readonly to: string
  readonly message: string
  readonly summary?: string
  /** 为 false 时跳过相同正文去重；默认 true。 */
  readonly dedupe?: boolean
}

/** 目标可以对挂起消息执行的动作。 */
export type ReviewAction = 'list' | 'accept' | 'refuse'

/** 呈现给目标的一条挂起消息。 */
export interface HeldRow {
  readonly messageId: string
  readonly sender: string
  readonly senderId: string
  readonly summary: string
  readonly preview: string
  readonly createdAt: number
  readonly expiresAt: number
}

/** 一次裁决的结果。 */
export interface ReviewOutcome {
  readonly messageId: string
  readonly sender: string
  readonly status: 'accepted' | 'refused' | 'denied' | 'failed' | 'expired' | 'not_found'
  readonly detail?: string
}

/** `review_session_messages` 的返回值。 */
export interface ReviewResult {
  readonly held: readonly HeldRow[]
  readonly outcomes: readonly ReviewOutcome[]
}

/** `create_session_agent` 的终态。 */
export type CreateSessionStatus = 'accepted' | 'refused' | 'failed'

/** 一次创建会话请求的输入。 */
export interface CreateSessionInput {
  /** 新会话收到的第一条消息正文。 */
  readonly prompt: string
  /** 新会话的工作目录（绝对路径）；缺省为调用方自己的工作目录。 */
  readonly cwd?: string
  /**
   * 目标工作区：Workspace id，或已登记 Workspace 的绝对路径。
   * 给出时会话建在该 Workspace 的根目录；与 cwd 同时给出时必须指向同一目录。
   */
  readonly workspace?: string
  /**
   * 配合 `cwd` / `workspace` 路径使用：目录不存在时创建、未登记时登记成
   * Workspace（等价于 GUI 的「添加文件夹」），再在该 Workspace 里建会话。
   */
  readonly ensureWorkspace?: boolean
  /** 可选标题；在首轮开始前写入。 */
  readonly title?: string
  /** 可选 Agent preset id，由 DSH 解析并挂载。 */
  readonly agentPreset?: string
}

/** `create_session_agent` 的返回值。 */
export interface CreateSessionResult {
  readonly status: CreateSessionStatus
  /** 新会话标识；创建在 DSH 侧失败时为空字符串。 */
  readonly sessionId: string
  readonly shortId: string
  /** 新会话的工作目录；未能确定时为空字符串。 */
  readonly cwd: string
  /** 会话实际归属的 Workspace id；未归属时缺省。 */
  readonly workspaceId?: string
  /** 首条消息的标识（写在消息 source 上，便于后续对账）。 */
  readonly messageId: string
  readonly detail: string
  /** 成功写入的标题。 */
  readonly title?: string
  /** 新会话实际运行的 Agent preset。 */
  readonly agentPreset?: string
}
