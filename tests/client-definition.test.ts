/**
 * 跨会话消息的 Conversation 定义：认领范围、视图模型与 Chat 节点生成。
 *
 * 认领规则是本次 UI 的关键：内置 `input-message` 把非 `user` 来源的 user message
 * 当上下文行，必须由本定义用 `exclusive` 抢过来；抢多了会把人类消息变成卡片，
 * 抢少了又退回折叠行。用例覆盖这两种回归。
 */

import { describe, expect, it } from 'vitest'
import { createSessionMessageDefinition } from '../src/client/definition.ts'
import { frameOf } from '../src/client/source.ts'
import type {
  ConversationLocationLike, SessionEventLike, SessionMessageSource,
} from '../src/client/contract.ts'

/** 一条真实的转发 source。 */
const SOURCE: SessionMessageSource = {
  kind: 'session-message',
  form: 'relay',
  messageId: '54ba652e-db08-4ec0-a684-596cedc9819b',
  senderId: 'session-f0e0e0ce-226e-41e8-90a4-3ba97aa0f7f1',
  senderName: '测试会话智能体工具能力',
}

/** 构造一条本插件转发的 user message 事件。 */
function relayEvent(text: string, overrides: Partial<SessionMessageSource> = {}): SessionEventLike {
  const source = { ...SOURCE, ...overrides }
  return {
    type: 'user/message',
    seq: 8,
    time: 1_793_711_287_884,
    data: {
      id: 'd8fb7e14-0871-4156-8b0c-218ad6a7837b',
      role: 'user',
      content: [{ type: 'text', text: `${frameOf(source)}\n${text}` }],
      source,
    },
  }
}

const definition = createSessionMessageDefinition()

/** 一个 Step 位置（默认 Step 2：中途 steer）。 */
const location: ConversationLocationLike = { kind: 'step', turn: { turn: 1 }, step: { step: 2 } }

/**
 * 用一条事件跑完 start + buildViewNode。
 * @param event - 本插件转发的 user message。
 * @param at - 事件位置。
 * @returns 生成的视图模型与节点。
 */
function materialize(event: SessionEventLike, at: ConversationLocationLike = location) {
  const match = { event, role: 'start' as const, location: at }
  const context = { key: 'k', id: 'u1', state: undefined, start: match, matches: [match] }
  const state = definition.start(context, match)
  return { state, node: definition.buildViewNode({ ...context, state }) }
}

describe('session-message definition', () => {
  it('claims relay user messages exclusively', () => {
    expect(definition.match(relayEvent('正文'))).toEqual({
      id: 'd8fb7e14-0871-4156-8b0c-218ad6a7837b',
      role: 'start',
      exclusive: true,
    })
  })

  it('ignores human messages, notices, and non-message events', () => {
    const human = relayEvent('正文')
    ;(human.data as { source: unknown }).source = { kind: 'user' }
    expect(definition.match(human)).toBeNull()

    expect(definition.match({ ...relayEvent('正文'), type: 'agent/inbox/spliced' })).toBeNull()

    const notice = relayEvent('正文')
    ;(notice.data as { source: unknown }).source = { kind: 'session-message/notice' }
    expect(definition.match(notice)).toBeNull()
  })

  it('strips the frame and keeps the durable identity in the view model', () => {
    const { state } = materialize(relayEvent('正文内容'))
    expect(state.text).toBe('正文内容')
    expect(state.senderName).toBe(SOURCE.senderName)
    expect(state.messageId).toBe(SOURCE.messageId)
    expect(state.senderId).toBe(SOURCE.senderId)
  })

  it('publishes a visible Chat node anchored on the event seq', () => {
    const { state, node } = materialize(relayEvent('正文内容'))
    expect(node).toEqual({
      key: 'k',
      kind: 'session-message',
      id: 'u1',
      target: 'chat',
      anchorSeq: 8,
      location,
      visibility: 'visible',
      // Step 2：中途 steer 进来的消息留在当前流程里，不切折叠区间。
      groupTree: undefined,
      data: state,
    })
  })

  it('places a message that opens Step 1 at the input boundary', () => {
    const opening: ConversationLocationLike = { kind: 'step', turn: { turn: 1 }, step: { step: 1 } }
    expect(materialize(relayEvent('正文内容'), opening).node?.groupTree).toBe('input')
  })

  it('falls back to the first match location when the start is not loaded', () => {
    const event = relayEvent('正文内容')
    const match = { event, role: 'start' as const, location }
    const state = definition.start(
      { key: 'k', id: 'u1', state: undefined, start: match, matches: [match] },
      match,
    )
    expect(definition.buildViewNode({
      key: 'k', id: 'u1', state, start: undefined, matches: [match],
    })?.location).toEqual(location)
  })

  it('renders nothing when the context has no state', () => {
    expect(definition.buildViewNode({
      key: 'k', id: 'u1', state: undefined, start: undefined, matches: [],
    })).toBeNull()
  })
})
