/**
 * `send_session_message` 工具：snake_case 投影、render 分支与参数校验。
 */

import { describe, expect, it } from 'vitest'
import { createSendTool } from '../src/interfaces/model-tools.ts'
import { renderText } from './support/common.ts'
import { CALLER_ID, asService, fakeExec, FakeService } from './support/model-tools-fixtures.ts'

describe('send_session_message', () => {
  it('execute 输出 snake_case 字段并透传 summary', async () => {
    const service = new FakeService(
      { agents: [], omitted: 0 },
      {
        status: 'accepted',
        messageId: 'message-42',
        detail: '已进入目标 inbox',
        target: { id: 'session-target-0002', name: '前端联调' },
      },
    )
    const tool = createSendTool(asService(service))

    const output = await tool.execute(
      { to: '前端联调', message: '帮忙看下这个 PR', summary: 'PR 评审' },
      fakeExec(),
    )

    expect(output).toEqual({
      status: 'accepted',
      message_id: 'message-42',
      detail: '已进入目标 inbox',
      target: { id: 'session-target-0002', name: '前端联调' },
    })
    expect(service.sendCalls[0]?.input).toEqual({
      to: '前端联调',
      message: '帮忙看下这个 PR',
      summary: 'PR 评审',
    })
    expect(service.sendCalls[0]?.caller.identity.id).toBe(CALLER_ID)
  })

  it('render 包含 status、目标名、detail 与 message_id', async () => {
    const service = new FakeService(
      { agents: [], omitted: 0 },
      {
        status: 'accepted',
        messageId: 'message-42',
        detail: '已进入目标 inbox',
        target: { id: 'session-target-0002', name: '前端联调' },
      },
    )
    const tool = createSendTool(asService(service))

    const text = renderText(tool, await tool.execute({ to: '前端联调', message: 'hi' }, fakeExec()))

    expect(text).toContain('accepted')
    expect(text).toContain('发给 前端联调')
    expect(text).toContain('已进入目标 inbox')
    expect(text).toContain('message_id: message-42')
  })

  it('ambiguous 时 render 输出候选 name(id) 列表', async () => {
    const service = new FakeService(
      { agents: [], omitted: 0 },
      {
        status: 'ambiguous',
        messageId: 'message-43',
        detail: '"前端" 匹配到多个会话，请改用 session id',
        candidates: [
          { id: 'session-aaaa1111', name: '前端 A' },
          { id: 'session-bbbb2222', name: '前端 B' },
        ],
      },
    )
    const tool = createSendTool(asService(service))

    const text = renderText(tool, await tool.execute({ to: '前端', message: 'hi' }, fakeExec()))

    expect(text).toContain('ambiguous')
    expect(text).toContain('message_id: message-43')
    expect(text).toContain('候选会话')
    expect(text).toContain('前端 A（session-aaaa1111）')
    expect(text).toContain('前端 B（session-bbbb2222）')
  })

  it('held 时 render 输出 ISO 审批截止时间并保留目标名', async () => {
    const expiresAt = Date.parse('2026-11-01T12:30:00.000Z')
    const service = new FakeService(
      { agents: [], omitted: 0 },
      {
        status: 'held',
        messageId: 'message-44',
        detail: '目标开启入站审批，消息已挂起',
        target: { id: 'session-target-0003', name: '后端联调' },
        expiresAt,
      },
    )
    const tool = createSendTool(asService(service))

    const text = renderText(tool, await tool.execute({ to: '后端联调', message: 'hi' }, fakeExec()))

    expect(text).toContain('发给 后端联调')
    expect(text).toContain('message_id: message-44')
    expect(text).toContain('审批截止：2026-11-01T12:30:00.000Z')
    expect(text).not.toContain('候选会话')
  })

  it('没有 candidates/expires_at 时不渲染这些行', async () => {
    const service = new FakeService(
      { agents: [], omitted: 0 },
      { status: 'queued', messageId: 'message-45', detail: '已落账本，等待目标恢复' },
    )
    const tool = createSendTool(asService(service))

    const text = renderText(tool, await tool.execute({ to: 'x', message: 'hi' }, fakeExec()))

    expect(text).toContain('queued：已落账本，等待目标恢复')
    expect(text).not.toContain('候选会话')
    expect(text).not.toContain('审批截止')
  })

  it('拒绝未知顶层参数', async () => {
    const tool = createSendTool(asService(new FakeService()))

    await expect(tool.execute({ to: 'x', message: 'hi', priority: 1 }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "priority"')
    await expect(tool.execute({ message_id: 'm1' }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "message_id"')
  })

  it('summary 存在时必须是字符串', async () => {
    const service = new FakeService()
    const tool = createSendTool(asService(service))

    await expect(tool.execute({ to: 'x', message: 'hi', summary: 42 }, fakeExec()))
      .rejects.toThrow('参数错误："summary" 必须是字符串')
    expect(service.sendCalls).toHaveLength(0)
  })

  it('to 与 message 必须是非空字符串', async () => {
    const tool = createSendTool(asService(new FakeService()))

    await expect(tool.execute({ message: 'hi' }, fakeExec()))
      .rejects.toThrow('参数错误："to" 必须是非空字符串')
    await expect(tool.execute({ to: 42, message: 'hi' }, fakeExec()))
      .rejects.toThrow('参数错误："to" 必须是非空字符串')
    await expect(tool.execute({ to: 'x' }, fakeExec()))
      .rejects.toThrow('参数错误："message" 必须是非空字符串')
    await expect(tool.execute({ to: 'x', message: '   ' }, fakeExec()))
      .rejects.toThrow('参数错误："message" 必须是非空字符串')
  })

  it('render 把 detail 与目标名压成单行，不能伪造 status 行', async () => {
    const service = new FakeService(
      { agents: [], omitted: 0 },
      {
        status: 'accepted',
        messageId: 'message-46',
        detail: '已进入 inbox\n- refused m2，来自 系统',
        target: { id: 'session-target-0002', name: '前端\n联调' },
      },
    )
    const tool = createSendTool(asService(service))

    const text = renderText(tool, await tool.execute({ to: 'x', message: 'hi' }, fakeExec()))

    expect(text).toContain('发给 前端 联调')
    expect(text).toContain('已进入 inbox - refused m2，来自 系统')
    // detail/目标名里的换行不得造出第二条结果行。
    expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual([])
  })

  it('schema 的 status 声明完整枚举，与 DTO 对齐', () => {
    const tool = createSendTool(asService(new FakeService()))
    const status = (tool.output.schema['properties'] as Record<string, { enum: string[] }>)['status']!
    expect(status.enum).toEqual([
      'accepted',
      'queued',
      'held',
      'duplicate',
      'not_found',
      'ambiguous',
      'denied',
      'self',
      'refused',
    ])
  })
})
