import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, SessionEvent, TeamMemberView } from '../src/types.ts'
import { messageAccepted, relayMessage } from '../src/domain/message.ts'
import { JsonlInboundRepository } from '../src/infrastructure/jsonl-inbound-repository.ts'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { createMessagingRuntime } from '../src/composition.ts'
import { apply } from '../src/index.ts'
import { planDelivery } from '../src/domain/routing.ts'
import { authorize, identityOf, sameCwd } from '../src/domain/authorization.ts'
import { displayName, normalizeAddress } from '../src/domain/target.ts'
import { foldAgentOptions, foldTitle, readPersistedSession } from '../src/infrastructure/persisted-session.ts'

interface FakeSession {
  readonly id: string
  readonly header: { readonly id: string; readonly cwd?: string }
  readonly inheritedEventCount: number
  readonly events: SessionEvent[]
  ownEvents(): readonly SessionEvent[]
}

interface FakeAgent extends Agent {
  readonly session: FakeSession
}

/** 在线 Agent 替身：把 steer 记录成可持久化的 inbox splice。 */
function makeAgent(
  id: string,
  cwd: string | undefined,
  status: 'idle' | 'running' = 'idle',
  extras: { readonly route?: AgentOptions; readonly recordSteer?: boolean } = {},
): FakeAgent {
  const header = { id, ...cwd === undefined ? {} : { cwd } }
  const events: SessionEvent[] = []
  const session: FakeSession = {
    id,
    header,
    inheritedEventCount: 0,
    events,
    ownEvents: () => events,
  }
  const agent: FakeAgent = {
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
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(done => setTimeout(done, 5))
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-test-'))
  tempDirs.push(dir)
  return dir
}

interface HarnessOptions {
  readonly agents: FakeAgent[]
  readonly cold?: readonly {
    readonly id: string
    readonly cwd: string
    readonly origin?: string
    readonly parentSession?: string
  }[]
  readonly coldEvents?: ReadonlyMap<string, SessionEvent[]>
  readonly titles?: ReadonlyMap<string, string>
  readonly resume?: (id: string) => FakeAgent
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

function makeHarness(options: HarnessOptions) {
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


/** 构造一条 `request/header` 事件，用于折叠冷会话的模型路由。 */
function requestHeader(provider: string, model: string): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: 1,
    data: { header: { config: { provider, model } } },
  }
}
function callerOf(agent: FakeAgent) {
  return { agent, identity: identityOf(agent) }
}

describe('config', () => {
  it('applies documented defaults', () => {
    const config = resolveConfig(Config({}))
    expect(config.allowCrossWorkspace).toBe(false)
    expect(config.allowlist).toEqual([])
    expect(config.maxMessageBytes).toBe(64 * 1024)
    expect(config.maxPerMinute).toBe(20)
    expect(config.allowColdWake).toBe(true)
    expect(config.socketEnabled).toBe(true)
  })

  it('rejects a wrong-typed value', () => {
    expect(() => Config({ maxPerMinute: 'many' })).toThrow()
  })
})

describe('addressing', () => {
  it('normalizes quotes, case, and whitespace', () => {
    expect(normalizeAddress('  "Web App "')).toBe('web app')
    expect(normalizeAddress("'web   app'")).toBe('web app')
  })

  it('falls back to the short id when there is no title', () => {
    expect(displayName('abcdef123456', undefined)).toBe('session-abcdef12')
    expect(displayName('abcdef123456', 'Docs')).toBe('Docs')
  })

  it('folds the latest title and request route from a log', () => {
    const events = [
      { type: 'session/title', seq: 1, time: 1, data: { title: 'first' } },
      { type: 'session/title', seq: 2, time: 2, data: { title: 'second' } },
      { type: 'request/header', seq: 3, time: 3, data: { header: { config: { provider: 'p', model: 'm', maxTokens: 8 } } } },
    ]
    expect(foldTitle(events)).toBe('second')
    expect(foldAgentOptions(events)).toEqual({ provider: 'p', model: 'm', maxTokens: 8 })
  })
})

describe('message acceptance', () => {
  it('sees a message through the pending inbox splice', () => {
    const message = relayMessage('u1', 'hi', { messageId: 'm1', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [{
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    }]
    expect(messageAccepted(events, 'm1')).toBe(true)
    expect(messageAccepted(events, 'other')).toBe(false)
  })

  it('sees a message after it reached model history', () => {
    const message = relayMessage('u2', 'hi', { messageId: 'm2', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [{ type: 'user/message', seq: 1, time: 1, data: message }]
    expect(messageAccepted(events, 'm2')).toBe(true)
  })

  it('treats a claimed message as accepted even though the inbox is empty', () => {
    const message = relayMessage('u3', 'hi', { messageId: 'm3', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [
      { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { target: 'next-step', start: 0, inserted: [message] } },
      { type: 'agent/inbox/spliced', seq: 2, time: 2, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: 3, time: 3, data: message },
    ]
    expect(messageAccepted(events, 'm3')).toBe(true)
  })
})

describe('outbox ledger', () => {
  it('keeps unconfirmed messages and drops confirmed ones', () => {
    const ledger = new JsonlOutboxRepository(tempDir(), 'sender-1')
    ledger.queue({ messageId: 'a', senderId: 'sender-1', senderName: 'S', targetId: 't', text: 'one', at: 1 })
    ledger.queue({ messageId: 'b', senderId: 'sender-1', senderName: 'S', targetId: 't', text: 'two', at: 2 })
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['a', 'b'])
    expect(ledger.pendingTo('t')).toBe(2)

    ledger.deliver('a')
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['b'])

    ledger.compact()
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['b'])
  })
})

describe('authorization', () => {
  const callerIdentity = { id: 'caller', cwd: 'C:/repo/app' }
  const row = (id: string, cwd: string | undefined, extra: { kind?: 'peer' | 'subagent'; parentSession?: string } = {}) => ({
    id,
    ...cwd === undefined ? {} : { cwd },
    ...extra.parentSession === undefined ? {} : { parentSession: extra.parentSession },
    status: 'offline' as const,
    kind: extra.kind ?? 'peer' as const,
  })

  it('compares working directories by segments with an explicit case rule', () => {
    expect(sameCwd('C:/repo/app', 'C:/repo/app/')).toBe(true)
    expect(sameCwd('C:/Repo/App', 'c:/repo/app')).toBe(false)
    expect(sameCwd('C:/Repo/App', 'c:/repo/app', true)).toBe(true)
    expect(sameCwd('C:/repo/../repo/app', 'C:/repo/app')).toBe(true)
    expect(sameCwd('', '')).toBe(false)
  })

  it('allows the same workspace and denies another by default', () => {
    expect(authorize(callerIdentity, row('same', 'C:/repo/app'), { allowCrossWorkspace: false, allowlist: [] }).allowed).toBe(true)
    const denied = authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: false, allowlist: [] })
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe('cross-workspace')
  })

  it('honors the switch, the allowlist, and direct subagent lineage', () => {
    expect(authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: true, allowlist: [] }).allowed).toBe(true)
    expect(authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: false, allowlist: ['C:/repo'] }).allowed).toBe(true)
    expect(authorize(callerIdentity, row('kid', 'C:/repo/app', { kind: 'subagent', parentSession: 'caller' }), { allowCrossWorkspace: false, allowlist: [] }).allowed).toBe(true)
    const foreign = authorize(callerIdentity, row('kid', 'C:/repo/app', { kind: 'subagent', parentSession: 'someone' }), { allowCrossWorkspace: false, allowlist: [] })
    expect(foreign.code).toBe('subagent-of-other')
  })

  it('refuses self delivery', () => {
    expect(authorize(callerIdentity, { ...row('caller', 'C:/repo/app'), kind: 'peer' }, { allowCrossWorkspace: true, allowlist: [] }).code).toBe('self')
  })
})

