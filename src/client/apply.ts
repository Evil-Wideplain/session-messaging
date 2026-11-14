/**
 * 浏览器端插件：把跨会话消息接进 Chat。
 *
 * 注册三样东西，全部由 `ctx.effect` / `ctx.slots.inject` 管生命周期：
 * 1. locale 字典（UI 文案）；
 * 2. 一张 `<style>`（卡片样式，卸载时移除）；
 * 3. Conversation 事件定义（独占认领 `source.kind === 'session-message'` 的
 *    `user/message`），以及它在 `conversation.chat.node` 上的键控渲染器。
 *
 * 这里只做「装配」：数据在 `definition.ts`，组件在 `SessionMessageView.tsx`，
 * 样式在 `styles.ts`。`uiWorkspace` 按可选服务处理——没有它时卡片仍可读、
 * 可复制，只是点击不导航。
 *
 * @module session-messaging/client/apply
 */

import type { ClientContextLike, SessionNavigationLike } from './contract.ts'
import { createSessionMessageDefinition, SESSION_MESSAGE_NODE_KIND } from './definition.ts'
import { DICTIONARIES, NS } from './locale.ts'
import { SessionMessageView } from './SessionMessageView.tsx'
import { STYLE_TEXT } from './styles.ts'

/** 只在第一次发现导航能力缺失时提示一次，避免每点击一条消息就刷控制台。 */
let warnedNavigation = false

/**
 * 读取可选的会话导航服务。
 * @param ctx - 客户端插件上下文。
 * @returns 可用的导航服务；缺失或形状不对时 undefined。
 */
function navigationOf(ctx: ClientContextLike): SessionNavigationLike | undefined {
  const navigation = ctx.get('uiWorkspace') as Partial<SessionNavigationLike> | undefined
  return typeof navigation?.openSession === 'function' ? navigation as SessionNavigationLike : undefined
}

/**
 * 插槽声明顺序：Chat 的 View 与 Conversation 的注册表必须先存在。
 *
 * 这些是服务名而不是包名；包级加载顺序由 `package.json` 的 `dsh.client.inject`
 * 决定，两者不能互相替代。
 */
export const inject = ['slots', 'uiConversation', 'locale']

/**
 * 安装 UI 扩展。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-messaging: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['sessionMessaging'] = ''
    style.textContent = STYLE_TEXT
    document.head.append(style)
    return () => { style.remove() }
  }, 'session-messaging: styles')
  ctx.effect(
    () => ctx.uiConversation.events.register(createSessionMessageDefinition()),
    'session-messaging: conversation definition',
  )
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: SESSION_MESSAGE_NODE_KIND,
    locale: NS,
    // 导航服务是可选依赖：缺席时 canNavigate() 为 false，卡片退化为只读。
    inject: () => ({
      // 能力在每次渲染时读取：uiWorkspace 晚于本插件挂载也能生效。
      canNavigate: (): boolean => navigationOf(ctx) !== undefined,
      openSession: (sessionId: string): void => {
        const navigation = navigationOf(ctx)
        if (navigation === undefined) {
          if (!warnedNavigation) {
            warnedNavigation = true
            console.warn('[session-messaging] uiWorkspace.openSession 不可用：跨会话消息卡片只读')
          }
          return
        }
        try {
          navigation.openSession(sessionId)
        } catch {
          // 会话已归档或已被删除时保持当前视图；卡片本身已提供了可读的来源信息。
        }
      },
    }),
  }, SessionMessageView))
}
