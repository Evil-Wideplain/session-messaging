/**
 * 表现层纯函数：来源框架剥离、正文拼接、会话 id 与时间文本。
 *
 * 这些用例不碰 React、DOM 或 DSH 运行时——`source.ts` 是纯函数，直接用假数据
 * 驱动，保证「显示什么正文」「时间长什么样」这两条最容易出错的规则有回归保护。
 */

import { describe, expect, it } from 'vitest'
import {
  clockText, frameOf, isNavigableSessionId, isSessionMessageSource, shortSessionId, stripSessionFrame,
  textOfContent,
} from '../src/client/source.ts'
import type { SessionMessageSource } from '../src/client/contract.ts'

/** 一条真实的转发 source。 */
const SOURCE: SessionMessageSource = {
  kind: 'session-message',
  form: 'relay',
  messageId: '54ba652e-db08-4ec0-a684-596cedc9819b',
  senderId: 'session-f0e0e0ce-226e-41e8-90a4-3ba97aa0f7f1',
  senderName: '测试会话智能体工具能力',
}

describe('stripSessionFrame', () => {
  it('removes the exact frame Host wrote into the body', () => {
    const body = '这是一个工具能力测试。'
    expect(stripSessionFrame(SOURCE, `${frameOf(SOURCE)}\n${body}`)).toBe(body)
  })

  it('accepts CRLF after the frame', () => {
    expect(stripSessionFrame(SOURCE, `${frameOf(SOURCE)}\r\n${'多行正文'}`)).toBe('多行正文')
  })

  it('keeps the body when the frame does not match the source', () => {
    const text = `${frameOf({ ...SOURCE, senderName: '别人' })}\n正文`
    expect(stripSessionFrame(SOURCE, text)).toBe(text)
  })

  it('keeps a body that merely starts with the word "Session message"', () => {
    const text = 'Session message 不是框架，只是一句正文'
    expect(stripSessionFrame(SOURCE, text)).toBe(text)
  })
})

describe('isSessionMessageSource', () => {
  it('accepts a complete relay source', () => {
    expect(isSessionMessageSource(SOURCE)).toBe(true)
  })

  it('rejects other kinds and incomplete sources', () => {
    expect(isSessionMessageSource({ ...SOURCE, kind: 'user' })).toBe(false)
    expect(isSessionMessageSource({ ...SOURCE, senderId: undefined })).toBe(false)
    expect(isSessionMessageSource({ ...SOURCE, summary: 42 })).toBe(false)
    expect(isSessionMessageSource(null)).toBe(false)
  })
})

describe('textOfContent', () => {
  it('joins text blocks in order and ignores other block types', () => {
    expect(textOfContent([
      { type: 'text', text: '第一段' },
      { type: 'image', attachment: 'x' },
      { type: 'text', text: '第二段' },
    ])).toBe('第一段第二段')
  })

  it('tolerates malformed content', () => {
    expect(textOfContent(undefined)).toBe('')
    expect(textOfContent([null, { type: 'text' }, 3])).toBe('')
  })
})

describe('isNavigableSessionId', () => {
  it('accepts a durable session id', () => {
    expect(isNavigableSessionId('session-f0e0e0ce-226e-41e8-90a4-3ba97aa0f7f1')).toBe(true)
    expect(isNavigableSessionId('  abc  ')).toBe(true)
  })

  it('rejects empty, oversized, and whitespace-containing values', () => {
    expect(isNavigableSessionId('')).toBe(false)
    expect(isNavigableSessionId('   ')).toBe(false)
    expect(isNavigableSessionId('a'.repeat(201))).toBe(false)
    expect(isNavigableSessionId('a b')).toBe(false)
  })
})

describe('shortSessionId', () => {
  it('drops the session- prefix and keeps eight characters', () => {
    expect(shortSessionId('session-f0e0e0ce-226e-41e8-90a4-3ba97aa0f7f1')).toBe('f0e0e0ce')
    expect(shortSessionId('abc')).toBe('abc')
  })
})

describe('clockText', () => {
  it('shows only the clock for the same local day', () => {
    const time = new Date(2026, 10, 14, 9, 5).getTime()
    const now = new Date(2026, 10, 14, 18, 0).getTime()
    expect(clockText(time, undefined, now)).toBe('09:05')
  })

  it('adds the date for another day using the Chat template', () => {
    const time = new Date(2026, 10, 3, 21, 7).getTime()
    const now = new Date(2026, 10, 14, 18, 0).getTime()
    expect(clockText(time, undefined, now)).toBe('11/3 21:07')
    const zh = (key: string, params?: Readonly<Record<string, string | number>>): string =>
      key === 'clock.md' ? `${params?.['m']}月${params?.['d']}日` : key
    expect(clockText(time, zh, now)).toBe('11月3日 21:07')
  })

  it('adds the year for another year', () => {
    const time = new Date(2025, 11, 31, 23, 30).getTime()
    const now = new Date(2026, 0, 1, 0, 10).getTime()
    expect(clockText(time, undefined, now)).toBe('2025-12-31 23:30')
    const zh = (key: string, params?: Readonly<Record<string, string | number>>): string =>
      key === 'clock.ymd' ? `${params?.['y']}年${params?.['m']}月${params?.['d']}日` : key
    expect(clockText(time, zh, now)).toBe('2025年12月31日 23:30')
  })
})