describe('messaging service', () => {
  it('delivers to a live session and confirms durable acceptance', async () => {
    const target = makeAgent('target-1', 'C:/repo/app')
    const sender = makeAgent('sender-1', 'C:/repo/app')
    const harness = makeHarness({ agents: [sender, target] })

    const result = await harness.service.send(callerOf(sender), { to: 'target-1', message: 'hello' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.id).toBe('target-1')

    const delivered = target.session.events.filter(event => event.type === 'agent/inbox/spliced')
    expect(delivered).toHaveLength(1)
    const pending = new JsonlOutboxRepository(harness.outboxDir, 'sender-1').pending()
    expect(pending).toHaveLength(0)
  })

  it('resolves a target by display name', async () => {
    const target = makeAgent('target-2', 'C:/repo/app')
    const sender = makeAgent('sender-2', 'C:/repo/app')
    const harness = makeHarness({ agents: [sender, target], titles: new Map([['target-2', 'Docs Writer']]) })

    const list = await harness.service.list(callerOf(sender), { includeSubagents: false })
    expect(list.agents.map(row => row.name)).toContain('Docs Writer')

    const result = await harness.service.send(callerOf(sender), { to: '"docs writer"', message: 'ping' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.id).toBe('target-2')
  })

  it('hides unauthorized targets behind the same not_found reply', async () => {
    const sender = makeAgent('sender-3', 'C:/repo/a')
    const far = makeAgent('far-1', 'C:/repo/b')
    const harness = makeHarness({ agents: [sender, far] })

    const missing = await harness.service.send(callerOf(sender), { to: 'nope', message: 'x' }, new AbortController().signal)
    expect(missing.status).toBe('not_found')

    // 跨 workspace 未授权与「不存在」返回同一文案，调用方无法用它枚举会话。
    const denied = await harness.service.send(callerOf(sender), { to: 'far-1', message: 'x' }, new AbortController().signal)
    expect(denied.status).toBe('not_found')
    expect(denied.detail).toMatch(/^没有匹配 ".+" 的会话$/)
    expect(missing.detail).toMatch(/^没有匹配 ".+" 的会话$/)
  })

  it('opens another workspace with the switch and its allowlist', async () => {
    const sender = makeAgent('sender-4', 'C:/repo/a')
    const far = makeAgent('far-2', 'C:/repo/b')
    const open = makeHarness({ agents: [sender, far], allowCrossWorkspace: true })
    expect((await open.service.send(callerOf(sender), { to: 'far-2', message: 'x' }, new AbortController().signal)).status).toBe('accepted')

    const sender5 = makeAgent('sender-5', 'C:/repo/a')
    const listed = makeHarness({ agents: [sender5, far], allowlist: ['C:/repo/b'] })
    expect((await listed.service.send(callerOf(sender5), { to: 'far-2', message: 'x' }, new AbortController().signal)).status).toBe('accepted')
  })

  it('deduplicates an identical body inside the window', async () => {
    const sender = makeAgent('sender-6', 'C:/repo/a')
    const target = makeAgent('target-6', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target], dedupeWindowMs: 60_000 })

    const first = await harness.service.send(callerOf(sender), { to: 'target-6', message: 'same' }, new AbortController().signal)
    const second = await harness.service.send(callerOf(sender), { to: 'target-6', message: 'same' }, new AbortController().signal)
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('duplicate')
    expect(second.messageId).toBe(first.messageId)
  })

  it('enforces the per-target rate limit', async () => {
    const sender = makeAgent('sender-7', 'C:/repo/a')
    const target = makeAgent('target-7', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target], maxPerMinute: 1, dedupeWindowMs: 0 })

    expect((await harness.service.send(callerOf(sender), { to: 'target-7', message: 'one' }, new AbortController().signal)).status).toBe('accepted')
    const second = await harness.service.send(callerOf(sender), { to: 'target-7', message: 'two' }, new AbortController().signal)
    expect(second.status).toBe('refused')
    expect(second.detail).toContain('频率限制')
  })

  it('wakes a cold session once even under concurrent sends', async () => {
    const sender = makeAgent('sender-8', 'C:/repo/a')
    let resumed: FakeAgent | undefined
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-1', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-1', [requestHeader('test', 'test-model')]]]),
      resume: () => {
        resumed = makeAgent('cold-1', 'C:/repo/a', 'idle', { route: { provider: 'test', model: 'test-model' } })
        return resumed
      },
    })
    const signal = new AbortController().signal
    const [left, right] = await Promise.all([
      harness.service.send(callerOf(sender), { to: 'cold-1', message: 'wake' }, signal),
      harness.service.send(callerOf(sender), { to: 'cold-1', message: 'wake too' }, signal),
    ])
    expect(left.status).toBe('accepted')
    expect(right.status).toBe('accepted')
    expect(harness.resumeCalls).toEqual(['cold-1'])
    expect(harness.resumeRequests[0]?.agentOptions).toMatchObject({ provider: 'test', model: 'test-model' })
    expect(resumed?.session.ownEvents()).toHaveLength(2)
  })

  it('replays an unconfirmed outbox entry when the sender starts again', async () => {
    const target = makeAgent('target-9', 'C:/repo/a')
    const sender = makeAgent('sender-9', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target] })

    const ledger = new JsonlOutboxRepository(harness.outboxDir, 'sender-9')
    ledger.queue({ messageId: 'legacy-1', senderId: 'sender-9', senderName: 'S', targetId: 'target-9', text: 'replayed', at: Date.now() })

    await harness.service.recover(sender)
    expect(target.session.events).toHaveLength(1)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-9').pending()).toHaveLength(0)
  })
})

