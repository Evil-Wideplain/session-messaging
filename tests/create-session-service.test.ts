/**
 * `SessionCreationService`：目录授权、root-only、限额与首条消息构造。
 */

import { describe, expect, it } from 'vitest'
import {
  CALLER_CWD,
  CREATION_CALLER_ID,
  FakeCreator,
  FakeWorkspaces,
  NEW_SESSION_ID,
  creationCaller,
  makeSessionAgent,
  serviceHarness,
} from './support/create-session-fixtures.ts'

describe('SessionCreationService', () => {
  it('creates in the caller cwd and frames the first message as a session message', async () => {
    const { service, creator } = serviceHarness({ titles: new Map([[CREATION_CALLER_ID, '主会话']]) })
    const result = await service.create(creationCaller(), { prompt: '把 web 端重构成新布局' })

    expect(result.status).toBe('accepted')
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.shortId).toBe('0f1e2d3c')
    expect(result.cwd).toBe(CALLER_CWD)
    expect(result.messageId).not.toBe('')

    expect(creator.calls).toHaveLength(1)
    const call = creator.calls[0]!
    expect(call.cwd).toBe(CALLER_CWD)
    expect(call.message.source['kind']).toBe('session-message')
    expect(call.message.source['senderId']).toBe(CREATION_CALLER_ID)
    expect(call.message.source['messageId']).toBe(result.messageId)
    const text = call.message.content[0]?.text ?? ''
    expect(text).toContain(`Session message ${result.messageId} from 主会话 (${CREATION_CALLER_ID}):`)
    expect(text).toContain('把 web 端重构成新布局')
  })

  it('allows an explicit cwd inside the same workspace', async () => {
    const { service, creator } = serviceHarness()
    const result = await service.create(creationCaller(), { prompt: 'x', cwd: '/repo/main/' })
    expect(result.status).toBe('accepted')
    expect(creator.calls[0]!.cwd).toBe('/repo/main/')
  })

  it('refuses a cross-workspace cwd unless the policy opens it', async () => {
    const { service, creator } = serviceHarness()
    const refusedResult = await service.create(creationCaller(), { prompt: 'x', cwd: '/repo/other' })
    expect(refusedResult.status).toBe('refused')
    expect(refusedResult.detail).toContain('不允许在该目录创建会话')
    expect(creator.calls).toHaveLength(0)

    const opened = serviceHarness({ config: { allowCrossWorkspace: true } })
    const accepted = await opened.service.create(creationCaller(), { prompt: 'x', cwd: '/repo/other' })
    expect(accepted.status).toBe('accepted')
    expect(opened.creator.calls[0]!.cwd).toBe('/repo/other')
  })

  it('allows a cwd below an allowlist prefix', async () => {
    const { service, creator } = serviceHarness({ config: { allowlist: ['/repo/shared'] } })
    const result = await service.create(creationCaller(), { prompt: 'x', cwd: '/repo/shared/web' })
    expect(result.status).toBe('accepted')
    expect(creator.calls[0]!.cwd).toBe('/repo/shared/web')
  })

  it('refuses a relative cwd', async () => {
    const { service } = serviceHarness()
    const result = await service.create(creationCaller(), { prompt: 'x', cwd: 'relative/path' })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('cwd 必须是绝对路径')
  })

  it('refuses callers without a cwd when no explicit cwd is given', async () => {
    const { service } = serviceHarness()
    const result = await service.create(creationCaller(makeSessionAgent({ id: CREATION_CALLER_ID })), { prompt: 'x' })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('没有记录工作目录')
  })

  it('refuses subagent callers: root sessions are the only creation point', async () => {
    const { service, creator } = serviceHarness()
    const result = await service.create(
      creationCaller(makeSessionAgent({ id: 'session-child-01', cwd: CALLER_CWD, origin: 'subagent' })),
      { prompt: 'x' },
    )
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('子代理不能创建普通会话')
    expect(creator.calls).toHaveLength(0)
  })

  it('respects allowCreateSession=false', async () => {
    const { service } = serviceHarness({ config: { allowCreateSession: false } })
    const result = await service.create(creationCaller(), { prompt: 'x' })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('allowCreateSession=false')
  })

  it('refuses empty and oversized prompts before calling the runtime', async () => {
    const { service, creator } = serviceHarness({ config: { maxMessageBytes: 8 } })
    const empty = await service.create(creationCaller(), { prompt: '   ' })
    expect(empty.status).toBe('refused')
    expect(empty.detail).toContain('正文为空')

    const oversized = await service.create(creationCaller(), { prompt: '0123456789' })
    expect(oversized.status).toBe('refused')
    expect(oversized.detail).toContain('上限为 8')
    expect(creator.calls).toHaveLength(0)
  })

  it('limits creations per caller per minute', async () => {
    const { service, creator } = serviceHarness({ config: { maxCreatesPerMinute: 1 } })
    const first = await service.create(creationCaller(), { prompt: 'a' })
    const second = await service.create(creationCaller(), { prompt: 'b' })
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('refused')
    expect(second.detail).toContain('触发创建频率限制')
    expect(creator.calls).toHaveLength(1)
  })

  it('does not register a workspace when the rate limit rejects the request', async () => {
    const workspaces = new FakeWorkspaces()
    const { service, creator } = serviceHarness({
      workspaces,
      config: { maxCreatesPerMinute: 1, allowCreateWorkspace: true },
    })
    const first = await service.create(creationCaller(), { prompt: 'a' })
    expect(first.status).toBe('accepted')

    // 限额必须挡在 ensure_workspace 的 mkdir/登记之前：被拒绝的请求不能留下副作用。
    const second = await service.create(creationCaller(), {
      prompt: 'b',
      cwd: CALLER_CWD,
      ensureWorkspace: true,
    })
    expect(second.status).toBe('refused')
    expect(second.detail).toContain('触发创建频率限制')
    expect(workspaces.ensured).toEqual([])
    expect(creator.calls).toHaveLength(1)
  })

  it('refuses subagent callers detected by delegation depth alone', async () => {
    const { service, creator } = serviceHarness()
    const result = await service.create(
      creationCaller(makeSessionAgent({ id: 'session-child-02', cwd: CALLER_CWD, delegationDepth: 1 })),
      { prompt: 'x' },
    )
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('子代理不能创建普通会话')
    expect(creator.calls).toHaveLength(0)
  })

  it('passes trimmed title and preset through to the creator', async () => {
    const { service, creator } = serviceHarness()
    await service.create(creationCaller(), { prompt: 'x', title: '  前端联调 ', agentPreset: ' coding ' })
    expect(creator.calls[0]!.title).toBe('前端联调')
    expect(creator.calls[0]!.agentPreset).toBe('coding')
  })

  it('reports failed with no session id when DSH rejects the creation', async () => {
    const creator = new FakeCreator(new Error('agent-preset/not-found'))
    const { service } = serviceHarness({ creator })
    const result = await service.create(creationCaller(), { prompt: 'x' })
    expect(result.status).toBe('failed')
    expect(result.sessionId).toBe('')
    expect(result.detail).toContain('创建会话失败')
    expect(result.detail).toContain('agent-preset/not-found')
  })

  it('keeps the session id when only the first message was not admitted', async () => {
    const creator = new FakeCreator({
      sessionId: NEW_SESSION_ID,
      cwd: CALLER_CWD,
      accepted: false,
      detail: '会话已创建，但首条消息投递失败',
    })
    const { service } = serviceHarness({ creator })
    const result = await service.create(creationCaller(), { prompt: 'x' })
    expect(result.status).toBe('failed')
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.shortId).toBe('0f1e2d3c')
  })
})
