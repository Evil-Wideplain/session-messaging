/**
 * 会话目标（领域值对象）。
 *
 * 这是「可以给谁发消息」在领域里的唯一表示：一个会话的标识、工作目录、
 * 参与关系（普通会话 / 子代理 / 团队成员）以及当前是否在线。
 *
 * 只描述业务概念，不持有 Cordis 上下文或 Agent 实例——在线状态是快照，
 * 真正的运行时对象由基础设施层按需读取。
 *
 * @module session-messaging/domain/target
 */

/** 会话在寻址语境中的参与关系。 */
export type SessionKind = 'peer' | 'subagent' | 'teammate'

/** 会话当前的可投递状态。 */
export type SessionStatus = 'running' | 'idle' | 'offline'

/** 一个可寻址的会话目标。 */
export interface SessionTarget {
  /** 会话标识，等于 session id。 */
  readonly id: string
  /** 工作目录；冷会话缺失时表示无法判断 workspace 归属。 */
  readonly cwd?: string
  /** 父会话标识，仅子代理会话有值。 */
  readonly parentSession?: string
  /** 最近一次记录的标题，用于显示名。 */
  readonly title?: string
  /** 团队名册里的成员名；只有队友目标才有。 */
  readonly teamMemberName?: string
  /** 显式显示名（团队名册名）；优先于标题。 */
  readonly name?: string
  /** 参与关系：普通会话、子代理还是团队成员。 */
  readonly kind: SessionKind
  /** 快照状态：running / idle / offline。 */
  readonly status: SessionStatus
  /**
   * 是否被用户归档（或位于归档会话的子代理血脉下）。
   *
   * 归档会话仍会被 DSH 恢复，但归档门禁会拒绝它的模型 step，回合以 `blocked`
   * 收口且消息不会进入 `user/message`——投递前必须先看这个标记。
   */
  readonly archived?: boolean
}

/** 地址没有匹配到任何会话。 */
export class TargetNotFound extends Error {
  /**
   * @param address - 用户输入的原始地址。
   */
  constructor(readonly address: string) {
    super(`没有匹配 "${address}" 的会话`)
    this.name = 'TargetNotFound'
  }
}

/** 地址匹配到多个会话，需要用户改用精确 id。 */
export class TargetAmbiguous extends Error {
  /**
   * @param address - 用户输入的原始地址。
   * @param candidates - 命中的候选会话。
   */
  constructor(readonly address: string, readonly candidates: readonly SessionTarget[]) {
    super(`地址 "${address}" 匹配到 ${candidates.length} 个会话`)
    this.name = 'TargetAmbiguous'
  }
}

/**
 * 去掉引号、首尾空白并折叠内部空白，再做大小写归一，用于匹配标题。
 * @param input - 用户输入的地址。
 * @returns 归一化后的匹配串。
 */
export function normalizeAddress(input: string): string {
  let value = input.trim()
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
    value = value.slice(1, -1)
  }
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * 会话标识的短写：去掉 `session-` 前缀后取 8 个字符，便于模型引用。
 * @param id - 会话标识。
 * @returns 供展示与引用的短 id。
 */
export function shortIdOf(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length, 'session-'.length + 8) : id.slice(0, 8)
}

/**
 * 会话的显示名：优先显式名称（团队名册），再标题，最后回退为短 id。
 * @param id - 会话标识。
 * @param title - 已记录的标题。
 * @param name - 显式名称（可选）。
 * @returns 展示用名称。
 */
export function displayName(id: string, title: string | undefined, name?: string): string {
  if (name !== undefined && name !== '') return name
  if (title !== undefined && title !== '') return title
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
  return `session-${bare.slice(0, 8)}`
}

/**
 * 目标的显示名，统一处理显式名称与标题。
 * @param target - 会话目标。
 * @returns 展示用名称。
 */
export function targetName(target: SessionTarget): string {
  return displayName(target.id, target.title, target.name)
}

/**
 * 判断一个会话头描述的是子代理还是普通会话。
 * @param header - 会话头（只取本领域关心的两个字段）。
 * @param header.origin - 会话来源标记。
 * @param header.delegationDepth - 委派深度。
 * @returns 子代理会话返回 true。
 */
export function isSubagentSession(header: {
  readonly origin?: string
  readonly delegationDepth?: number
}): boolean {
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}