describe('persisted session read', () => {
  it('accepts both the runtime wrapper and a plain event array', async () => {
    const events = [requestHeader('p', 'm')]
    const base = { header: { id: 's1' }, inheritedEventCount: 0, close: async () => {} }
    const wrapper = { open: async () => ({ ...base, read: async () => ({ events }) }) }
    expect((await readPersistedSession(wrapper as never, 's1')).events).toEqual(events)
    const plain = { open: async () => ({ ...base, read: async () => events }) }
    expect((await readPersistedSession(plain as never, 's1')).events).toEqual(events)
  })
})

describe('plugin wiring', () => {
  it('subscribes recovery to the real agent lifecycle event', () => {
    const subscribed: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      tools: { register: () => () => {} },
      agents: { list: () => [], get: () => undefined, resume: async () => { throw new Error('no resume') } },
      sessions: { get: () => undefined, flush: async () => true },
      effect: (fn: () => unknown) => { fn(); return () => {} },
      on: (event: string) => { subscribed.push(event); return () => {} },
      get: () => undefined,
    } as unknown as Context
    apply(ctx, Config({ socketEnabled: false }))
    expect(subscribed).toContain('agent/created')
    expect(subscribed).not.toContain('agent/session-start')
  })
})

describe('delivery acceptance', () => {
  it('accepts a live delivery as soon as the inbox accepts it', async () => {
    const sender = makeAgent('sender-a1', 'C:/repo/a')
    // 目标在 steer 后立刻 claim（splice 被移除、user/message 还没落账）时，
    // 事件里可能暂时看不到消息；inbox acceptance 已成立，状态必须是 accepted。
    const target = makeAgent('target-a1', 'C:/repo/a', 'idle', { recordSteer: false })
    const harness = makeHarness({ agents: [sender, target] })

    const result = await harness.service.send(callerOf(sender), { to: 'target-a1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('inbox')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-a1').pending()).toHaveLength(0)
  })
})

