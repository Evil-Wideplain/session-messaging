/**
 * 投递网关共享类型（基础设施层）。
 *
 * 冷唤醒需要的运行时上下文与可变状态（恢复句柄集合、并发恢复表、日志出口）
 * 由门面 `CordisDeliveryGateway` 持有，通道与 inbox 投递通过 `WakeState`
 * 共享同一份引用；复制一份状态会让「同一目标只恢复一次」的语义失效。
 *
 * 恢复记录带引用计数：并发投递共享同一个恢复 job 与同一个 Agent，只有最后一个
 * 持有者离开时才允许释放句柄、摘监听；否则先结束的一方会把另一方正在 steer
 * 的 Agent 销毁。
 *
 * @module dsh-plugin-session-messaging/infrastructure/delivery/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '../../types.ts'

/**
 * 冷唤醒后等待首个失败信号的窗口（毫秒）。
 *
 * 它只用于发现 prompt 组装级别、归档门禁级别的快速失败；「是否送达」不由它决定，
 * 而是回到会话事件里的实际证据（见 `deliverToInbox`）。
 */
export const WAKE_SETTLE_MS = 1_200

/** 冷唤醒 Agent 的首轮错误探针。 */
export interface WakeFailure {
  /** 首个 `agent/error`、归档门禁的 blocked 收口，或超时（undefined）。 */
  readonly promise: Promise<Error | undefined>
  /**
   * 注册在恢复上下文上的监听清理函数。
   *
   * 必须在判定结束后调用：被恢复的 Agent 可能长期在线，闭包不释放会一直持有
   * 探针与目标会话引用。
   */
  readonly disposers: (() => void)[]
  /** 已捕获的首个错误；用于区分「已经报错过」与「只是窗口超时」。 */
  error?: Error
  /** 结束探针（首个错误到达时调用；重复调用无效果）。 */
  resolve(error: Error): void
}

/**
 * 一次恢复 job 的产出。
 *
 * 故意不带恢复记录：同一 job 会被多个并发投递共享，记录与引用计数由 `wake()`
 * 在返回时另附（见 `WakeResult.entry`），避免每个调用方拿到同一份可变记录。
 */
export interface WakeOutcome {
  /** 可投递的在线 Agent。 */
  readonly agent: Agent
  /** 本插件拥有的恢复句柄；在线目标没有。 */
  readonly handle?: AgentHandle
  /** 只有冷唤醒才有错误探针。 */
  readonly failure?: WakeFailure
  /** 是否由本次调用从持久化会话恢复。 */
  readonly cold: boolean
}

/** 一次冷唤醒的结果（每次 acquire 一份，携带自己的释放凭据）。 */
export interface WakeResult extends WakeOutcome {
  /** 本次调用共享的恢复记录；判定结束后必须 `release` 一次。 */
  readonly entry: ResumeEntry
}

/** 恢复表中的一条记录：同一目标的并发调用共用同一个 job。 */
export interface ResumeEntry {
  /** 记录归属的目标会话标识（释放时只删除自己这条记录）。 */
  readonly targetId: string
  /** 恢复任务。 */
  readonly job: Promise<WakeOutcome>
  /** 任务是否已经成功结束；结束后的会话可能再次消失，需要允许重新唤醒。 */
  settled: boolean
  /** 持有者数量；归零才允许释放句柄、摘掉监听。 */
  refs: number
  /** job 成功后记下的本插件句柄，供最后一个持有者释放。 */
  handle?: AgentHandle
  /** 首轮错误探针；最后一个持有者离开时摘掉它注册的监听。 */
  failure?: WakeFailure
}

/** 门面持有的唤醒状态，供 inbox 投递与冷唤醒共同读写。 */
export interface WakeState {
  /** Cordis 上下文（agents / sessions / 持久化服务）。 */
  readonly ctx: Context
  /** 日志出口。 */
  readonly log: (message: string) => void
  /** 本插件拥有的恢复句柄，dispose 时要统一释放。 */
  readonly handles: Set<AgentHandle>
  /** 目标会话标识 → 进行中的恢复任务。 */
  readonly resumes: Map<string, ResumeEntry>
}
