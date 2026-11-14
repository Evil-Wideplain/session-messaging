import type { SessionMessageViewModel } from './message.ts'

/**
 * Conversation 事件定义与 Chat 节点契约（表现层）。
 *
 * 只声明本插件实现/渲染所需的字段；真实对象由 `uiConversation.events` 的运行时
 * 提供。`exclusive` 的语义见 `client/definition.ts` 的文件头说明。
 *
 * @module session-messaging/client/contract/conversation
 */

/** 一条客户端历史事件（durable 与 transient 取子集）。 */
export interface SessionEventLike {
  /** 事件类型，例如 `user/message`。 */
  readonly type: string
  /** 会话内单调序号。 */
  readonly seq: number
  /** 事件时间（Unix 毫秒）。 */
  readonly time: number
  /** 事件载荷，由定义自己做结构收敛。 */
  readonly data: unknown
}

/** Definition 识别出的一条业务匹配。 */
export interface ConversationMatchResultLike {
  /** Definition 内的业务身份。 */
  readonly id: string
  /** 首个事件是 `start`，其后是 `update`。 */
  readonly role: 'start' | 'update'
  /**
   * 独占声明：同一 target 上的其它 Definition 不再收到该事件。
   * 用它替换 Chat 内置的 `input-message` 对 `user/message` 的归类。
   */
  readonly exclusive?: true
}

/** 引擎解析出的位置；这里只用到 `step`/`turn` 与未解析形态。 */
export type ConversationLocationLike =
  | { readonly kind: 'session' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'turn'; readonly turn: { readonly turn: number } }
  | {
    readonly kind: 'step'
    readonly turn: { readonly turn: number }
    readonly step: { readonly step: number }
  }

/** 一次已接受的匹配。 */
export interface ConversationMatchLike {
  /** 匹配到的原始事件。 */
  readonly event: SessionEventLike
  /** 生命周期角色。 */
  readonly role: 'start' | 'update'
  /** 引擎解析出的位置。 */
  readonly location: ConversationLocationLike
}

/** 交给 Definition 的只读上下文。 */
export interface ConversationNodeContextLike<State = unknown> {
  /** 引擎生成的稳定 key。 */
  readonly key: string
  /** Definition 业务身份。 */
  readonly id: string
  /** 当前状态。 */
  readonly state: State | undefined
  /** 首个匹配，未加载到起点时缺失。 */
  readonly start: ConversationMatchLike | undefined
  /** 已接受的全部匹配。 */
  readonly matches: readonly ConversationMatchLike[]
}

/** Chat 节点渲染器收到的 Node 形状（只声明本插件消费的字段）。 */
export interface ChatNodeLike<State> {
  /** 稳定 key。 */
  readonly key: string
  /** 渲染器 kind。 */
  readonly kind: 'session-message'
  /** 业务身份。 */
  readonly id: string
  /** Chat View target。 */
  readonly target: 'chat'
  /** 排序用的序号。 */
  readonly anchorSeq: number
  /** 事件在 Turn/Step 里的位置。 */
  readonly location: ConversationLocationLike
  /** 是否参与可见行。 */
  readonly visibility: 'visible' | 'hidden'
  /**
   * 分组树位置：开启 Step 1 的消息放在 `input`（与内置 notice 一致），
   * 中途 steer 的消息留空（留在当前 step 的流程里）。
   */
  readonly groupTree: 'input' | 'exchange' | undefined
  /** 渲染器载荷。 */
  readonly data: State
}

/** Conversation 事件定义（只声明本插件实现的部分）。 */
export interface ConversationDefinitionLike {
  /** 渲染器 key。 */
  readonly kind: 'session-message'
  /** View target；Chat 的 target 固定为 `chat`。 */
  readonly target: 'chat'
  /**
   * 识别本插件转发的 user message。
   * @param event - 一条客户端事件。
   * @returns 匹配结果；不相关时返回 null。
   */
  match(event: SessionEventLike): ConversationMatchResultLike | null
  /**
   * 从起点建立状态。
   * @param context - 已收集的上下文。
   * @param match - 起点匹配。
   * @returns 视图模型。
   */
  start(context: ConversationNodeContextLike, match: ConversationMatchLike): SessionMessageViewModel
  /**
   * 吸收后续匹配；本插件没有可合并的增量，原样返回状态。
   * @param context - 带当前状态的上下文。
   * @returns 当前状态。
   */
  update(
    context: ConversationNodeContextLike<SessionMessageViewModel> & { readonly state: SessionMessageViewModel },
  ): SessionMessageViewModel
  /**
   * 生成最终 Chat 节点。
   * @param context - 最新上下文。
   * @returns 可见节点；没有状态时返回 null。
   */
  buildViewNode(
    context: ConversationNodeContextLike<SessionMessageViewModel>,
  ): ChatNodeLike<SessionMessageViewModel> | null
}
