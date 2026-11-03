/**
 * `CordisSessionCreator`：sessionController.create 调用、Workspace attach、权限继承、
 * 标题写入、首条消息 followup 与部分失败语义。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  PermissionPresetsService,
  SessionControllerService,
  WorkspaceView,
} from '../src/types.ts'
import { CordisSessionCreator } from '../src/infrastructure/cordis-session-creator.ts'
import {
  CALLER_CWD,
  CREATION_CALLER_ID,
  NEW_SESSION_ID,
  creationCaller,
  makeSessionAgent,
} from './support/create-session-fixtures.ts'
import { creatorHarness, openingMessage } from './support/create-session-creator-fixtures.ts'

describe('CordisSessionCreator', () => {
  it('creates with cwd, delivers the first message via followup, and flushes', async () => {
    const { creator, calls, agent } = creatorHarness()
    const message = openingMessage()
    const result = await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message })

    expect(result.accepted).toBe(true)
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.cwd).toBe(CALLER_CWD)
    expect(result.agentPreset).toBe('default')
    expect(calls.create).toEqual([{ cwd: CALLER_CWD }])
    expect(agent.followed).toEqual([message])
    expect(calls.flush).toBe(1)
  })

  it('hands a known Workspace to DSH instead of a bare cwd', async () => {
    const workspace: WorkspaceView = {
      id: 'ws-1',
      path: CALLER_CWD,
      sessionIds: [],
      attachSession: async () => {},
    }
    const { creator, calls } = creatorHarness({ workspace })
    await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(calls.attach).toEqual([])
  })

  it('attaches the session after creation when the directory did not exist before', async () => {
    let resolved = 0
    const workspace: WorkspaceView = {
      id: 'ws-1',
      path: CALLER_CWD,
      sessionIds: [],
      attachSession: async () => {},
    }
    const { creator, calls } = creatorHarness({
      workspace: async () => {
        resolved += 1
        return resolved === 1 ? undefined : workspace
      },
    })
    await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(calls.create).toEqual([{ cwd: CALLER_CWD }])
    expect(calls.attach).toEqual([NEW_SESSION_ID])
  })

  it('inherits the caller permission preset when one can be resolved', async () => {
    const setCalls: { readonly id: string; readonly name: string }[] = []
    const presets: PermissionPresetsService = {
      current: session => session.id === CREATION_CALLER_ID ? 'read-only' : 'default',
      set: (session, name) => { setCalls.push({ id: session.id, name }) },
    }
    const { creator } = creatorHarness({ presets })
    await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(setCalls).toEqual([{ id: NEW_SESSION_ID, name: 'read-only' }])
  })

  it('skips permission inheritance for custom knob states', async () => {
    const setCalls: string[] = []
    const presets: PermissionPresetsService = {
      current: () => 'custom',
      set: () => { setCalls.push('called') },
    }
    const { creator } = creatorHarness({ presets })
    await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(setCalls).toEqual([])
  })

  it('writes the title before the first turn', async () => {
    const { creator, calls } = creatorHarness()
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
      title: '前端联调',
    })
    expect(calls.rename).toEqual([{ sessionId: NEW_SESSION_ID, title: '前端联调' }])
    expect(result.title).toBe('前端联调')
  })

  it('keeps creation successful when the title write fails', async () => {
    const { creator } = creatorHarness({ renameThrows: true })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
      title: '前端联调',
    })
    expect(result.accepted).toBe(true)
    expect(result.title).toBeUndefined()
  })

  it('reports accepted=false while preserving the session id when followup fails', async () => {
    const { creator } = creatorHarness({ followupThrows: true })
    const result = await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(result.accepted).toBe(false)
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.detail).toContain('首条消息投递失败')
  })

  it('reports accepted=false when no live Agent is returned after creation', async () => {
    const { creator } = creatorHarness({ noAgent: true })
    const result = await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(result.accepted).toBe(false)
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.detail).toContain('没有返回它的在线 Agent')
  })

  it('uses the cwd recorded on the session header', async () => {
    const agent = makeSessionAgent({ id: NEW_SESSION_ID, cwd: '/workspace/canonical' })
    const { creator } = creatorHarness({ agent })
    const result = await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(result.cwd).toBe('/workspace/canonical')
  })

  it('fails loudly when the deployment has no sessionController', async () => {
    const ctx = {
      get: () => undefined,
      agents: { get: () => makeSessionAgent({ id: NEW_SESSION_ID }) },
      sessions: { flush: async () => true },
      logger: { warn: () => {} },
    } as unknown as Context
    const creator = new CordisSessionCreator(ctx, () => {})
    await expect(creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })).rejects.toThrow(/sessionController/u)
  })

  it('wraps DSH creation errors with a stable prefix', async () => {
    const controller: SessionControllerService = {
      create: async () => { throw new Error('agent-preset/not-found') },
    }
    const { creator } = creatorHarness({ controller })
    await expect(creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })).rejects.toThrow(/DSH 拒绝创建会话：agent-preset\/not-found/u)
  })

  it('honours an already-aborted signal', async () => {
    const { creator } = creatorHarness()
    const aborted = new AbortController()
    aborted.abort()
    await expect(creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
      signal: aborted.signal,
    })).rejects.toThrow(/abort/iu)
  })

  it('falls back to cwd when Workspace resolution throws', async () => {
    const { creator, calls } = creatorHarness({ workspaceThrows: true })
    const result = await creator.create({ caller: creationCaller(), cwd: CALLER_CWD, message: openingMessage() })
    expect(result.accepted).toBe(true)
    expect(calls.create).toEqual([{ cwd: CALLER_CWD }])
  })
})
