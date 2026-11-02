/**
 * bus 端点派生规则（infrastructure/paths）的单元测试。
 *
 * 重点是 Windows：命名管道名必须由 socketDir 决定，测试进程 / 第二个宿主才不会
 * 和正在运行的 GUI 抢同一条管道（`EADDRINUSE`）；同时同一目录必须在不同进程间
 * 稳定得到同一个端点。POSIX 的 `<dir>/bus.sock` 形式保持不变。
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busEndpoint, defaultSocketDir } from '../src/infrastructure/paths.ts'

const isWindows = process.platform === 'win32'
/** Windows 命名管道命名空间的字面前缀 `\\.\pipe\`。 */
const PIPE_ROOT = '\\\\.\\pipe\\'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-paths-'))
  tempDirs.push(dir)
  return dir
}

/** 端点名里应有的用户标识，与 paths.ts 的 userId() 规则一致。 */
function expectedUser(): string {
  const getuid = process.getuid
  return typeof getuid === 'function' ? String(getuid()) : 'win'
}

/** 契约规定的哈希：sha256(规范化绝对路径) 的前 8 个十六进制字符。 */
function expectedHash(dir: string): string {
  const absolute = resolve(dir)
  const normalized = isWindows ? absolute.toLowerCase() : absolute
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8)
}

describe('busEndpoint', () => {
  it.skipIf(isWindows)('keeps the socket file inside the directory on POSIX', () => {
    const dir = tempDir()
    expect(busEndpoint(dir)).toBe(join(dir, 'bus.sock'))
  })

  it.skipIf(!isWindows)('names a per-directory pipe on Windows', () => {
    const dir = tempDir()
    const endpoint = busEndpoint(dir)

    expect(endpoint).toBe(`${PIPE_ROOT}dsh-session-messaging-${expectedUser()}-${expectedHash(dir)}`)
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\dsh-session-messaging-[a-z0-9]+-[0-9a-f]{8}$/)
  })

  it('is stable for one directory and distinct across directories', () => {
    const first = tempDir()
    const second = tempDir()

    expect(busEndpoint(first)).toBe(busEndpoint(first))
    expect(busEndpoint(first)).not.toBe(busEndpoint(second))
  })

  it('normalizes the same directory spelled differently', () => {
    const dir = tempDir()
    const endpoint = busEndpoint(dir)

    expect(busEndpoint(join(dir, '.'))).toBe(endpoint)
    expect(busEndpoint(`${resolve(dir)}${sep}`)).toBe(endpoint)
  })

  it('treats Windows paths case-insensitively (and POSIX paths case-sensitively)', () => {
    const dir = tempDir()
    const lower = dir.toLowerCase()
    const upper = dir.toUpperCase()

    if (isWindows) expect(busEndpoint(lower)).toBe(busEndpoint(upper))
    else expect(busEndpoint(lower)).not.toBe(busEndpoint(upper))
  })

  it('keeps the default socket directory per user under the temp directory', () => {
    expect(defaultSocketDir()).toBe(join(tmpdir(), `dsh-session-messaging-${expectedUser()}`))
  })
})
