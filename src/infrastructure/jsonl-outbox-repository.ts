/**
 * JSONL 出站账本（基础设施层实现）。
 *
 * 自定义 Session 事件类型无法安全写进会话日志（恢复读路径会拒绝未知类型），
 * 因此发送方账本落在插件自己的 JSONL 文件里：
 *
 * ```text
 * {"op":"queued","messageId":…,"senderId":…,"targetId":…,"text":…,"at":…}
 * {"op":"held","messageId":…,"expiresAt":…}
 * {"op":"delivered"|"expired"|"refused","messageId":…,"at":…}
 * ```
 *
 * `queued` 可重放；`held` 归接收方入站账本，不参与发送方重放，但必须保留在
 * 账本里——否则 `pendingTo()` 会低估该目标名下的未确认消息，`maxPendingPerTarget`
 * 形同虚设。已知终态（delivered/expired/refused）才把记录移出账本；未知 op 忽略，
 * 避免拼错或未来新增的 op 把消息错误地当成已终结。
 *
 * @module dsh-plugin-session-messaging/infrastructure/jsonl-outbox-repository
 */

import type { OutboxEntry } from '../domain/outbox.ts'
import type { OutboxAck } from '../domain/outbox.ts'
import type { OutboxRepository } from '../application/ports.ts'
import { JsonlLedgerFile } from './jsonl-ledger.ts'

/** 仍留在账本里的记录：可重放的排队项，或等待目标审批的挂起项。 */
type OpenEntry = { readonly op: 'queued' | 'held' } & OutboxEntry

/** 已知终态；只有这些 op 才把消息移出账本。 */
const TERMINAL_OPS: readonly OutboxAck[] = ['delivered', 'expired', 'refused']

/** 单个发送方的追加式 JSONL 账本。 */
export class JsonlOutboxRepository implements OutboxRepository {
  private readonly ledger: JsonlLedgerFile

  /**
   * @param dir - 存放 `<senderId>.jsonl` 的目录。
   * @param senderId - 归属会话。
   */
  constructor(dir: string, senderId: string) {
    this.ledger = new JsonlLedgerFile(dir, senderId, () => this.compact())
  }

  /** @inheritdoc */
  queue(entry: OutboxEntry): void {
    this.ledger.append({ op: 'queued', ...entry })
  }

  /** @inheritdoc */
  hold(entry: OutboxEntry): void {
    this.ledger.append({ op: 'held', ...entry })
  }

  /** @inheritdoc */
  deliver(messageId: string): void {
    this.ledger.append({ op: 'delivered', messageId, at: Date.now() })
  }

  /** @inheritdoc */
  ack(messageId: string, verdict: Exclude<OutboxAck, 'delivered'>): void {
    this.ledger.append({ op: verdict, messageId, at: Date.now() })
  }

  /** @inheritdoc */
  pending(): OutboxEntry[] {
    return [...this.fold().values()]
      .filter(entry => entry.op === 'queued')
      .map(entry => entryOf(entry))
  }

  /** @inheritdoc */
  pendingTo(targetId: string): number {
    let count = 0
    for (const entry of this.fold().values()) {
      if (entry.targetId === targetId) count += 1
    }
    return count
  }

  /** @inheritdoc */
  compact(): void {
    // queued 与 held 都要保留：held 在目标审批之前同样是「未确认」。
    const survivors = [...this.fold().values()].map(entry => ({ op: entry.op, ...entryOf(entry) }))
    this.ledger.rewrite(survivors)
  }

  /** 折叠全部记录，得到仍未确认的消息（按 messageId 去重，后写覆盖先写）。 */
  private fold(): Map<string, OpenEntry> {
    const open = new Map<string, OpenEntry>()
    this.ledger.forEach((record) => {
      const messageId = record['messageId']
      if (typeof messageId !== 'string') return
      const op = record['op']
      if (op === 'queued' || op === 'held') {
        open.set(messageId, record as unknown as OpenEntry)
        return
      }
      if (typeof op === 'string' && TERMINAL_OPS.includes(op as OutboxAck)) open.delete(messageId)
    })
    return open
  }
}

/**
 * 去掉账本记录里的 `op`，还原成领域条目。
 * @param record - 账本记录。
 * @returns 不含 op 的条目。
 */
function entryOf(record: OpenEntry): OutboxEntry {
  const { op: _op, ...entry } = record
  return entry
}
