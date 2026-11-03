/**
 * 入站审批（Claude Code 风格）：挂起、放行、拒绝、过期、队列淘汰与重放。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs, spliced } from './support/common.ts'
import {
  makeRoutingAgent,
  makeRoutingHarness,
  routingCaller,
  signal,
} from './support/routing-approval-fixtures.ts'

afterEach(cleanupTempDirs)

describe('inbound approval (Claude Code style)', () => {
  it('holds a message, notifies the target, and accepts it on review', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    const sent = await harness.service.send(routingCaller(sender), { to: 'target', message: 'deploy now', summary: 'deploy' }, signal)
    expect(sent.status).toBe('held')
    expect(sent.expiresAt).toBeGreaterThan(Date.now())
    expect(spliced(target)).toHaveLength(1) // the approval notice, not the payload

    const listed = await harness.service.review(routingCaller(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(1)
    expect(listed.held[0]?.preview).toBe('deploy now')
    expect(listed.held[0]?.summary).toBe('deploy')

    const accepted = await harness.service.review(routingCaller(target), 'accept', undefined, signal)
    expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['accepted'])
    expect(accepted.held).toHaveLength(0)
    expect(spliced(target)).toHaveLength(2)

    // 发送方的 held 条目此时应变成已确认送达。
    const { JsonlOutboxRepository } = await import('../src/infrastructure/jsonl-outbox-repository.ts')
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender').pending()).toHaveLength(0)
  })

  it('refuses a held message on review and never delivers it', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(routingCaller(sender), { to: 'target', message: 'spam' }, signal)
    const refused = await harness.service.review(routingCaller(target), 'refuse', undefined, signal)
    expect(refused.outcomes.map(outcome => outcome.status)).toEqual(['refused'])
    expect(spliced(target)).toHaveLength(1) // notice only
  })

  it('expires held messages past the deadline and tells a live sender', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold', holdExpiryMs: 10 })

    await harness.service.send(routingCaller(sender), { to: 'target', message: 'too late' }, signal)
    await new Promise(resolve => setTimeout(resolve, 25))
    const listed = await harness.service.review(routingCaller(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(0)
    expect(listed.outcomes.map(outcome => outcome.status)).toEqual(['expired'])
    expect(spliced(sender)).toHaveLength(1) // expiry notice
  })

  it('drops the oldest held message when the queue is full', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold', maxHeldPerTarget: 1 })

    await harness.service.send(routingCaller(sender), { to: 'target', message: 'first' }, signal)
    await harness.service.send(routingCaller(sender), { to: 'target', message: 'second' }, signal)
    const listed = await harness.service.review(routingCaller(target), 'list', undefined, signal)
    expect(listed.held).toHaveLength(1)
    expect(listed.held[0]?.preview).toBe('second')
    // 淘汰发生在入队时，所以发送方会立刻收到通知；
    // 审批列表只会报告仍然挂起的消息。
    expect(spliced(sender)).toHaveLength(1)
  })

  it('rejects inbound delivery outright under the refuse policy', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'refuse' })

    const result = await harness.service.send(routingCaller(sender), { to: 'target', message: 'hello' }, signal)
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('inbound')
    expect(spliced(target)).toHaveLength(0)
  })

  it('denies acceptance when the sender no longer satisfies the policy', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo/a' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo/a' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(routingCaller(sender), { to: 'target', message: 'stale authorization' }, signal)
    // 发送方的工作目录在目标裁决之前发生了变化；accept 必须重新检查策略，
    // 而不能信任发送时的快照。
    ;(sender.session.header as { cwd?: string }).cwd = '/repo/b'
    const accepted = await harness.service.review(routingCaller(target), 'accept', undefined, signal)
    expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['denied'])
    expect(spliced(target)).toHaveLength(1) // notice only
  })

  it('accepts only the message named by message_id and keeps the rest held', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    const first = await harness.service.send(routingCaller(sender), { to: 'target', message: 'one' }, signal)
    const second = await harness.service.send(routingCaller(sender), { to: 'target', message: 'two' }, signal)
    expect([first.status, second.status]).toEqual(['held', 'held'])

    const accepted = await harness.service.review(routingCaller(target), 'accept', first.messageId, signal)
    expect(accepted.outcomes.map(outcome => outcome.messageId)).toEqual([first.messageId])
    expect(accepted.outcomes.map(outcome => outcome.status)).toEqual(['accepted'])
    // 指定 message_id 只作用于那一条：另一条必须仍在账本里等下一轮裁决。
    expect(accepted.held.map(row => row.messageId)).toEqual([second.messageId])

    const listed = await harness.service.review(routingCaller(target), 'list', undefined, signal)
    expect(listed.held.map(row => row.messageId)).toEqual([second.messageId])
  })

  it('reports not_found for an unknown message_id and keeps other holds intact', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    const held = await harness.service.send(routingCaller(sender), { to: 'target', message: 'keep' }, signal)
    const result = await harness.service.review(routingCaller(target), 'accept', 'no-such-id', signal)
    expect(result.outcomes.map(outcome => outcome.status)).toEqual(['not_found'])
    expect(result.outcomes[0]?.detail).toContain('no-such-id')
    expect(result.held.map(row => row.messageId)).toEqual([held.messageId])
    expect(spliced(target)).toHaveLength(1) // notice only：未知 id 不触发投递
  })

  it('does not replay a held message as if it were queued', async () => {
    const sender = makeRoutingAgent({ id: 'sender', cwd: '/repo' })
    const target = makeRoutingAgent({ id: 'target', cwd: '/repo' })
    const harness = makeRoutingHarness({ agents: [sender, target], inbound: 'hold' })

    await harness.service.send(routingCaller(sender), { to: 'target', message: 'held' }, signal)
    await harness.service.recover(sender)
    expect(spliced(target)).toHaveLength(1) // notice only, no re-steer of the payload
  })
})
