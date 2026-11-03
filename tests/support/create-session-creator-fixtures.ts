/**
 * `CordisSessionCreator` 单元测试的共享夹具：假 DSH 上下文与首条消息构造。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Caller, SessionCreationRequest } from '../../src/application/ports.ts'
import type {
  PermissionPresetsService,
  SessionControllerService,
  UserMessage,
  WorkspaceView,
} from '../../src/types.ts'
import { CordisSessionCreator } from '../../src/infrastructure/cordis-session-creator.ts'
import { CALLER_CWD, NEW_SESSION_ID, makeSessionAgent } from './create-session-fixtures.ts'

/** `CordisSessionCreator` 的假上下文。 */
export function creatorHarness(options: {
  readonly agent?: FakeAgent
  /** 模拟「创建后拿不到在线 Agent」。 */
  readonly noAgent?: boolean
  readonly workspace?: WorkspaceView | Error | (() => Promise<WorkspaceView | undefined>)
  readonly presets?: PermissionPresetsService
  readonly renameThrows?: boolean
  readonly followupThrows?: boolean
  readonly flushThrows?: boolean
  /** 让创建后补的 attach 失败。 */
  readonly attachThrows?: boolean
  /** 在假 `create` 返回前执行（用来模拟创建期间发生的取消）。 */
  readonly onCreate?: () => void
  readonly controller?: SessionControllerService
  readonly workspaceThrows?: boolean
} = {}) {
  const createdAgent = options.agent
    ?? makeSessionAgent({ id: NEW_SESSION_ID, cwd: CALLER_CWD }, { followupThrows: options.followupThrows })
  const calls = {
    create: [] as { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string }[],
    rename: [] as { readonly sessionId: string; readonly title: string }[],
    flush: 0,
    attach: [] as string[],
  }
  const controller: SessionControllerService = options.controller ?? {
    async create(request) {
      calls.create.push(request)
      options.onCreate?.()
      return { sessionId: NEW_SESSION_ID, agentPreset: 'default' }
    },
    async rename(request) {
      calls.rename.push(request)
      if (options.renameThrows === true) throw new Error('no session-title service')
      return { title: request.title, seq: 1 }
    },
  }
  const workspace = typeof options.workspace === 'function'
    ? options.workspace
    : options.workspace instanceof Error
      ? async () => { throw options.workspace }
      : async () => options.workspace
  const registry = options.workspaceThrows === true
    ? { archivedSessionIds: [], resolveByPath: async () => { throw new Error('ENOENT') } }
    : {
      archivedSessionIds: [],
      async resolveByPath(path: string) {
        const found = await workspace(path)
        if (found === undefined) return undefined
        return {
          ...found,
          async attachSession(id: string) {
            calls.attach.push(id)
            if (options.attachThrows === true) throw new Error('attach/unsupported')
          },
        }
      },
    }
  const ctx = {
    get(name: string) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      if (name === 'permissionPresets') return options.presets
      return undefined
    },
    agents: {
      list: () => [createdAgent],
      get: (id: string) => options.noAgent === true || id !== createdAgent.id ? undefined : createdAgent,
    },
    sessions: {
      flush: async () => {
        calls.flush += 1
        if (options.flushThrows === true) throw new Error('persistence unavailable')
        return true
      },
    },
    logger: { warn: () => {} },
  } as unknown as Context
  return { creator: new CordisSessionCreator(ctx, () => {}), calls, agent: createdAgent, controller }
}

/** 构造一条首条消息（内容不参与 creator 语义，只验证被原样投递）。 */
export function openingMessage(): UserMessage {
  return {
    id: 'message-1',
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'session-message', messageId: 'message-1' },
  }
}
