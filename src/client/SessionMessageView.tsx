/**
 * 跨会话消息卡片（React 组件）。
 *
 * 这是本插件唯一的可视化组件：它只负责把 {@link SessionMessageViewModel} 画成
 * 与 Chat 用户气泡同形、但带强调色竖条与来源行的卡片，并把「打开会话」与
 * 「复制」两个动作委托给注入的 props。数据折叠、事件认领都在 `definition.ts`，
 * 样式在 `styles.ts`，组件本身不读全局状态、不发请求。
 *
 * 交互约定：
 * - 点击气泡（鼠标/触屏）延迟约 300ms 才导航：双击选词时第二次点击会取消它，
 *   选区落在卡片内时也不导航——复制正文优先于跳转。
 * - 键盘与读屏用户走来源行右侧的「打开会话」按钮，按钮立即导航。
 * - 「复制」是卡片下方的独立按钮，三态（复制/已复制/复制失败）带 live region。
 *
 * @module session-messaging/client/SessionMessageView
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { SessionMessageViewModel, Translate } from './contract.ts'
import { CopyGlyph, InboxGlyph, OpenGlyph, StateGlyph } from './icons.tsx'
import { clockText, isNavigableSessionId, shortSessionId } from './source.ts'

/** 单击气泡后等待的时间（毫秒）；双击的第二次点击会在此之前取消导航。 */
const NAVIGATE_DELAY_MS = 300

/** 复制反馈的展示时长（毫秒）。 */
const COPY_FEEDBACK_MS = 1600

/** 复制按钮的三态。 */
type CopyState = 'idle' | 'copied' | 'failed'

/** 组件从插槽座位拿到的 props（Node、locale 座位与注入的导航能力）。 */
export interface SessionMessageViewProps {
  /** 键控 Chat 渲染器收到的节点；只消费 data。 */
  readonly node: { readonly data: SessionMessageViewModel }
  /** locale 座位；未注册命名空间时会退回键名。 */
  readonly t: Translate
  /** 导航服务当前是否可用；每次渲染读取，服务晚到也能生效。 */
  readonly canNavigate: () => boolean
  /** 注入的导航动作。 */
  readonly openSession: (sessionId: string) => void
}

/**
 * 渲染一条跨会话消息。
 * @param props - 节点数据、locale 座位与导航能力。
 * @returns 右对齐的强调色气泡。
 */
export function SessionMessageView({ node, t, canNavigate, openSession }: SessionMessageViewProps): ReactNode {
  const data = node.data
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const card = useRef<HTMLDivElement>(null)
  const navigateTimer = useRef<number | undefined>(undefined)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current)
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
  }, [])

  const navigate = useCallback((): void => {
    if (!isNavigableSessionId(data.senderId)) return
    if (!canNavigate()) return
    openSession(data.senderId)
  }, [canNavigate, data.senderId, openSession])

  const clearNavigateTimer = useCallback((): void => {
    if (navigateTimer.current === undefined) return
    window.clearTimeout(navigateTimer.current)
    navigateTimer.current = undefined
  }, [])

  const copy = useCallback((): void => {
    if (data.text === '') return
    const announce = (state: CopyState): void => {
      setCopyState(state)
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopyState('idle') }, COPY_FEEDBACK_MS)
    }
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      announce('failed')
      return
    }
    clipboard.writeText(data.text).then(() => { announce('copied') }).catch(() => { announce('failed') })
  }, [data.text])

  const navigable = data.senderId !== '' && canNavigate()
  const sender = data.senderName.trim() === '' ? shortSessionId(data.senderId) : data.senderName
  const idLabel = shortSessionId(data.senderId)
  const showId = idLabel !== '' && idLabel !== sender
  const label = t('label')

  /**
   * 点击气泡：选区落在卡片内、或这是双击的一部分时不导航。
   * 延迟导航是为了让第二次点击的 `dblclick` 能取消它。
   * @param event - 鼠标点击事件。
   */
  const onCardClick = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (!navigable) return
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed
      && (card.current?.contains(selection.anchorNode) === true || card.current?.contains(selection.focusNode) === true)) {
      return
    }
    // 双击的第一次 click 已经进入这里；等一小会儿，让 dblclick 有机会取消。
    if (event.detail > 1) {
      clearNavigateTimer()
      return
    }
    clearNavigateTimer()
    navigateTimer.current = window.setTimeout(() => {
      navigateTimer.current = undefined
      navigate()
    }, NAVIGATE_DELAY_MS)
  }, [clearNavigateTimer, navigate, navigable])

  const copyLabel = copyState === 'copied' ? t('copied') : copyState === 'failed' ? t('copyFailed') : t('copy')

  return (
    <div className="dsm-row" data-dsm-row="">
      <div className="dsm-stack">
        <div
          ref={card}
          className="dsm-card"
          {...navigable ? { 'data-dsm-clickable': '', onClick: onCardClick, onDoubleClick: clearNavigateTimer } : {}}
        >
          <div className="dsm-head" data-dsm-head="">
            <span className="dsm-glyph"><InboxGlyph /></span>
            <span className="dsm-sender" data-dsm-sender="">{sender}</span>
            {showId && <span className="dsm-id" data-dsm-id="" aria-hidden="true" title={data.senderId}>{idLabel}</span>}
            {navigable && (
              <button
                type="button"
                className="dsm-open"
                data-dsm-open=""
                aria-label={`${label}: ${sender} — ${t('open')}`}
                onClick={(event) => {
                  event.stopPropagation()
                  clearNavigateTimer()
                  navigate()
                }}
              >
                <span className="dsm-open-text">{t('open')}</span>
                <OpenGlyph />
              </button>
            )}
          </div>
          {data.summary !== undefined && data.summary.trim() !== '' && (
            <div className="dsm-summary" data-dsm-summary="">{data.summary}</div>
          )}
          {data.text !== '' && (
            <div className="dsm-body" data-dsm-body="" data-text-interaction-source="">{data.text}</div>
          )}
        </div>
        <div className="dsm-actions" data-dsm-actions="">
          <span className="dsm-time" data-dsm-time="">{clockText(data.time, t)}</span>
          {data.text !== '' && (
            <button
              type="button"
              className="dsm-action"
              data-dsm-action="copy"
              data-dsm-copy=""
              data-state={copyState === 'idle' ? undefined : copyState}
              aria-label={copyLabel}
              title={copyLabel}
              onClick={copy}
            >
              {copyState === 'idle' ? <CopyGlyph /> : <StateGlyph failed={copyState === 'failed'} />}
            </button>
          )}
          <span className="dsm-sr" role="status" aria-live="polite">
            {copyState === 'idle' ? '' : copyLabel}
          </span>
        </div>
      </div>
    </div>
  )
}
