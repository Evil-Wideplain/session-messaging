/**
 * 测试共享夹具：临时目录、工具输出渲染、inbox splice 观察辅助。
 *
 * 文件名不带 `.test`，不会被 vitest 收集，仅供 `tests/*.test.ts` 导入。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, SessionEvent, ToolDefinition } from '../../src/types.ts'

const tempDirs: string[] = []

/** 创建一个测试期间使用的临时目录，由 `cleanupTempDirs` 统一删除。 */
export function tempDir(prefix = 'dsm-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 删除本次测试创建的全部临时目录；各测试文件在 `afterEach` 里调用。 */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** 取出工具 `output.render` 的纯文本。 */
export function renderText(tool: ToolDefinition, value: unknown): string {
  return tool.output.render({}, value).map(block => block.text ?? '').join('\n')
}

/** 目标会话收到的 inbox splice 事件（steer / followup 的落点）。 */
export function spliced(agent: Agent): SessionEvent[] {
  return agent.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced')
}
