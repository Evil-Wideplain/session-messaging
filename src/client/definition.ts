/**
 * 跨会话消息的 Chat 行定义（Conversation 事件定义）。
 *
 * 为什么需要它：DSH 内置的 `input-message` 定义把 `source.kind !== 'user'` 的
 * user message 一律归为 `context`，Chat 于是用折叠的「上下文注入」行呈现跨会话
 * 消息——只显示生产者与摘要，正文要点开才看得到。本定义在同一个事件上返回
 * `exclusive: true` 抢占该事件，内置定义不再收到它，跨会话消息改由本插件的
 * `session-message` 渲染器呈现。
 *
 * 独占声明是按 target 解析的（先收集所有 claim 再逐个接受），因此不依赖注册
 * 顺序；没有 claim 的其它 target 仍会收到事件。
 *
 * @module session-messaging/client/definition
 */

import type {
  ChatNodeLike, ConversationDefinitionLike, ConversationLocationLike, ConversationMatchLike,
  ConversationNodeContextLike, SessionEventLike, SessionMessageSource, SessionMessageViewModel,
} from './contract.ts'
import { isSessionMessageSource, stripSessionFrame, textOfContent } from './source.ts'

/** 渲染器 kind；`conversation.chat.node` 的 key 与它一致。 */
export const SESSION_MESSAGE_NODE_KIND = 'session-message'

/** 本插件认领的 durable 事件类型。 */
const USER_MESSAGE_EVENT = 'user/message'

/** `user/message` 事件里本插件消费的字段。 */
interface UserMessageEventData {
  readonly id?: unknown
  readonly role?: unknown
  readonly content?: unknown
  readonly source?: unknown
}

/**
 * 把一条 durable 事件收敛成视图模型。
 * @param event - 已确认是本插件转发的 `user/message`。
 * @param source - 已类型收窄的 source。
 * @returns 交给渲染器的只读视图模型。
 */
function viewModelOf(event: SessionEventLike, source: SessionMessageSource): SessionMessageViewModel {
  const data = event.data as UserMessageEventData
  const text = stripSessionFrame(source, textOfContent(data.content))
  const summary = source.summary
  return {
    kind: SESSION_MESSAGE_NODE_KIND,
    seq: event.seq,
    time: event.time,
    messageId: source.messageId,
    senderId: source.senderId,
    senderName: source.senderName,
    ...(summary === undefined ? {} : { summary }),
    text,
    source,
  }
}

/**
 * 读取匹配事件上的 source；结构不完整时返回 undefined。
 * @param event - 任意客户端事件。
 * @returns 已类型收窄的 source。
 */
function sourceOf(event: SessionEventLike): SessionMessageSource | undefined {
  if (event.type !== USER_MESSAGE_EVENT) return undefined
  const data = event.data as UserMessageEventData | null
  if (typeof data !== 'object' || data === null) return undefined
  if (data.role !== 'user') return undefined
  return isSessionMessageSource(data.source) ? data.source : undefined
}

/**
 * 取事件在 Turn/Step 里的位置。
 * @param context - 当前上下文。
 * @returns 起点位置；尚未加载到起点时按未解析处理。
 */
function locationOf(context: ConversationNodeContextLike<SessionMessageViewModel>): ConversationLocationLike {
  // 历史分页可能只加载到后续事件：此时起点缺失，但第一条匹配的位置仍能把节点
  // 放进正确的 Turn/Step（与 Chat 内置 helper 的退回顺序一致）。
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * 判断这条消息是否开启了新 Turn 的 Step 1。
 *
 * 与 Chat 内置的非人类输入保持一致：开启 Turn 的消息放在输入位（`input`），
 * 中途 steer 进来的消息留在当前 step 的流程里（`undefined`），避免把一次运行
 * 的折叠区间从中间切开。
 * @param location - 事件位置。
 * @returns 开启 Step 1 时为 true。
 */
function opensTurn(location: ConversationLocationLike): boolean {
  return location.kind === 'step' && location.step.step === 1
}

/**
 * 创建跨会话消息的 Conversation 事件定义。
 * @returns 可直接交给 `uiConversation.events.register()` 的定义。
 */
export function createSessionMessageDefinition(): ConversationDefinitionLike {
  return {
    kind: SESSION_MESSAGE_NODE_KIND,
    target: 'chat',
    match(event) {
      const source = sourceOf(event)
      if (source === undefined) return null
      const data = event.data as UserMessageEventData
      if (typeof data.id !== 'string') return null
      return { id: data.id, role: 'start', exclusive: true }
    },
    start(_context, match: ConversationMatchLike) {
      const source = sourceOf(match.event)
      if (source === undefined) {
        throw new Error('session-message 定义只能从本插件转发的 user/message 建立状态')
      }
      return viewModelOf(match.event, source)
    },
    update(context) {
      return context.state
    },
    buildViewNode(context) {
      const state = context.state
      if (state === undefined) return null
      const location = locationOf(context)
      const node: ChatNodeLike<SessionMessageViewModel> = {
        key: context.key,
        kind: SESSION_MESSAGE_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: state.seq,
        location,
        visibility: 'visible',
        groupTree: opensTurn(location) ? 'input' : undefined,
        data: state,
      }
      return node
    },
  }
}