describe('cold wake route handling', () => {
  it('uses the folded history route when waking a session', async () => {
    const sender = makeAgent('sender-w1', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-w1', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-w1', [requestHeader('folded', 'folded-model')]]]),
      resume: () => makeAgent('cold-w1', 'C:/repo/a', 'idle', { route: { provider: 'folded', model: 'folded-model' } }),
    })
    const result = await harness.service.send(callerOf(sender), { to: 'cold-w1', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(harness.resumeRequests[0]?.agentOptions).toEqual({ provider: 'folded', model: 'folded-model' })
  })

  it('falls back to the deployment default model when history has no route', async () => {
    const sender = makeAgent('sender-w2', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-w2', cwd: 'C:/repo/a' }],
      agentDefault: { provider: 'default-p', model: 'default-m' },
      resume: () => makeAgent('cold-w2', 'C:/repo/a', 'idle', { route: { provider: 'default-p', model: 'default-m' } }),
    })
    const result = await harness.service.send(callerOf(sender), { to: 'cold-w2', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(harness.resumeRequests[0]?.agentOptions).toEqual({ provider: 'default-p', model: 'default-m' })
  })

  it('refuses to wake without any route instead of losing the message', async () => {
    const sender = makeAgent('sender-w3', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-w3', cwd: 'C:/repo/a' }],
      resume: () => makeAgent('cold-w3', 'C:/repo/a', 'idle', { route: { provider: 'p', model: 'm' } }),
    })
    const result = await harness.service.send(callerOf(sender), { to: 'cold-w3', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('queued')
    expect(result.detail).toContain('模型路由')
    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-w3').pending()).toHaveLength(1)
  })

  it('rolls back a wake whose first turn fails, keeping the message queued', async () => {
    const sender = makeAgent('sender-w4', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-w4', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-w4', [requestHeader('p', 'm')]]]),
      resume: () => makeAgent('cold-w4', 'C:/repo/a', 'idle', { route: { provider: 'p', model: 'm' }, recordSteer: false }),
    })
    const pending = harness.service.send(callerOf(sender), { to: 'cold-w4', message: 'wake' }, new AbortController().signal)
    await waitFor(() => harness.errorListeners.length > 0)
    harness.emitError(new Error('prompt variable "{{model}}" has no value'))
    const result = await pending
    expect(result.status).toBe('queued')
    expect(result.detail).toContain('首轮失败')
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.live.some(agent => agent.id === 'cold-w4')).toBe(false)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-w4').pending()).toHaveLength(1)
  })
})

