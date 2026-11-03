/**
 * `CordisWorkspaceResolver`：按 id/路径解析工作区，以及 ensure 的目录创建与登记语义。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceView } from '../src/types.ts'
import { CordisWorkspaceResolver } from '../src/infrastructure/cordis-workspace-resolver.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-ws-'))
  tempDirs.push(dir)
  return dir
}

function view(id: string, path: string, title?: string): WorkspaceView {
  return {
    id,
    path,
    ...title === undefined ? {} : { title },
    sessionIds: [],
    attachSession: async () => {},
  }
}

function resolverHarness(options: {
  readonly byId?: Map<string, WorkspaceView>
  readonly byPath?: Map<string, WorkspaceView>
  readonly created?: WorkspaceView
  readonly pathThrows?: boolean
  /** 让 `resolveByPath` 抛指定错误（用于区分「目录不存在」和别的故障）。 */
  readonly pathError?: Error
  readonly noRegistry?: boolean
  readonly noCreate?: boolean
} = {}) {
  const created: string[] = []
  const registry = {
    archivedSessionIds: [],
    get: (id: string) => options.byId?.get(id),
    async resolveByPath(path: string) {
      if (options.pathError !== undefined) throw options.pathError
      if (options.pathThrows === true) throw new Error('ENOENT')
      return options.byPath?.get(path)
    },
    ...options.noCreate === true ? {} : {
      async create(path: string) {
        created.push(path)
        return options.created ?? view('ws-created', path)
      },
    },
  }
  const ctx = {
    get: (name: string) => name === 'workspaceRegistry' && options.noRegistry !== true ? registry : undefined,
  } as unknown as Context
  return { resolver: new CordisWorkspaceResolver(ctx, () => {}), created }
}

describe('CordisWorkspaceResolver', () => {
  it('按 id 解析已登记工作区', async () => {
    const path = join(tempDir(), 'main')
    const target = view('ws-1', path, '主工作区')
    const { resolver } = resolverHarness({ byId: new Map([['ws-1', target]]) })
    await expect(resolver.resolve('ws-1')).resolves.toEqual({ id: 'ws-1', path, title: '主工作区' })
  })

  it('按绝对路径解析，并按末段补缺省标题', async () => {
    const path = join(tempDir(), 'main')
    const target = view('ws-1', path)
    const { resolver } = resolverHarness({ byPath: new Map([[target.path, target]]) })
    const resolved = await resolver.resolve(target.path)
    expect(resolved).toEqual({ id: 'ws-1', path, title: 'main' })
  })

  it('未登记或目录不存在时返回 undefined', async () => {
    const { resolver } = resolverHarness({ pathThrows: true })
    await expect(resolver.resolve(join(tempDir(), 'missing'))).resolves.toBeUndefined()
    await expect(resolver.resolve('ws-unknown')).resolves.toBeUndefined()
  })

  it('ensure 对已登记目录直接复用，不重复登记', async () => {
    const target = view('ws-1', join(tempDir(), 'main'))
    const { resolver, created } = resolverHarness({ byPath: new Map([[target.path, target]]) })
    const ensured = await resolver.ensure(target.path)
    expect(ensured.id).toBe('ws-1')
    expect(created).toEqual([])
  })

  it('ensure 创建缺失目录后登记', async () => {
    const path = join(tempDir(), 'nested', 'project')
    const { resolver, created } = resolverHarness({
      pathThrows: true,
      created: view('ws-created', path, 'project'),
    })
    const ensured = await resolver.ensure(path)
    expect(ensured).toMatchObject({ id: 'ws-created', path, title: 'project' })
    expect(created).toEqual([path])
  })

  it('ensure 拒绝非绝对路径', async () => {
    const { resolver } = resolverHarness()
    await expect(resolver.ensure('relative/dir')).rejects.toThrow(/必须是绝对路径/u)
  })

  it('没有 workspaceRegistry 服务时给出可诊断错误', async () => {
    const { resolver } = resolverHarness({ noRegistry: true })
    await expect(resolver.resolve('ws-1')).rejects.toThrow(/没有 workspaceRegistry 服务/u)
    await expect(resolver.ensure(join(tempDir(), 'main'))).rejects.toThrow(/没有 workspaceRegistry 服务/u)
  })

  it('注册表不支持 create 时 ensure 失败', async () => {
    const { resolver } = resolverHarness({ noCreate: true, pathThrows: true })
    await expect(resolver.ensure(join(tempDir(), 'main'))).rejects.toThrow(/不支持登记工作区/u)
  })

  it('注册表不支持 create 时，已登记目录的 ensure 仍然幂等返回', async () => {
    const target = view('ws-1', join(tempDir(), 'main'))
    const { resolver, created } = resolverHarness({
      noCreate: true,
      byPath: new Map([[target.path, target]]),
    })
    const ensured = await resolver.ensure(target.path)
    expect(ensured.id).toBe('ws-1')
    expect(created).toEqual([])
  })

  it('注册表读取失败（非目录不存在）时向上抛，不伪装成未登记', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const { resolver } = resolverHarness({ pathError: denied })
    await expect(resolver.resolve(join(tempDir(), 'main'))).rejects.toThrow(/EACCES/u)
    await expect(resolver.ensure(join(tempDir(), 'main'))).rejects.toThrow(/EACCES/u)
  })
})
