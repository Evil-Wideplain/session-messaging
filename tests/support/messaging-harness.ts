/**
 * messaging 测试的共享装配：把假 Agent 接入真实 `createMessagingRuntime`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionEvent } from '../../src/types.ts'
import { Config, resolveConfig } from '../../src/config.ts'
import { createMessagingRuntime } from '../../src/composition.ts'
import { tempDir } from './common.ts'
import type { MessagingHarnessOptions } from './messaging-fixtures.ts'

export function makeMessagingHarness(options: MessagingHarnessOptions) {
  const live = [...options.agents]
  const resumeCalls: string[] = []
  const resumeRequests: { resumeSessionId: string; agentOptions?: Record<string, unknown> }[] = []
  const errorListeners: ((payload: { readonly error: Error }) => void)[] = []
  const sessionListeners: ((session: { readonly id: string }, event: SessionEvent) => void)[] = []
  let disposeCalls = 0
  const cold = options.cold ?? []
  const titles = options.titles ?? new Map<string, string>()
  const services = new Map<string, unknown>()
  const outboxDir = options.outboxDir ?? tempDir()

  services.set('sessionTitle', {
    get(session: { id: string }) {
      const title = titles.get(session.id)
      return title === undefined ? undefined : { title }
    },
  })
  if (cold.length > 0) {
    const coldHeader = (row: (typeof cold)[number]) => ({
      id: row.id,
      cwd: row.cwd,
      ...row.origin === undefined ? {} : { origin: row.origin },
      ...row.parentSession === undefined ? {} : { parentSession: row.parentSession },
    })
    services.set('sessionQuery', {
      listSessions: async () => cold.map(row => ({ header: coldHeader(row), live: false, persisted: true })),
      observeSession: async (id: string) => {
        const row = cold.find(entry => entry.id === id)
        if (row === undefined) throw new Error('missing')
        return { header: coldHeader(row), events: [], inheritedEventCount: 0 }
      },
    })
    services.set('sessionPersistence', {
      open: async (id: string) => {
        const row = cold.find(entry => entry.id === id)
        return {
          header: coldHeader(row ?? { id, cwd: '' }),
          inheritedEventCount: 0,
          // 真实运行时返回 { events, eventState }；这里只给 events。
          read: async () => ({ events: options.coldEvents?.get(id) ?? [] }),
          close: async () => {},
        }
      },
    })
  }
  services.set('agentPresets', undefined)
  if (options.team !== undefined) {
    const team = options.team
    services.set('agentTeams', {
      membership: (agent: Agent) => team.members.some(member => member.id === agent.id)
        ? { teamId: 'team-1' }
        : undefined,
      listMembers: () => team.members,
      sendMessage: async (_agent: Agent, request: { target: string }) => {
        team.sends.push(request.target)
        return { messageId: `team-${team.sends.length}` }
      },
    })
  }
  if (options.subagents !== undefined) {
    const subagents = options.subagents
    services.set('subagents', {
      sendMessage: async (_sender: Agent, targetId: string) => {
        subagents.sends.push(targetId)
        return `sub-${subagents.sends.length}`
      },
    })
  }
  if (options.agentDefault !== undefined) {
    services.set('agentDefaultModel', { currentSelection: () => options.agentDefault })
  }
  if (options.archived !== undefined || options.archiveReadFails === true) {
    services.set('workspaceRegistry', {
      get archivedSessionIds(): readonly string[] {
        if (options.archiveReadFails === true) throw new Error('registry unavailable')
        return options.archived ?? []
      },
    })
  }

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agents: {
      list: () => live,
      get: (id: string) => live.find(agent => agent.id === id),
      resume: async (request: {
        resumeSessionId: string
        agentOptions?: Record<string, unknown>
        setup?: (agentCtx: unknown) => void | Promise<void>
      }) => {
        resumeCalls.push(request.resumeSessionId)
        resumeRequests.push({
          resumeSessionId: request.resumeSessionId,
          ...request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions },
        })
        if (options.resume === undefined) throw new Error('resume is not available in this harness')
        const agent = options.resume(request.resumeSessionId)
        live.push(agent)
        if (request.setup !== undefined) {
          await request.setup({
            on: (event: string, handler: (payload: never) => void) => {
              if (event === 'agent/error') {
                errorListeners.push(handler as unknown as (payload: { readonly error: Error }) => void)
              }
              if (event === 'session/event') {
                sessionListeners.push(handler as unknown as (
                  session: { readonly id: string },
                  event: SessionEvent,
                ) => void)
              }
            },
          })
        }
        return {
          agent,
          dispose: () => {
            disposeCalls += 1
            const index = live.indexOf(agent)
            if (index >= 0) live.splice(index, 1)
          },
        }
      },
    },
    sessions: {
      get: (id: string) => live.find(agent => agent.id === id)?.session,
      flush: async () => true,
    },
    get: (name: string) => services.get(name),
  } as unknown as Context

  const config = resolveConfig(Config({
    ...options.allowCrossWorkspace === undefined ? {} : { allowCrossWorkspace: options.allowCrossWorkspace },
    ...options.allowlist === undefined ? {} : { allowlist: options.allowlist },
    ...options.dedupeWindowMs === undefined ? {} : { dedupeWindowMs: options.dedupeWindowMs },
    ...options.maxPerMinute === undefined ? {} : { maxPerMinute: options.maxPerMinute },
    ...options.allowColdWake === undefined ? {} : { allowColdWake: options.allowColdWake },
    ...options.inbound === undefined ? {} : { inbound: options.inbound },
    ...options.holdExpiryMs === undefined ? {} : { holdExpiryMs: options.holdExpiryMs },
    outboxDir,
  }))
  const runtime = createMessagingRuntime(ctx, config)
  return {
    ctx,
    service: runtime.service,
    resumeCalls,
    resumeRequests,
    errorListeners,
    sessionListeners,
    emitError: (error: Error) => { for (const listener of errorListeners) listener({ error }) },
    emitSessionEvent: (session: { readonly id: string }, event: SessionEvent) => {
      for (const listener of sessionListeners) listener(session, event)
    },
    disposeCalls: () => disposeCalls,
    teamSends: options.team?.sends ?? [],
    subagentSends: options.subagents?.sends ?? [],
    live,
    outboxDir,
  }
}
