/**
 * 客户端服务契约（表现层）。
 *
 * 只声明本插件消费的方法，方法签名按 DSH 0.2.x 的公开行为收敛；多声明一个
 * 参数不会带来能力，只会让升级时的破坏点变多，因此这里刻意保持窄。
 *
 * @module session-messaging/client/contract/services
 */

import type { ConversationDefinitionLike } from './conversation.ts'

/** 翻译入口（locale 座位注入）。 */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** locale 服务里本插件消费的切片。 */
export interface LocaleServiceLike {
  /**
   * 注册一个命名空间字典；返回幂等注销函数。
   * @param namespace - 命名空间。
   * @param dictionaries - 语言 → 字典。
   * @returns 注销函数。
   */
  register(
    namespace: string,
    dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): () => void
}

/** 插槽服务里本插件消费的切片。 */
export interface SlotsServiceLike {
  /**
   * 注册一个插槽条目；返回幂等注销函数。
   * @param options - 插槽名与条目选项。
   * @param component - React 组件。
   * @returns 注销函数。
   */
  register(options: Readonly<Record<string, unknown>>, component: unknown): () => void
  /**
   * 在宿主声明存在时安装条目，声明撤销时自动卸载。
   * @param owner - 插槽名。
   * @param install - 安装回调。
   */
  inject(owner: string, install: () => () => void): void
}

/** Conversation 事件注册表。 */
export interface ConversationEventsServiceLike {
  /**
   * 注册一个事件定义；返回幂等注销函数。
   * @param definition - 事件定义。
   * @returns 注销函数。
   */
  register(definition: ConversationDefinitionLike): () => void
}

/** 客户端插件上下文里本插件消费的切片。 */
export interface ClientContextLike {
  /**
   * 注册一个由当前插件生命周期拥有的副作用。
   * @param create - 返回值作为清理函数。
   * @param label - 诊断标签。
   * @returns 立即注销函数。
   */
  effect(create: () => (() => void) | void, label?: string): () => void
  /**
   * 服务查找；可选服务（如 `uiWorkspace`）用它读取。
   * @param key - 服务名。
   * @returns 服务对象或 undefined。
   */
  get(key: string): unknown
  /** 本地化服务。 */
  locale: LocaleServiceLike
  /** 插槽服务。 */
  slots: SlotsServiceLike
  /** Conversation 事件注册表。 */
  uiConversation: { readonly events: ConversationEventsServiceLike }
}

/** 会话导航服务里本插件消费的切片。 */
export interface SessionNavigationLike {
  /**
   * 选中一个会话并把它的 Conversation 显示出来。
   * @param sessionId - 目标会话标识。
   */
  openSession(sessionId: string): void
}
