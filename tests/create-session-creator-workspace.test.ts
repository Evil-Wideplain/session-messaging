/**
 * `CordisSessionCreator` 的 Workspace 归属：应用层 workspaceId 直传、
 * 按 cwd 解析出的归属、以及创建后 attach 的归属都会投影到结果里。
 */

import { describe, expect, it } from 'vitest'
import type { WorkspaceView } from '../src/types.ts'
import { CALLER_CWD, NEW_SESSION_ID, creationCaller } from './support/create-session-fixtures.ts'
import { creatorHarness, openingMessage } from './support/create-session-creator-fixtures.ts'

describe('CordisSessionCreator workspace', () => {
  it('把应用层解析出的 workspaceId 原样交给 DSH', async () => {
    const { creator, calls } = creatorHarness()
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      workspaceId: 'ws-app',
      message: openingMessage(),
    })

    expect(calls.create).toEqual([{ workspaceId: 'ws-app' }])
    expect(calls.attach).toEqual([])
    expect(result.workspaceId).toBe('ws-app')
  })

  it('按 cwd 解析到工作区时把 id 投影到结果', async () => {
    const workspace: WorkspaceView = {
      id: 'ws-1',
      path: CALLER_CWD,
      title: 'main',
      sessionIds: [],
      attachSession: async () => {},
    }
    const { creator, calls } = creatorHarness({ workspace })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })

    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(result.workspaceId).toBe('ws-1')
  })

  it('创建后补 attach 成功时投影归属的 workspaceId', async () => {
    const workspace: WorkspaceView = {
      id: 'ws-late',
      path: CALLER_CWD,
      sessionIds: [],
      attachSession: async () => {},
    }
    let lookups = 0
    const { creator, calls } = creatorHarness({
      workspace: async () => {
        lookups += 1
        return lookups === 1 ? undefined : workspace
      },
    })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })

    expect(calls.create).toEqual([{ cwd: CALLER_CWD }])
    expect(calls.attach).toEqual([expect.stringMatching(/^session-/u)])
    expect(result.workspaceId).toBe('ws-late')
  })

  it('按 cwd 解析出的工作区路径不同时按 cwd 创建，不改写 workspaceId', async () => {
    const parent: WorkspaceView = {
      id: 'ws-parent',
      path: '/repo',
      title: 'repo',
      sessionIds: [],
      attachSession: async () => {},
    }
    let lookups = 0
    const { creator, calls } = creatorHarness({
      workspace: async () => {
        lookups += 1
        return lookups === 1 ? parent : undefined
      },
    })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: '/repo/sub',
      message: openingMessage(),
      caseInsensitivePaths: true,
    })

    // 运行时若按「所属」返回父工作区，改写 workspaceId 会把会话建到 /repo，
    // 与调用方按 /repo/sub 授权的 cwd 不一致。
    expect(calls.create).toEqual([{ cwd: '/repo/sub' }])
    expect(result.workspaceId).toBeUndefined()
  })

  it('创建后补 attach 失败时不影响创建结果，也不带 workspaceId', async () => {
    const workspace: WorkspaceView = {
      id: 'ws-late',
      path: CALLER_CWD,
      sessionIds: [],
      attachSession: async () => {},
    }
    let lookups = 0
    const { creator, calls } = creatorHarness({
      workspace: async () => {
        lookups += 1
        return lookups === 1 ? undefined : workspace
      },
      attachThrows: true,
    })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })

    expect(result.accepted).toBe(true)
    expect(calls.attach).toEqual([NEW_SESSION_ID])
    expect(result.workspaceId).toBeUndefined()
  })
})
