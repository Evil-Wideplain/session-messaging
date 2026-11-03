/**
 * 包级端到端：插件入口、工具注册与入站审批（基于构建产物 `lib/index.js`）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../lib/index.js'
import * as creation from '../lib/creation.js'
import { JsonlOutboxRepository } from '../lib/infrastructure/jsonl-outbox-repository.js'
import { cleanupTempDirs, spliced } from './support/common.ts'
import { boot, makeE2eAgent } from './support/e2e-fixtures.ts'

afterEach(cleanupTempDirs)

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
    expect(config.allowCreateSession).toBe(true)
    expect(config.maxCreatesPerMinute).toBe(4)
  })

  it('splits create_session_agent into its own loader row', async () => {
    expect(creation.name).toBe('session-creation')
    expect(creation.inject).toEqual(['tools', 'sessionMessaging'])

    const harness = boot({
      agents: [makeE2eAgent({ id: 'a', cwd: '/repo' })],
      withCreation: false,
    })
    try {
      // 只装主行：三个会话间通信工具在，创建工具不在。
      expect([...harness.tools.keys()].sort()).toEqual([
        'list_session_agents',
        'review_session_messages',
        'send_session_message',
      ])
      // 创建行单独装回：只补 create_session_agent，不重复注册其他工具。
      creation.apply(harness.ctx)
      expect([...harness.tools.keys()].sort()).toEqual([
        'create_session_agent',
        'list_session_agents',
        'review_session_messages',
        'send_session_message',
      ])
    } finally {
      await harness.dispose()
    }
  })

  it('registers the four tools with model-facing schemas and renders', async () => {
    const harness = boot({ agents: [makeE2eAgent({ id: 'a', cwd: '/repo' })] })
    try {
      expect([...harness.tools.keys()].sort()).toEqual([
        'create_session_agent',
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

  it('holds a message and delivers it only after the target accepts it', async () => {
    const sender = makeE2eAgent({ id: 'sender', cwd: '/repo' })
    const target = makeE2eAgent({ id: 'target', cwd: '/repo' })
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
