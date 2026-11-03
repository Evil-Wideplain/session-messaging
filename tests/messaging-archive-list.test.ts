/**
 * 归档门禁与列表 `include_subagents`：归档会话不可见、重放跳过、归档状态不可读时拒绝唤醒。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { cleanupTempDirs } from './support/common.ts'
import {
  makeMessagingAgent,
  messagingCaller,
  requestHeader,
  waitFor,
} from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('归档门禁与 include_subagents', () => {
  it('归档会话不出现在列表里，发送被明确拒绝且不唤醒', async () => {
    const caller = makeMessagingAgent('caller-arch', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [caller],
      cold: [{ id: 'cold-archived', cwd: 'C:/repo/a' }],
      archived: ['cold-archived'],
    })

    const list = await harness.service.list(messagingCaller(caller), { includeSubagents: false })
    expect(list.agents.map(row => row.id)).not.toContain('cold-archived')

    const result = await harness.service.send(
      messagingCaller(caller),
      { to: 'cold-archived', message: 'archived' },
      new AbortController().signal,
    )
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('已归档')
    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'caller-arch').pending()).toHaveLength(0)
  })

  it('恢复重放跳过归档目标，保持 queued 不丢账', async () => {
    const sender = makeMessagingAgent('sender-arch', 'C:/repo/a')
    const archived: string[] = []
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-q', cwd: 'C:/repo/a' }],
      archived,
    })

    // 没有模型路由，投递只能排队，不会真的唤醒。
    const result = await harness.service.send(
      messagingCaller(sender),
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
    const caller = makeMessagingAgent('caller-sub', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [caller],
      cold: [
        { id: 'own-sub', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'caller-sub' },
        { id: 'foreign-sub', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'other-session' },
      ],
    })

    const off = await harness.service.list(messagingCaller(caller), { includeSubagents: false })
    expect(off.agents.map(row => row.id)).toContain('own-sub')
    expect(off.agents.map(row => row.id)).not.toContain('foreign-sub')
    expect(off.omitted).toBeGreaterThan(0)

    const on = await harness.service.list(messagingCaller(caller), { includeSubagents: true })
    const foreign = on.agents.find(row => row.id === 'foreign-sub')
    expect(foreign?.kind).toBe('subagent')
    expect(foreign?.sendable).toBe(false)

    const denied = await harness.service.send(
      messagingCaller(caller),
      { to: 'foreign-sub', message: 'nope' },
      new AbortController().signal,
    )
    expect(denied.status).toBe('not_found')
  })

  it('首轮被归档门禁 blocked 时回滚并保持 queued', async () => {
    const sender = makeMessagingAgent('sender-blocked', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-blocked', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-blocked', [requestHeader('p', 'm')]]]),
      resume: () => makeMessagingAgent('cold-blocked', 'C:/repo/a', 'idle', {
        route: { provider: 'p', model: 'm' },
        recordSteer: false,
      }),
    })

    const pending = harness.service.send(
      messagingCaller(sender),
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
