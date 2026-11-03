/**
 * `CordisSessionCreator` 的失败与取消语义：日志刷新失败不改变创建结果、创建期间
 * 取消不再投递首条消息、sessionController 形状不符时按「缺服务」报错、拿不到
 * 在线 Agent 时仍保留 DSH 解析出的 preset。
 */

import { describe, expect, it } from 'vitest'
import type { SessionControllerService } from '../src/types.ts'
import { CALLER_CWD, NEW_SESSION_ID, creationCaller } from './support/create-session-fixtures.ts'
import { creatorHarness, openingMessage } from './support/create-session-creator-fixtures.ts'

describe('CordisSessionCreator 失败与取消', () => {
  it('日志刷新失败不影响创建结果', async () => {
    const { creator } = creatorHarness({ flushThrows: true })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })

    // flush 只让消息尽快落盘，失败不能让已经进入 inbox 的首条消息变成 queued。
    expect(result.accepted).toBe(true)
    expect(result.detail).toContain('已创建普通会话')
  })

  it('创建期间取消时保留会话但不再投递首条消息', async () => {
    const aborter = new AbortController()
    const { creator, agent } = creatorHarness({ onCreate: () => { aborter.abort() } })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
      signal: aborter.signal,
    })

    // create 不可取消（已发生），所以会话保留；但调用方已经放弃，不能再多一轮。
    expect(result.accepted).toBe(false)
    expect(result.sessionId).toBe(NEW_SESSION_ID)
    expect(result.detail).toContain('调用已取消')
    expect(agent.followed).toEqual([])
  })

  it('sessionController 缺少 create 时按缺服务报错', async () => {
    const controller = { rename: async () => ({ title: 'x', seq: 1 }) } as unknown as SessionControllerService
    const { creator } = creatorHarness({ controller })

    // 不能落成「DSH 拒绝创建会话：controller.create is not a function」这种误导性失败。
    await expect(creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })).rejects.toThrow(/sessionController/u)
  })

  it('拿不到在线 Agent 时结果仍带 DSH 解析出的 preset', async () => {
    const { creator } = creatorHarness({ noAgent: true })
    const result = await creator.create({
      caller: creationCaller(),
      cwd: CALLER_CWD,
      message: openingMessage(),
    })

    expect(result.accepted).toBe(false)
    expect(result.agentPreset).toBe('default')
  })
})
