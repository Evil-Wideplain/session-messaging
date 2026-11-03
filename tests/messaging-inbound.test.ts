/**
 * 入站审批挂起消息的惰性过期、逐个过期与批次结果上报。
 */

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { relayMessage } from '../src/domain/message.ts'
import { JsonlInboundRepository } from '../src/infrastructure/jsonl-inbound-repository.ts'
import { cleanupTempDirs, spliced } from './support/common.ts'
import { makeMessagingAgent, messagingCaller } from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('inbound expiry reporting', () => {
  it('reports messages expired during recovery on the next review', async () => {
    const sender = makeMessagingAgent('sender-e1', 'C:/repo/a')
    const target = makeMessagingAgent('target-e1', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], inbound: 'hold', holdExpiryMs: 1 })

    const held = await harness.service.send(messagingCaller(sender), { to: 'target-e1', message: 'expire-me' }, new AbortController().signal)
    expect(held.status).toBe('held')
    await new Promise(done => setTimeout(done, 10))

    // 目标会话“启动”：recover 先惰性过期，目标还没来得及 review。
    await harness.service.recover(target)
    const review = await harness.service.review(messagingCaller(target), 'list', undefined, new AbortController().signal)
    expect(review.held).toHaveLength(0)
    expect(review.outcomes.map(outcome => outcome.status)).toEqual(['expired'])

    // 报告一次后清空，不重复报告。
    const again = await harness.service.review(messagingCaller(target), 'list', undefined, new AbortController().signal)
    expect(again.outcomes).toEqual([])
  })
})

describe('review fixes', () => {
  const signal = new AbortController().signal

  it('expires only the messages whose deadline passed', async () => {
    const target = makeMessagingAgent('target-exp', 'C:/repo/a')
    const sender = makeMessagingAgent('sender-exp', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], inbound: 'hold' })
    const inboundDir = join(harness.outboxDir, 'inbound')
    const inbound = new JsonlInboundRepository(inboundDir, 'target-exp')
    const now = Date.now()
    const base = { senderId: 'sender-exp', senderName: 'S', targetId: 'target-exp', text: 'x', at: now }
    inbound.hold({ ...base, messageId: 'expired-1', expiresAt: now - 1_000 })
    inbound.hold({ ...base, messageId: 'live-1', expiresAt: now + 300_000 })

    const result = await harness.service.review(messagingCaller(target), 'list', undefined, signal)
    expect(result.held.map(row => row.messageId)).toEqual(['live-1'])
    expect(result.outcomes.map(outcome => outcome.messageId)).toEqual(['expired-1'])
    // 未过期的那条必须仍在账本里，而不是被 settle 一起删掉。
    expect(new JsonlInboundRepository(inboundDir, 'target-exp').held().map(entry => entry.messageId))
      .toEqual(['live-1'])
  })

  it('treats a different summary as a different message and lets dedupe=false through', async () => {
    const sender = makeMessagingAgent('sender-dd', 'C:/repo/a')
    const target = makeMessagingAgent('target-dd', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], dedupeWindowMs: 60_000 })

    const first = await harness.service.send(messagingCaller(sender), { to: 'target-dd', message: 'same', summary: 'one' }, signal)
    const second = await harness.service.send(messagingCaller(sender), { to: 'target-dd', message: 'same', summary: 'two' }, signal)
    expect([first.status, second.status]).toEqual(['accepted', 'accepted'])

    const third = await harness.service.send(messagingCaller(sender), { to: 'target-dd', message: 'same', summary: 'two' }, signal)
    expect(third.status).toBe('duplicate')

    const forced = await harness.service.send(
      messagingCaller(sender),
      { to: 'target-dd', message: 'same', summary: 'two', dedupe: false },
      signal,
    )
    expect(forced.status).toBe('accepted')
  })

  it('does not let the allowlist bypass the foreign-subagent rule', async () => {
    const sender = makeMessagingAgent('sender-al', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      allowlist: ['C:/repo'],
      cold: [{ id: 'child-al', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'other-session' }],
    })
    const result = await harness.service.send(messagingCaller(sender), { to: 'child-al', message: 'hi' }, signal)
    expect(result.status).toBe('not_found')
  })

  it('does not leak unauthorized sessions through ambiguous replies', async () => {
    const sender = makeMessagingAgent('sender-amb', 'C:/repo/a')
    const title = [{ type: 'session/title', seq: 1, time: 1, data: { title: 'Same Title' } }]
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [
        { id: 'amb-1', cwd: 'C:/repo/a' },
        { id: 'amb-2', cwd: 'C:/repo/b' },
      ],
      coldEvents: new Map([['amb-1', title], ['amb-2', title]]),
    })
    // 同名但只有一个可见：不能报 ambiguous（否则回包里会带出另一个会话）。
    const visible = await harness.service.send(messagingCaller(sender), { to: 'Same Title', message: 'x' }, signal)
    expect(visible.status).not.toBe('ambiguous')
    expect(visible.candidates).toBeUndefined()

    // 只把跨 workspace 的那个标题留给调用方：应得到 not_found，而不是带候选的 ambiguous。
    const hidden = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'amb-3', cwd: 'C:/repo/b' }],
      coldEvents: new Map([['amb-3', title]]),
    })
    const denied = await hidden.service.send(messagingCaller(sender), { to: 'Same Title', message: 'x' }, signal)
    expect(denied.status).toBe('not_found')
    expect(denied.candidates).toBeUndefined()
  })

  it('counts limit truncation separately from hidden sessions', async () => {
    const caller = makeMessagingAgent('caller-tr', 'C:/repo/a')
    const left = makeMessagingAgent('tr-a', 'C:/repo/a')
    const right = makeMessagingAgent('tr-b', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [caller, left, right] })
    const result = await harness.service.list(messagingCaller(caller), { includeSubagents: false, limit: 1 })
    expect(result.agents).toHaveLength(1)
    expect(result.truncated).toBe(1)
    expect(result.omitted).toBe(0)
  })

  it('refuses cold wake when the archive set cannot be read', async () => {
    const sender = makeMessagingAgent('sender-fc', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-fc', cwd: 'C:/repo/a' }],
      archiveReadFails: true,
    })
    // 读不到归档集合时不能「当作没有归档」继续唤醒：门禁会 blocked 收口，消息静默丢。
    const result = await harness.service.send(messagingCaller(sender), { to: 'cold-fc', message: 'x' }, signal)
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('归档')
    expect(harness.resumeCalls).toEqual([])
  })

  it('notifies the target at most once per window for repeated holds', async () => {
    const sender = makeMessagingAgent('sender-n1', 'C:/repo/a')
    const target = makeMessagingAgent('target-n1', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target], inbound: 'hold' })

    const first = await harness.service.send(messagingCaller(sender), { to: 'target-n1', message: 'one' }, signal)
    const second = await harness.service.send(messagingCaller(sender), { to: 'target-n1', message: 'two' }, signal)
    expect([first.status, second.status]).toEqual(['held', 'held'])
    // notifyIntervalMs（默认 60s）窗口内只提示一次：每条挂起都塞通知会把
    // 目标的 inbox 刷满，而提示本身没有新信息。
    expect(spliced(target)).toHaveLength(1)
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
