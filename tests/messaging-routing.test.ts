/**
 * 通道路由：team mailbox 优先于 subagent 通道，以及 inactive 队友的寻址。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { TeamMemberView } from '../src/types.ts'
import { planDelivery } from '../src/domain/routing.ts'
import { cleanupTempDirs } from './support/common.ts'
import { makeMessagingAgent, messagingCaller } from './support/messaging-fixtures.ts'
import { makeMessagingHarness } from './support/messaging-harness.ts'

afterEach(cleanupTempDirs)

describe('team routing', () => {
  const members: readonly TeamMemberView[] = [
    { id: 'lead-1', name: 'lead', role: 'lead', status: 'running' },
    { id: 'worker-1', name: 'worker', role: 'teammate', status: 'inactive' },
  ]

  it('lists and routes to an inactive teammate through the team channel', async () => {
    const lead = makeMessagingAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeMessagingHarness({ agents: [lead], team: { members, sends } })

    const list = await harness.service.list(messagingCaller(lead), { includeSubagents: false })
    const worker = list.agents.find(row => row.id === 'worker-1')
    expect(worker).toMatchObject({ name: 'worker', kind: 'teammate', state: 'offline' })

    const result = await harness.service.send(messagingCaller(lead), { to: 'worker-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('团队邮箱')
    expect(sends).toEqual(['worker'])
  })

  it('resolves an inactive teammate by name', async () => {
    const lead = makeMessagingAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeMessagingHarness({ agents: [lead], team: { members, sends } })
    const result = await harness.service.send(messagingCaller(lead), { to: 'worker', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.target?.name).toBe('worker')
    expect(sends).toEqual(['worker'])
  })

  it('keeps team routing when cold wake is disabled', async () => {
    const lead = makeMessagingAgent('lead-1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeMessagingHarness({ agents: [lead], team: { members, sends }, allowColdWake: false })
    const result = await harness.service.send(messagingCaller(lead), { to: 'worker-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(sends).toEqual(['worker'])
  })

  it('prefers the team channel over the subagent channel', () => {
    const decision = planDelivery({
      target: { id: 'worker-1', kind: 'subagent', parentSession: 'lead-1', status: 'offline' },
      senderId: 'lead-1',
      isOwnSubagent: true,
      teamMemberName: 'worker',
      hasSubagentChannel: true,
      hasTeamChannel: true,
    })
    expect(decision.route).toBe('team')
  })
})

describe('cold wake', () => {
  it('refuses an offline peer when cold wake is disabled', async () => {
    const sender = makeMessagingAgent('sender-cw', 'C:/repo/a')
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'cold-peer', cwd: 'C:/repo/a' }],
      allowColdWake: false,
    })

    const result = await harness.service.send(
      messagingCaller(sender),
      { to: 'cold-peer', message: 'hi' },
      new AbortController().signal,
    )
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('冷唤醒已关闭')
    expect(harness.resumeCalls).toEqual([])
  })
})

describe('own subagents', () => {
  it('lists and wakes the caller own ended subagent through the subagent channel', async () => {
    const sender = makeMessagingAgent('sender-s1', 'C:/repo/a')
    const sends: string[] = []
    const harness = makeMessagingHarness({
      agents: [sender],
      cold: [{ id: 'sub-1', cwd: 'C:/repo/a', origin: 'subagent', parentSession: 'sender-s1' }],
      subagents: { sends },
    })

    const list = await harness.service.list(messagingCaller(sender), { includeSubagents: false })
    const sub = list.agents.find(row => row.id === 'sub-1')
    expect(sub).toMatchObject({ kind: 'subagent', state: 'offline' })

    const result = await harness.service.send(messagingCaller(sender), { to: 'sub-1', message: 'hi' }, new AbortController().signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('subagent 通道')
    expect(sends).toEqual(['sub-1'])
  })
})
