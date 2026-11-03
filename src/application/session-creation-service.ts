/**
 * 创建会话应用服务（用例编排）。
 *
 * 只依赖会话目录、创建端口与有效配置；真正的 DSH 调用在基础设施层。本层把
 * 「模型想开一个新会话」翻译成受策略约束的用例：
 *
 * - 只有 root 会话可以创建（子代理已有 subagent / spawn_teammate 通道，再放开
 *   会绕开委派深度与权限收敛）；
 * - 位置可以是 Workspace（id 或已登记路径）或 `cwd`；缺省用调用方自己的工作
 *   目录，显式指定时复用投递侧的 workspace 授权策略（allowCrossWorkspace /
 *   allowlist），避免模型借创建会话扩张权限；
 * - `ensure_workspace` 在授权通过后才登记目录（可自动 mkdir）；登记返回的
 *   realpath 若指向别处，还要按规范路径重新授权（防符号链接/junction 绕过）；
 * - 创建昂贵（新 Agent + 新模型调用），按调用方限流；限额必须排在 ensure 的
 *   副作用之前，被拒绝的请求不能留下 mkdir/登记；
 * - 首条消息复用转发消息的构造（带来源框架），让新会话知道这话来自会话而非人类。
 *
 * @module session-messaging/application/session-creation-service
 */

import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.ts'
import type { Caller, SessionCreator, SessionDirectory, WorkspaceResolver } from './ports.ts'
import type { CreateSessionInput, CreateSessionResult } from './dto.ts'
import { authorizeCwd, sameCwd } from '../domain/authorization.ts'
import { displayName, isSubagentSession, shortIdOf } from '../domain/target.ts'
import { relayMessage } from '../domain/message.ts'
import { messageOf, nonBlank } from '../domain/util.ts'
import { RateLimiter } from './guards.ts'
import { RATE_WINDOW_MS } from './messaging/deps.ts'
import { resolveLocation } from './session-creation/location.ts'

/** 应用服务依赖（由组合根装配）。 */
export interface SessionCreationDependencies {
  /** 有效配置。 */
  readonly config: ResolvedConfig
  /** 会话目录（用于取调用方显示名）。 */
  readonly directory: SessionDirectory
  /** 会话创建端口。 */
  readonly creator: SessionCreator
  /** Workspace 解析/登记端口。 */
  readonly workspaces: WorkspaceResolver
  /** 可选日志出口（默认静默，便于测试）。 */
  readonly log?: (message: string) => void
}

/**
 * 创建普通（root）会话并投递首条消息。
 */
export class SessionCreationService {
  private readonly config: ResolvedConfig
  private readonly directory: SessionDirectory
  private readonly creator: SessionCreator
  private readonly workspaces: WorkspaceResolver
  private readonly log: (message: string) => void
  private readonly rateLimiter = new RateLimiter(RATE_WINDOW_MS)

  /**
   * @param dependencies - 端口实现与有效配置。
   */
  constructor(dependencies: SessionCreationDependencies) {
    this.config = dependencies.config
    this.directory = dependencies.directory
    this.creator = dependencies.creator
    this.workspaces = dependencies.workspaces
    this.log = dependencies.log ?? (() => {})
  }

