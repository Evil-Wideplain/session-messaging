/**
 * 包级端到端测试的共享夹具：加载构建产物并装配插件上下文。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionEvent, ToolDefinition, ToolExecution } from '../../src/types.ts'
import * as plugin from '../../lib/index.js'
import { tempDir } from './common.ts'

export interface E2eHeader {
  readonly id: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

export function makeE2eAgent(header: E2eHeader): Agent {
  const events: SessionEvent[] = []
  const session = {
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
    steer(message) {
      events.push({
        type: 'agent/inbox/spliced',
        seq: events.length + 1,
        time: Date.now(),
        data: { target: 'next-step', start: 0, inserted: [message] },
      })
    },
    followup(message) {
      events.push({
        type: 'agent/inbox/spliced',
        seq: events.length + 1,
        time: Date.now(),
        data: { target: 'next-turn', start: 0, inserted: [message] },
      })
    },
    whenIdle: async () => {},
  } as unknown as Agent
}

export interface BootOptions {
  readonly agents: Agent[]
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  readonly titles?: ReadonlyMap<string, string>
}

export function boot(options: BootOptions) {
  const outboxDir = tempDir()
  const socketDir = tempDir()
  const tools = new Map<string, ToolDefinition>()
  const effects: (() => void)[] = []
  const shellContributors: { name: string; resolve(exec: ToolExecution): Record<string, string> }[] = []
  const services = new Map<string, unknown>()

  services.set('sessionTitle', {
    get: (session: { id: string }) => {
      const title = options.titles?.get(session.id)
      return title === undefined ? undefined : { title }
    },
  })
  services.set('shellEnv', {
    register(contributor: { name: string; resolve(exec: ToolExecution): Record<string, string> }) {
      shellContributors.push(contributor)
      return () => {}
    },
  })

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(fn: () => (() => void) | void) {
      const disposer = fn()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
      return disposer
    },
    on() {
      return () => {}
    },
    get: (name: string) => services.get(name),
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
      },
    },
    agents: {
      list: () => options.agents,
      get: (id: string) => options.agents.find(agent => agent.id === id),
      resume: async () => { throw new Error('resume is not available in this harness') },
    },
    sessions: {
      flush: async () => true,
    },
  } as unknown as Context

  plugin.apply(ctx, plugin.Config({
    outboxDir,
    socketDir,
    ...options.inbound === undefined ? {} : { inbound: options.inbound },
  }))

  return {
    ctx,
    tools,
    outboxDir,
    shellContributors,
    exec(agent?: Agent): ToolExecution {
      return {
        agent,
        signal: new AbortController().signal,
        session: agent?.session,
        callId: 'e2e-call',
        toolName: 'e2e',
      } as unknown as ToolExecution
    },
    async dispose(): Promise<void> {
      for (const effect of effects.splice(0).reverse()) await Promise.resolve(effect())
    },
  }
}
