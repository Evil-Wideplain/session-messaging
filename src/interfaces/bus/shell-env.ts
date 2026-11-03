/**
 * shell 环境注入（接口层）。
 *
 * 把总线端点与每会话 token 注册进 bash/pwsh 环境。token 按密钥对待：它是
 * 「连接 = 某个发送方身份」的唯一依据，注入后脚本的身份就是它所在的会话。
 *
 * @module session-messaging/interfaces/bus/shell-env
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '../../types.ts'
import type { LocalBus } from './server.ts'

/**
 * 把总线端点与每会话 token 注册进 bash/pwsh 环境。
 * @param ctx - 携带 `shellEnv` 的上下文。
 * @param bus - 要暴露的总线。
 * @returns 贡献者的释放函数；没有 `shellEnv` 时返回空操作。
 */
export function registerShellEnv(ctx: Context, bus: LocalBus): () => void {
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) return () => {}
  return shellEnv.register({
    name: 'session-messaging',
    variables: {
      DSH_SESSION_MESSAGING_SOCKET: {
        description: '本会话 shell 脚本可用的本地总线端点（list/send）。',
      },
      DSH_SESSION_MESSAGING_TOKEN: {
        description: '本会话总线请求的 bearer token，按密钥对待。',
      },
    },
    resolve(execution: ToolExecution): Record<string, string> {
      const agent = execution.agent
      if (agent === undefined) return {}
      return {
        DSH_SESSION_MESSAGING_SOCKET: bus.endpoint,
        DSH_SESSION_MESSAGING_TOKEN: bus.tokenFor(agent.id),
      }
    },
  })
}