  /**
   * 创建一个新会话，并把第一条消息投递进去。
   * @param caller - 运行时验证过的调用方。
   * @param input - 首条消息、目录、标题与 preset。
   * @param signal - 调用方取消信号。
   * @returns 稳定的状态描述；只有真正创建成功时 `sessionId` 才非空。
   */
  async create(
    caller: Caller,
    input: CreateSessionInput,
    signal?: AbortSignal,
  ): Promise<CreateSessionResult> {
    const messageId = randomUUID()
    const identity = caller.identity
    const requestedCwd = nonBlank(input.cwd)
    const requestedWorkspace = nonBlank(input.workspace)
    const knownCwd = requestedCwd ?? nonBlank(identity.cwd) ?? ''

    if (!this.config.allowCreateSession) {
      return refused(messageId, knownCwd, '创建会话已关闭（allowCreateSession=false）')
    }
    // 子代理创建 root 会话会绕开委派深度与权限收敛：直接拒绝，并给出替代路径。
    if (isSubagentSession(caller.agent.session.header)) {
      return refused(
        messageId,
        knownCwd,
        '子代理不能创建普通会话；需要派生任务请用 subagent / spawn_teammate，或让主会话创建',
      )
    }
    const prompt = input.prompt
    if (prompt.trim() === '') return refused(messageId, knownCwd, '首条消息正文为空')
    const bytes = Buffer.byteLength(prompt, 'utf8')
    if (bytes > this.config.maxMessageBytes) {
      return refused(messageId, knownCwd, `首条消息为 ${bytes} 字节，上限为 ${this.config.maxMessageBytes}`)
    }

    const policy = {
      allowCrossWorkspace: this.config.allowCrossWorkspace,
      allowlist: this.config.allowlist,
      caseInsensitivePaths: this.config.pathCaseInsensitive,
    }
    const location = await resolveLocation(this.workspaces, {
      ...requestedCwd === undefined ? {} : { cwd: requestedCwd },
      ...requestedWorkspace === undefined ? {} : { workspace: requestedWorkspace },
      ensureWorkspace: input.ensureWorkspace === true,
      identity,
      policy,
      allowCreateWorkspace: this.config.allowCreateWorkspace,
    })
    if (location.kind === 'refused') return refused(messageId, location.cwd, location.detail)
    let cwd = location.cwd
    let workspace = location.workspace

    // 限额放在位置解析之后、workspace 副作用之前：被拒绝的请求不消耗配额，
    // 更不能留下 mkdir/登记这类持久副作用。
    if (!this.rateLimiter.take(`create:${identity.id}`, this.config.maxCreatesPerMinute, Date.now())) {
      return refused(messageId, cwd, `触发创建频率限制（每分钟最多 ${this.config.maxCreatesPerMinute} 个）`)
    }

    // 授权通过后才允许产生副作用：登记未登记的目录（必要时 mkdir）。
    if (location.ensure) {
      try {
        workspace = await this.workspaces.ensure(location.cwd)
      } catch (error) {
        return refused(messageId, cwd, `登记工作区失败：${messageOf(error)}`)
      }
      // 登记返回 realpath 规范化后的路径；与授权时的字面路径不同就按规范路径
      // 重新授权，避免 allowlist 内的符号链接/junction 把会话建到授权范围外。
      if (!sameCwd(location.cwd, workspace.path, this.config.pathCaseInsensitive)) {
        const decision = authorizeCwd(identity, workspace.path, policy)
        if (!decision.allowed) {
          return refused(messageId, cwd, `不允许在该目录创建会话：${decision.reason ?? '跨 workspace 创建已关闭'}`)
        }
      }
      cwd = workspace.path
    }

    const title = nonBlank(input.title)
    const agentPreset = nonBlank(input.agentPreset)
    const message = relayMessage(randomUUID(), prompt, {
      messageId,
      senderId: identity.id,
      senderName: displayName(identity.id, this.directory.titleOf(identity.id)),
    })

    try {
      const created = await this.creator.create({
        caller,
        cwd,
        ...workspace === undefined ? {} : { workspaceId: workspace.id },
        message,
        ...title === undefined ? {} : { title },
        ...agentPreset === undefined ? {} : { agentPreset },
        caseInsensitivePaths: this.config.pathCaseInsensitive,
        ...signal === undefined ? {} : { signal },
      })
      if (!created.accepted) {
        this.log(`[session-messaging] 会话 ${created.sessionId} 已创建但首条消息未投递：${created.detail}`)
      }
      const workspaceId = created.workspaceId ?? workspace?.id
      return {
        status: created.accepted ? 'accepted' : 'failed',
        sessionId: created.sessionId,
        ...workspaceId === undefined ? {} : { workspaceId },
        shortId: shortIdOf(created.sessionId),
        cwd: created.cwd,
        messageId,
        detail: created.detail,
        ...created.title === undefined ? {} : { title: created.title },
        ...created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset },
      }
    } catch (error) {
      // 会话本身没有建出来：不返回 sessionId，避免调用方拿一个不存在的地址继续投递。
      return {
        status: 'failed',
        sessionId: '',
        shortId: '',
        cwd,
        messageId,
        detail: `创建会话失败：${messageOf(error)}`,
      }
    }
  }
}

/** 构造一条拒绝结果。 */
function refused(messageId: string, cwd: string, detail: string): CreateSessionResult {
  return { status: 'refused', sessionId: '', shortId: '', cwd, messageId, detail }
}
