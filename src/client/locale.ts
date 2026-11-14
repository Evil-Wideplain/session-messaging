/**
 * 浏览器端文案字典。
 *
 * 客户端 locale 与 Host 的插件页 locale 是两套资源：前者注册进
 * `ctx.locale` 供 React 组件取词，后者由 Loader 读取用于插件页标题/描述。
 * 这里只放 UI 里真正出现的短句，键名保持稳定，翻译缺口由英文字典兜底。
 *
 * @module session-messaging/client/locale
 */

/** 本插件在客户端 locale 注册表里的命名空间。 */
export const NS = 'session-messaging-ui'

/** 本插件 UI 用到的字典键。 */
export type SessionMessagingUiKey = 'label' | 'open' | 'copy' | 'copied' | 'copyFailed' | 'clock.md' | 'clock.ymd'

/** 英文字典（locale 的基线兜底）。 */
const EN: Readonly<Record<SessionMessagingUiKey, string>> = {
  label: 'Session message',
  open: 'Open session',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  'clock.md': '{m}/{d}',
  'clock.ymd': '{y}-{m}-{d}',
}

/** 中文字典。 */
const ZH: Readonly<Record<SessionMessagingUiKey, string>> = {
  label: '跨会话消息',
  open: '打开会话',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败',
  'clock.md': '{m}月{d}日',
  'clock.ymd': '{y}年{m}月{d}日',
}

/** 交给 `ctx.locale.register()` 的字典集合。 */
export const DICTIONARIES = { en: EN, zh: ZH } as const
