/**
 * 模型工具（接口层）单元测试。
 *
 * 只调用 `tool.execute` 与 `tool.output.render`：用假的 MessagingService 固定
 * 业务返回值，用假的 ToolExecution 提供调用方 Agent。不启动真实 socket、不调用
 * 真实模型、不读写磁盘。
 */

import { describe, expect, it } from 'vitest'
import type { MessagingService } from '../src/application/messaging-service.ts'
import type { Caller } from '../src/application/ports.ts'
import type {
  HeldRow,
  ListResult,
  ListRow,
  ReviewAction,
  ReviewResult,
  SendInput,
  SendResult,
} from '../src/application/dto.ts'
import { createListTool, createReviewTool, createSendTool } from '../src/interfaces/model-tools.ts'
import type { Agent, ToolDefinition, ToolExecution } from '../src/types.ts'

const CALLER_ID = 'session-caller-0001'

/** list 的入参快照，形状对齐 MessagingService.list。 */
interface ListOptions {
  readonly includeSubagents: boolean
  readonly limit?: number
  readonly signal?: AbortSignal
}

/** 记录调用并返回固定结果的假应用服务。 */
class FakeService {
  readonly listCalls: { caller: Caller; options: ListOptions }[] = []
  readonly sendCalls: { caller: Caller; input: SendInput; signal: AbortSignal }[] = []
  readonly reviewCalls: {
    caller: Caller
    action: ReviewAction
    messageId: string | undefined
    signal: AbortSignal
  }[] = []

  constructor(
    private readonly listResult: ListResult = { agents: [], omitted: 0, truncated: 0 },
    private readonly sendResult: SendResult = { status: 'accepted', messageId: 'message-1', detail: '已送达目标 inbox' },
    private readonly reviewResult: ReviewResult = { held: [], outcomes: [] },
  ) {}

  async list(caller: Caller, options: ListOptions): Promise<ListResult> {
    this.listCalls.push({ caller, options })
    return this.listResult
  }

  async send(caller: Caller, input: SendInput, signal: AbortSignal): Promise<SendResult> {
    this.sendCalls.push({ caller, input, signal })
    return this.sendResult
  }

  async review(
    caller: Caller,
    action: ReviewAction,
    messageId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    this.reviewCalls.push({ caller, action, messageId, signal })
    return this.reviewResult
  }
}

/** 假服务是 MessagingService 的结构替身（该类有私有字段，只能强转）。 */
function asService(service: FakeService): MessagingService {
  return service as unknown as MessagingService
}

/** 假 Agent：identityOf 只读 id 与 session.header.cwd。 */
function fakeAgent(cwd: string | undefined = 'C:\\repo\\main', id: string = CALLER_ID): Agent {
  const header = { id, ...cwd === undefined ? {} : { cwd } }
  return {
    id,
    session: {
      id,
      header,
      inheritedEventCount: 0,
      ownEvents: () => [],
    },
    status: 'idle',
    steer() {},
    followup() {},
    whenIdle: async () => {},
  }
}

/** 假工具执行上下文。 */
function fakeExec(agent: Agent = fakeAgent()): ToolExecution {
  return {
    callId: 'call-1',
    name: 'test-tool',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  }
}

/** 不带调用方 Agent 的执行上下文。 */
function fakeExecWithoutAgent(): ToolExecution {
  return {
    callId: 'call-1',
    name: 'test-tool',
    arguments: {},
    signal: new AbortController().signal,
  }
}

/** 取出 render 的纯文本。 */
function renderText(tool: ToolDefinition, value: unknown): string {
  return tool.output.render({}, value).map(block => block.text ?? '').join('\n')
}

/** 常用 list 行固定值。 */
function listRow(overrides: Partial<ListRow> = {}): ListRow {
  return {
    name: '前端联调',
    id: 'session-abcdef0123456789',
    shortId: 'abcdef01',
    cwd: 'C:\\repo\\web',
    workspace: 'same',
    state: 'idle',
    kind: 'peer',
    sendable: true,
    ...overrides,
  }
}

