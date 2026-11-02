/**
 * 包级端到端测试。
 *
 * 加载*构建产物*（`lib/index.js`，而不是 `src/`），按真实 harness 的方式驱动插件：
 * `apply(ctx, config)` 在携带 DSH 服务的上下文里注册工具，然后通过每个工具公开的
 * `execute()` 入口执行，并用真实 socket / 命名管道和真实 bearer token 走一遍本地总线。
 *
 * 这补上了单测覆盖不到的环节：ESM 产物与跨模块导入、插件入口（`name`、`inject`、
 * `Config`、`apply`）、真正暴露给模型的工具定义，以及经 `ctx.shellEnv` 接出的 shell 传输。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { JsonlOutboxRepository } from '../lib/infrastructure/jsonl-outbox-repository.js'
import type { Agent, SessionEvent, ToolDefinition, ToolExecution } from '../src/types.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-e2e-'))
  tempDirs.push(dir)
  return dir
}

interface FakeHeader {
  readonly id: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

function makeAgent(header: FakeHeader): Agent {
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

interface BootOptions {
  readonly agents: Agent[]
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  readonly titles?: ReadonlyMap<string, string>
}

function boot(options: BootOptions) {
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

/** 通过真实端点发一条总线请求（端点来自 shell 环境变量）。 */
async function busRequest(
  endpoint: string,
  token: string,
  request: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`)
    })
    socket.on('data', (chunk: string) => { buffer += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as { ok: boolean })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** 轮询等待总线服务可连接。 */
async function waitForBus(endpoint: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      await busRequest(endpoint, 'probe', { op: 'list' })
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

const spliced = (agent: Agent) => agent.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced')

describe('built package end to end', () => {
  it('exposes the documented plugin entry points', () => {
    expect(plugin.name).toBe('session-messaging')
    expect(plugin.inject).toEqual(['tools', 'agents', 'sessions'])
    const config = plugin.Config({})
    expect(config.inbound).toBe('accept')
    expect(config.holdExpiryMs).toBe(300_000)
    expect(config.maxHeldPerTarget).toBe(100)
    expect(config.allowCrossWorkspace).toBe(false)
    expect(config.socketEnabled).toBe(true)
  })

  it('registers the three tools with model-facing schemas and renders', async () => {
    const harness = boot({ agents: [makeAgent({ id: 'a', cwd: '/repo' })] })
    try {
      expect([...harness.tools.keys()].sort()).toEqual([
        'list_session_agents',
        'review_session_messages',
        'send_session_message',
      ])
      for (const definition of harness.tools.values()) {
        expect(definition.description.length).toBeGreaterThan(20)
        expect(definition.parameters['type']).toBe('object')
        expect(definition.output.schema['type']).toBe('object')
        expect(typeof definition.output.render).toBe('function')
      }
      for (let attempt = 0; attempt < 200 && harness.shellContributors.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      expect(harness.shellContributors.map(contributor => contributor.name)).toEqual(['session-messaging'])
    } finally {
      await harness.dispose()
    }
  })

  it('delivers tool and bus messages into a live session inbox', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = boot({ agents: [sender, target], titles: new Map([['target', 'docs-bot']]) })
    try {
      const list = harness.tools.get('list_session_agents')
      const send = harness.tools.get('send_session_message')
      expect(list).toBeDefined()
      expect(send).toBeDefined()

      const listed = await list!.execute({}, harness.exec(sender)) as {
        agents: { name: string; id: string; state: string }[]
      }
      expect(listed.agents).toEqual([
        { name: 'docs-bot', id: 'target', short_id: 'target', cwd: '/repo', workspace: 'same', state: 'idle', kind: 'peer', sendable: true },
      ].map(row => ({ ...row, short_id: row.id.slice(0, 8) })))

      const sent = await send!.execute({ to: 'docs-bot', message: 'ping', summary: 'e2e' }, harness.exec(sender)) as {
        status: string
        message_id: string
      }
      expect(sent.status).toBe('accepted')
      const delivered = spliced(target)
      expect(delivered).toHaveLength(1)
      const message = (delivered[0]!.data as { inserted: { source: { kind: string; messageId: string } }[] }).inserted[0]
      expect(message?.source.messageId).toBe(sent.message_id)
      expect(message?.source.kind).toBe('session-message')

      // 去重键包含摘要：同正文、同摘要才判 duplicate（摘要不同是另一条消息）。
      const duplicate = await send!.execute(
        { to: 'docs-bot', message: 'ping', summary: 'e2e' },
        harness.exec(sender),
      ) as {
        status: string
      }
      expect(duplicate.status).toBe('duplicate')

      // shell 传输：同一个会话用自己的 token，以 bash 的身份发起请求。
      // shellEnv 只在总线真正 listening 之后才注册（异步），这里等它出现。
      for (let attempt = 0; attempt < 200 && harness.shellContributors.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      const contributor = harness.shellContributors[0]!
      const env = contributor.resolve(harness.exec(sender))
      const endpoint = env['DSH_SESSION_MESSAGING_SOCKET']
      const token = env['DSH_SESSION_MESSAGING_TOKEN']
      expect(typeof endpoint).toBe('string')
      expect(typeof token).toBe('string')
      await waitForBus(endpoint!)

      const busList = await busRequest(endpoint!, token!, { op: 'list' })
      expect(busList.ok).toBe(true)
      expect((busList.result as { agents: { id: string }[] }).agents.map(row => row.id)).toEqual(['target'])

      const busSend = await busRequest(endpoint!, token!, { op: 'send', to: 'target', message: 'from the shell' })
      expect(busSend.ok).toBe(true)
      expect((busSend.result as { status: string }).status).toBe('accepted')
      expect(spliced(target)).toHaveLength(2)

      const forged = await busRequest(endpoint!, 'not-a-token', { op: 'list' })
      expect(forged.ok).toBe(false)
      expect(forged.error?.code).toBe('unauthenticated')
    } finally {
      await harness.dispose()
    }
  })

  it('holds a message and delivers it only after the target accepts it', async () => {
    const sender = makeAgent({ id: 'sender', cwd: '/repo' })
    const target = makeAgent({ id: 'target', cwd: '/repo' })
    const harness = boot({ agents: [sender, target], inbound: 'hold' })
    try {
      const send = harness.tools.get('send_session_message')!
      const review = harness.tools.get('review_session_messages')!
      const sent = await send.execute({ to: 'target', message: 'ship it' }, harness.exec(sender)) as {
        status: string
        message_id: string
      }
      expect(sent.status).toBe('held')
      expect(spliced(target)).toHaveLength(1) // the approval notice only

      const inspected = await review.execute({ action: 'list' }, harness.exec(target)) as {
        held: { message_id: string; preview: string }[]
      }
      expect(inspected.held).toHaveLength(1)
      expect(inspected.held[0]?.message_id).toBe(sent.message_id)
      expect(inspected.held[0]?.preview).toBe('ship it')

      const accepted = await review.execute({ action: 'accept' }, harness.exec(target)) as {
        outcomes: { status: string }[]
        held: unknown[]
      }
      expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['accepted'])
      expect(accepted.held).toHaveLength(0)
      expect(spliced(target)).toHaveLength(2)
      expect(new JsonlOutboxRepository(harness.outboxDir, 'sender').pending()).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})
