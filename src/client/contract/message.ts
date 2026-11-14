/**
 * 跨会话消息的业务数据契约（表现层）。
 *
 * 这些形状与 Host 端 `src/domain/message.ts` 写入的 durable 数据一一对应；
 * 两边必须同步修改，否则 UI 会读不到来源信息、退回到原始正文。
 *
 * @module session-messaging/client/contract/message
 */

/** 组合包写入的 durable source（与 Host 端 `relayMessage()` 一致）。 */
export interface SessionMessageSource {
  /** 来源类型，固定为 `session-message`。 */
  readonly kind: 'session-message'
  /** 投递形态；转发消息固定 `relay`。 */
  readonly form: 'relay'
  /** 转发消息标识（Host 账本主键）。 */
  readonly messageId: string
  /** 发送方会话标识。 */
  readonly senderId: string
  /** 发送方显示名。 */
  readonly senderName: string
  /** 可选的一行摘要。 */
  readonly summary?: string
}

/** 交给 Chat 渲染器的只读视图模型。 */
export interface SessionMessageViewModel {
  /** 渲染器 kind，等于 Conversation Definition 的 `kind`。 */
  readonly kind: 'session-message'
  /** durable 事件的序号（同 `anchorSeq`）。 */
  readonly seq: number
  /** durable 事件时间（Unix 毫秒）。 */
  readonly time: number
  /** 转发消息标识。 */
  readonly messageId: string
  /** 发送方会话标识；点击卡片时用它导航。 */
  readonly senderId: string
  /** 发送方显示名；缺失时由组件回退到短 id。 */
  readonly senderName: string
  /** 可选摘要。 */
  readonly summary?: string
  /** 去掉来源框架后的正文（模型看到的仍是带框架的原文）。 */
  readonly text: string
  /** 原始 durable source，便于后续扩展或诊断。 */
  readonly source: SessionMessageSource
}
