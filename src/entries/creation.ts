/**
 * 创建行 `session-creation` 的入口实现：只注册 `create_session_agent`。
 *
 * 这一行与主行（`session-messaging`）同属一个插件包，但在 `cordis.patch.yml`
 * 里是独立的 Loader 行，因此在插件页上是独立组件、有独立启停开关：关掉它只
 * 少这一个工具，list / send / review 与本地总线照常。
 *
 * 创建会话服务由主行 provide（见 `shared/service.ts`）。主行没激活时本行等依赖，
 * `create_session_agent` 自然不可用；这是依赖关系，不是故障。
 *
 * 组合包入口是 `src/creation.ts`（薄 barrel，`package.json` 的 `./creation`
 * 子路径）；本文件不直接被包名解析，实现与入口职责分开。
 *
 * @module session-messaging/entries/creation
 */

import type { Context } from '@deepseek-ai/cordis'
import { createCreateSessionAgentTool } from '../interfaces/tools/create-session.ts'
import { SESSION_MESSAGING_SERVICE } from '../shared/service.ts'

/** 这一行的插件名；Loader 行 id 由 `cordis.patch.yml` 的 `session-creation` 指定。 */
export const name = 'session-creation'

/** 注册工具需要工具注册表，以及主行提供的创建会话服务。 */
export const inject = ['tools', SESSION_MESSAGING_SERVICE]

/**
 * 注册 `create_session_agent` 模型工具。
 * @param ctx - 已注入 `tools` 与 `sessionMessaging` 的行上下文。
 */
export function apply(ctx: Context): void {
  const runtime = ctx.get(SESSION_MESSAGING_SERVICE)
  // inject 保证服务可用；这里显式判空，让依赖装配错误在日志里可辨认，
  // 而不是运行时以 `undefined.creation` 的形式炸掉。
  if (runtime === undefined) {
    throw new Error(
      'sessionMessaging 服务不可用：session-creation 行必须与 session-messaging 行一起启用',
    )
  }
  ctx.tools.register(createCreateSessionAgentTool(runtime.creation))
}
