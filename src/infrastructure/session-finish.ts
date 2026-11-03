/**
 * 会话创建后的收尾步骤（基础设施层）。
 *
 * 创建完成后还有三件「尽力而为」的事：继承调用方的权限预设（DSH 的
 * `pinInitialPermission` 给全新会话套的是用户默认权限，可能比调用方更宽）、
 * 写入标题、刷新日志让首条消息尽快落盘。
 *
 * 任何一步失败都只记日志：会话已经存在，这些步骤不该把创建结果改判成失败。
 *
 * @module session-messaging/infrastructure/session-finish
 */

import type { Context } from '@deepseek-ai/cordis'
import { messageOf } from '../domain/util.ts'
import type { Agent, PermissionPresetsService, SessionControllerService } from '../types.ts'

/**
 * 把调用方的有效权限预设复制给新会话。
 *
 * `current()` 返回 `custom` 时没有可复制的预设名，只能跳过并记日志（此时新会话
 * 仍按默认权限运行，属于已知限制）；`set()` 对 custom 也会抛错，所以必须先跳过。
 * @param ctx - Cordis 上下文（读取 permissionPresets 服务）。
 * @param log - 日志出口。
 * @param caller - 调用方 Agent（权限来源）。
 * @param created - 新创建的 Agent（权限目标）。
 */
export function inheritPermissions(
  ctx: Context,
  log: (message: string) => void,
  caller: Agent,
  created: Agent,
): void {
  const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
  if (presets === undefined) return
  try {
    const effective = presets.current(caller.session)
    if (effective === '' || effective === 'custom') return
    if (presets.current(created.session) === effective) return
    presets.set(created.session, effective)
  } catch (error) {
    log(`[session-messaging] 新会话继承调用方权限预设失败: ${messageOf(error)}`)
  }
}

/**
 * 在首轮开始前写入标题；标题服务缺席或校验失败时忽略。
 * @param controller - sessionController 服务（提供 rename）。
 * @param log - 日志出口。
 * @param sessionId - 新会话标识。
 * @param title - 期望标题（未提供时跳过）。
 * @returns 运行时接受的标题；没写入时返回 undefined。
 */
export async function writeTitle(
  controller: SessionControllerService,
  log: (message: string) => void,
  sessionId: string,
  title: string | undefined,
): Promise<string | undefined> {
  if (title === undefined || title === '' || typeof controller.rename !== 'function') return undefined
  try {
    const value = await controller.rename({ sessionId, title })
    return value.title
  } catch (error) {
    log(`[session-messaging] 新会话 ${sessionId} 写入标题失败: ${messageOf(error)}`)
    return undefined
  }
}

/**
 * 刷新会话日志，让首条消息尽快落盘；失败只记日志。
 * @param ctx - Cordis 上下文（sessions 服务）。
 * @param log - 日志出口。
 * @param agent - 新会话的 Agent。
 */
export async function flushSessionLog(
  ctx: Context,
  log: (message: string) => void,
  agent: Agent,
): Promise<void> {
  try {
    await ctx.sessions.flush(agent.session)
  } catch (error) {
    log(`[session-messaging] 刷新新会话 ${agent.id} 的日志失败: ${messageOf(error)}`)
  }
}
