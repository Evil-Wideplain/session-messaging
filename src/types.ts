/**
 * 本插件用到的 DSH 服务的本地结构契约（barrel）。
 *
 * 插件刻意不在运行时或构建期导入任何 `@deepseek-ai/dsh-*` 包：它是 bundle
 * 插件，必须在不同 alpha 版本之间继续可用，因此只声明自己用到的服务切片，
 * 真实对象由 Cordis 传入。这些结构已对照 0.2.x 源码核对；0.1.3-alpha.1 时期的
 * 核对记录保留在 docs/research/，不再作为当前运行时的依据。
 * 注意：本文件只做类型声明，构建产物里不会留下对 `@deepseek-ai/dsh-*` 的 import。
 *
 * 具体声明按主题拆在 `types/` 子模块里，这里只做汇总再导出；导入方继续写
 * `import type { ... } from '../types.ts'` 即可，公开导出名与路径不变。
 *
 * @module dsh-plugin-session-messaging/types
 */

// 副作用导入：Cordis 的 `Context` / `Events` 增补必须进入编译单元，
// `ctx.tools`、`ctx.agents` 等成员才会在插件代码里可见。
import './types/context.ts'

export type * from './types/session.ts'
export type * from './types/agent.ts'
export type * from './types/tools.ts'
export type * from './types/services.ts'
