/**
 * 官方通道路由：subagent 通道与 team mailbox 的优先顺序。
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

describe('official channel routing', () => {
  it('delivers to the caller\'s own subagent through the subagent channel', async () => {
    const sender = makeRoutingAgent({ id: 'parent', cwd: '/repo' })
    const child = makeRoutingAgent({ id: 'child', cwd: '/repo', origin: 'subagent', parentSession: 'parent' })
    const subagents = { calls: [] as { targetId: string; text: string }[] }
    const harness = makeRoutingHarness({ agents: [sender, child], subagents })

    const result = await harness.service.send(routingCaller(sender), { to: 'child', message: 'check the build' }, signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('subagent 通道')
    expect(subagents.calls.map(call => call.targetId)).toEqual(['child'])
    // 官方通道收到的是带来源框架的正文（目标模型据此判断消息不是人类指令）。
    expect(subagents.calls[0]?.text).toContain('check the build')
    expect(subagents.calls[0]?.text.startsWith('Session message ')).toBe(true)
    expect(spliced(child)).toHaveLength(0)
  })

  it('falls back to the inbox when the subagent channel refuses', async () => {
    const sender = makeRoutingAgent({ id: 'parent', cwd: '/repo' })
    const child = makeRoutingAgent({ id: 'child', cwd: '/repo', origin: 'subagent', parentSession: 'parent' })
    const subagents = { calls: [] as { targetId: string; text: string }[], fail: true }
    const harness = makeRoutingHarness({ agents: [sender, child], subagents })

    const result = await harness.service.send(routingCaller(sender), { to: 'child', message: 'still here' }, signal)
    expect(result.status).toBe('accepted')
    expect(spliced(child)).toHaveLength(1)
  })

  it('delivers to a teammate through the team mailbox, across workspaces', async () => {
    const sender = makeRoutingAgent({ id: 'lead', cwd: '/repo/a' })
    const teammate = makeRoutingAgent({ id: 'teammate-1', cwd: '/repo/b' })
    const agentTeams = { name: 'Docs Bot', calls: [] as { target: string; text: string }[] }
    const harness = makeRoutingHarness({ agents: [sender, teammate], agentTeams })

    const listed = await harness.service.list(routingCaller(sender), { includeSubagents: false })
    expect(listed.agents.find(row => row.id === 'teammate-1')?.kind).toBe('teammate')

    const result = await harness.service.send(routingCaller(sender), { to: 'teammate-1', message: 'update the docs' }, signal)
    expect(result.status).toBe('accepted')
    expect(result.detail).toContain('团队邮箱')
    expect(agentTeams.calls.map(call => call.target)).toEqual(['Docs Bot'])
    expect(agentTeams.calls[0]?.text).toContain('update the docs')
    expect(agentTeams.calls[0]?.text.startsWith('Session message ')).toBe(true)
    expect(spliced(teammate)).toHaveLength(0)
  })
})
