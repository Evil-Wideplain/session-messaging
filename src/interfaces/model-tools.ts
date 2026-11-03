/**
 * 模型工具（接口层）：`list_session_agents`、`send_session_message`、
 * `review_session_messages`、`create_session_agent`。
 *
 * 工具名全部 snake_case，并刻意区别于内置的 `list_agents` / `send_message`
 * （那两个走运行时自己的子代理直连），因为这四个工具走的是本插件自己的
 * 寻址、路由与授权层。
 *
 * 本层只做参数校验与 DTO 投影，业务规则全部在应用服务与领域层。
 * 每个工具的实现拆在 `tools/` 子模块里，本文件只做汇总再导出，
 * 导入方继续写 `import { createListTool } from '../interfaces/model-tools.ts'`。
 *
 * @module dsh-plugin-session-messaging/interfaces/model-tools
 */

export { createListTool } from './tools/list.ts'
export { createSendTool } from './tools/send.ts'
export { createReviewTool } from './tools/review.ts'
export { createCreateSessionAgentTool } from './tools/create-session.ts'
