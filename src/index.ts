/**
 * DSH 跨会话消息插件（组合根）。
 *
 * 提供三个模型工具（`list_session_agents`、`send_session_message`、
 * `review_session_messages`）和一个 shell 传输层（每用户一条本地总线），
 * 让同一 DSH 进程内的 Agent 会话可以互相寻址、唤醒、审批消息。
 *
 * 代码按 DDD 分层组织：
 * - `domain/`：寻址、授权、路由、消息与审批的纯业务规则；
 * - `application/`：用例编排（list/send/review/recover）与端口接口；
 * - `infrastructure/`：JSONL 账本、Cordis 会话目录、投递网关；
 * - `interfaces/`：模型工具与本地总线。
 *
 * @module dsh-plugin-session-messaging
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config as MessagingConfig } from './config.ts'
import { Config } from './config.ts'
import { resolveConfig } from './config.ts'
import { createMessagingRuntime } from './composition.ts'
import { identityOf } from './domain/authorization.ts'
import { LocalBus, registerShellEnv } from './interfaces/local-bus.ts'
import { createListTool, createReviewTool, createSendTool } from './interfaces/model-tools.ts'

export { Config }
export type { Config as MessagingConfig } from './config.ts'

export const name = 'session-messaging'

export const inject = ['tools', 'agents', 'sessions']

/**
 * 注册跨会话消息工具、本地总线与恢复钩子。
 * @param ctx - 插件上下文。
 * @param config - 已应用 schema 默认值的部署策略。
 */
export function apply(ctx: Context, config: MessagingConfig): void {
  const runtime = createMessagingRuntime(ctx, resolveConfig(config))
  const service = runtime.service
  ctx.tools.register(createListTool(service))
  ctx.tools.register(createSendTool(service))
  ctx.tools.register(createReviewTool(service))
  ctx.effect(() => () => runtime.dispose())

  if (config.socketEnabled !== false) {
    const bus = new LocalBus(ctx, service, config.socketDir)
    let disposed = false
    // dispose 时 await：stop() 要等 server.close 回调，不等待会让关闭流程悬空。
    // 同时置 disposed，避免「启动完成后又往已卸载的 ctx 注册 shellEnv」。
    ctx.effect(() => async () => {
      disposed = true
      await bus.stop()
    })
    // 只有真正 listening 之后才把端点与 token 导进 shell 环境：先导出再启动，
    // 启动失败时脚本拿到的是一个没人监听（或属于别人）的端点。
    void (async () => {
      try {
        await bus.start()
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[session-messaging] 总线启动失败（${bus.endpoint}）: ${detail}`)
        return
      }
      if (disposed) return
      ctx.effect(() => registerShellEnv(ctx, bus))
    })()
  }

  // 会话恢复（冷唤醒、重启、fork）时重放自己未确认的账本，
  // 这样崩溃前排队但未确认的消息不会丢。
  //
  // 事件名必须用运行时真实存在的那一个：0.2.x 的 Agent 生命周期是
  // `agent/created` / `agent/disposed`，不存在 `agent/session-start`。
  // 单测直接调 service.recover() 会绕过这里，因此必须保留至少一个
  // 真进程集成用例（scripts/e2e-runtime.mjs 之外见 e2e-workspace）。
  ctx.on('agent/created', ({ agent }) => {
    void service.recover({ agent, identity: identityOf(agent) })
  })
  for (const agent of ctx.agents.list()) {
    void service.recover({ agent, identity: identityOf(agent) })
  }
}
