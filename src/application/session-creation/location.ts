/**
 * 创建会话的位置解析（应用层策略）。
 *
 * 把模型给的「工作区 id / 工作区路径 / 目录 / 什么都不给」翻译成一个可创建
 * 会话的目录，并在此处完成 workspace 授权（复用投递侧策略）。真正的工作区
 * 登记（`ensure_workspace`）不在这里做：授权通过后才允许产生副作用。
 *
 * 安全约束：`workspace` 传工作区 id 时，「未登记」与「已登记但未授权」必须
 * 返回完全相同的回包（含 cwd 字段），否则调用方可以用文案差异枚举工作区
 * 登记状态；只有绝对路径写法保留可操作的提示。
 *
 * @module dsh-plugin-session-messaging/application/session-creation/location
 */

import { isAbsolute } from 'node:path'
import type { CallerIdentity } from '../../domain/authorization.ts'
import { authorizeCwd, sameCwd } from '../../domain/authorization.ts'
import { messageOf, nonBlank } from '../../domain/util.ts'
import type { WorkspaceResolver, WorkspaceTarget } from '../ports.ts'

/**
 * 工作区不可用时的统一文案。
 *
 * 未登记的工作区 id、已登记但未授权、以及相对路径形式的非法 workspace 都用它：
 * 文案（以及回包里的 cwd）一旦有差异，就变成「工作区是否存在 / 根目录是什么」的
 * 枚举 oracle。
 */
const UNAVAILABLE_WORKSPACE_DETAIL =
  '无法在该位置创建会话：工作区不可用或未获授权；'
  + '可开启 allowCrossWorkspace / allowlist 或换到调用方 cwd'

/** 一次位置解析的输入。 */
export interface LocationInput {
  /** 模型给的 Workspace id 或绝对路径。 */
  readonly workspace?: string
  /** 是否允许登记未登记的目录（`ensure_workspace`）。 */
  readonly ensureWorkspace: boolean
  /** 模型给的目录。 */
  readonly cwd?: string
  /** 调用方身份（含自己的工作目录）。 */
  readonly identity: CallerIdentity
  /** 部署的 workspace 授权策略。 */
  readonly policy: {
    readonly allowCrossWorkspace: boolean
    readonly allowlist: readonly string[]
    readonly caseInsensitivePaths: boolean
  }
  /** 部署是否允许登记工作区。 */
  readonly allowCreateWorkspace: boolean
}

/** 位置解析结果：通过时给出会话目录与（可选的）目标 Workspace。 */
export type LocationOutcome =
  | { readonly kind: 'ok'; readonly cwd: string; readonly ensure: boolean; readonly workspace?: WorkspaceTarget }
  | { readonly kind: 'refused'; readonly cwd: string; readonly detail: string }

/**
 * 解析创建会话的位置并做授权。
 * @param resolver - Workspace 解析端口。
 * @param input - 模型参数与部署策略。
 * @returns 通过时给出目录/工作区；否则给出拒绝文案。
 */
export async function resolveLocation(
  resolver: WorkspaceResolver,
  input: LocationInput,
): Promise<LocationOutcome> {
  const requestedCwd = nonBlank(input.cwd)
  const spec = nonBlank(input.workspace)
  const specIsPath = spec !== undefined && isAbsolute(spec)

  let cwd: string
  let workspace: WorkspaceTarget | undefined
  let ensure = false

  if (spec !== undefined) {
    let resolved: WorkspaceTarget | undefined
    try {
      resolved = await resolver.resolve(spec)
    } catch (error) {
      return refused(requestedCwd ?? spec, `解析工作区失败：${messageOf(error)}`)
    }
    if (resolved !== undefined) {
      // 解析到工作区后必须落在它的根目录；id 与路径两种写法都适用。
      // 先解析再比较，才能接受「工作区 id + 指向同一目录的 cwd」这种合法组合。
      if (requestedCwd !== undefined && !sameCwd(requestedCwd, resolved.path, input.policy.caseInsensitivePaths)) {
        return refused(requestedCwd, 'workspace 与 cwd 同时给出时必须指向同一个目录；也可以只传 workspace')
      }
      cwd = resolved.path
      workspace = resolved
    } else if (specIsPath && input.ensureWorkspace) {
      // 尚未登记：先按目录处理，授权通过后再 mkdir + 登记。
      cwd = spec
      ensure = true
    } else if (specIsPath) {
      return refused(
        spec,
        `工作区不存在：${spec}；可传 ensure_workspace: true 创建并登记该目录，或先在 GUI 里添加为工作区`,
      )
    } else {
      // 工作区 id 解析不到：与「解析到但无权」返回同一段文案，且不回显任何路径。
      return refused('', UNAVAILABLE_WORKSPACE_DETAIL)
    }
  } else if (requestedCwd !== undefined) {
    if (!isAbsolute(requestedCwd)) return refused(requestedCwd, `cwd 必须是绝对路径：${requestedCwd}`)
    cwd = requestedCwd
    ensure = input.ensureWorkspace
  } else {
    const callerCwd = nonBlank(input.identity.cwd)
    if (callerCwd === undefined) return refused('', '调用方没有记录工作目录，请显式传入 cwd 或 workspace')
    cwd = callerCwd
    ensure = input.ensureWorkspace
  }

  if (ensure && !input.allowCreateWorkspace) {
    return refused(cwd, '创建工作区已关闭（allowCreateWorkspace=false）')
  }
  const decision = authorizeCwd(input.identity, cwd, input.policy)
  if (!decision.allowed) {
    // id 写法下「未授权」与「未登记」同文案、同空 cwd：不能泄漏工作区根目录。
    if (spec !== undefined && !specIsPath) return refused('', UNAVAILABLE_WORKSPACE_DETAIL)
    return refused(cwd, `不允许在该目录创建会话：${decision.reason ?? '跨 workspace 创建已关闭'}`)
  }
  return { kind: 'ok', cwd, ensure, ...workspace === undefined ? {} : { workspace } }
}

/** 构造一条位置拒绝。 */
function refused(cwd: string, detail: string): LocationOutcome {
  return { kind: 'refused', cwd, detail }
}