/** 常用挂起消息固定值。 */
function heldRow(overrides: Partial<HeldRow> = {}): HeldRow {
  return {
    messageId: 'held-1',
    sender: '后端联调',
    senderId: 'session-sender-0002',
    summary: 'schema 迁移完成',
    preview: '迁移脚本已经跑完，等你确认',
    createdAt: Date.parse('2026-11-01T10:00:00.000Z'),
    expiresAt: Date.parse('2026-11-01T11:00:00.000Z'),
    ...overrides,
  }
}

describe('list_session_agents', () => {
  it('execute 输出 snake_case 字段并保留行内全部信息', async () => {
    const service = new FakeService({
      agents: [listRow(), listRow({
        name: '冷会话',
        id: 'session-ffff0000',
        shortId: 'ffff0000',
        cwd: '',
        workspace: 'unknown',
        state: 'offline',
        kind: 'teammate',
      })],
      omitted: 0,
    })
    const tool = createListTool(asService(service))

    const output = await tool.execute({}, fakeExec()) as {
      agents: Record<string, unknown>[]
      omitted: number
    }

    expect(output.agents).toEqual([
      {
        name: '前端联调',
        id: 'session-abcdef0123456789',
        short_id: 'abcdef01',
        cwd: 'C:\\repo\\web',
        workspace: 'same',
        state: 'idle',
        kind: 'peer',
        sendable: true,
      },
      {
        name: '冷会话',
        id: 'session-ffff0000',
        short_id: 'ffff0000',
        cwd: '',
        workspace: 'unknown',
        state: 'offline',
        kind: 'teammate',
        sendable: true,
      },
    ])
    expect(output.omitted).toBe(0)
    expect(service.listCalls[0]?.caller.identity).toEqual({ id: CALLER_ID, cwd: 'C:\\repo\\main' })
  })

  it('render 每行包含显示名、完整 id、short_id、state、kind、workspace、cwd', async () => {
    const service = new FakeService({ agents: [listRow()], omitted: 0 })
    const tool = createListTool(asService(service))

    const text = renderText(tool, await tool.execute({}, fakeExec()))

    expect(text).toContain('前端联调')
    expect(text).toContain('session-abcdef0123456789')
    expect(text).toContain('abcdef01')
    expect(text).toContain('state: idle')
    expect(text).toContain('kind: peer')
    expect(text).toContain('workspace: same')
    expect(text).toContain('C:\\repo\\web')
  })

  it('render 把缺失 cwd 写为“未记录”，并保留 omitted 计数', async () => {
    const service = new FakeService({
      agents: [listRow({ cwd: '', workspace: 'unknown', state: 'offline', kind: 'teammate' })],
      omitted: 3,
    })
    const tool = createListTool(asService(service))

    const text = renderText(tool, await tool.execute({}, fakeExec()))

    expect(text).toContain('cwd: 未记录')
    expect(text).toContain('workspace: unknown')
    expect(text).toContain('state: offline')
    expect(text).toContain('kind: teammate')
    expect(text).toContain('另有 3 个会话不可见')
  })

  it('他人子代理标注不可发送', async () => {
    const service = new FakeService({
      agents: [listRow({ name: '别人的子代理', id: 'session-9999aaaa', kind: 'subagent', sendable: false })],
      omitted: 0,
    })
    const tool = createListTool(asService(service))

    const text = renderText(tool, await tool.execute({ include_subagents: true }, fakeExec()))
    expect(text).toContain('别人的子代理')
    expect(text).toContain('不可发送')
  })

  it('默认不包含其他会话的子代理，显式传 true 与 limit 时透传', async () => {
    const service = new FakeService({ agents: [], omitted: 0 })
    const tool = createListTool(asService(service))

    await tool.execute({}, fakeExec())
    await tool.execute({ include_subagents: true, limit: 5 }, fakeExec())

    expect(service.listCalls[0]?.options.includeSubagents).toBe(false)
    expect(service.listCalls[0]?.options.limit).toBeUndefined()
    expect(service.listCalls[1]?.options.includeSubagents).toBe(true)
    expect(service.listCalls[1]?.options.limit).toBe(5)
  })

  it('拒绝未知顶层参数，多个时按字典序取第一个', async () => {
    const tool = createListTool(asService(new FakeService()))

    await expect(tool.execute({ scope: 'workspace' }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "scope"')
    await expect(tool.execute({ scope: 'workspace', zzz: 1, aaa: 2 }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "aaa"')
    await expect(tool.execute({ includeSubagent: true }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "includeSubagent"')
  })

  it('include_subagents 必须是布尔值', async () => {
    const service = new FakeService()
    const tool = createListTool(asService(service))

    await expect(tool.execute({ include_subagents: 'true' }, fakeExec()))
      .rejects.toThrow('参数错误："include_subagents" 必须是布尔值')
    await expect(tool.execute({ include_subagents: 1 }, fakeExec()))
      .rejects.toThrow('参数错误："include_subagents" 必须是布尔值')
    expect(service.listCalls).toHaveLength(0)
  })

  it('limit 必须是 [1, 200] 范围内的整数', async () => {
    const tool = createListTool(asService(new FakeService()))

    for (const limit of [0, 201, 1.5, '10', null] as unknown[]) {
      await expect(tool.execute({ limit }, fakeExec()))
        .rejects.toThrow('参数错误："limit" 必须是 [1, 200] 范围内的整数')
    }
  })

  it('参数不是对象时拒绝', async () => {
    const tool = createListTool(asService(new FakeService()))

    await expect(tool.execute(null, fakeExec())).rejects.toThrow('参数错误：需要一个对象')
    await expect(tool.execute([], fakeExec())).rejects.toThrow('参数错误：需要一个对象')
    await expect(tool.execute('x', fakeExec())).rejects.toThrow('参数错误：需要一个对象')
  })

  it('缺少调用方 Agent 时失败（参数合法）', async () => {
    const tool = createListTool(asService(new FakeService()))

    await expect(tool.execute({}, fakeExecWithoutAgent()))
      .rejects.toThrow('list_session_agents 需要调用方 Agent（exec.agent 为空）')
  })
})

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
})

describe('review_session_messages', () => {
  it('execute 输出 snake_case 字段（含可选 detail）', async () => {
    const service = new FakeService({ agents: [], omitted: 0 }, undefined, {
      held: [heldRow()],
      outcomes: [
        { messageId: 'held-9', sender: '前端联调', status: 'accepted', detail: '已放行并投递给模型' },
        { messageId: 'held-10', sender: '', status: 'refused' },
      ],
    })
    const tool = createReviewTool(asService(service))

    const output = await tool.execute({ action: 'accept', message_id: 'held-9' }, fakeExec())

    expect(output).toEqual({
      held: [{
        message_id: 'held-1',
        sender: '后端联调',
        sender_id: 'session-sender-0002',
        summary: 'schema 迁移完成',
        preview: '迁移脚本已经跑完，等你确认',
        created_at: Date.parse('2026-11-01T10:00:00.000Z'),
        expires_at: Date.parse('2026-11-01T11:00:00.000Z'),
      }],
      outcomes: [
        { message_id: 'held-9', sender: '前端联调', status: 'accepted', detail: '已放行并投递给模型' },
        { message_id: 'held-10', sender: '', status: 'refused' },
      ],
    })
    expect(service.reviewCalls[0]?.action).toBe('accept')
    expect(service.reviewCalls[0]?.messageId).toBe('held-9')
  })

  it('render 的 outcome 行带 detail，缺失时不留空尾巴', async () => {
    const service = new FakeService({ agents: [], omitted: 0 }, undefined, {
      held: [],
      outcomes: [
        { messageId: 'held-9', sender: '前端联调', status: 'accepted', detail: '已放行并投递给模型' },
        { messageId: 'held-10', sender: '', status: 'refused' },
        { messageId: 'held-11', sender: '运维', status: 'expired', detail: '' },
      ],
    })
    const tool = createReviewTool(asService(service))

    const text = renderText(tool, await tool.execute({ action: 'accept' }, fakeExec()))

    expect(text).toContain('- accepted held-9，来自 前端联调：已放行并投递给模型')
    expect(text).toContain('- refused held-10，来自 未知会话')
    expect(text).toContain('- expired held-11，来自 运维')
    expect(text).not.toContain('当前没有等待审批的消息')
  })

  it('render 的 held 行带 preview 摘要并截断到约 120 字符', async () => {
    const longPreview = '长'.repeat(300)
    const service = new FakeService({ agents: [], omitted: 0 }, undefined, {
      held: [heldRow({ preview: longPreview })],
      outcomes: [],
    })
    const tool = createReviewTool(asService(service))

    const text = renderText(tool, await tool.execute({ action: 'list' }, fakeExec()))

    expect(text).toContain('仍有 1 条消息挂起')
    expect(text).toContain('后端联调')
    expect(text).toContain('schema 迁移完成')
    expect(text).toContain('截止 2026-11-01T11:00:00.000Z')
    expect(text).toContain(`${'长'.repeat(119)}…`)
    expect(text).not.toContain('长'.repeat(120))
  })

  it('render 保留未超长 preview 全文', async () => {
    const preview = '短'.repeat(120)
    const service = new FakeService({ agents: [], omitted: 0 }, undefined, {
      held: [heldRow({ preview })],
      outcomes: [],
    })
    const tool = createReviewTool(asService(service))

    const text = renderText(tool, await tool.execute({ action: 'list' }, fakeExec()))

    expect(text).toContain(preview)
    expect(text).not.toContain(`${preview}…`)
  })

  it('空列表文案保持现有行为', async () => {
    const service = new FakeService({ agents: [], omitted: 0 }, undefined, { held: [], outcomes: [] })
    const tool = createReviewTool(asService(service))

    expect(renderText(tool, await tool.execute({ action: 'list' }, fakeExec())))
      .toBe('当前没有等待审批的消息')
  })

  it('拒绝未知顶层参数', async () => {
    const tool = createReviewTool(asService(new FakeService()))

    await expect(tool.execute({ action: 'list', sender: 'x' }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "sender"')
    await expect(tool.execute({ action: 'list', to: 'x' }, fakeExec()))
      .rejects.toThrow('参数错误：未知参数 "to"')
  })

  it('action 必须是 list / accept / refuse 之一', async () => {
    const service = new FakeService()
    const tool = createReviewTool(asService(service))

    await expect(tool.execute({ action: 'drop' }, fakeExec()))
      .rejects.toThrow('参数错误："action" 必须是 list / accept / refuse 之一')
    await expect(tool.execute({ action: 42 }, fakeExec()))
      .rejects.toThrow('参数错误："action" 必须是非空字符串')
    await expect(tool.execute({}, fakeExec()))
      .rejects.toThrow('参数错误："action" 必须是非空字符串')
    expect(service.reviewCalls).toHaveLength(0)
  })

  it('message_id 存在时必须是字符串', async () => {
    const tool = createReviewTool(asService(new FakeService()))

    await expect(tool.execute({ action: 'list', message_id: 7 }, fakeExec()))
      .rejects.toThrow('参数错误："message_id" 必须是字符串')
  })
})

describe('工具 description 与事实一致', () => {
  it('send_session_message 说明团队消息走 team mailbox 且 inactive 队友可寻址', () => {
    const tool = createSendTool(asService(new FakeService()))

    expect(tool.description).toContain('team mailbox')
    expect(tool.description).toContain('subagent channel')
    expect(tool.description).toContain('inactive')
    expect(tool.description).not.toContain('a teammate goes through the subagent channel')
  })

  it('list_session_agents 说明 include_subagents 只影响其他会话的子代理', () => {
    const tool = createListTool(asService(new FakeService()))
    const parameters = tool.parameters as {
      properties: Record<string, { description?: string }>
    }

    expect(tool.description).toContain('Your own subagents are always listed')
    expect(tool.description).toContain("other sessions' subagents")
    expect(parameters.properties['include_subagents']?.description).toContain('always listed')
  })
})
