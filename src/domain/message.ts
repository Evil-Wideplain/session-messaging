/**
 * 消息构造与送达判定（领域模型）。
 *
 * 转发的消息就是一条普通 `user/message`，`source.kind` 标为 `session-message`；
 * 「是否送达」用与官方 Agent Teams 邮箱相同的标准判断：要么已经进入模型历史，
 * 要么仍持久地挂在目标 inbox 的 splice 投影里。
 *
 * 正文必须自带来源框架（frame）：DSH 把 `user/message` 原样投影给模型，不会
 * 替生产者补任何提示，`source` 元数据只到 UI 为止。所以「谁发的」只能写进
 * `content`，否则目标模型看到的是一段无主的用户文本。
 *
 * @module session-messaging/domain/message
 */

import type { SessionEvent, UserMessage } from '../types.ts'

/** 本插件转发的消息所带的 source 类型。 */
export const SESSION_MESSAGE_KIND = 'session-message'

/** 本插件自己发出的提示（notice）所带的 source 类型。 */
export const SESSION_NOTICE_KIND = 'session-message/notice'

/** `Agent.send()` 写入的 inbox splice 数据。 */
interface InboxSpliceData {
  readonly target: 'next-turn' | 'next-step'
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly UserMessage[]
}

/**
 * 转发消息正文的开头框架。
 *
 * 格式与官方 Agent Teams 邮箱保持一致（`Team message <id> from <name>:`），
 * 让模型能从正文本身判断这是跨会话消息而不是人类指令。
 * @param source - 来源信息。
 * @returns 单行框架文本。
 */
function frameOf(source: {
  readonly messageId: string
  readonly senderId: string
  readonly senderName: string
}): string {
  return `Session message ${source.messageId} from ${source.senderName} (${source.senderId}):`
}

/**
 * 从事件流里还原「仍在等待被认领」的 inbox 消息。
 * @param events - 目标会话的本地事件段。
 * @returns 按 next-turn、next-step 顺序排列的待认领消息。
 */
function pendingInboxMessages(events: readonly SessionEvent[]): UserMessage[] {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data as InboxSpliceData
    if (data === null || typeof data !== 'object') continue
    const pending = inbox[data.target]
    if (pending === undefined || !Array.isArray(data.inserted)) continue
    pending.splice(data.start, data.removedCount ?? 0, ...data.inserted)
  }
  return [...inbox['next-turn'], ...inbox['next-step']]
}

/**
 * 判断一条转发的消息是否已经送达（进入历史或持久待认领）。
 * @param events - 目标会话的非继承事件段。
 * @param messageId - 转发消息标识。
 * @returns 已送达返回 true。
 */
export function messageAccepted(events: readonly SessionEvent[], messageId: string): boolean {
  const matches = (message: UserMessage): boolean =>
    message?.source?.kind === SESSION_MESSAGE_KIND && message.source['messageId'] === messageId
  return events.some(event => event.type === 'user/message' && matches(event.data as UserMessage))
    || pendingInboxMessages(events).some(matches)
}

/**
 * 构造一条发给目标会话的消息。
 * @param id - 本次 user message 的运行时标识；领域层不持有宿主随机源，由调用方生成。
 * @param text - 消息正文。
 * @param source - 写在 source 上的来源信息。
 * @param source.messageId - 转发消息标识。
 * @param source.senderId - 发送方会话标识。
 * @param source.senderName - 发送方显示名。
 * @param source.summary - 可选的一行摘要。
 * @returns 可直接交给 `Agent.steer` 的 user message。
 */
export function relayMessage(id: string, text: string, source: {
  readonly messageId: string
  readonly senderId: string
  readonly senderName: string
  readonly summary?: string
}): UserMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: `${frameOf(source)}\n${text}` }],
    source: {
      kind: SESSION_MESSAGE_KIND,
      form: 'relay',
      messageId: source.messageId,
      senderId: source.senderId,
      senderName: source.senderName,
      ...source.summary === undefined ? {} : { summary: source.summary },
    },
  }
}

/**
 * 构造一条插件提示：它是短的 user-role 消息，但不是被转发的正文，
 * 因此永远不需要审批，也不参与去重。提示同样带 `[session-messaging]` 前缀，
 * 与转发的正文区分开。
 * @param id - 本次 user message 的运行时标识。
 * @param text - 提示正文。
 * @param topic - 稳定的主题标签，写进 source 便于排查。
 * @returns 可直接交给 `Agent.steer` 的 user message。
 */
export function noticeMessage(id: string, text: string, topic: string): UserMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SESSION_NOTICE_KIND, form: 'notice', topic },
  }
}
