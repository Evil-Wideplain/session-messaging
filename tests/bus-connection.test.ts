/**
 * 总线连接边界（framing + 请求体形状）。
 *
 * 三个语义各自对应一条实现约束：
 * 1. 一次连接只解析第一份文档，同一 chunk 的尾随文档按协议错误结束；
 * 2. 第一份文档解析后到达的字节不再 dispatch（否则同一连接能执行两条 send）；
 * 3. 请求体必须是普通 JSON 对象，`null`/数组/标量一律 `bad_request`。
 *
 * 与 `bus-protocol.test.ts`（参数校验）分开，保持每个测试文件 ≤200 行。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MessagingService } from '../src/application/messaging-service.ts'
import type { Agent } from '../src/types.ts'
import { LocalBus } from '../src/interfaces/local-bus.ts'

const tempDirs: string[] = []
const NEWLINE = '\n'

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-bus-conn-'))
  tempDirs.push(dir)
  return dir
}

/** 足以完成 token 鉴权的在线 Agent 替身。 */
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

/** 只认识给定会话 id 的假上下文。 */
function contextFor(ids: readonly string[]): Context {
  const agents = new Map(ids.map(id => [id, fakeAgent(id)]))
  return {
    logger: { warn: () => {} },
    agents: { get: (id: string) => agents.get(id) },
  } as unknown as Context
}

/** 一次性排入若干帧（不等待响应），收集一行响应。 */
async function writeFrames(endpoint: string, frames: readonly Buffer[]): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000)
    socket.on('connect', () => {
      for (const frame of frames) socket.write(frame)
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

describe('local bus connection framing', () => {
  it('同一次写入里的第二份文档按协议错误结束，且不执行任何请求', async () => {
    const calls: string[] = []
    const service = {
      list: async () => ({ agents: [], omitted: 0, truncated: 0 }),
      send: async (_caller: unknown, input: { message: string }) => {
        calls.push(input.message)
        return { status: 'accepted', messageId: 'm1', detail: 'ok' }
      },
    } as unknown as MessagingService
    const bus = new LocalBus(contextFor(['session-a']), service, tempDir())
    await bus.start()
    try {
      const token = bus.tokenFor('session-a')
      const first = JSON.stringify({ token, op: 'send', to: 'session-b', message: 'first' })
      const second = JSON.stringify({ token, op: 'send', to: 'session-b', message: 'second' })
      const response = await writeFrames(
        bus.endpoint,
        [Buffer.from(`${first}${NEWLINE}${second}${NEWLINE}`, 'utf8')],
      )

      expect((response['error'] as { code: string }).code).toBe('bad_request')
      expect((response['error'] as { message: string }).message).toBe('一次连接只能携带一个 JSON 文档')
      // 尾随文档不能被执行：first 也不执行，直接按协议错误收口。
      expect(calls).toEqual([])
    } finally {
      await bus.stop()
    }
  })

  it('分成两次写入的第二份文档不会再次 dispatch', async () => {
    const calls: string[] = []
    const service = {
      // 让第一次 dispatch 悬挂一会儿：第二次写入必须单独成为一个 data 事件，
      // 才真正走到「已解析后收到后续字节」的分支（同一 tick 的两次写入会被合并成一个 chunk）。
      list: async () => {
        calls.push('list')
        await new Promise(done => setTimeout(done, 25))
        return { agents: [], omitted: 0, truncated: 0 }
      },
      send: async () => ({ status: 'accepted', messageId: 'm1', detail: 'ok' }),
    } as unknown as MessagingService
    const bus = new LocalBus(contextFor(['session-a']), service, tempDir())
    await bus.start()
    try {
      const token = bus.tokenFor('session-a')
      const frame = Buffer.from(`${JSON.stringify({ token, op: 'list' })}${NEWLINE}`, 'utf8')
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = connect(bus.endpoint)
        let buffer = ''
        socket.setEncoding('utf8')
        socket.setTimeout(5_000)
        socket.on('connect', () => {
          socket.write(frame)
          setTimeout(() => { socket.write(frame) }, 10)
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

      // 第二份文档永远不执行：无论客户端读到的是第一条的成功还是协议错误，
      // 服务端都只 dispatch 一次。
      expect(calls).toEqual(['list'])
      expect(typeof response['ok']).toBe('boolean')
    } finally {
      await bus.stop()
    }
  })

  it('顶层不是 JSON 对象时返回 bad_request，而不是 failed/TypeError', async () => {
    const service = {
      list: async () => ({ agents: [], omitted: 0, truncated: 0 }),
      send: async () => ({ status: 'accepted', messageId: 'm1', detail: 'ok' }),
    } as unknown as MessagingService
    const bus = new LocalBus(contextFor(['session-a']), service, tempDir())
    await bus.start()
    try {
      for (const raw of ['null', '[]', '42', '"x"']) {
        const response = await writeFrames(bus.endpoint, [Buffer.from(`${raw}${NEWLINE}`, 'utf8')])
        expect(response['ok'], raw).toBe(false)
        expect((response['error'] as { code: string }).code, raw).toBe('bad_request')
        expect((response['error'] as { message: string }).message, raw).toBe('请求体必须是 JSON 对象')
      }
    } finally {
      await bus.stop()
    }
  })
})
