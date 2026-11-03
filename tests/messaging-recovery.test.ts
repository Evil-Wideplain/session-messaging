/**
 * 重放恢复：出站账本重放、持久化会话读取、生命周期订阅与历史去重。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../src/types.ts'
import { Config } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { readPersistedSession } from '../src/infrastructure/persisted-session.ts'
import { cleanupTempDirs } from './support/common.ts'
import {
  makeMessagingAgent,
  messagingCaller,
  requestHeader,
} from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('messaging service', () => {
  it('replays an unconfirmed outbox entry when the sender starts again', async () => {
    const target = makeMessagingAgent('target-9', 'C:/repo/a')
    const sender = makeMessagingAgent('sender-9', 'C:/repo/a')
    const harness = makeMessagingHarness({ agents: [sender, target] })

    const ledger = new JsonlOutboxRepository(harness.outboxDir, 'sender-9')
    ledger.queue({ messageId: 'legacy-1', senderId: 'sender-9', senderName: 'S', targetId: 'target-9', text: 'replayed', at: Date.now() })

    await harness.service.recover(sender)
    expect(target.session.events).toHaveLength(1)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-9').pending()).toHaveLength(0)
  })
})

describe('persisted session read', () => {
  it('accepts both the runtime wrapper and a plain event array', async () => {
    const events = [requestHeader('p', 'm')]
    const base = { header: { id: 's1' }, inheritedEventCount: 0, close: async () => {} }
    const wrapper = { open: async () => ({ ...base, read: async () => ({ events }) }) }
    expect((await readPersistedSession(wrapper as never, 's1')).events).toEqual(events)
    const plain = { open: async () => ({ ...base, read: async () => events }) }
    expect((await readPersistedSession(plain as never, 's1')).events).toEqual(events)
  })
})

describe('plugin wiring', () => {
  it('subscribes recovery to the real agent lifecycle event', () => {
    const subscribed: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      tools: { register: () => () => {} },
      agents: { list: () => [], get: () => undefined, resume: async () => { throw new Error('no resume') } },
      sessions: { get: () => undefined, flush: async () => true },
      effect: (fn: () => unknown) => { fn(); return () => {} },
      on: (event: string) => { subscribed.push(event); return () => {} },
      get: () => undefined,
    } as unknown as Context
    apply(ctx, Config({ socketEnabled: false }))
    expect(subscribed).toContain('agent/created')
    expect(subscribed).not.toContain('agent/session-start')
  })
})

describe('recovery dedupe', () => {
  it('does not replay a message already present in the target history', async () => {
    const sender = makeMessagingAgent('sender-r1', 'C:/repo/a')
    const target = makeMessagingAgent('target-r1', 'C:/repo/a')
    target.session.events.push({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: {
        id: 'x1',
        role: 'user',
        content: [{ type: 'text', text: 'old' }],
        source: { kind: 'session-message', form: 'relay', messageId: 'r1', senderId: 'sender-r1', senderName: 'S' },
      },
    })
    const harness = makeMessagingHarness({ agents: [sender, target] })
    new JsonlOutboxRepository(harness.outboxDir, 'sender-r1').queue({
      messageId: 'r1', senderId: 'sender-r1', senderName: 'S', targetId: 'target-r1', text: 'old', at: Date.now(),
    })

    await harness.service.recover(sender)

    expect(target.session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-r1').pending()).toHaveLength(0)
  })

  it('detects delivery in an offline target history before replaying', async () => {
    const sender = makeMessagingAgent('sender-r2', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-r2', cwd: 'C:/repo/a' }],
      coldEvents: new Map([['cold-r2', [{
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          id: 'x2',
          role: 'user',
          content: [{ type: 'text', text: 'old' }],
          source: { kind: 'session-message', form: 'relay', messageId: 'r2', senderId: 'sender-r2', senderName: 'S' },
        },
      } as SessionEvent]]]),
    })
    new JsonlOutboxRepository(harness.outboxDir, 'sender-r2').queue({
      messageId: 'r2', senderId: 'sender-r2', senderName: 'S', targetId: 'cold-r2', text: 'old', at: Date.now(),
    })

    await harness.service.recover(sender)

    expect(harness.resumeCalls).toEqual([])
    expect(new JsonlOutboxRepository(harness.outboxDir, 'sender-r2').pending()).toHaveLength(0)
  })
})
