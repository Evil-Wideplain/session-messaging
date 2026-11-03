/**
 * 创建行入口（`package.json` 的 `./creation` 子路径）：只做转出。
 *
 * Loader 行 `name: session-messaging/creation` 解析到本文件；
 * 实现见 `entries/creation.ts`。
 *
 * @module session-messaging/creation
 */

export { apply, inject, name } from './entries/creation.ts'
