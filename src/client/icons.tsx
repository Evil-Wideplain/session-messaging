/**
 * 卡片用到的内联图标。
 *
 * 全部是 16×16 的描边 SVG，`currentColor` 跟随文字/强调色；`aria-hidden` 保证
 * 读屏只读文本，不读装饰图形。DSH 的基础图标库是宿主模块（本插件刻意不 import
 * 任何 `@deepseek-ai/dsh-client-*`），所以这几个小图形自绘。
 *
 * @module session-messaging/client/icons
 */

import type { ReactNode } from 'react'

/** 图标：收件箱，表示「别的会话发来的消息」。 */
export function InboxGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.75 3.5h10.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"
        fill="none" stroke="currentColor" strokeWidth="1.2"
      />
      <path d="M1.75 9h3l.85 1.35h4.8L11.25 9h3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** 图标：右上箭头，表示可以打开来源会话。 */
export function OpenGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M4.75 11.25 11.25 4.75M6.25 4.75h5v5"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** 图标：复制。 */
export function CopyGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.5 3.5v-.75A1.25 1.25 0 0 0 9.25 1.5H3.75A1.25 1.25 0 0 0 2.5 2.75v5.5A1.25 1.25 0 0 0 3.75 9.5h.75"
        fill="none" stroke="currentColor" strokeWidth="1.2"
      />
    </svg>
  )
}

/**
 * 图标：复制结果标记。
 * @param props - `failed` 为 true 时画叉，否则画对勾。
 * @returns 状态图标。
 */
export function StateGlyph({ failed }: { readonly failed: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d={failed ? 'M4.5 4.5l7 7M11.5 4.5l-7 7' : 'M3 8.5 6.5 12 13 4.5'}
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}
