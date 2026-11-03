/**
 * messaging 测试的共享夹具：假 Agent、冷会话选项与时钟辅助。
 */

import type { Agent, AgentOptions, SessionEvent, TeamMemberView } from '../../src/types.ts'
import { identityOf } from '../../src/domain/authorization.ts'

export interface MessagingSession {
  readonly id: string
  readonly header: { readonly id: string; readonly cwd?: string }
  readonly inheritedEventCount: number
  readonly events: SessionEvent[]
  ownEvents(): readonly SessionEvent[]
}

export interface MessagingAgent extends Agent {
  readonly session: MessagingSession
}

/** 在线 Agent 替身：把 steer 记录成可持久化的 inbox splice。 */
export function makeMessagingAgent(
  id: string,
  cwd: string | undefined,
  status: 'idle' | 'running' = 'idle',
  extras: { readonly route?: AgentOptions; readonly recordSteer?: boolean } = {},
): MessagingAgent {
  const header = { id, ...cwd === undefined ? {} : { cwd } }
  const events: SessionEvent[] = []
  const session: MessagingSession = {
    id,
    header,
    inheritedEventCount: 0,
    events,
    ownEvents: () => events,
  }
  const agent: MessagingAgent = {
    id,
    session: session as unknown as Agent['session'],
    status,
    ...extras.route === undefined ? {} : { options: extras.route },
    steer(message) {
      if (extras.recordSteer === false) return
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
  }
  return agent
}

/** 等到条件成立（用于观察异步投递的中间状态）。 */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(done => setTimeout(done, 5))
  }
}


export interface MessagingHarnessOptions {
  readonly agents: MessagingAgent[]
  readonly cold?: readonly {
    readonly id: string
    readonly cwd: string
    readonly origin?: string
    readonly parentSession?: string
  }[]
  readonly coldEvents?: ReadonlyMap<string, SessionEvent[]>
  readonly titles?: ReadonlyMap<string, string>
  readonly resume?: (id: string) => MessagingAgent
  readonly allowCrossWorkspace?: boolean
  readonly allowlist?: string[]
  readonly dedupeWindowMs?: number
  readonly maxPerMinute?: number
  readonly allowColdWake?: boolean
  readonly outboxDir?: string
  readonly team?: { readonly members: readonly TeamMemberView[]; readonly sends: string[] }
  readonly subagents?: { readonly sends: string[] }
  readonly agentDefault?: { readonly provider: string; readonly model: string }
  /** 已归档会话 id（可变数组，便于测试中途归档）。 */
  readonly archived?: string[]
  /** 让 workspaceRegistry 的读取直接抛错，模拟归档状态不可判定。 */
  readonly archiveReadFails?: boolean
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  readonly holdExpiryMs?: number
}

/** 构造一条 `request/header` 事件，用于折叠冷会话的模型路由。 */
export function requestHeader(provider: string, model: string): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: 1,
    data: { header: { config: { provider, model } } },
  }
}
export function messagingCaller(agent: MessagingAgent) {
  return { agent, identity: identityOf(agent) }
}
