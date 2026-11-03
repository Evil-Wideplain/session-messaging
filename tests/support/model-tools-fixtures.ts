/**
 * 模型工具单元测试的共享夹具：假应用服务、假 Agent 与常用 DTO 固定值。
 */

import type { MessagingService } from '../../src/application/messaging-service.ts'
import type { Caller } from '../../src/application/ports.ts'
import type {
  HeldRow,
  ListResult,
  ListRow,
  ReviewAction,
  ReviewResult,
  SendInput,
  SendResult,
} from '../../src/application/dto.ts'
import type { Agent, ToolExecution } from '../../src/types.ts'

export const CALLER_ID = 'session-caller-0001'

/** list 的入参快照，形状对齐 MessagingService.list。 */
export interface ListOptions {
  readonly includeSubagents: boolean
  readonly limit?: number
  readonly signal?: AbortSignal
}

/** 记录调用并返回固定结果的假应用服务。 */
export class FakeService {
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
export function asService(service: FakeService): MessagingService {
  return service as unknown as MessagingService
}

/** 假 Agent：identityOf 只读 id 与 session.header.cwd。 */
export function fakeAgent(cwd: string | undefined = 'C:\\repo\\main', id: string = CALLER_ID): Agent {
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
export function fakeExec(agent: Agent = fakeAgent()): ToolExecution {
  return {
    callId: 'call-1',
    name: 'test-tool',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  }
}

/** 不带调用方 Agent 的执行上下文。 */
export function fakeExecWithoutAgent(): ToolExecution {
  return {
    callId: 'call-1',
    name: 'test-tool',
    arguments: {},
    signal: new AbortController().signal,
  }
}


/** 常用 list 行固定值。 */
export function listRow(overrides: Partial<ListRow> = {}): ListRow {
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
export function heldRow(overrides: Partial<HeldRow> = {}): HeldRow {
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
