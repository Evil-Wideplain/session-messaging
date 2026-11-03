/**
 * Cordis 会话创建适配器（基础设施层实现）。
 *
 * 创建会话走 DSH 的产品入口 `ctx.sessionController.create()`，而不是直接
 * `ctx.agents.create()`：
 *
 * - `sessionController` 负责 mkdir、Agent preset 挂载、模型选择、Workspace attach
 *   以及 `api-session/added` 广播，与 GUI 的「新建会话」完全同构；
 * - 它的生命周期所有权在应用组合，插件重载不会把新会话一起拆掉；直接
 *   `ctx.agents.create()` 得到的会话归插件 Fiber 所有，插件一卸载就消失。
 *
 * 首条消息用 `agent.followup()` 投递（与内置 `dsh -p` 的驱动方式一致）：
 * 排入 `next-turn` 并唤醒一个新会话，消息本体由应用层构造成带来源框架的
 * `user/message`。这里刻意不使用 `ctx.sessionController.prompt()`——那是
 * Remote 层给客户端用的入口，依赖调用侧 principal 与附件/文件回执服务；
 * 把一条「另一个会话发来的消息」伪装成人类 prompt 也不符合本插件的来源约定。
 *
 * 创建后还会做三件尽力而为的收尾（失败只记日志，不影响创建结果，见
 * `session-finish.ts`）：Workspace attach（应用层没解析出 Workspace 时按 cwd
 * 补归属）、权限预设继承、标题写入。
 *
 * @module dsh-plugin-session-messaging/infrastructure/cordis-session-creator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionControllerService, WorkspaceRegistryService, WorkspaceView } from '../types.ts'
import type { CreatedSession, SessionCreationRequest, SessionCreator } from '../application/ports.ts'
import { sameCwd } from '../domain/authorization.ts'
import { messageOf } from '../domain/util.ts'
import { flushSessionLog, inheritPermissions, writeTitle } from './session-finish.ts'

/** 会话创建适配器。 */
export class CordisSessionCreator implements SessionCreator {
  /**
   * @param ctx - Cordis 上下文（sessionController / agents / sessions / workspaceRegistry / permissionPresets）。
   * @param log - 日志出口（组合根传入 `ctx.logger.warn` 之类的实现）。
   */
  constructor(
    private readonly ctx: Context,
    private readonly log: (message: string) => void,
  ) {}

  /** @inheritdoc */
  async create(request: SessionCreationRequest): Promise<CreatedSession> {
    request.signal?.throwIfAborted()
    const controller = this.ctx.get('sessionController') as SessionControllerService | undefined
    // create 是产品入口的必需能力；形状不符时按「没有该服务」处理，不要落到
    // 「DSH 拒绝创建」这种误导性的失败上。
    if (controller === undefined || typeof controller.create !== 'function') {
      throw new Error(
        '当前部署没有可用的 sessionController 服务，无法创建普通会话；'
        + '该工具需要带 GUI/Web 应用组合的宿主（headless/CLI 组合不装配它）',
      )
    }

    // 应用层已解析出的 Workspace 直接用；否则按 cwd 解析一次。只有「解析结果与请求
    // cwd 是同一目录」才改写成 workspaceId：若运行时按包含关系返回父工作区，改写
    // 会把会话建到父目录，与调用方授权的 cwd 不一致。
    const resolved = request.workspaceId !== undefined ? undefined : await this.workspaceFor(request.cwd)
    const exact = resolved !== undefined
      && sameCwd(resolved.path, request.cwd, request.caseInsensitivePaths === true)
      ? resolved
      : undefined
    let created
    try {
      created = await controller.create({
        ...request.workspaceId !== undefined
          ? { workspaceId: request.workspaceId }
          : exact === undefined ? { cwd: request.cwd } : { workspaceId: exact.id },
        ...request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset },
      })
    } catch (error) {
      // 会话没建出来：让应用层把错误原文交给模型，并保持 sessionId 为空。
      throw new Error(`DSH 拒绝创建会话：${messageOf(error)}`, { cause: error })
    }

    const sessionId = created.sessionId
    const agentPreset = created.agentPreset
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      const knownWorkspace = request.workspaceId ?? exact?.id
      return {
        sessionId,
        cwd: request.cwd,
        ...knownWorkspace === undefined ? {} : { workspaceId: knownWorkspace },
        accepted: false,
        detail: '会话已创建，但运行时没有返回它的在线 Agent；首条消息未投递',
        ...agentPreset === undefined ? {} : { agentPreset },
      }
    }
    const cwd = agent.session.header.cwd ?? request.cwd
    let workspaceId = request.workspaceId ?? exact?.id
    if (workspaceId === undefined) workspaceId = (await this.attach(cwd, sessionId))?.id
    inheritPermissions(this.ctx, this.log, request.caller.agent, agent)
    const title = await writeTitle(controller, this.log, sessionId, request.title)

    // 取消可能在 create 期间到来：会话留着（不回滚已成功的创建），但不再投递首条
    // 消息，避免调用方已经放弃后仍在目标会话里多出一轮。
    if (request.signal?.aborted === true) {
      return {
        sessionId,
        cwd,
        ...workspaceId === undefined ? {} : { workspaceId },
        accepted: false,
        detail: '调用已取消：会话已创建，但首条消息未投递（可用 send_session_message 补发）',
        ...title === undefined ? {} : { title },
        ...agentPreset === undefined ? {} : { agentPreset },
      }
    }

    try {
      agent.followup(request.message)
    } catch (error) {
      // 会话已经存在，不能报成「创建失败」：把 sessionId 带回去，让调用方决定是否补发。
      return {
        sessionId,
        cwd,
        ...workspaceId === undefined ? {} : { workspaceId },
        accepted: false,
        detail: `会话已创建，但首条消息投递失败：${messageOf(error)}`,
        ...title === undefined ? {} : { title },
        ...agentPreset === undefined ? {} : { agentPreset },
      }
    }
    await flushSessionLog(this.ctx, this.log, agent)
    return {
      sessionId,
      cwd,
      ...workspaceId === undefined ? {} : { workspaceId },
      accepted: true,
      detail: '已创建普通会话，首条消息已进入其 inbox；会话会自行开始第一轮',
      ...title === undefined ? {} : { title },
      ...agentPreset === undefined ? {} : { agentPreset },
    }
  }

  /** 按目录解析所属 Workspace；服务缺席或目录不存在时返回 undefined。 */
  private async workspaceFor(cwd: string): Promise<WorkspaceView | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
    const resolve = registry?.resolveByPath
    if (registry === undefined || typeof resolve !== 'function') return undefined
    try {
      return await resolve.call(registry, cwd)
    } catch (error) {
      // 目录首次创建时 realpath 必然失败，这属于预期路径。
      this.log(`[session-messaging] 解析 ${cwd} 的 Workspace 失败: ${messageOf(error)}`)
      return undefined
    }
  }

  /** 创建后把会话登记进目录所属的 Workspace（尽力而为）。 */
  private async attach(cwd: string, sessionId: string): Promise<WorkspaceView | undefined> {
    const workspace = await this.workspaceFor(cwd)
    if (workspace === undefined) return undefined
    try {
      await workspace.attachSession(sessionId)
      return workspace
    } catch (error) {
      this.log(`[session-messaging] 会话 ${sessionId} 登记进 Workspace 失败: ${messageOf(error)}`)
      return undefined
    }
  }
}
