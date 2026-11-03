/**
 * 跨会话投递的授权规则（领域服务）。
 *
 * 身份永远来自运行时（工具调用的 `exec.agent`、bus token、账本记录），
 * 消息正文和 `source` 里的任何字段都不能冒充发送者。这里只做纯规则判断，
 * 不读取文件、不访问服务、也不探测平台：大小写敏感性与路径语义都由调用方
 * 作为事实传进来，测试可以在任意平台上覆盖两条分支。
 *
 * 判定顺序：不能发给自己 → 子代理归属 → 同 workspace → 例外清单 → 跨 workspace。
 * 例外清单（allowlist）只用于「放开 workspace 策略」，不能替别人接管子代理，
 * 因此必须排在子代理归属之后。
 *
 * 另有 {@link authorizeCwd}：创建会话时的目录授权（同一套 workspace 策略，
 * 但没有「目标会话」这个值对象，也不该靠伪造目标复用投递判定）。
 *
 * @module dsh-plugin-session-messaging/domain/authorization
 */

import type { Agent } from '../types.ts'
import type { SessionTarget } from './target.ts'

/** 拒绝投递的原因码。 */
export type DenyCode =
  | 'self'
  | 'subagent-of-other'
  | 'cross-workspace'
  | 'cwd-unknown'

/** 一次授权判断的结果。 */
export interface AuthorizationDecision {
  /** 是否允许。 */
  readonly allowed: boolean
  /** 拒绝原因码，仅拒绝时存在。 */
  readonly code?: DenyCode
  /** 面向模型/用户的拒绝说明，仅拒绝时存在。 */
  readonly reason?: string
}

/** 发送方身份，来自运行时，不可伪造。 */
export interface CallerIdentity {
  /** 会话标识。 */
  readonly id: string
  /** 会话的工作目录。 */
  readonly cwd?: string
}

/** 授权策略（部署配置的一部分）。 */
export interface AuthPolicy {
  /** 是否允许跨 workspace 投递。 */
  readonly allowCrossWorkspace: boolean
  /** 例外清单：会话 id 或目录前缀。 */
  readonly allowlist: readonly string[]
  /** 路径比较是否忽略大小写；Windows 为 true，由组合根从运行时探测后注入。 */
  readonly caseInsensitivePaths?: boolean
}

/**
 * 把路径拆成分段，并按目录语义处理 `.` 与 `..`。
 *
 * 不使用 `node:path`：领域层保持零运行时依赖，同时避免把「分隔符是哪个」
 * 交给平台去猜——`C:/a`、`C:\a`、`C:\a\..\a` 在两种平台上都按同一套分段规则处理。
 * @param path - 原始路径。
 * @param caseInsensitive - 是否折叠分段大小写。
 * @returns 归一化后的路径分段。
 */
function pathSegments(path: string, caseInsensitive: boolean): string[] {
  const segments: string[] = []
  for (const part of path.split(/[\\/]+/u)) {
    if (part === '' || part === '.') continue
    // `..` 回退一层：allowlist 里的 `/repo/../other` 不能把自己算进 `/repo`。
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(caseInsensitive ? part.toLowerCase() : part)
  }
  return segments
}

/**
 * 比较两个工作目录是否指向同一处。
 * @param left - 第一个目录。
 * @param right - 第二个目录。
 * @param caseInsensitivePaths - 是否忽略大小写。
 * @returns 视为同一 workspace 时返回 true；任一侧为空时返回 false（没有 cwd 谈不上相同）。
 */
export function sameCwd(left: string, right: string, caseInsensitivePaths = false): boolean {
  const a = pathSegments(left, caseInsensitivePaths)
  const b = pathSegments(right, caseInsensitivePaths)
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return a.every((segment, index) => segment === b[index])
}

/**
 * 判断 `cwd` 是否位于 `prefix` 目录之下（含相等）。
 * @param cwd - 待判断的目录。
 * @param prefix - 目录前缀。
 * @param caseInsensitivePaths - 是否忽略大小写。
 * @returns 位于其下返回 true。
 */
function isPathInside(cwd: string, prefix: string, caseInsensitivePaths: boolean): boolean {
  const child = pathSegments(cwd, caseInsensitivePaths)
  const parent = pathSegments(prefix, caseInsensitivePaths)
  if (parent.length === 0 || parent.length > child.length) return false
  return parent.every((segment, index) => segment === child[index])
}

