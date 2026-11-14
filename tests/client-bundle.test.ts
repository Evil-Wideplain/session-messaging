/**
 * 构建产物级用例：`lib/client.js` 必须能被 DSH 的客户端模块加载器接受。
 *
 * 客户端模块不是普通 ESM——它是一段调用 `window.__ModuleLoader__.load()` 的
 * 脚本，由 factory 的 `require` 取 React，并返回带 `apply`/`inject` 的插件对象。
 * 这些约定无法靠 tsc 类型检查发现，所以在 VM 里跑一遍真实产物：校验模块 id、
 * 导出形状、注册的插槽键，以及 Conversation 定义确实只认领本插件的转发消息。
 *
 * 依赖 `npm run build` 先产出 `lib/client.js`（`npm test` 已包含构建）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/** 读取构建产物。 */
function clientBundle(): string {
  return readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
}

/** 一个足够让 bundle 装配、但不渲染的 React 桩。 */
const react = {
  createElement: () => null,
  useState: <T,>(value: T | (() => T)): [T, () => void] => [typeof value === 'function' ? (value as () => T)() : value, () => {}],
  useEffect: () => {},
  useCallback: <F,>(fn: F): F => fn,
  useRef: <T,>(value: T) => ({ current: value }),
}

/** jsx-runtime 桩：本用例只装配，不渲染。 */
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }

/** 一次装配收集到的副作用与注册。 */
interface Harness {
  readonly moduleId: string
  readonly exported: { apply(ctx: unknown): void; inject: readonly string[] }
  readonly effects: { label: string | undefined }[]
  readonly styles: { text: string }[]
  readonly slots: {
    owner?: string
    options?: Record<string, unknown>
    component?: unknown
    inject?: () => Record<string, unknown>
  }
  readonly conversation: { namespace?: string; definition?: Record<string, unknown> }
}

/**
 * 在隔离的 VM 上下文里执行客户端产物并调用 `apply()`。
 * @returns 模块 id、导出对象与注册结果。
 */
function runBundle(): Harness {
  let captured: { id: string; factory(require: (id: string) => unknown): unknown } | undefined
  const effects: { label: string | undefined }[] = []
  const styles: { text: string }[] = []
  const slots: Harness['slots'] = {}
  const conversation: Harness['conversation'] = {}

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition: typeof captured) => { captured = definition },
      },
      getSelection: () => null,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    document: {
      head: { append: (element: { textContent: string }) => { styles.push({ text: element.textContent }) } },
      createElement: () => ({
        dataset: {} as Record<string, string>,
        textContent: '',
        remove: () => {},
      }),
    },
    navigator: { clipboard: { writeText: async () => {} } },
  }
  vm.runInNewContext(clientBundle(), sandbox)

  const loaded = captured
  if (loaded === undefined) throw new Error('客户端产物没有调用 window.__ModuleLoader__.load()')
  const exported = loaded.factory(id => (id === 'react' ? react : jsxRuntime)) as Harness['exported']

  exported.apply({
    effect(create: () => (() => void) | void, label?: string) {
      create()
      effects.push({ label })
      return () => {}
    },
    get: () => undefined,
    locale: {
      register(namespace: string) {
        conversation.namespace = namespace
        return () => {}
      },
    },
    slots: {
      inject(owner: string, install: () => unknown) {
        slots.owner = owner
        install()
      },
      register(options: Record<string, unknown>, component: unknown) {
        slots.options = options
        slots.component = component
        return () => {}
      },
    },
    uiConversation: {
      events: {
        register(definition: Record<string, unknown>) {
          conversation.definition = definition
          return () => {}
        },
      },
    },
  })

  return { moduleId: loaded.id, exported, effects, styles, slots, conversation }
}

describe('built client module', () => {
  it('declares the package module id and the plugin effects', () => {
    const harness = runBundle()
    expect(harness.moduleId).toBe('session-messaging')
    expect(harness.exported.inject).toEqual(['slots', 'uiConversation', 'locale'])
    expect(harness.effects.map(effect => effect.label)).toEqual([
      'session-messaging: locale',
      'session-messaging: styles',
      'session-messaging: conversation definition',
    ])
    expect(harness.styles).toHaveLength(1)
    // 样式表是纯字符串，断言关键钩子存在，避免 CSS 笔误只能靠肉眼发现。
    expect(harness.styles[0]?.text).toContain('[data-dsm-clickable]')
    expect(harness.styles[0]?.text).toContain('--dsw-specific-bubble')
  })

  it('registers the keyed Chat renderer and the message definition', () => {
    const harness = runBundle()
    expect(harness.slots.owner).toBe('conversation.chat.node')
    expect(harness.slots.options?.['key']).toBe('session-message')
    expect(harness.slots.options?.['locale']).toBe('session-messaging-ui')
    expect(typeof harness.slots.component).toBe('function')
    expect(harness.slots.options?.['inject']).toBeTypeOf('function')
    // 没有 uiWorkspace 时导航能力必须如实报告不可用，而不是给一个空实现。
    const injected = (harness.slots.options?.['inject'] as () => Record<string, unknown>)()
    expect(injected['canNavigate']).toBeTypeOf('function')
    expect((injected['canNavigate'] as () => boolean)()).toBe(false)
    expect(injected['openSession']).toBeTypeOf('function')
    expect(harness.conversation.definition?.['kind']).toBe('session-message')
    expect(harness.conversation.definition?.['target']).toBe('chat')
  })

  it('claims only relay messages and strips the model-facing frame', () => {
    const harness = runBundle()
    const definition = harness.conversation.definition as {
      match(event: unknown): unknown
      start(context: unknown, match: unknown): { text: string; senderName: string }
    }
    const source = {
      kind: 'session-message', form: 'relay', messageId: 'm1',
      senderId: 'session-abc', senderName: '前端联调',
    }
    const event = {
      type: 'user/message',
      seq: 3,
      time: 1,
      data: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: `Session message m1 from 前端联调 (session-abc):\n正文` }],
        source,
      },
    }
    expect(definition.match(event)).toEqual({ id: 'u1', role: 'start', exclusive: true })
    const state = definition.start({}, { event, role: 'start', location: { kind: 'unresolved' } })
    expect(state.text).toBe('正文')
    expect(state.senderName).toBe('前端联调')
  })
})
