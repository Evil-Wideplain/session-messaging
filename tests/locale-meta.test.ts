/**
 * 插件页显示文案：包根 locale 提供插件（组合包）与主行组件的标题/描述，
 * 子路径 locale 提供 `session-creation` 组件的标题/描述；两者都必须通过
 * package.json 的 exports 暴露给 Loader 的元信息读取器。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Meta {
  readonly title?: string
  readonly description?: string
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', relative), 'utf8')) as Record<string, unknown>
}

function metaOf(relative: string): Meta {
  return readJson(relative)['meta'] as Meta
}

describe('plugin display metadata', () => {
  it('gives the plugin and its main row a localized title and description', () => {
    for (const language of ['en', 'zh'] as const) {
      const meta = metaOf(`locale/${language}.json`)
      expect(meta.title).toBe('session-messaging')
      expect(meta.description?.trim()).not.toBe('')
    }
  })

  it('gives the session-creation row its own localized title and description', () => {
    for (const language of ['en', 'zh'] as const) {
      const meta = metaOf(`locale/creation/${language}.json`)
      expect(meta.title).toBe('session-creation')
      expect(meta.description?.trim()).not.toBe('')
    }
  })

  it('exports both locale trees for the Loader to resolve', () => {
    const pkg = readJson('package.json')
    const exports = pkg['exports'] as Record<string, string>
    expect(exports['./locale/*.json']).toBe('./locale/*.json')
    expect(exports['./creation/locale/*.json']).toBe('./locale/creation/*.json')
    expect((pkg['files'] as string[]).includes('locale/**/*.json')).toBe(true)
  })
})
