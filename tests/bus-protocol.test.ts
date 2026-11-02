import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '../src/types.ts'
import type { MessagingService } from '../src/application/messaging-service.ts'
import { LocalBus } from '../src/interfaces/local-bus.ts'

const NEWLINE = String.fromCharCode(10)

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-busproto-'))
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

function contextFor(ids: readonly string[]): Context {
  return {
    logger: { warn: () => {} },
    agents: { get: (id: string) => ids.includes(id) ? fakeAgent(id) : undefined },
  } as unknown as Context
}

/** 把预先切好的字节块按顺序写入，收集一行响应。 */
async function exchange(endpoint: string, chunks: readonly Buffer[]): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000)
    socket.on('connect', () => {
      let index = 0
      const next = (): void => {
        const chunk = chunks[index]
        index += 1
        if (chunk === undefined) return
        socket.write(chunk)
        setTimeout(next, 10)
      }
      next()
    })
    socket.on('data', (chunk: string) => { buffer += chunk })
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

/** 单次写入的便捷封装。 */
async function request(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  return await exchange(endpoint, [Buffer.from(`${JSON.stringify(body)}${NEWLINE}`, 'utf8')])
}

describe('local bus protocol', () => {
  it('keeps a multi-byte character intact when a request is split across writes', async () => {
    const calls: string[] = []
    const service = {
      list: async () => ({ agents: [], omitted: 0, truncated: 0 }),
      send: async (_caller: unknown, input: { message: string }) => {
        calls.push(input.message)
        return { status: 'accepted', messageId: 'm1', detail: 'ok', target: { id: 'session-b', name: 'session-b' } }
      },
    } as unknown as MessagingService
    const bus = new LocalBus(contextFor(['session-a']), service, tempDir())
    await bus.start()
    try {
      const message = '中文消息：跨 chunk 传输'
      const body = Buffer.from(
        `${JSON.stringify({ token: bus.tokenFor('session-a'), op: 'send', to: 'session-b', message })}${NEWLINE}`,
        'utf8',
      )
      // 切在「消」字的第二个字节中间：逐 chunk toString('utf8') 的实现会得到 U+FFFD。
      const cut = body.indexOf(Buffer.from('消', 'utf8')) + 1
      expect(cut).toBeGreaterThan(0)

      const response = await exchange(bus.endpoint, [body.subarray(0, cut), body.subarray(cut)])
      expect(response['ok']).toBe(true)
      expect(calls).toEqual([message])
    } finally {
      await bus.stop()
    }
  })

  it('rejects mistyped parameters instead of silently ignoring them', async () => {
    const listCalls: unknown[] = []
    const service = {
      list: async (_caller: unknown, input: unknown) => {
        listCalls.push(input)
        return { agents: [], omitted: 0, truncated: 0 }
      },
      send: async () => ({ status: 'accepted', messageId: 'm1', detail: 'ok' }),
    } as unknown as MessagingService
    const bus = new LocalBus(contextFor(['session-a']), service, tempDir())
    await bus.start()
    try {
      const token = bus.tokenFor('session-a')
      const cases: { readonly body: unknown; readonly why: string }[] = [
        { body: { token, op: 'list', limit: '10' }, why: 'limit 是字符串' },
        { body: { token, op: 'list', limit: 0 }, why: 'limit 越界' },
        { body: { token, op: 'list', include_subagents: 'yes' }, why: 'include_subagents 是字符串' },
        { body: { token, op: 'send', to: 'session-b', message: 'x', dedupe: 'no' }, why: 'dedupe 是字符串' },
        { body: { token, op: 'send', to: '', message: 'x' }, why: 'to 为空' },
        { body: { token, op: 'send', to: 'session-b' }, why: '缺少 message' },
      ]
      for (const item of cases) {
        const response = await request(bus.endpoint, item.body)
        expect(response['ok'], item.why).toBe(false)
        expect((response['error'] as { code: string }).code, item.why).toBe('bad_request')
      }
      // 错类型不能发出去，也不能被当成一次真实调用。
      expect(listCalls).toEqual([])

      const listed = await request(bus.endpoint, { token, op: 'list', include_subagents: true, limit: 5 })
      expect(listed['ok']).toBe(true)
      expect(listCalls.at(-1)).toMatchObject({ includeSubagents: true, limit: 5 })
    } finally {
      await bus.stop()
    }
  })

  it('falls back to a private endpoint instead of stealing the live one', async () => {
    const dir = tempDir()
    const service = {
      list: async () => ({ agents: [], omitted: 0, truncated: 0 }),
      send: async () => ({ status: 'accepted', messageId: 'm1', detail: 'ok' }),
    } as unknown as MessagingService

    const owner = new LocalBus(contextFor(['alpha']), service, dir)
    await owner.start()
    try {
      // 第二个宿主（例如 GUI 已在跑时的 dsh headless）不能抢端点，但本进程的
      // 脚本仍要能用：退让到进程私有端点。
      const second = new LocalBus(contextFor(['beta']), service, dir)
      const shared = second.endpoint
      await second.start()
      try {
        expect(second.endpoint).not.toBe(owner.endpoint)
        expect(second.endpoint).not.toBe(shared)

        const ownList = await request(second.endpoint, { token: second.tokenFor('beta'), op: 'list' })
        expect(ownList['ok']).toBe(true)
        const ownerList = await request(owner.endpoint, { token: owner.tokenFor('alpha'), op: 'list' })
        expect(ownerList['ok']).toBe(true)
      } finally {
        await second.stop()
      }
      // 退让方的 stop() 不能删掉属主的端点。
      const afterStop = await request(owner.endpoint, { token: owner.tokenFor('alpha'), op: 'list' })
      expect(afterStop['ok']).toBe(true)
    } finally {
      await owner.stop()
    }
  })
})