describe('team routing', () => {
  const members: readonly TeamMemberView[] = [
    { id: 'lead-1', name: 'lead', role: 'lead', status: 'running' },
    { id: 'worker-1', name: 'worker', role: 'teammate', status: 'inactive' },
  ]

  it('lists and routes to an inactive teammate through the team channel', async () => {
    const lead = makeAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeHarness({ agents: [lead], team: { members, sends } })

    const list = await harness.service.list(callerOf(lead), { includeSubagents: false })
    const worker = list.agents.find(row => row.id === 'worker-1')
    expect(worker).toMatchObject({ name: 'worker', kind: 'teammate', state: 'offline' })

    const result = await harness.service.send(callerOf(lead), { to: 'worker-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('团队邮箱')
    expect(sends).toEqual(['worker'])
  })

  it('resolves an inactive teammate by name', async () => {
    const lead = makeAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeHarness({ agents: [lead], team: { members, sends } })
    const result = await harness.service.send(callerOf(lead), { to: 'worker', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.name).toBe('worker')
    expect(sends).toEqual(['worker'])
  })

  it('keeps team routing when cold wake is disabled', async () => {
    const lead = makeAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeHarness({ agents: [lead], team: { members, sends }, allowColdWake: false })
    const result = await harness.service.send(callerOf(lead), { to: 'worker-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(sends).toEqual(['worker'])
  })

  it('prefers the team channel over the subagent channel', () => {
    const decision = planDelivery({
      target: { id: 'worker-1', kind: 'subagent', parentSession: 'lead-1', status: 'offline' },
      senderId: 'lead-1',
      isOwnSubagent: true,
      teamMemberName: 'worker',
      hasSubagentChannel: true,
      hasTeamChannel: true,
    })
    expect(decision.route).toBe('team')
  })
})

describe('own subagents', () => {
  it('lists and wakes the caller own ended subagent through the subagent channel', async () => {
    const sender = makeAgent('sender-s1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'sub-1', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'sender-s1' }],
      subagents: { sends },
    })

    const list = await harness.service.list(callerOf(sender), { includeSubagents: false })
    const sub = list.agents.find(row => row.id === 'sub-1')
    expect(sub).toMatchObject({ kind: 'subagent', state: 'offline' })

    const result = await harness.service.send(callerOf(sender), { to: 'sub-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('subagent 通道')
    expect(sends).toEqual(['sub-1'])
  })
})

describe('recovery dedupe', () => {
  it('does not replay a message already present in the target history', async () => {
    const sender = makeAgent('sender-r1', 'C:/repo/a')
    const target = makeAgent('target-r1', 'C:/repo/a')
    target.session.events.push({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: {
        id: 'x1',
        role: 'user',
        content: [{ type: 'text', text: 'old' }],
        source: { kind: 'session-message', form: 'relay', messageId: 'r1', senderId: 'sender-r1', senderName: 'S' },
      },
    })
    const harness = makeHarness({ agents: [sender, target] })
    new JsonlOutboxRepository(harness.outboxDir, 'sender-r1').queue({
      messageId: 'r1', senderId: 'sender-r1', senderName: 'S', targetId: 'target-r1', text: 'old', at: Date.now(),
    })

    await harness.service.recover(sender)

    expect(target.session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-r1').pending()).toHaveLength(0)
  })

  it('detects delivery in an offline target history before replaying', async () => {
    const sender = makeAgent('sender-r2', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-r2', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-r2', [{
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          id: 'x2',
          role: 'user',
          content: [{ type: 'text', text: 'old' }],
          source: { kind: 'session-message', form: 'relay', messageId: 'r2', senderId: 'sender-r2', senderName: 'S' },
        },
      } as SessionEvent]]]),
    })
    new JsonlOutboxRepository(harness.outboxDir, 'sender-r2').queue({
      messageId: 'r2', senderId: 'sender-r2', senderName: 'S', targetId: 'cold-r2', text: 'old', at: Date.now(),
    })

    await harness.service.recover(sender)

    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-r2').pending()).toHaveLength(0)
  })
})

describe('inbound expiry reporting', () => {
  it('reports messages expired during recovery on the next review', async () => {
    const sender = makeAgent('sender-e1', 'C:/repo/a')
    const target = makeAgent('target-e1', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold', holdExpiryMs: 1 })

    const held = await harness.service.send(callerOf(sender), { to: 'target-e1', message: 'expire-me' }, new AbortController().signal)
    expect(held.status).toBe('held')
    await new Promise(done => setTimeout(done, 10))

    // 目标会话“启动”：recover 先惰性过期，目标还没来得及 review。
    await harness.service.recover(target)
    const review = await harness.service.review(callerOf(target), 'list', undefined, new AbortController().signal)
    expect(review.held).toHaveLength(0)
    expect(review.outcomes.map(outcome => outcome.status)).toEqual(['expired'])

    // 报告一次后清空，不重复报告。
    const again = await harness.service.review(callerOf(target), 'list', undefined, new AbortController().signal)
    expect(again.outcomes).toEqual([])
  })
})


describe('归档门禁与 include_subagents', () => {
  it('归档会话不出现在列表里，发送被明确拒绝且不唤醒', async () => {
    const caller = makeAgent('caller-arch', 'C:/repo/a')
    const harness = makeHarness({
      agents: [caller],
      cold: [{ id: 'cold-archived', cwd: 'C:/repo/a' }],
      archived: ['cold-archived'],
    })

    const list = await harness.service.list(callerOf(caller), { includeSubagents: false })
    expect(list.agents.map(row => row.id)).not.toContain('cold-archived')

    const result = await harness.service.send(
      callerOf(caller),
      { to: 'cold-archived', message: 'archived' },
      new AbortController().signal,
    )
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('已归档')
    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'caller-arch').pending()).toHaveLength(0)
  })

  it('恢复重放跳过归档目标，保持 queued 不丢账', async () => {
    const sender = makeAgent('sender-arch', 'C:/repo/a')
    const archived: string[] = []
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-q', cwd: 'C:/repo/a' }],
      archived,
    })

    // 没有模型路由，投递只能排队，不会真的唤醒。
    const result = await harness.service.send(
      callerOf(sender),
      { to: 'cold-q', message: 'queued' },
      new AbortController().signal,
    )
    expect(result.status).toBe('queued')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-arch').pending()).toHaveLength(1)

    archived.push('cold-q')
    await harness.service.recover(sender)
    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-arch').pending()).toHaveLength(1)
  })

  it('include_subagents=true 列出他人子代理但标注不可发送', async () => {
    const caller = makeAgent('caller-sub', 'C:/repo/a')
    const harness = makeHarness({
      agents: [caller],
      cold: [
        { id: 'own-sub', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'caller-sub' },
        { id: 'foreign-sub', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'other-session' },
      ],
    })

    const off = await harness.service.list(callerOf(caller), { includeSubagents: false })
    expect(off.agents.map(row => row.id)).toContain('own-sub')
    expect(off.agents.map(row => row.id)).not.toContain('foreign-sub')
    expect(off.omitted).toBeGreaterThan(0)

    const on = await harness.service.list(callerOf(caller), { includeSubagents: true })
    const foreign = on.agents.find(row => row.id === 'foreign-sub')
    expect(foreign?.kind).toBe('subagent')
    expect(foreign?.sendable).toBe(false)

    const denied = await harness.service.send(
      callerOf(caller),
      { to: 'foreign-sub', message: 'nope' },
      new AbortController().signal,
    )
    expect(denied.status).toBe('not_found')
  })

  it('首轮被归档门禁 blocked 时回滚并保持 queued', async () => {
    const sender = makeAgent('sender-blocked', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-blocked', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-blocked', [requestHeader('p', 'm')]]]),
      resume: () => makeAgent('cold-blocked', 'C:/repo/a', 'idle', {
        route: { provider: 'p', model: 'm' },
        recordSteer: false,
      }),
    })

    const pending = harness.service.send(
      callerOf(sender),
      { to: 'cold-blocked', message: 'blocked' },
      new AbortController().signal,
    )
    await waitFor(() => harness.sessionListeners.length > 0)
    const woken = harness.live.find(agent => agent.id === 'cold-blocked')
    expect(woken).toBeDefined()
    harness.emitSessionEvent(woken!.session, {
      type: 'turn/end',
      seq: 99,
      time: Date.now(),
      data: { reason: { kind: 'blocked' } },
    })

    const result = await pending
    expect(result.status).toBe('queued')
    expect(result.detail).toContain('blocked')
    expect(harness.disposeCalls()).toBe(1)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-blocked').pending()).toHaveLength(1)
  })
})

