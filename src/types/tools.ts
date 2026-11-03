/**
 * 工具与 shell 环境相关的结构契约（`../types.ts` 的子模块）。
 *
 * `ctx.tools` / `ctx.shellEnv` 的本地声明，真实对象由 Cordis 传入。
 *
 * @module dsh-plugin-session-messaging/types/tools
 */

import type { Agent } from './agent.ts'
import type { ContentBlock } from './session.ts'

/** 工具执行时看到的上下文。 */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** `ctx.tools.register` 接受的结构形状。 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

/** 工具注册表切片。 */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** shell 环境注册表切片（`ctx.shellEnv`）。 */
export interface ShellEnvRegistry {
  register(contributor: {
    readonly name: string
    readonly variables: Readonly<Record<string, { readonly description: string }>>
    resolve(execution: ToolExecution): Readonly<Record<string, string>>
  }): () => void
}
