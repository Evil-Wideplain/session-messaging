/**
 * 通道路由 / 入站审批测试的共享夹具：假 Agent 与最小可信的 messaging runtime。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionEvent } from '../../src/types.ts'
import { identityOf } from '../../src/domain/authorization.ts'
import { Config, resolveConfig } from '../../src/config.ts'
import { createMessagingRuntime } from '../../src/composition.ts'
import { tempDir } from './common.ts'

export interface RoutingHeader {
  readonly id: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

export function makeRoutingAgent(header: RoutingHeader, status: 'idle' | 'running' = 'idle'): Agent {
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
    status,
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

export interface RoutingHarnessOptions {
  readonly agents: Agent[]
  readonly titles?: ReadonlyMap<string, string>
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  readonly holdExpiryMs?: number
  readonly maxHeldPerTarget?: number
  readonly subagents?: { readonly calls: { targetId: string; text: string }[]; readonly fail?: boolean }
  readonly agentTeams?: { readonly name: string; readonly calls: { target: string; text: string }[]; readonly fail?: boolean }
  readonly outboxDir?: string
}

export function makeRoutingHarness(options: RoutingHarnessOptions) {
  const agents = [...options.agents]
  const titles = options.titles ?? new Map<string, string>()
  const services = new Map<string, unknown>()
  const outboxDir = options.outboxDir ?? tempDir('dsm-approval-')

  services.set('sessionTitle', {
    get(session: { id: string }) {
      const title = titles.get(session.id)
      return title === undefined ? undefined : { title }
    },
  })
  if (options.subagents !== undefined) {
    const fake = options.subagents
    services.set('subagents', {
      sendMessage: async (_sender: Agent, targetId: string, content: { text?: string }[]) => {
        if (fake.fail === true) throw new Error('subagent channel refused')
        fake.calls.push({ targetId, text: content[0]?.text ?? '' })
        return 'sub-message-1'
      },
    })
  }
  if (options.agentTeams !== undefined) {
    const fake = options.agentTeams
    services.set('agentTeams', {
      membership: () => ({ teamId: 'team-1' }),
      listMembers: () => [{ id: 'teammate-1', name: fake.name }],
      sendMessage: async (_sender: Agent, request: { target: string; content: { text?: string }[] }) => {
        if (fake.fail === true) throw new Error('team channel refused')
        fake.calls.push({ target: request.target, text: request.content[0]?.text ?? '' })
        return { messageId: 'team-message-1', status: 'accepted' }
      },
    })
  }

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agents: {
      list: () => agents,
      get: (id: string) => agents.find(agent => agent.id === id),
      resume: async () => { throw new Error('resume is not available in this harness') },
    },
    sessions: {
      get: (id: string) => agents.find(agent => agent.id === id)?.session,
      flush: async () => true,
    },
    get: (name: string) => services.get(name),
  } as unknown as Context

  const runtime = createMessagingRuntime(ctx, resolveConfig(Config({
    ...options.inbound === undefined ? {} : { inbound: options.inbound },
    ...options.holdExpiryMs === undefined ? {} : { holdExpiryMs: options.holdExpiryMs },
    ...options.maxHeldPerTarget === undefined ? {} : { maxHeldPerTarget: options.maxHeldPerTarget },
    outboxDir,
  })))
  return { service: runtime.service, agents, outboxDir }
}

/** 测试共用的 abort signal。 */
export const signal = new AbortController().signal

/** 运行时验证过的调用方。 */
export const routingCaller = (agent: Agent) => ({ agent, identity: identityOf(agent) })
