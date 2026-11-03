/**
 * 工具 description / parameters 文案与事实一致（团队邮箱、include_subagents 语义）。
 */

import { describe, expect, it } from 'vitest'
import { createListTool, createSendTool } from '../src/interfaces/model-tools.ts'
import { asService, FakeService } from './support/model-tools-fixtures.ts'

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
