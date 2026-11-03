/**
 * 会话目录共享常量与类型（基础设施层）。
 *
 * 目录门面 `CordisSessionDirectory` 持有上下文与标题缓存，各投影模块通过
 * `DirectoryState` 共享同一份缓存引用：「同一会话的标题只短读一次」才成立；
 * 复制一份 Map 会让缓存形同虚设。
 *
 * @module dsh-plugin-session-messaging/infrastructure/directory/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionDirectory } from '../../application/ports.ts'

/** 标题缓存时长：`/rename` 随时可能改标题，因此只缓存很短时间。 */
export const TITLE_TTL_MS = 30_000

/** 冷会话标题并发读取上限：串行读 200 份日志会让一次 send 卡到几十秒。 */
export const COLD_READ_CONCURRENCY = 8

/** 标题缓存条目。 */
export interface TitleCacheEntry {
  /** 会话标题；读取失败时为 undefined（负缓存同样受 TTL 约束）。 */
  readonly title: string | undefined
  /** 写入缓存的时间戳（毫秒）。 */
  readonly at: number
}

/** 目录门面持有的共享状态。 */
export interface DirectoryState {
  /** Cordis 上下文（agents / sessionQuery / sessionPersistence / sessionTitle / agentTeams）。 */
  readonly ctx: Context
  /** 冷会话标题缓存（会话标识 → 标题 + 写入时间）。 */
  readonly titles: Map<string, TitleCacheEntry>
}

/**
 * 候选目标枚举选项。
 *
 * 直接取端口方法签名的参数类型：另写一份结构相同的接口会在端口新增选项时静默
 * 漂移（方法参数双变，门面实现不会报错，新选项被悄悄忽略）。
 */
export type CandidatesOptions = Parameters<SessionDirectory['candidates']>[0]
