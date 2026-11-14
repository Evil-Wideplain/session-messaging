/**
 * 浏览器端用到的 DSH 客户端契约（本地声明，不导入任何 `@deepseek-ai/dsh-*` 包）。
 *
 * 与 Host 端的 `src/types.ts` 同一套做法：插件只声明自己实际消费的服务切片，
 * 真实对象由 Cordis 传入。客户端契约比 Host 更窄——只覆盖 Chat 插槽注册、
 * Conversation 事件定义、locale 与服务查找，避免把客户端实现锁死在某个
 * alpha 版本的导出细节上。
 *
 * 具体声明按主题拆在 `contract/` 子模块里，这里只做汇总再导出；导入方继续写
 * `import type { ... } from './contract.ts'` 即可。
 *
 * @module session-messaging/client/contract
 */

export type * from './contract/message.ts'
export type * from './contract/conversation.ts'
export type * from './contract/services.ts'
