/**
 * 应用层端口（依赖倒置）。
 *
 * 应用服务只认识这些接口，由基础设施层用 Cordis / JSONL 实现；测试可以
 * 换成内存实现。领域层不知道这些接口的存在。
 *
 * @module dsh-plugin-session-messaging/application/ports
 */

import type { Agent, UserMessage } from '../types.ts'
import type { CallerIdentity } from '../domain/authorization.ts'
import type { SessionTarget } from '../domain/target.ts'
import type { DeliveryRoute } from '../domain/routing.ts'
import type { OutboxAck, OutboxEntry } from '../domain/outbox.ts'
import type { HeldMessage, HeldVerdict } from '../domain/held-message.ts'

/** 运行时验证过的调用方：在线 Agent 加它的身份。 */
export interface Caller {
  /** 在线 Agent（工具/总线入口保证存在）。 */
  readonly agent: Agent
  /** 从 Agent 派生的身份。 */
  readonly identity: CallerIdentity
}

/** 发送方出站账本仓储。 */
export interface OutboxRepository {
  /** 记录一条待投递消息（投递前先落账）。 */
  queue(entry: OutboxEntry): void
  /** 记录一条被目标挂起审批的消息。 */
  hold(entry: OutboxEntry): void
  /** 记录一条已确认送达的消息。 */
  deliver(messageId: string): void
  /** 记录一条过期或被拒绝的挂起消息。 */
  ack(messageId: string, verdict: Exclude<OutboxAck, 'delivered'>): void
  /** 仍可重放的未确认消息（只有 queued）。 */
  pending(): OutboxEntry[]
  /** 某个目标名下未确认的消息数量（queued + held）。 */
  pendingTo(targetId: string): number
  /** 压缩账本，只保留可重放（queued）与待审批（held）的消息。 */
  compact(): void
}

/** 接收方入站账本仓储。 */
export interface InboundRepository {
  /** 记录一条待审批消息。 */
  hold(message: HeldMessage): void
  /** 仍挂起且未过期的消息（按到达顺序）。 */
  held(now?: number): HeldMessage[]
  /** 已过截止时间但仍留在账本里的消息。 */
  expired(now?: number): HeldMessage[]
  /** 对挂起消息应用裁决并移出挂起集合。 */
  settle(verdict: HeldVerdict, ids?: readonly string[]): HeldMessage[]
  /** 压缩账本，只保留仍挂起的消息。 */
  compact(now?: number): void
}

/** 会话目录：把运行时状态投影成领域目标。 */
export interface SessionDirectory {
  /** 列出候选会话（含冷会话；带 caller 时会补上团队名册里的 inactive 队友）。 */
  candidates(options: {
    readonly includeCold: boolean
    readonly coldLimit?: number
    readonly signal?: AbortSignal
    readonly caller?: Caller
  }): Promise<SessionTarget[]>
  /** 按 id、标题或团队名解析出唯一目标。 */
  resolve(address: string, signal?: AbortSignal, caller?: Caller): Promise<SessionTarget>
  /** 按精确 id 查找目标，找不到时返回 undefined。 */
  findById(id: string, signal?: AbortSignal): Promise<SessionTarget | undefined>
  /** 目标在调用方团队名册中的成员名，不是队友时返回 undefined。 */
  teamMemberName(caller: Caller, target: SessionTarget): string | undefined
  /** 指定会话是否与目标同属一个团队；会话离线时返回 undefined。 */
  teamMemberNameById(agentId: string, target: SessionTarget): string | undefined
  /** 在线会话的实时标题，缺失时返回 undefined。 */
  titleOf(id: string): string | undefined
  /** 目标会话历史里是否已有某条转发的消息（重放前用于去重）。 */
  hasDelivered(id: string, messageId: string, signal?: AbortSignal): Promise<boolean>
  /**
   * 目标是否处于归档门禁之下；是则返回面向模型的拒绝原因。
   * 归档会话不会产生 `agent/error`，只在 `turn/end` 里以 `blocked` 收口，
   * 因此必须在投递前同步判断。
   */
  archivedReason(target: SessionTarget): string | undefined
  /**
   * 归档状态是否可判定（运行时提供了 Workspace 注册表且读取成功）。
   *
   * 为 false 时冷唤醒必须 fail-closed：无法确认目标是否被归档，唤醒一旦被
   * 门禁拦下就只能丢消息。
   */
  archiveStateKnown(): boolean
}

/** 一次投递的结果。 */
export interface DeliveryOutcome {
  /** 是否已确认送达。 */
  readonly accepted: boolean
  /** 实际使用的通道。 */
  readonly route: DeliveryRoute
  /** 面向模型的说明。 */
  readonly detail: string
}

/** 发送方事实，供路由决策与投递执行使用。 */
export interface DeliverySenderFacts {
  /** 发送方会话标识。 */
  readonly senderId: string
  /** 发送方工作目录。 */
  readonly senderCwd?: string
  /** 发送方在目标所属团队里的成员名（如有）。 */
  readonly teamMemberName?: string
}

/** 投递网关：负责真正把消息交给运行时（官方通道、inbox、冷唤醒）。 */
export interface DeliveryGateway {
  /**
   * 投递一条已构造好的消息。
   * @param target - 目标会话。
   * @param message - 已构造的消息。
   * @param sender - 发送方事实。
   * @param signal - 取消信号。
   * @returns 送达结果。
   */
  deliver(
    target: SessionTarget,
    message: UserMessage,
    sender: DeliverySenderFacts,
    signal: AbortSignal,
  ): Promise<DeliveryOutcome>

  /**
   * 给一个在线会话发一条插件提示（不是转发正文，不参与审批）。
   * @param agentId - 目标会话标识。
   * @param text - 提示正文。
   * @param topic - 主题标签。
   */
  notify(agentId: string, text: string, topic: string): void
}
