import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionEvent } from '../src/types.ts'
import { identityOf } from '../src/domain/authorization.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { createMessagingRuntime } from '../src/composition.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-approval-'))
  tempDirs.push(dir)
  return dir
}

interface FakeHeader {
  readonly id: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

function makeAgent(header: FakeHeader, status: 'idle' | 'running' = 'idle'): Agent {
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

interface HarnessOptions {
  readonly agents: Agent[]
  readonly titles?: ReadonlyMap<string, string>
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  readonly holdExpiryMs?: number
  readonly maxHeldPerTarget?: number
  readonly subagents?: { readonly calls: { targetId: string; text: string }[]; readonly fail?: boolean }
  readonly agentTeams?: { readonly name: string; readonly calls: { target: string; text: string }[]; readonly fail?: boolean }
  readonly outboxDir?: string
}

function makeHarness(options: HarnessOptions) {
  const agents = [...options.agents]
  const titles = options.titles ?? new Map<string, string>()
  const services = new Map<string, unknown>()
  const outboxDir = options.outboxDir ?? tempDir()

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

const signal = new AbortController().signal
const callerOf = (agent: Agent) => ({ agent, identity: identityOf(agent) })
const spliced = (agent: Agent) => agent.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced')

describe('official channel routing', () => {
  it('delivers to the caller\'s own subagent through the subagent channel', async () => {
    const sender = makeAgent({ id: 'parent', cwd: '/repo' })
    const child = makeAgent({ id: 'child', cwd: '/repo', origin: 'subagent', parentSession: 'parent' })
    const subagents = { calls: [] as { targetId: string; text: string }[] }
    const harness = makeHarness({ agents: [sender, child], subagents })

    const result = await harness.service.send(callerOf(sender), { to: 'child', message: 'check the build' }, signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('subagent 通道')
    expect(subagents.calls.map(call => call.targetId)).toEqual(['child'])
    // 官方通道收到的是带来源框架的正文（目标模型据此判断消息不是人类指令）。
    expect(subagents.calls[0]?.text).toContain('check the build')
    expect(subagents.calls[0]?.text.startsWith('Session message ')).toBe(true)
    expect(spliced(child)).toHaveLength(0)
  })

  it('falls back to the inbox when the subagent channel refuses', async () => {
    const sender = makeAgent({ id: 'parent', cwd: '/repo' })
    const child = makeAgent({ id: 'child', cwd: '/repo', origin: 'subagent', parentSession: 'parent' })
    const subagents = { calls: [] as { targetId: string; text: string }[], fail: true }
    const harness = makeHarness({ agents: [sender, child], subagents })

    const result = await harness.service.send(callerOf(sender), { to: 'child', message: 'still here' }, signal)
    expect(result.status).toBe('accepted')
    expect(spliced(child)).toHaveLength(1)
  })

  it('delivers to a teammate through the team mailbox, across workspaces', async () => {
    const sender = makeAgent({ id: 'lead', cwd: '/repo/a' })
    const teammate = makeAgent({ id: 'teammate-1', cwd: '/repo/b' })
    const agentTeams = { name: 'Docs Bot', calls: [] as { target: string; text: string }[] }
    const harness = makeHarness({ agents: [sender, teammate], agentTeams })

    const listed = await harness.service.list(callerOf(sender), { includeSubagents: false })
    expect(listed.agents.find(row => row.id === 'teammate-1')?.kind).toBe('teammate')

    const result = await harness.service.send(callerOf(sender), { to: 'teammate-1', message: 'update the docs' }, signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('团队邮箱')
    expect(agentTeams.calls.map(call => call.target)).toEqual(['Docs Bot'])
    expect(agentTeams.calls[0]?.text).toContain('update the docs')
    expect(agentTeams.calls[0]?.text.startsWith('Session message ')).toBe(true)
    expect(spliced(teammate)).toHaveLength(0)
  })
})

describe('inbound approval (Claude Code style)', () => {
  it('holds a message, notifies the target, and accepts it on review', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold' })

    const sent = await harness.service.send(callerOf(sender), { to: 'target', message: 'deploy now', summary: 'deploy' }, signal)
    expect(sent.status).toBe('held')
    expect(sent.expiresAt).toBeGreaterThan(Date.now())
    expect(spliced(target)).toHaveLength(1) // the approval notice, not the payload

    const listed = await harness.service.review(callerOf(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(1)
    expect(listed.held[0]?.preview).toBe('deploy now')
    expect(listed.held[0]?.summary).toBe('deploy')

    const accepted = await harness.service.review(callerOf(target), 'accept', undefined, signal)
    expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['accepted'])
    expect(accepted.held).toHaveLength(0)
    expect(spliced(target)).toHaveLength(2)

    // 发送方的 held 条目此时应变成已确认送达。
    const { JsonlOutboxRepository } = await import('../src/infrastructure/jsonl-outbox-repository.ts')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender').pending()).toHaveLength(0)
  })

  it('refuses a held message on review and never delivers it', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(callerOf(sender), { to: 'target', message: 'spam' }, signal)
    const refused = await harness.service.review(callerOf(target), 'refuse', undefined, signal)
    expect(refused.outcomes.map(outcome => outcome.status)).toEqual(['refused'])
    expect(spliced(target)).toHaveLength(1) // notice only
  })

  it('expires held messages past the deadline and tells a live sender', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold', holdExpiryMs: 10 })

    await harness.service.send(callerOf(sender), { to: 'target', message: 'too late' }, signal)
    await new Promise(resolve => setTimeout(resolve, 25))
    const listed = await harness.service.review(callerOf(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(0)
    expect(listed.outcomes.map(outcome => outcome.status)).toEqual(['expired'])
    expect(spliced(sender)).toHaveLength(1) // expiry notice
  })

  it('drops the oldest held message when the queue is full', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold', maxHeldPerTarget: 1 })

    await harness.service.send(callerOf(sender), { to: 'target', message: 'first' }, signal)
    await harness.service.send(callerOf(sender), { to: 'target', message: 'second' }, signal)
    const listed = await harness.service.review(callerOf(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(1)
    expect(listed.held[0]?.preview).toBe('second')
    // 淘汰发生在入队时，所以发送方会立刻收到通知；
    // 审批列表只会报告仍然挂起的消息。
    expect(spliced(sender)).toHaveLength(1)
  })

  it('rejects inbound delivery outright under the refuse policy', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'refuse' })

    const result = await harness.service.send(callerOf(sender), { to: 'target', message: 'hello' }, signal)
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('inbound')
    expect(spliced(target)).toHaveLength(0)
  })

  it('denies acceptance when the sender no longer satisfies the policy', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo/a' })
    const target = makeAgent({ id: 'target', cwd: '/repo/a' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(callerOf(sender), { to: 'target', message: 'stale authorization' }, signal)
    // 发送方的工作目录在目标裁决之前发生了变化；accept 必须重新检查策略，
    // 而不能信任发送时的快照。
    ;(sender.session.header as { cwd?: string }).cwd = '/repo/b'
    const accepted = await harness.service.review(callerOf(target), 'accept', undefined, signal)
    expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['denied'])
    expect(spliced(target)).toHaveLength(1) // notice only
  })

  it('does not replay a held message as if it were queued', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = makeHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(callerOf(sender), { to: 'target', message: 'held' }, signal)
    await harness.service.recover(sender)
    expect(spliced(target)).toHaveLength(1) // notice only, no re-steer of the payload
  })
})
