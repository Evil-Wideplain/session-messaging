/**
 * Workspace 端口（从 `ports.ts` 拆出，保持每文件 ≤200 行）。
 *
 * 创建会话时需要把「工作区 id 或目录」翻译成一个可创建会话的位置；
 * 解析与登记都是运行时细节，由基础设施层实现。
 *
 * @module session-messaging/application/ports-workspace
 */

/** 一个已登记 Workspace 的投影（创建会话用）。 */
export interface WorkspaceTarget {
  /** Workspace 标识。 */
  readonly id: string
  /** 规范化（realpath）后的目录路径。 */
  readonly path: string
  /** 侧栏显示名。 */
  readonly title: string
}

/** Workspace 解析/登记端口：把「工作区 id 或目录」翻译成可创建会话的位置。 */
export interface WorkspaceResolver {
  /**
   * 按 id 或规范化目录路径解析已登记 Workspace（不创建、不修改）。
   * @param spec - Workspace id，或绝对目录路径。
   * @returns 找不到（或路径不存在）时返回 undefined。
   */
  resolve(spec: string): Promise<WorkspaceTarget | undefined>
  /**
   * 把目录登记成 Workspace：目录不存在时递归创建，已登记时复用。
   * @param cwd - 绝对目录路径（调用方已做绝对路径校验）。
   * @returns 登记后的 Workspace（路径可能经 realpath 规范化）。
   */
  ensure(cwd: string): Promise<WorkspaceTarget>
}
