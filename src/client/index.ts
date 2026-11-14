/**
 * 浏览器端入口（模块标识 `session-messaging`，由 `dsh.client` 解析）。
 *
 * 与 Host 入口分开：本文件只被客户端模块加载器读取，编译产物是
 * `lib/client.js`（自带 `window.__ModuleLoader__` 包装，不引用 Node 内置模块）。
 *
 * @module session-messaging/client
 */

export { apply, inject } from './apply.ts'
