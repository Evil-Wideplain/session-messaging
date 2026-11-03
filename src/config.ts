/**
 * 插件配置与运行时 schema。
 *
 * 字段刻意保持扁平：bundle patch 只提供部分值，其余由 schemastery 填默认。
 *
 * @module dsh-plugin-session-messaging/config
 */

import z from '@deepseek-ai/schemastery'

/** 跨会话消息的部署策略。 */
export interface Config {
  /** 是否允许向工作目录不同的会话发消息。 */
  readonly allowCrossWorkspace?: boolean
  /** 例外清单：精确会话 id，或目录前缀（`/repo`、`C:\repo`）。 */
  readonly allowlist?: string[]
  /** 单条消息正文的字节上限。 */
  readonly maxMessageBytes?: number
  /** 一个发送方每分钟最多向同一目标投递多少条。 */
  readonly maxPerMinute?: number
  /** 同一发送方对同一目标的相同正文在多长时间窗口内去重。 */
  readonly dedupeWindowMs?: number
  /** 同一目标名下允许的未确认消息上限。 */
  readonly maxPendingPerTarget?: number
  /** 目标会话未运行时是否先恢复（冷唤醒）再投递。 */
  readonly allowColdWake?: boolean
  /** 本部署的入站策略：直接接收、挂起审批、一律拒绝。 */
  readonly inbound?: 'accept' | 'hold' | 'refuse'
  /** 挂起消息等待目标决定的时长，超时过期。 */
  readonly holdExpiryMs?: number
  /** 每个目标最多挂起多少条；满了丢最旧。 */
  readonly maxHeldPerTarget?: number
  /** 「有消息待审批」提示给同一目标的最小间隔。 */
  readonly notifyIntervalMs?: number
  /** 是否暴露本地总线（shell 脚本用）。 */
  readonly socketEnabled?: boolean
  /** 总线 socket 所在目录（POSIX）；默认每用户临时目录。 */
  readonly socketDir?: string
  /** 出站账本目录；默认 `$DSH_HOME/session-messaging/outbox`。 */
  readonly outboxDir?: string
  /** 是否允许模型工具创建新会话。 */
  readonly allowCreateSession?: boolean
  /** 一个调用方每分钟最多创建多少个新会话。 */
  readonly maxCreatesPerMinute?: number
  /** 是否允许创建会话时用 `ensure_workspace` 自动登记工作区。 */
  readonly allowCreateWorkspace?: boolean
}

/** {@link Config} 的运行时 schema。 */
// schemastery 无法表达 `exactOptionalPropertyTypes` 的可选字段，因此这里断言
// 解析后的形状，并在 resolveConfig 里逐字段兜底默认值。
export const Config = z.object({
  allowCrossWorkspace: z.boolean().default(false)
    .description('允许向工作目录不同的会话发消息。'),
  allowlist: z.array(z.string()).default([])
    .description('不受 workspace 策略限制的会话 id 或目录前缀。'),
  maxMessageBytes: z.number().step(1).min(1).default(64 * 1024)
    .description('单条消息正文的字节上限。'),
  maxPerMinute: z.number().step(1).min(1).default(20)
    .description('一个发送方每分钟最多向同一目标投递多少条。'),
  dedupeWindowMs: z.number().step(1).min(0).default(10_000)
    .description('相同正文去重窗口（毫秒）。'),
  maxPendingPerTarget: z.number().step(1).min(1).default(50)
    .description('同一目标名下允许的未确认消息上限。'),
  allowColdWake: z.boolean().default(true)
    .description('目标会话未运行时先恢复再投递。'),
  inbound: z.union(['accept', 'hold', 'refuse']).default('accept')
    .description('入站策略：直接接收、挂起等待目标审批、一律拒绝。'),
  holdExpiryMs: z.number().step(1).min(1).default(5 * 60_000)
    .description('挂起消息的审批截止窗口。'),
  maxHeldPerTarget: z.number().step(1).min(1).default(100)
    .description('每个目标最多挂起多少条；满了丢最旧。'),
  notifyIntervalMs: z.number().step(1).min(0).default(60_000)
    .description('审批提示给同一目标的最小间隔。'),
  socketEnabled: z.boolean().default(true)
    .description('暴露供 shell 脚本使用的本地总线。'),
  socketDir: z.string(),
  outboxDir: z.string(),
  allowCreateSession: z.boolean().default(true)
    .description('允许模型工具创建新的普通会话。'),
  maxCreatesPerMinute: z.number().step(1).min(1).default(4)
    .description('一个调用方每分钟最多创建多少个新会话。'),
  allowCreateWorkspace: z.boolean().default(true)
    .description('允许 create_session_agent 用 ensure_workspace 把目录登记成工作区。'),
}) as unknown as z<Config>

/** 所有默认值都已补齐的配置。 */
export interface ResolvedConfig {
  readonly allowCrossWorkspace: boolean
  readonly allowlist: readonly string[]
  readonly maxMessageBytes: number
  readonly maxPerMinute: number
  readonly dedupeWindowMs: number
  readonly maxPendingPerTarget: number
  readonly allowColdWake: boolean
  readonly inbound: 'accept' | 'hold' | 'refuse'
  readonly holdExpiryMs: number
  readonly maxHeldPerTarget: number
  readonly notifyIntervalMs: number
  readonly socketEnabled: boolean
  readonly socketDir: string | undefined
  readonly outboxDir: string | undefined
  readonly allowCreateSession: boolean
  readonly maxCreatesPerMinute: number
  readonly allowCreateWorkspace: boolean
  /**
   * 路径比较是否忽略大小写。
   *
   * 由 `resolveConfig` 从运行时平台探测后注入，不是用户可配置项；放在这里是为了
   * 让领域层拿到「事实」而不是自己去读 `process.platform`。
   */
  readonly pathCaseInsensitive: boolean
}

/**
 * 补齐文档里的默认值。
 * @param config - 部分部署配置。
 * @returns 生效配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    allowCrossWorkspace: config.allowCrossWorkspace ?? false,
    allowlist: config.allowlist ?? [],
    maxMessageBytes: config.maxMessageBytes ?? 64 * 1024,
    maxPerMinute: config.maxPerMinute ?? 20,
    dedupeWindowMs: config.dedupeWindowMs ?? 10_000,
    maxPendingPerTarget: config.maxPendingPerTarget ?? 50,
    allowColdWake: config.allowColdWake ?? true,
    inbound: config.inbound ?? 'accept',
    holdExpiryMs: config.holdExpiryMs ?? 5 * 60_000,
    maxHeldPerTarget: config.maxHeldPerTarget ?? 100,
    notifyIntervalMs: config.notifyIntervalMs ?? 60_000,
    socketEnabled: config.socketEnabled ?? true,
    socketDir: config.socketDir,
    outboxDir: config.outboxDir,
    allowCreateSession: config.allowCreateSession ?? true,
    maxCreatesPerMinute: config.maxCreatesPerMinute ?? 4,
    allowCreateWorkspace: config.allowCreateWorkspace ?? true,
    pathCaseInsensitive: process.platform === 'win32',
  }
}
