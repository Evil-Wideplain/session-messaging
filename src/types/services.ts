/**
 * 运行时服务切片与注册表（`../types.ts` 的子模块）。
 *
 * 包含 Agent / 会话注册表、Workspace 注册表与会话控制器；真实对象由
 * Cordis 传入。服务是否装配由部署决定，因此除 `tools` / `agents` / `sessions`
 * 之外的切片都是可选的。
 *
 * @module session-messaging/types/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from './agent.ts'
import type { Session, SessionId } from './session.ts'

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

/** `ctx.sessionController.create` 的请求（只声明本插件用到的字段）。 */
export interface SessionCreateRequest {
  /** 加入的 Workspace；与 `cwd` 互斥。 */
  readonly workspaceId?: string
  /** 不指定 Workspace 时会话拥有的目录。 */
  readonly cwd?: string
  /** 复用的空白会话（或新会话的标识）；本插件不传，保证每次都是新会话。 */
  readonly sessionId?: SessionId
  /** Agent preset；由 DSH 解析与挂载。 */
  readonly agentPreset?: string
}

/** `ctx.sessionController.create` 的返回值。 */
export interface SessionCreateValue {
  /** 实际创建或复用的会话标识，可能不等于请求里的 sessionId。 */
  readonly sessionId: SessionId
  /** 该会话运行的 Agent preset（部署配置了名册时才有）。 */
  readonly agentPreset?: string
}

/**
 * 会话控制器切片（可选；GUI/Web 组合才装配）。
 *
 * `create` 是 DSH 唯一的「创建普通（root）会话」产品入口：它负责 mkdir、
 * preset 挂载、模型选择、Workspace attach 与 `api-session/added` 广播。
 * 用 `ctx.agents.create` 自建会得到「插件拥有生命周期」的会话，插件重载即被拆掉，
 * 因此这里优先走控制器。
 */
export interface SessionControllerService {
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
  /** 设置会话标题（可选；标题服务缺席时 DSH 会拒绝）。 */
  rename?(request: {
    readonly sessionId: SessionId
    readonly title: string
  }): Promise<{ readonly title: string; readonly seq: number }>
}

/** Workspace 视图（只声明本插件使用的成员）。 */
export interface WorkspaceView {
  readonly id: string
  /** 规范化（realpath）后的目录路径。 */
  readonly path: string
  /** 侧栏显示名；旧部署可能没有该字段。 */
  readonly title?: string
  /** 归属该 Workspace 的会话（手工顺序）。 */
  readonly sessionIds: readonly string[]
  /** 把一个已存在的会话登记进 Workspace。 */
  attachSession(sessionId: SessionId): Promise<void>
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
  /**
   * 按规范化绝对路径与已登记的 Workspace 精确匹配（不做父目录包含匹配，不创建、不修改）。
   * 目录不存在时 DSH 会拒绝（realpath 失败）；未归属任何 Workspace 的目录返回 undefined。
   */
  resolveByPath?(path: string): Promise<WorkspaceView | undefined>
  /** 按 id 取已登记 Workspace；不存在时返回 undefined。 */
  get?(id: string): WorkspaceView | undefined
  /**
   * 把已存在的目录登记成 Workspace（幂等；已登记时原样复用）。
   * 目录不存在时 DSH 会拒绝，因此调用方需要先创建目录。
   */
  create?(path: string, title?: string): Promise<WorkspaceView>
}
