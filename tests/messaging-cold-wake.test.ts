/**
 * 冷会话唤醒：路由折叠、默认模型回退、无路由排队与首轮失败回滚。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { cleanupTempDirs } from './support/common.ts'
import type { MessagingAgent } from './support/messaging-fixtures.ts'
import {
  makeMessagingAgent,
  messagingCaller,
  requestHeader,
  waitFor,
} from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('messaging service', () => {
  it('wakes a cold session once even under concurrent sends', async () => {
    const sender = makeMessagingAgent('sender-8', 'C:/repo/a')
    let resumed: MessagingAgent | undefined
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-1', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-1', [requestHeader('test', 'test-model')]]]),
      resume: () => {
        resumed = makeMessagingAgent('cold-1', 'C:/repo/a', 'idle', { route: { provider: 'test', model: 'test-model' } })
        return resumed
      },
    })
    const signal = new AbortController().signal
    const [left, right] = await Promise.all([
      harness.service.send(messagingCaller(sender), { to: 'cold-1', message: 'wake' }, signal),
      harness.service.send(messagingCaller(sender), { to: 'cold-1', message: 'wake too' }, signal),
    ])
    expect(left.status).toBe('accepted')
    expect(right.status).toBe('accepted')
    expect(harness.resumeCalls).toEqual(['cold-1'])
    expect(harness.resumeRequests[0]?.agentOptions).toMatchObject({ provider: 'test', model: 'test-model' })
    expect(resumed?.session.ownEvents()).toHaveLength(2)
  })
})

describe('cold wake route handling', () => {
  it('uses the folded history route when waking a session', async () => {
    const sender = makeMessagingAgent('sender-w1', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-w1', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-w1', [requestHeader('folded', 'folded-model')]]]),
      resume: () => makeMessagingAgent('cold-w1', 'C:/repo/a', 'idle', { route: { provider: 'folded', model: 'folded-model' } }),
    })
    const result = await harness.service.send(messagingCaller(sender), { to: 'cold-w1', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(harness.resumeRequests[0]?.agentOptions).toEqual({ provider: 'folded', model: 'folded-model' })
  })

  it('falls back to the deployment default model when history has no route', async () => {
    const sender = makeMessagingAgent('sender-w2', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-w2', cwd: 'C:/repo/a' }],
      agentDefault: { provider: 'default-p', model: 'default-m' },
      resume: () => makeMessagingAgent('cold-w2', 'C:/repo/a', 'idle', { route: { provider: 'default-p', model: 'default-m' } }),
    })
    const result = await harness.service.send(messagingCaller(sender), { to: 'cold-w2', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(harness.resumeRequests[0]?.agentOptions).toEqual({ provider: 'default-p', model: 'default-m' })
  })

  it('refuses to wake without any route instead of losing the message', async () => {
    const sender = makeMessagingAgent('sender-w3', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-w3', cwd: 'C:/repo/a' }],
      resume: () => makeMessagingAgent('cold-w3', 'C:/repo/a', 'idle', { route: { provider: 'p', model: 'm' } }),
    })
    const result = await harness.service.send(messagingCaller(sender), { to: 'cold-w3', message: 'wake' }, new AbortController().signal)
    expect(result.status).toBe('queued')
    expect(result.detail).toContain('模型路由')
    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-w3').pending()).toHaveLength(1)
  })

  it('rolls back a wake whose first turn fails, keeping the message queued', async () => {
    const sender = makeMessagingAgent('sender-w4', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-w4', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-w4', [requestHeader('p', 'm')]]]),
      resume: () => makeMessagingAgent('cold-w4', 'C:/repo/a', 'idle', { route: { provider: 'p', model: 'm' }, recordSteer: false }),
    })
    const pending = harness.service.send(messagingCaller(sender), { to: 'cold-w4', message: 'wake' }, new AbortController().signal)
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