/** 例外清单的目录前缀是否命中某个路径（路径未提供时视为不命中）。 */
function allowlistedPath(
  path: string | undefined,
  allowlist: readonly string[],
  caseInsensitivePaths: boolean,
): boolean {
  if (path === undefined) return false
  return allowlist.some(entry => entry !== '' && isPathInside(path, entry, caseInsensitivePaths))
}

/** 例外清单是否命中某个目标：精确会话 id，或目录前缀命中目标 cwd。 */
function allowlisted(target: SessionTarget, allowlist: readonly string[], caseInsensitivePaths: boolean): boolean {
  if (allowlist.some(entry => entry !== '' && entry === target.id)) return true
  return allowlistedPath(target.cwd, allowlist, caseInsensitivePaths)
}

/**
 * 判断发送方能否向目标投递。
 * @param identity - 运行时给出的发送方身份。
 * @param target - 目标会话。
 * @param policy - 部署授权策略。
 * @returns 判断结果；拒绝时带上稳定原因码和模型可读说明。
 */
export function authorize(identity: CallerIdentity, target: SessionTarget, policy: AuthPolicy): AuthorizationDecision {
  const caseInsensitive = policy.caseInsensitivePaths === true
  if (target.id === identity.id) {
    return { allowed: false, code: 'self', reason: '不能给发送方自己发消息' }
  }
  if (target.kind === 'subagent') {
    // 归属判断先于 allowlist：例外清单是给 workspace 策略开口子的，
    // 不是把别人的子代理交给任意会话的授权。
    if (target.parentSession === identity.id) return { allowed: true }
    return {
      allowed: false,
      code: 'subagent-of-other',
      reason: '该子代理属于其他会话，请让它的主会话代为转达',
    }
  }

  const listed = allowlisted(target, policy.allowlist, caseInsensitive)
  if (target.cwd === undefined) {
    // 没有 cwd 就无法判断是否同 workspace：只有显式放行才允许。
    return listed
      ? { allowed: true }
      : { allowed: false, code: 'cwd-unknown', reason: '目标会话没有记录工作目录，未在 allowlist 中显式放行' }
  }
  if (identity.cwd !== undefined && sameCwd(identity.cwd, target.cwd, caseInsensitive)) return { allowed: true }
  if (listed) return { allowed: true }
  if (policy.allowCrossWorkspace) return { allowed: true }
  // 不回显目标 cwd：未授权调用方不该通过拒绝文案探测它。
  return {
    allowed: false,
    code: 'cross-workspace',
    reason: '跨 workspace 投递已关闭；可开启 allowCrossWorkspace 或把目标加入 allowlist',
  }
}

/**
 * 判断发送方能否在某个目录里创建会话。
 *
 * 创建会话会让新 Agent 在目录里拥有写权限，因此复用投递侧的 workspace 策略：
 * 与调用方 cwd 相同、命中 allowlist 目录前缀、或放开 allowCrossWorkspace 才允许。
 * 这里不构造伪目标、也不做「不能发给自己」之类的投递专属判断，避免语义靠巧合成立。
 * @param identity - 运行时给出的调用方身份。
 * @param cwd - 待创建会话的目录（绝对路径，调用方已做格式校验）。
 * @param policy - 部署授权策略。
 * @returns 判断结果；拒绝时带上稳定原因码和模型可读说明。
 */
export function authorizeCwd(identity: CallerIdentity, cwd: string, policy: AuthPolicy): AuthorizationDecision {
  const caseInsensitive = policy.caseInsensitivePaths === true
  if (identity.cwd !== undefined && sameCwd(identity.cwd, cwd, caseInsensitive)) return { allowed: true }
  if (allowlistedPath(cwd, policy.allowlist, caseInsensitive)) return { allowed: true }
  if (policy.allowCrossWorkspace) return { allowed: true }
  return {
    allowed: false,
    code: 'cross-workspace',
    reason: '目标目录不在允许的 workspace 内；可开启 allowCrossWorkspace 或把目录加入 allowlist',
  }
}

/**
 * 从运行时 Agent 派生发送方身份。
 * @param agent - 在线 Agent。
 * @returns 只含 id 与 cwd 的身份。
 */
export function identityOf(agent: Agent): CallerIdentity {
  const cwd = agent.session.header.cwd
  return { id: agent.id, ...cwd === undefined ? {} : { cwd } }
}
