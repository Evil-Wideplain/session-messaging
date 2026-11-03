/**
 * 创建会话的位置解析：`workspace` 参数、`ensure_workspace` 与「先授权、后副作用」顺序。
 */

import { describe, expect, it } from 'vitest'
import type { WorkspaceTarget } from '../src/application/ports.ts'
import { CALLER_CWD, FakeWorkspaces, creationCaller, serviceHarness } from './support/create-session-fixtures.ts'

const caller = creationCaller()
const mainWorkspace: WorkspaceTarget = { id: 'ws-main', path: CALLER_CWD, title: 'main' }

describe('create_session_agent 位置解析', () => {
  it('按 workspace id 创建并归属该工作区', async () => {
    const workspaces = new FakeWorkspaces({ resolveResult: mainWorkspace })
    const { service, creator } = serviceHarness({ workspaces })
    const result = await service.create(caller, { prompt: 'hi', workspace: 'ws-main' })

    expect(workspaces.resolved).toEqual(['ws-main'])
    expect(creator.calls[0]).toMatchObject({ cwd: CALLER_CWD, workspaceId: 'ws-main' })
    expect(result).toMatchObject({ status: 'accepted', workspaceId: 'ws-main' })
  })

  it('workspace 与指向同一目录的 cwd 同时给出时允许', async () => {
    const workspaces = new FakeWorkspaces({ resolveResult: mainWorkspace })
    const { service } = serviceHarness({ workspaces })
    const result = await service.create(caller, {
      prompt: 'hi',
      workspace: mainWorkspace.path,
      cwd: mainWorkspace.path,
    })
    expect(result.status).toBe('accepted')
    expect(workspaces.resolved).toEqual([mainWorkspace.path])
  })

  it('workspace 与不同 cwd 同时给出时拒绝', async () => {
    const { service, creator } = serviceHarness({
      workspaces: new FakeWorkspaces({ resolveResult: mainWorkspace }),
    })
    const result = await service.create(caller, {
      prompt: 'hi',
      workspace: mainWorkspace.path,
      cwd: '/repo/other',
    })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('workspace 与 cwd')
    expect(creator.calls).toEqual([])
  })

  it('workspace id 与指向其根目录的 cwd 同时给出时允许', async () => {
    const workspaces = new FakeWorkspaces({ resolveResult: mainWorkspace })
    const { service, creator } = serviceHarness({ workspaces })
    const result = await service.create(caller, { prompt: 'hi', workspace: 'ws-main', cwd: CALLER_CWD })

    expect(result.status).toBe('accepted')
    expect(creator.calls[0]).toMatchObject({ cwd: CALLER_CWD, workspaceId: 'ws-main' })
  })

  it('工作区 id 不可用时拒绝，且不区分「未登记」与「未授权」', async () => {
    const missing = await serviceHarness().service.create(caller, { prompt: 'hi', workspace: 'ws-missing' })
    expect(missing.status).toBe('refused')
    expect(missing.cwd).toBe('')
    expect(missing.detail).toContain('工作区不可用或未获授权')

    // 已登记但调用方无权访问：回包必须与「未登记」逐字一致，否则文案差异
    // 就是工作区登记状态与根目录的枚举 oracle。
    const other: WorkspaceTarget = { id: 'ws-other', path: '/repo/other', title: 'other' }
    const denied = await serviceHarness({ workspaces: new FakeWorkspaces({ resolveResult: other }) })
      .service.create(caller, { prompt: 'hi', workspace: 'ws-other' })
    expect(denied.status).toBe('refused')
    expect(denied.cwd).toBe('')
    expect(denied.detail).toBe(missing.detail)
  })

  it('登记返回的规范路径越界时按规范路径重新授权', async () => {
    const workspaces = new FakeWorkspaces({
      ensureResult: { id: 'ws-link', path: '/repo/outside', title: 'link' },
    })
    const { service, creator } = serviceHarness({ workspaces })
    // 字面路径在调用方 cwd 内（授权通过），但 realpath 指向授权范围外。
    const result = await service.create(caller, { prompt: 'hi', cwd: CALLER_CWD, ensureWorkspace: true })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('不允许在该目录创建会话')
    expect(creator.calls).toEqual([])
    expect(workspaces.ensured).toEqual([CALLER_CWD])
    // 拒绝回包只回显调用方给的路径，不泄漏 realpath 指向的真实目录。
    expect(result.cwd).toBe(CALLER_CWD)
  })

  it('未登记的绝对路径 + 非 ensure_workspace 时提示 ensure_workspace', async () => {
    const { service, creator } = serviceHarness()
    const result = await service.create(caller, { prompt: 'hi', workspace: '/repo/new' })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('工作区不存在')
    expect(result.detail).toContain('ensure_workspace: true')
    expect(creator.calls).toEqual([])
  })

  it('解析工作区抛错时把原因交给模型', async () => {
    const workspaces = new FakeWorkspaces({ resolveThrows: new Error('registry down') })
    const { service } = serviceHarness({ workspaces })
    const result = await service.create(caller, { prompt: 'hi', workspace: 'ws-main' })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('解析工作区失败：registry down')
  })

  it('ensure_workspace 登记未登记目录并按返回路径建会话', async () => {
    const ensured: WorkspaceTarget = { id: 'ws-new', path: '/repo/new', title: 'new' }
    const workspaces = new FakeWorkspaces({ ensureResult: ensured })
    const { service, creator } = serviceHarness({ workspaces, config: { allowCrossWorkspace: true } })
    const result = await service.create(caller, { prompt: 'hi', cwd: '/repo/new', ensureWorkspace: true })

    expect(workspaces.ensured).toEqual(['/repo/new'])
    expect(creator.calls[0]).toMatchObject({ cwd: '/repo/new', workspaceId: 'ws-new' })
    expect(result.workspaceId).toBe('ws-new')
  })

  it('未登记的工作区路径 + ensure_workspace 同样先登记再创建', async () => {
    const ensured: WorkspaceTarget = { id: 'ws-new', path: '/repo/new', title: 'new' }
    const workspaces = new FakeWorkspaces({ ensureResult: ensured })
    const { service, creator } = serviceHarness({ workspaces, config: { allowCrossWorkspace: true } })
    const result = await service.create(caller, {
      prompt: 'hi',
      workspace: '/repo/new',
      ensureWorkspace: true,
    })

    expect(workspaces.resolved).toEqual(['/repo/new'])
    expect(workspaces.ensured).toEqual(['/repo/new'])
    expect(creator.calls[0]).toMatchObject({ workspaceId: 'ws-new' })
    expect(result.workspaceId).toBe('ws-new')
  })

  it('allowCreateWorkspace=false 时拒绝登记', async () => {
    const workspaces = new FakeWorkspaces()
    const { service, creator } = serviceHarness({
      workspaces,
      config: { allowCrossWorkspace: true, allowCreateWorkspace: false },
    })
    const result = await service.create(caller, { prompt: 'hi', cwd: '/repo/new', ensureWorkspace: true })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('创建工作区已关闭')
    expect(workspaces.ensured).toEqual([])
    expect(creator.calls).toEqual([])
  })

  it('授权失败时不登记工作区（先授权、后副作用）', async () => {
    const workspaces = new FakeWorkspaces()
    const { service, creator } = serviceHarness({ workspaces })
    const result = await service.create(caller, { prompt: 'hi', cwd: '/repo/other', ensureWorkspace: true })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('不允许在该目录创建会话')
    expect(workspaces.ensured).toEqual([])
    expect(creator.calls).toEqual([])
  })

  it('未传 ensure_workspace 时未登记目录保持未分组', async () => {
    const { service, creator } = serviceHarness()
    const result = await service.create(caller, { prompt: 'hi' })

    expect(result.status).toBe('accepted')
    expect(result.workspaceId).toBeUndefined()
    expect(creator.calls[0]?.workspaceId).toBeUndefined()
    expect(creator.calls[0]?.cwd).toBe(CALLER_CWD)
  })

  it('省略位置时用调用方 cwd，并可按 ensure_workspace 登记', async () => {
    const workspaces = new FakeWorkspaces({
      ensureResult: { id: 'ws-self', path: CALLER_CWD, title: 'self' },
    })
    const { service, creator } = serviceHarness({ workspaces })
    const result = await service.create(caller, { prompt: 'hi', ensureWorkspace: true })

    expect(workspaces.ensured).toEqual([CALLER_CWD])
    expect(creator.calls[0]).toMatchObject({ workspaceId: 'ws-self' })
    expect(result.workspaceId).toBe('ws-self')
  })

  it('登记工作区失败时拒绝并带上原因', async () => {
    const workspaces = new FakeWorkspaces({ ensureThrows: new Error('mkdir denied') })
    const { service, creator } = serviceHarness({ workspaces, config: { allowCrossWorkspace: true } })
    const result = await service.create(caller, { prompt: 'hi', cwd: '/repo/new', ensureWorkspace: true })

    expect(result.status).toBe('refused')
    expect(result.detail).toContain('登记工作区失败：mkdir denied')
    expect(creator.calls).toEqual([])
  })
})
