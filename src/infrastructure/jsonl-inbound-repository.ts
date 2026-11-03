/**
 * JSONL 入站账本（基础设施层实现）。
 *
 * 对应 Claude Code 的入站 `accept / hold / refuse`：被挂起的消息停在这里，
 * 不进入目标会话；目标通过 `review_session_messages` 决定后写终态。
 *
 * ```text
 * {"op":"held","messageId":…,"senderId":…,"text":…,"expiresAt":…}
 * {"op":"accepted"|"refused"|"expired","messageId":…,"at":…}
 * ```
 *
 * `settle` 必须显式带上要裁决的 messageId 集合：缺省语义是「全部挂起消息」，
 * 用它来结算「本次刚过期的那些」会把尚未到期的消息一起删掉。
 *
 * @module session-messaging/infrastructure/jsonl-inbound-repository
 */

import type { HeldMessage, HeldVerdict } from '../domain/held-message.ts'
import type { InboundRepository } from '../application/ports.ts'
import { JsonlLedgerFile } from './jsonl-ledger.ts'

/** 已知终态；只有这些 op 才把消息移出挂起集合。 */
const TERMINAL_OPS: readonly HeldVerdict[] = ['accepted', 'refused', 'expired']

/** 单个目标会话的追加式 JSONL 入站账本。 */
export class JsonlInboundRepository implements InboundRepository {
  private readonly ledger: JsonlLedgerFile

  /**
   * @param dir - 存放 `<targetId>.jsonl` 的目录。
   * @param targetId - 归属会话。
   */
  constructor(dir: string, targetId: string) {
    this.ledger = new JsonlLedgerFile(dir, targetId, () => this.compact())
  }

  /** @inheritdoc */
  hold(message: HeldMessage): void {
    this.ledger.append({ op: 'held', ...message })
  }

  /** @inheritdoc */
  held(now = Date.now()): HeldMessage[] {
    return [...this.fold().values()].filter(message => message.expiresAt > now)
  }

  /** @inheritdoc */
  expired(now = Date.now()): HeldMessage[] {
    return [...this.fold().values()].filter(message => message.expiresAt <= now)
  }

  /** @inheritdoc */
  settle(verdict: HeldVerdict, ids?: readonly string[]): HeldMessage[] {
    const wanted = ids === undefined ? undefined : new Set(ids)
    const affected = [...this.fold().values()]
      .filter(message => wanted === undefined || wanted.has(message.messageId))
    const at = Date.now()
    for (const message of affected) this.ledger.append({ op: verdict, messageId: message.messageId, at })
    return affected
  }

  /** @inheritdoc */
  compact(now = Date.now()): void {
    const survivors = this.held(now).map(message => ({ op: 'held', ...message }))
    this.ledger.rewrite(survivors)
  }

  /** 折叠全部记录，返回当前挂起集合。 */
  private fold(): Map<string, HeldMessage> {
    const held = new Map<string, HeldMessage>()
    this.ledger.forEach((record) => {
      const messageId = record['messageId']
      if (typeof messageId !== 'string') return
      const op = record['op']
      if (op === 'held') {
        const { op: _op, ...message } = record
        held.set(messageId, message as unknown as HeldMessage)
        return
      }
      if (typeof op === 'string' && TERMINAL_OPS.includes(op as HeldVerdict)) held.delete(messageId)
    })
    return held
  }
}
