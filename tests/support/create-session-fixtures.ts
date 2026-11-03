/**
 * 创建会话单元测试的共享夹具：假会话/代理、假目录与假创建端口。
 */

import type { Agent, AgentOptions, SessionEvent, UserMessage } from '../../src/types.ts'
import type {
  Caller,
  CreatedSession,
  SessionCreator,
  SessionCreationRequest,
  SessionDirectory,
  WorkspaceResolver,
  WorkspaceTarget,
} from '../../src/application/ports.ts'
import type { Config } from '../../src/config.ts'
import { resolveConfig } from '../../src/config.ts'
import { SessionCreationService } from '../../src/application/session-creation-service.ts'
import { identityOf } from '../../src/domain/authorization.ts'

export const CREATION_CALLER_ID = 'session-caller-0001'
export const CALLER_CWD = '/repo/main'
export const NEW_SESSION_ID = 'session-0f1e2d3c4b5a'

export interface FakeSession {
  readonly id: string
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly origin?: 'subagent'
    readonly parentSession?: string
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly inheritedEventCount: number
  readonly events: SessionEvent[]
  ownEvents(): readonly SessionEvent[]
}

export interface FakeAgent extends Agent {
  readonly session: FakeSession
  /** 本替身收到的 followup 消息（新会话就是靠它收到首条消息）。 */
  readonly followed: UserMessage[]
}

/** 在线 Agent 替身：把 followup 记录成可断言的 inbox splice。 */
export function makeSessionAgent(
  header: {
    readonly id: string
    readonly cwd?: string
    readonly origin?: 'subagent'
    readonly parentSession?: string
    readonly delegationDepth?: number
  },
  options: { readonly route?: AgentOptions; readonly followupThrows?: boolean } = {},
): FakeAgent {
  const events: SessionEvent[] = []
  const followed: UserMessage[] = []
  const session: FakeSession = {
    id: header.id,
    header,
    inheritedEventCount: 0,
    events,
    ownEvents: () => events,
  }
  return {
    id: header.id,
    session: session as unknown as Agent['session'],
    status: 'idle',
    ...options.route === undefined ? {} : { options: options.route },
    steer(message) {
      events.push({
        type: 'agent/inbox/spliced',
        seq: events.length + 1,
        time: Date.now(),
        data: { target: 'next-step', start: 0, inserted: [message] },
      })
    },
    followup(message) {
      if (options.followupThrows === true) throw new Error('inbox closed')
      followed.push(message)
      events.push({
        type: 'agent/inbox/spliced',
        seq: events.length + 1,
        time: Date.now(),
        data: { target: 'next-turn', start: 0, inserted: [message] },
      })
    },
    whenIdle: async () => {},
    followed,
  } as unknown as FakeAgent
}

/** 运行时验证过的调用方。 */
export function creationCaller(agent: Agent = makeSessionAgent({ id: CREATION_CALLER_ID, cwd: CALLER_CWD })): Caller {
  return { agent, identity: identityOf(agent) }
}

/** 只实现 `titleOf` 的会话目录替身。 */
export function fakeDirectory(titles = new Map<string, string>()): SessionDirectory {
  return {
    candidates: async () => [],
    resolve: async () => { throw new Error('not used') },
    findById: async () => undefined,
    teamMemberName: () => undefined,
    teamMemberNameById: () => undefined,
    titleOf: (id: string) => titles.get(id),
    hasDelivered: async () => false,
    archivedReason: () => undefined,
    archiveStateKnown: () => true,
  }
}

/** 记录调用并返回固定结果的创建端口替身。 */
export class FakeCreator implements SessionCreator {
  readonly calls: SessionCreationRequest[] = []

  constructor(
    private readonly outcome: CreatedSession | Error = {
      sessionId: NEW_SESSION_ID,
      cwd: CALLER_CWD,
      accepted: true,
      detail: '已创建普通会话',
    },
  ) {}

  async create(request: SessionCreationRequest): Promise<CreatedSession> {
    this.calls.push(request)
    if (this.outcome instanceof Error) throw this.outcome
    return this.outcome
  }
}

/** Workspace 解析端口替身：默认「什么都解析不到」，即按纯目录行为。 */
export class FakeWorkspaces implements WorkspaceResolver {
  readonly resolved: string[] = []
  readonly ensured: string[] = []
  resolveResult: WorkspaceTarget | undefined
  resolveThrows: Error | undefined
  ensureResult: WorkspaceTarget | undefined
  ensureThrows: Error | undefined

  constructor(options: {
    readonly resolveResult?: WorkspaceTarget
    readonly resolveThrows?: Error
    readonly ensureResult?: WorkspaceTarget
    readonly ensureThrows?: Error
  } = {}) {
    this.resolveResult = options.resolveResult
    this.resolveThrows = options.resolveThrows
    this.ensureResult = options.ensureResult
    this.ensureThrows = options.ensureThrows
  }

  async resolve(spec: string): Promise<WorkspaceTarget | undefined> {
    this.resolved.push(spec)
    if (this.resolveThrows !== undefined) throw this.resolveThrows
    return this.resolveResult
  }

  async ensure(cwd: string): Promise<WorkspaceTarget> {
    this.ensured.push(cwd)
    if (this.ensureThrows !== undefined) throw this.ensureThrows
    return this.ensureResult ?? { id: 'workspace-ensured', path: cwd, title: 'ensured' }
  }
}

/** 装配被测应用服务。 */
export function serviceHarness(options: {
  readonly config?: Config
  readonly creator?: FakeCreator
  readonly titles?: Map<string, string>
  readonly workspaces?: FakeWorkspaces
} = {}) {
  const creator = options.creator ?? new FakeCreator()
  const workspaces = options.workspaces ?? new FakeWorkspaces()
  const service = new SessionCreationService({
    config: resolveConfig(options.config ?? {}),
    directory: fakeDirectory(options.titles),
    creator,
    workspaces,
  })
  return { service, creator, workspaces }
}
