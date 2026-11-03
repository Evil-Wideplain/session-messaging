/**
 * `create_session_agent` 工具单元测试的共享夹具：假创建服务与工具执行上下文。
 */

import type { CreateSessionResult } from '../../src/application/dto.ts'
import type { Caller } from '../../src/application/ports.ts'
import type { Agent, ToolExecution } from '../../src/types.ts'
import { CALLER_CWD, NEW_SESSION_ID } from './create-session-fixtures.ts'

/** 记录调用的假创建应用服务。 */
export class FakeCreationService {
  readonly calls: {
    caller: Caller
    input: {
      readonly prompt: string
      readonly cwd?: string
      readonly workspace?: string
      readonly ensureWorkspace?: boolean
      readonly title?: string
      readonly agentPreset?: string
    }
    signal: AbortSignal | undefined
  }[] = []

  constructor(
    private readonly result: CreateSessionResult = {
      status: 'accepted',
      sessionId: NEW_SESSION_ID,
      shortId: '0f1e2d3c',
      cwd: CALLER_CWD,
      messageId: 'message-1',
      detail: '已创建普通会话',
      title: '前端联调',
      agentPreset: 'default',
    },
  ) {}

  async create(
    caller: Caller,
    input: {
      readonly prompt: string
      readonly cwd?: string
      readonly workspace?: string
      readonly ensureWorkspace?: boolean
      readonly title?: string
      readonly agentPreset?: string
    },
    signal?: AbortSignal,
  ): Promise<CreateSessionResult> {
    this.calls.push({ caller, input, signal })
    return this.result
  }
}

/** 假工具执行上下文。 */
export function createSessionExec(agent?: Agent): ToolExecution {
  return {
    callId: 'call-1',
    name: 'create_session_agent',
    arguments: {},
    ...agent === undefined ? {} : { agent },
    signal: new AbortController().signal,
  }
}