describe('review fixes', () => {
  const signal = new AbortController().signal

  it('expires only the messages whose deadline passed', async () => {
    const target = makeAgent('target-exp', 'C:/repo/a')
    const sender = makeAgent('sender-exp', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold' })
    const inboundDir = join(harness.outboxDir, 'inbound')
    const inbound = new JsonlInboundRepository(inboundDir, 'target-exp')
    const now = Date.now()
    const base = { senderId: 'sender-exp', senderName: 'S', targetId: 'target-exp', text: 'x', at: now }
    inbound.hold({ ...base, messageId: 'expired-1', expiresAt: now - 1_000 })
    inbound.hold({ ...base, messageId: 'live-1', expiresAt: now + 300_000 })

    const result = await harness.service.review(callerOf(target), 'list', undefined, signal)
    expect(result.held.map(row => row.messageId)).toEqual(['live-1'])
    expect(result.outcomes.map(outcome => outcome.messageId)).toEqual(['expired-1'])
    // 未过期的那条必须仍在账本里，而不是被 settle 一起删掉。
    expect(new JsonlInboundRepository(inboundDir, 'target-exp').held().map(entry => entry.messageId))
      .toEqual(['live-1'])
  })

  it('treats a different summary as a different message and lets dedupe=false through', async () => {
    const sender = makeAgent('sender-dd', 'C:/repo/a')
    const target = makeAgent('target-dd', 'C:/repo/a')
    const harness = makeHarness({ agents: [sender, target], dedupeWindowMs: 60_000 })

    const first = await harness.service.send(callerOf(sender), { to: 'target-dd', message: 'same', summary: 'one' }, signal)
    const second = await harness.service.send(callerOf(sender), { to: 'target-dd', message: 'same', summary: 'two' }, signal)
    expect([first.status, second.status]).toEqual(['accepted', 'accepted'])

    const third = await harness.service.send(callerOf(sender), { to: 'target-dd', message: 'same', summary: 'two' }, signal)
    expect(third.status).toBe('duplicate')

    const forced = await harness.service.send(
      callerOf(sender),
      { to: 'target-dd', message: 'same', summary: 'two', dedupe: false },
      signal,
    )
    expect(forced.status).toBe('accepted')
  })

  it('does not let the allowlist bypass the foreign-subagent rule', async () => {
    const sender = makeAgent('sender-al', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      allowlist: ['C:/repo'],
      cold: [{ id: 'child-al', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'other-session' }],
    })
    const result = await harness.service.send(callerOf(sender), { to: 'child-al', message: 'hi' }, signal)
    expect(result.status).toBe('not_found')
  })

  it('does not leak unauthorized sessions through ambiguous replies', async () => {
    const sender = makeAgent('sender-amb', 'C:/repo/a')
    const title = [{ type: 'session/title', seq: 1, time: 1, data: { title: 'Same Title' } }]
    const harness = makeHarness({
      agents: [sender],
      cold: [
        { id: 'amb-1', cwd: 'C:/repo/a' },
        { id: 'amb-2', cwd: 'C:/repo/b' },
      ],
      coldEvents: new Map([['amb-1', title], ['amb-2', title]]),
    })
    // 同名但只有一个可见：不能报 ambiguous（否则回包里会带出另一个会话）。
    const visible = await harness.service.send(callerOf(sender), { to: 'Same Title', message: 'x' }, signal)
    expect(visible.status).not.toBe('ambiguous')
    expect(visible.candidates).toBeUndefined()

    // 只把跨 workspace 的那个标题留给调用方：应得到 not_found，而不是带候选的 ambiguous。
    const hidden = makeHarness({
      agents: [sender],
      cold: [{ id: 'amb-3', cwd: 'C:/repo/b' }],
      coldEvents: new Map([['amb-3', title]]),
    })
    const denied = await hidden.service.send(callerOf(sender), { to: 'Same Title', message: 'x' }, signal)
    expect(denied.status).toBe('not_found')
    expect(denied.candidates).toBeUndefined()
  })

  it('counts limit truncation separately from hidden sessions', async () => {
    const caller = makeAgent('caller-tr', 'C:/repo/a')
    const left = makeAgent('tr-a', 'C:/repo/a')
    const right = makeAgent('tr-b', 'C:/repo/a')
    const harness = makeHarness({ agents: [caller, left, right] })
    const result = await harness.service.list(callerOf(caller), { includeSubagents: false, limit: 1 })
    expect(result.agents).toHaveLength(1)
    expect(result.truncated).toBe(1)
    expect(result.omitted).toBe(0)
  })

  it('refuses cold wake when the archive set cannot be read', async () => {
    const sender = makeAgent('sender-fc', 'C:/repo/a')
    const harness = makeHarness({
      agents: [sender],
      cold: [{ id: 'cold-fc', cwd: 'C:/repo/a' }],
      archiveReadFails: true,
    })
    // 读不到归档集合时不能「当作没有归档」继续唤醒：门禁会 blocked 收口，消息静默丢。
    const result = await harness.service.send(callerOf(sender), { to: 'cold-fc', message: 'x' }, signal)
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('归档')
    expect(harness.resumeCalls).toEqual([])
  })

  it('bakes the sender frame into relayed content', () => {
    const message = relayMessage('u-frame', 'hello', {
      messageId: 'm-frame',
      senderId: 'session-a',
      senderName: 'A',
    })
    expect(message.content[0]?.text).toBe('Session message m-frame from A (session-a):\nhello')
    expect(message.source['messageId']).toBe('m-frame')
    expect(message.source['kind']).toBe('session-message')
  })
})
