/**
 * 发送与投递：在线投递、按名字解析、未授权隐藏、跨 workspace、去重与限流。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { cleanupTempDirs, spliced } from './support/common.ts'
import { makeMessagingAgent, messagingCaller } from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('messaging service', () => {
  it('delivers to a live session and confirms durable acceptance', async () => {
    const target = makeMessagingAgent('target-1', 'C:/repo/app')
    const sender = makeMessagingAgent('sender-1', 'C:/repo/app')
    const harness = makeMessagingHarness({ agents: [sender, target] })

    const result = await harness.service.send(messagingCaller(sender), { to: 'target-1', message: 'hello' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.id).toBe('target-1')

    const delivered = target.session.events.filter(event => event.type === 'agent/inbox/spliced')
    expect(delivered).toHaveLength(1)
    const pending = new JsonlOutboxRepository(harness.outboxDir, 'sender-1').pending()
    expect(pending).toHaveLength(0)
  })

  it('resolves a target by display name', async () => {
    const target = makeMessagingAgent('target-2', 'C:/repo/app')
    const sender = makeMessagingAgent('sender-2', 'C:/repo/app')
    const harness = makeMessagingHarness({ agents: [sender, target], titles: new Map([['target-2', 'Docs Writer']]) })

    const list = await harness.service.list(messagingCaller(sender), { includeSubagents: false })
    expect(list.agents.map(row => row.name)).toContain('Docs Writer')

    const result = await harness.service.send(messagingCaller(sender), { to: '"docs writer"', message: 'ping' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.id).toBe('target-2')
  })

  it('hides unauthorized targets behind the same not_found reply', async () => {
    const sender = makeMessagingAgent('sender-3', 'C:/repo/a')
    const far = makeMessagingAgent('far-1', 'C:/repo/b')
    const harness = makeMessagingHarness({ agents: [sender, far] })

    const missing = await harness.service.send(messagingCaller(sender), { to: 'nope', message: 'x' }, new AbortController().signal)
    expect(missing.status).toBe('not_found')

    // 跨 workspace 未授权与「不存在」返回同一文案，调用方无法用它枚举会话。
    const denied = await harness.service.send(messagingCaller(sender), { to: 'far-1', message: 'x' }, new AbortController().signal)
    expect(denied.status).toBe('not_found')
    expect(denied.detail).toMatch(/^没有匹配 ".+" 的会话$/)
    expect(missing.detail).toMatch(/^没有匹配 ".+" 的会话$/)
  })

  it('opens another workspace with the switch and its allowlist', async () => {
    const sender = makeMessagingAgent('sender-4', 'C:/repo/a')
    const far = makeMessagingAgent('far-2', 'C:/repo/b')
    const open = makeMessagingHarness({ agents: [sender, far], allowCrossWorkspace: true })
    expect((await open.service.send(messagingCaller(sender), { to: 'far-2', message: 'x' }, new AbortController().signal)).status).toBe('accepted')

    const sender5 = makeMessagingAgent('sender-5', 'C:/repo/a')
    const listed = makeMessagingHarness({ agents: [sender5, far], allowlist: ['C:/repo/b'] })
    expect((await listed.service.send(messagingCaller(sender5), { to: 'far-2', message: 'x' }, new AbortController().signal)).status).toBe('accepted')
  })

  it('deduplicates an identical body inside the window', async () => {
    const sender = makeMessagingAgent('sender-6', 'C:/repo/a')
    const target = makeMessagingAgent('target-6', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], dedupeWindowMs: 60_000 })

    const first = await harness.service.send(messagingCaller(sender), { to: 'target-6', message: 'same' }, new AbortController().signal)
    const second = await harness.service.send(messagingCaller(sender), { to: 'target-6', message: 'same' }, new AbortController().signal)
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('duplicate')
    expect(second.messageId).toBe(first.messageId)
  })

  it('refuses when the target already has too many unconfirmed messages', async () => {
    const sender = makeMessagingAgent('sender-8', 'C:/repo/a')
    const target = makeMessagingAgent('target-8', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], dedupeWindowMs: 0 })

    // 账本是追加式 JSONL：直接把该目标名下的未确认数填到上限即可。
    const limit = resolveConfig(Config({})).maxPendingPerTarget
    const ledger = new JsonlOutboxRepository(harness.outboxDir, 'sender-8')
    for (let index = 0; index < limit; index += 1) {
      ledger.queue({
        messageId: `seed-${index}`,
        senderId: 'sender-8',
        senderName: 'S',
        targetId: 'target-8',
        text: 'x',
        at: Date.now(),
      })
    }

    const result = await harness.service.send(messagingCaller(sender), { to: 'target-8', message: 'one more' }, new AbortController().signal)
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('未确认消息过多')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-8').pendingTo('target-8')).toBe(limit)
    expect(spliced(target)).toHaveLength(0)
  })

  it('enforces the per-target rate limit', async () => {
    const sender = makeMessagingAgent('sender-7', 'C:/repo/a')
    const target = makeMessagingAgent('target-7', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], maxPerMinute: 1, dedupeWindowMs: 0 })

    expect((await harness.service.send(messagingCaller(sender), { to: 'target-7', message: 'one' }, new AbortController().signal)).status).toBe('accepted')
    const second = await harness.service.send(messagingCaller(sender), { to: 'target-7', message: 'two' }, new AbortController().signal)
    expect(second.status).toBe('refused')
    expect(second.detail).toContain('频率限制')
  })
})

describe('delivery acceptance', () => {
  it('accepts a live delivery as soon as the inbox accepts it', async () => {
    const sender = makeMessagingAgent('sender-a1', 'C:/repo/a')
    // 目标在 steer 后立刻 claim（splice 被移除、user/message 还没落账）时，
    // 事件里可能暂时看不到消息；inbox acceptance 已成立，状态必须是 accepted。
    const target = makeMessagingAgent('target-a1', 'C:/repo/a', 'idle', { recordSteer: false })
    const harness = makeMessagingHarness({ agents: [sender, target] })

    const result = await harness.service.send(messagingCaller(sender), { to: 'target-a1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('inbox')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-a1').pending()).toHaveLength(0)
  })
})
