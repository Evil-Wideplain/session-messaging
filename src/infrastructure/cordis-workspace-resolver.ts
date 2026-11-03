/**
 * Workspace 解析/登记适配器（基础设施层实现）。
 *
 * 只做两件事：
 * - `resolve`：把 workspace id 或绝对路径翻译成已登记 Workspace（不创建）；
 * - `ensure`：目录不存在时递归创建，再把目录登记成 Workspace（幂等）。
 *
 * DSH 的 `workspaceRegistry.create` 只接受已存在的目录（内部 realpath），
 * 所以 mkdir 必须在登记之前；登记后的路径以 DSH 返回的规范路径为准。
 *
 * 两个方法都先查已登记记录：幂等调用（目录已登记、只是再确认一次）不需要
 * `create` 能力，也不应该产生副作用。
 *
 * @module dsh-plugin-session-messaging/infrastructure/cordis-workspace-resolver
 */

import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceResolver, WorkspaceTarget } from '../application/ports.ts'
import { messageOf } from '../domain/util.ts'
import type { WorkspaceRegistryService, WorkspaceView } from '../types.ts'

/** Workspace 解析/登记适配器。 */
export class CordisWorkspaceResolver implements WorkspaceResolver {
  /**
   * @param ctx - Cordis 上下文（需要 workspaceRegistry 服务）。
   * @param log - 日志出口（组合根传入 `ctx.logger.warn` 之类的实现）。
   */
  constructor(
    private readonly ctx: Context,
    private readonly log: (message: string) => void,
  ) {}

  /** @inheritdoc */
  async resolve(spec: string): Promise<WorkspaceTarget | undefined> {
    const registry = this.registry()
    const view = isAbsolute(spec)
      ? await this.byPath(registry, spec)
      : registry.get?.(spec)
    return view === undefined ? undefined : targetOf(view)
  }

  /** @inheritdoc */
  async ensure(cwd: string): Promise<WorkspaceTarget> {
    if (!isAbsolute(cwd)) throw new Error(`工作区目录必须是绝对路径：${cwd}`)
    const registry = this.registry()
    // 先查登记记录：已登记的目录不该因为「部署不支持 create」而被判失败。
    const existing = await this.byPath(registry, cwd)
    if (existing !== undefined) return targetOf(existing)
    const create = registry.create
    if (create === undefined) throw new Error('当前部署的 workspaceRegistry 不支持登记工作区')
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error) {
      throw new Error(`创建工作区目录失败：${messageOf(error)}`, { cause: error })
    }
    const view = await create.call(registry, cwd)
    return targetOf(view)
  }

  /** 取注册表；缺席时给出可诊断的错误。 */
  private registry(): WorkspaceRegistryService {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
    if (registry === undefined) {
      throw new Error('当前部署没有 workspaceRegistry 服务，无法按工作区创建会话')
    }
    return registry
  }

  /** 按规范化路径解析；目录不存在时返回 undefined，其它错误向上抛。 */
  private async byPath(
    registry: WorkspaceRegistryService,
    path: string,
  ): Promise<WorkspaceView | undefined> {
    const resolve = registry.resolveByPath
    if (resolve === undefined) return undefined
    try {
      return await resolve.call(registry, path)
    } catch (error) {
      // 目录还没创建时 realpath 必然失败，这属于「未登记」的正常分支；其它错误
      // （权限、注册表故障）若也吞成 undefined，应用层会误报成「工作区不存在」，
      // 并引导模型去登记一个本来就已登记/无法读取的目录。
      if (!missingPath(error)) throw error
      this.log(`[session-messaging] 解析 ${path} 的 Workspace 失败: ${messageOf(error)}`)
      return undefined
    }
  }
}

/** 目录不存在时 DSH 的 realpath 失败（ENOENT/ENOTDIR，或其文本化的等价错误）。 */
function missingPath(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  return error instanceof Error && /ENOENT|ENOTDIR/u.test(error.message)
}

/** 把 Workspace 实体投影成端口形状。 */
function targetOf(view: WorkspaceView): WorkspaceTarget {
  return { id: view.id, path: view.path, title: view.title ?? titleOf(view.path) }
}

/** 用目录最后一段作为缺省显示名。 */
function titleOf(path: string): string {
  const parts = path.split(/[/\\]+/u).filter(part => part !== '')
  return parts.at(-1) ?? path
}
