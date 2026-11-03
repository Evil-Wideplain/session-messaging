/**
 * 配置默认值、寻址归一化、消息接受判定、出站账本与授权规则。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../src/types.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { authorize, authorizeCwd, sameCwd } from '../src/domain/authorization.ts'
import { messageAccepted, relayMessage } from '../src/domain/message.ts'
import { displayName, normalizeAddress } from '../src/domain/target.ts'
import { JsonlOutboxRepository } from '../src/infrastructure/jsonl-outbox-repository.ts'
import { foldAgentOptions, foldTitle } from '../src/infrastructure/persisted-session.ts'
import { cleanupTempDirs, tempDir } from './support/common.ts'

afterEach(cleanupTempDirs)

describe('config', () => {
  it('applies documented defaults', () => {
    const config = resolveConfig(Config({}))
    expect(config.allowCrossWorkspace).toBe(false)
    expect(config.allowlist).toEqual([])
    expect(config.maxMessageBytes).toBe(64 * 1024)
    expect(config.maxPerMinute).toBe(20)
    expect(config.allowColdWake).toBe(true)
    expect(config.socketEnabled).toBe(true)
  })

  it('rejects a wrong-typed value', () => {
    expect(() => Config({ maxPerMinute: 'many' })).toThrow()
  })
})

describe('addressing', () => {
  it('normalizes quotes, case, and whitespace', () => {
    expect(normalizeAddress('  "Web App "')).toBe('web app')
    expect(normalizeAddress("'web   app'")).toBe('web app')
  })

  it('falls back to the short id when there is no title', () => {
    expect(displayName('abcdef123456', undefined)).toBe('session-abcdef12')
    expect(displayName('abcdef123456', 'Docs')).toBe('Docs')
  })

  it('folds the latest title and request route from a log', () => {
    const events = [
      { type: 'session/title', seq: 1, time: 1, data: { title: 'first' } },
      { type: 'session/title', seq: 2, time: 2, data: { title: 'second' } },
      { type: 'request/header', seq: 3, time: 3, data: { header: { config: { provider: 'p', model: 'm', maxTokens: 8 } } } },
    ]
    expect(foldTitle(events)).toBe('second')
    expect(foldAgentOptions(events)).toEqual({ provider: 'p', model: 'm', maxTokens: 8 })
  })
})

describe('message acceptance', () => {
  it('sees a message through the pending inbox splice', () => {
    const message = relayMessage('u1', 'hi', { messageId: 'm1', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [{
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    }]
    expect(messageAccepted(events, 'm1')).toBe(true)
    expect(messageAccepted(events, 'other')).toBe(false)
  })

  it('sees a message after it reached model history', () => {
    const message = relayMessage('u2', 'hi', { messageId: 'm2', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [{ type: 'user/message', seq: 1, time: 1, data: message }]
    expect(messageAccepted(events, 'm2')).toBe(true)
  })

  it('treats a claimed message as accepted even though the inbox is empty', () => {
    const message = relayMessage('u3', 'hi', { messageId: 'm3', senderId: 's', senderName: 'S' })
    const events: SessionEvent[] = [
      { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { target: 'next-step', start: 0, inserted: [message] } },
      { type: 'agent/inbox/spliced', seq: 2, time: 2, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: 3, time: 3, data: message },
    ]
    expect(messageAccepted(events, 'm3')).toBe(true)
  })
})

describe('outbox ledger', () => {
  it('keeps unconfirmed messages and drops confirmed ones', () => {
    const ledger = new JsonlOutboxRepository(tempDir(), 'sender-1')
    ledger.queue({ messageId: 'a', senderId: 'sender-1', senderName: 'S', targetId: 't', text: 'one', at: 1 })
    ledger.queue({ messageId: 'b', senderId: 'sender-1', senderName: 'S', targetId: 't', text: 'two', at: 2 })
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['a', 'b'])
    expect(ledger.pendingTo('t')).toBe(2)

    ledger.deliver('a')
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['b'])

    ledger.compact()
    expect(ledger.pending().map(entry => entry.messageId)).toEqual(['b'])
  })
})

describe('authorization', () => {
  const callerIdentity = { id: 'caller', cwd: 'C:/repo/app' }
  const row = (id: string, cwd: string | undefined, extra: { kind?: 'peer' | 'subagent'; parentSession?: string } = {}) => ({
    id,
    ...cwd === undefined ? {} : { cwd },
    ...extra.parentSession === undefined ? {} : { parentSession: extra.parentSession },
    status: 'offline' as const,
    kind: extra.kind ?? 'peer' as const,
  })

  it('compares working directories by segments with an explicit case rule', () => {
    expect(sameCwd('C:/repo/app', 'C:/repo/app/')).toBe(true)
    expect(sameCwd('C:/Repo/App', 'c:/repo/app')).toBe(false)
    expect(sameCwd('C:/Repo/App', 'c:/repo/app', true)).toBe(true)
    expect(sameCwd('C:/repo/../repo/app', 'C:/repo/app')).toBe(true)
    expect(sameCwd('', '')).toBe(false)
  })

  it('allows the same workspace and denies another by default', () => {
    expect(authorize(callerIdentity, row('same', 'C:/repo/app'), { allowCrossWorkspace: false, allowlist: [] }).allowed).toBe(true)
    const denied = authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: false, allowlist: [] })
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe('cross-workspace')
  })

  it('honors the switch, the allowlist, and direct subagent lineage', () => {
    expect(authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: true, allowlist: [] }).allowed).toBe(true)
    expect(authorize(callerIdentity, row('other', 'C:/repo/other'), { allowCrossWorkspace: false, allowlist: ['C:/repo'] }).allowed).toBe(true)
    expect(authorize(callerIdentity, row('kid', 'C:/repo/app', { kind: 'subagent', parentSession: 'caller' }), { allowCrossWorkspace: false, allowlist: [] }).allowed).toBe(true)
    const foreign = authorize(callerIdentity, row('kid', 'C:/repo/app', { kind: 'subagent', parentSession: 'someone' }), { allowCrossWorkspace: false, allowlist: [] })
    expect(foreign.code).toBe('subagent-of-other')
  })

  it('authorizes a creation cwd without faking a delivery target', () => {
    const policy = { allowCrossWorkspace: false, allowlist: [] }
    expect(authorizeCwd(callerIdentity, 'C:/repo/app/', policy).allowed).toBe(true)
    const denied = authorizeCwd(callerIdentity, 'C:/repo/other', policy)
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe('cross-workspace')
    expect(authorizeCwd(callerIdentity, 'C:/repo/other', { allowCrossWorkspace: true, allowlist: [] }).allowed).toBe(true)
    expect(authorizeCwd(callerIdentity, 'C:/repo/shared/web', { allowCrossWorkspace: false, allowlist: ['C:/repo/shared'] }).allowed).toBe(true)
    // allowlist 是目录前缀，`..` 不能把它变成越权跳板。
    expect(authorizeCwd(callerIdentity, 'C:/repo/shared/../secret', { allowCrossWorkspace: false, allowlist: ['C:/repo/shared'] }).allowed).toBe(false)
    // 大小写规则与投递侧一致（Windows 部署开启 pathCaseInsensitive）。
    const insensitive = { allowCrossWorkspace: false, allowlist: [], caseInsensitivePaths: true }
    expect(authorizeCwd(callerIdentity, 'c:/REPO/app', insensitive).allowed).toBe(true)
  })

  it('refuses self delivery', () => {
    expect(authorize(callerIdentity, { ...row('caller', 'C:/repo/app'), kind: 'peer' }, { allowCrossWorkspace: true, allowlist: [] }).code).toBe('self')
  })
})
