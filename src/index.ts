/**
 * 组合包主入口（`package.json` 的 `main`）：只做转出。
 *
 * 主行 `session-messaging` 的 Loader 行 `name` 解析到本文件；实现见
 * `entries/messaging.ts`。入口与实现分离，方便在同一个包里继续增加装载行。
 *
 * @module session-messaging
 */

export { Config } from './config.ts'
export type { Config as MessagingConfig } from './config.ts'
export { apply, inject, name } from './entries/messaging.ts'
