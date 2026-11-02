import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '../src/types.ts'
import type { MessagingService } from '../src/application/messaging-service.ts'
import { LocalBus, registerShellEnv } from '../src/interfaces/local-bus.ts'
import { busEndpoint } from '../src/infrastructure/paths.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-bus-'))
  tempDirs.push(dir)
  return dir
}

/** 一个足以完成 token 鉴权的在线 Agent 替身。 */
function fakeAgent(id: string): Agent {
  return {
    id,
    session: { id, header: { id, cwd: '/repo' }, inheritedEventCount: 0, ownEvents: () => [] },
    status: 'idle',
    steer: () => {},
    followup: () => {},
    whenIdle: async () => {},
  } as unknown as Agent
}

/** 向端点发送一行请求，并收集一行响应。 */
async function request(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let buffer = ''
    socket.setTimeout(5_000)
    socket.on('connect', () => { socket.write(`${JSON.stringify(body)}\n`) })
    socket.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8') })
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', reject)
    socket.on('timeout', () => { reject(new Error('bus response timed out')) })
  })
}

describe('local bus', () => {
  it('authenticates a token, lists, and sends through the service', async () => {
    const agent = fakeAgent('session-a')
    const calls: { readonly to: string; readonly message: string }[] = []
    const service = {
      list: async () => ({ agents: [{ name: 'Docs', id: 'session-b', shortId: 'sessionb', cwd: '/repo', workspace: 'same', state: 'idle', kind: 'peer' }], omitted: 0 }),
      send: async (_caller: unknown, input: { to: string; message: string }) => {
        calls.push(input)
        return { status: 'accepted', messageId: 'm1', detail: 'ok', target: { id: input.to, name: input.to } }
      },
    } as unknown as MessagingService
    const ctx = {
      logger: { warn: () => {} },
      agents: { get: (id: string) => id === 'session-a' ? agent : undefined },
    } as unknown as Context

    const bus = new LocalBus(ctx, service, tempDir())
    await bus.start()
    try {
      const token = bus.tokenFor('session-a')

      const listed = await request(bus.endpoint, { token, op: 'list' })
      expect(listed['ok']).toBe(true)

      const sent = await request(bus.endpoint, { token, op: 'send', to: 'session-b', message: 'hi' })
      expect(sent['ok']).toBe(true)
      expect(calls).toEqual([{ to: 'session-b', message: 'hi' }])

      const rejected = await request(bus.endpoint, { token: 'forged', op: 'list' })
      expect(rejected['ok']).toBe(false)
      expect((rejected['error'] as { code: string }).code).toBe('unauthenticated')

      const unknownOp = await request(bus.endpoint, { token, op: 'drop-all' })
      expect((unknownOp['error'] as { code: string }).code).toBe('bad_request')
    } finally {
      await bus.stop()
    }
  })

  it('registers the endpoint and token into shell environments', () => {
    let contributor: Parameters<NonNullable<Context['shellEnv']>['register']>[0] | undefined
    const ctx = {
      get: (name: string) => name === 'shellEnv'
        ? { register: (registered: typeof contributor) => { contributor = registered; return () => {} } }
        : undefined,
    } as unknown as Context
    const bus = new LocalBus(ctx, {} as unknown as MessagingService, tempDir())
    const dispose = registerShellEnv(ctx, bus)

    expect(contributor?.name).toBe('session-messaging')
    expect(Object.keys(contributor?.variables ?? {}).sort()).toEqual([
      'DSH_SESSION_MESSAGING_SOCKET',
      'DSH_SESSION_MESSAGING_TOKEN',
    ])
    const env = contributor?.resolve({ agent: fakeAgent('session-a') } as never) ?? {}
    expect(env['DSH_SESSION_MESSAGING_SOCKET']).toBe(bus.endpoint)
    expect(env['DSH_SESSION_MESSAGING_TOKEN']).toBe(bus.tokenFor('session-a'))
    expect(contributor?.resolve({} as never)).toEqual({})
    dispose()
  })

  it('derives a stable endpoint from the socket directory', () => {
    const dir = tempDir()

    expect(busEndpoint(dir)).toBe(busEndpoint(dir))
    expect(busEndpoint(dir)).not.toBe(busEndpoint(tempDir()))
  })

  it.skipIf(process.platform !== 'win32')(
    'lets two buses listen on different socket directories at once',
    async () => {
      const hostFor = (id: string) => {
        const agent = fakeAgent(id)
        const service = {
          list: async () => ({
            agents: [{ name: id, id, shortId: id, cwd: '/repo', workspace: 'same', state: 'idle', kind: 'peer' }],
            omitted: 0,
          }),
          send: async () => { throw new Error('send is not used in this test') },
        } as unknown as MessagingService
        const ctx = {
          logger: { warn: () => {} },
          agents: { get: (candidate: string) => candidate === id ? agent : undefined },
        } as unknown as Context
        return { id, bus: new LocalBus(ctx, service, tempDir()) }
      }

      const hosts = [hostFor('alpha'), hostFor('beta')]
      expect(hosts[0].bus.endpoint).not.toBe(hosts[1].bus.endpoint)

      await Promise.all(hosts.map(host => host.bus.start()))
      try {
        for (const host of hosts) {
          const listed = await request(host.bus.endpoint, {
            token: host.bus.tokenFor(host.id),
            op: 'list',
          })
          expect(listed['ok']).toBe(true)
          const result = listed['result'] as { agents: { name: string }[] }
          expect(result.agents.map(agent => agent.name)).toEqual([host.id])
        }
      } finally {
        await Promise.all(hosts.map(host => host.bus.stop()))
      }
    },
  )
})
