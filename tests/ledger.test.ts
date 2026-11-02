import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlInboundRepository } from '../src/infrastructure/jsonl-inbound-repository.ts'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-ledger-'))
  tempDirs.push(dir)
  return dir
}

/** 一条最小的出站条目。 */
function entry(messageId: string, targetId = 't'): {
  messageId: string
  senderId: string
  senderName: string
  targetId: string
  text: string
  at: number
} {
  return { messageId, senderId: 'sender-1', senderName: 'S', targetId, text: 'x', at: 1 }
}

describe('jsonl ledgers', () => {
  it('repairs a missing trailing newline before appending', () => {
    const dir = tempDir()
    const id = 'sender-1'
    const file = join(dir, `${id}.jsonl`)
    // 模拟崩溃留下的「最后一行没有换行」。
    writeFileSync(
      file,
      JSON.stringify({ op: 'queued', ...entry('a') }),
      'utf8',
    )

    const repo = new JsonlOutboxRepository(dir, id)
    repo.queue(entry('b'))

    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(repo.pending().map(item => item.messageId)).toEqual(['a', 'b'])
  })

  it('keeps the readable prefix when the last line is torn', () => {
    const dir = tempDir()
    const id = 'sender-2'
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(
      file,
      `${JSON.stringify({ op: 'queued', ...entry('a') })}\n{"op":"queued","mess`,
      'utf8',
    )

    const repo = new JsonlOutboxRepository(dir, id)
    expect(repo.pending().map(item => item.messageId)).toEqual(['a'])

    repo.queue(entry('b'))
    expect(repo.pending().map(item => item.messageId)).toEqual(['a', 'b'])
  })

  it('keeps held entries when the outbox compacts', () => {
    const dir = tempDir()
    const repo = new JsonlOutboxRepository(dir, 'sender-3')
    repo.queue(entry('a'))
    repo.hold(entry('b'))

    repo.compact()

    // held 也是「未确认」：压缩后它必须继续占用 pendingTo 的配额。
    expect(repo.pendingTo('t')).toBe(2)
    expect(repo.pending().map(item => item.messageId)).toEqual(['a'])
  })

  it('ignores an unknown op instead of treating it as terminal', () => {
    const dir = tempDir()
    const id = 'sender-4'
    const repo = new JsonlOutboxRepository(dir, id)
    repo.queue(entry('a'))
    appendFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ op: 'deliverd', messageId: 'a' })}\n`)

    expect(repo.pending().map(item => item.messageId)).toEqual(['a'])
  })

  it('compacts an inbound ledger without dropping live holds', () => {
    const dir = tempDir()
    const repo = new JsonlInboundRepository(dir, 'target-1')
    const now = Date.now()
    const base = { senderId: 's', senderName: 'S', targetId: 'target-1', text: 'x', at: now }
    repo.hold({ ...base, messageId: 'live', expiresAt: now + 60_000 })
    repo.hold({ ...base, messageId: 'old', expiresAt: now - 1 })
    repo.settle('expired', ['old'])

    repo.compact(now)

    expect(repo.held(now).map(item => item.messageId)).toEqual(['live'])
  })

  it('refuses a ledger id that could escape the directory', () => {
    const dir = tempDir()
    expect(() => new JsonlOutboxRepository(dir, '../escape')).toThrow()
    expect(() => new JsonlInboundRepository(dir, 'a/b')).toThrow()
    expect(() => new JsonlOutboxRepository(dir, '..')).toThrow()
  })
})
