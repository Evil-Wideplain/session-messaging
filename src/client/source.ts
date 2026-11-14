/**
 * 来源框架与正文的纯函数（表现层数据整理）。
 *
 * Host 端为了让模型知道「这条 user message 不是人类发的」，会把来源框架写进
 * 正文：`Session message <messageId> from <senderName> (<senderId>):`。UI 不能再
 * 显示这一行（它会占满气泡、看起来像人类写的怪话），但也不能改写入库内容——
 * 模型、fork、resume 都依赖原文。因此展示层按 source 里的字段精确重建框架并
 * 剥离；重建失败时原样返回，宁可多显示一行，也不吞正文。
 *
 * @module session-messaging/client/source
 */

import type { SessionMessageSource, Translate } from './contract.ts'

/** 本插件转发的 user message 的 source 类型。 */
export const SESSION_MESSAGE_KIND = 'session-message'

/** 短会话 id 的显示长度（去掉 `session-` 前缀后的字符数）。 */
const SHORT_ID_LENGTH = 8

/**
 * 判断一个 source 是否为本插件写入的转发消息。
 * @param value - 未收敛的 event.data.source。
 * @returns 是转发消息时返回类型收窄后的 source。
 */
export function isSessionMessageSource(value: unknown): value is SessionMessageSource {
  if (typeof value !== 'object' || value === null) return false
  const source = value as Record<string, unknown>
  return source['kind'] === SESSION_MESSAGE_KIND
    && typeof source['messageId'] === 'string'
    && typeof source['senderId'] === 'string'
    && typeof source['senderName'] === 'string'
    && (source['summary'] === undefined || typeof source['summary'] === 'string')
}

/**
 * 重建 Host 端写入正文的来源框架（不含换行）。
 *
 * 格式与 `src/domain/message.ts` 的 `frameOf()` 严格一致；两处必须同步修改，
 * 否则 UI 会退化成一整条带 UUID 的原文。
 * @param source - 转发消息的来源信息。
 * @returns 单行框架文本。
 */
export function frameOf(source: SessionMessageSource): string {
  return `Session message ${source.messageId} from ${source.senderName} (${source.senderId}):`
}

/**
 * 从正文里剥离来源框架。
 * @param source - 转发消息的来源信息。
 * @param text - 入库的完整正文。
 * @returns 用户真正想看到的正文。
 */
export function stripSessionFrame(source: SessionMessageSource, text: string): string {
  const frame = frameOf(source)
  for (const separator of ['\r\n', '\n'] as const) {
    if (text.startsWith(frame + separator)) return text.slice(frame.length + separator.length)
  }
  return text.startsWith(frame) ? text.slice(frame.length) : text
}

/**
 * 从消息内容块里拼出纯文本正文。
 * @param content - `user/message` 的 content 块数组。
 * @returns 各 text 块按顺序拼接的结果。
 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('')
}

/**
 * 判断一个来源会话标识是否值得交给导航服务。
 *
 * 只做形状校验（非空、长度上限、不含空白），不解码 id 结构：会话 id 的具体形态
 * 由 DSH 决定，插件多校验一种格式就多一处版本耦合。
 * @param value - durable source 上的 senderId。
 * @returns 可以尝试导航时为 true。
 */
export function isNavigableSessionId(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 200 && !/\s/.test(trimmed)
}

/**
 * 取会话 id 的短形式用于紧凑显示。
 * @param sessionId - 完整会话标识（`session-<uuid>` 或裸 uuid）。
 * @returns 去掉前缀后的前 8 个字符；过短的 id 原样返回。
 */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.length > SHORT_ID_LENGTH ? bare.slice(0, SHORT_ID_LENGTH) : bare
}

/**
 * 读取 locale 模板；键未注册时返回 undefined，由调用方用兜底格式。
 * @param translate - locale 座位。
 * @param key - 模板键。
 * @param params - 年月日占位符。
 * @returns 模板文本；缺失时 undefined。
 */
function template(
  translate: Translate | undefined,
  key: 'clock.md' | 'clock.ymd',
  params: { y: number; m: number; d: number },
): string | undefined {
  if (translate === undefined) return undefined
  const text = translate(key, params)
  return text === key || text === '' ? undefined : text
}

/**
 * 把事件时间格式化成紧凑的本地时钟。
 *
 * 与 Chat 的消息时间一致：同一天只显示 `HH:mm`，跨天补日期、跨年补年份；
 * 日期模板与 Chat 的 `clock.md` / `clock.ymd` 对齐（中英文各一份），其它语言
 * 回退到英文模板，避免出现 DSH 用户消息里没有的 ISO 日期样式。
 * @param time - Unix 毫秒。
 * @param translate - locale 座位；缺席时使用英文模板兜底。
 * @param now - 参照时刻（默认当前时间，测试可注入）。
 * @returns 本地时区的时间文本。
 */
export function clockText(time: number, translate?: Translate, now: number = Date.now()): string {
  const date = new Date(time)
  const reference = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
  if (date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate()) {
    return clock
  }
  const day = date.getFullYear() === reference.getFullYear()
    ? template(translate, 'clock.md', params) ?? `${params.m}/${params.d}`
    : template(translate, 'clock.ymd', params) ?? `${params.y}-${pad(params.m)}-${pad(params.d)}`
  return `${day} ${clock}`
}
