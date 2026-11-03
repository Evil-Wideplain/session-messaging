/**
 * 追加式 JSONL 账本的文件原语（基础设施层共用）。
 *
 * 出站账本与入站账本都是「先落账、后投递」的耐久日志，因此这里统一处理三件
 * 容易被单点实现忽略的事：
 *
 * 1. append 前保证上一行以 `\n` 收尾——崩溃留下的半行若直接与下一条记录拼接，
 *    会得到一条非法 JSON，`fold` 会同时丢掉两条记录（既丢排队消息也丢 ack）。
 * 2. compact 用「临时文件 + fsync + rename」原子替换——直接 `'w'` 截断后重写，
 *    进程中途被杀就丢掉整本账，而这恰好只发生在崩溃恢复路径上。
 * 3. 按 (size, mtime) 缓存文件内容——`pendingTo()` 每次 send 都会调用，全量
 *    `readFileSync` + 逐行 JSON.parse 会把事件循环卡在同步 I/O 上。
 *
 * 本类不解释账本语义（哪些 op 是终态、哪些记录要保留），只提供文件原语；
 * 语义留给两个仓储实现。
 *
 * @module session-messaging/infrastructure/jsonl-ledger
 */

import {
  closeSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from './paths.ts'

/** 账本文件超过该体积时触发压缩回调，避免只增不减。 */
const COMPACT_THRESHOLD_BYTES = 256 * 1024

/** 会话标识作为文件名的白名单：只允许常见 id 字符，杜绝路径穿越。 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/u

/**
 * 校验会话标识可安全用作文件名。
 * @param id - 会话标识。
 * @returns 归一化后的标识。
 * @throws 标识含路径分隔符或非法字符时抛错。
 */
export function safeLedgerId(id: string): string {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`账本标识不合法（拒绝用作文件名）: ${JSON.stringify(id)}`)
  }
  return id
}

/**
 * 追加式 JSONL 账本文件。
 */
export class JsonlLedgerFile {
  private readonly path: string
  private cache: { readonly signature: string; readonly raw: string } | undefined

  /**
   * @param dir - 账本目录。
   * @param id - 归属会话标识（同时是文件名）。
   * @param onSizePressure - 体积超阈值时的压缩回调（由仓储提供保留语义）。
   */
  constructor(
    private readonly dir: string,
    id: string,
    private readonly onSizePressure?: () => void,
  ) {
    ensurePrivateDir(dir)
    this.path = join(dir, `${safeLedgerId(id)}.jsonl`)
  }

  /**
   * 追加一条记录并落盘。
   *
   * 用 `a+` 打开以便读最后一字节：崩溃留下的半行必须先补换行，否则下一条
   * 记录会与它拼成非法 JSON，两条一起丢。
   * @param record - 可 JSON 序列化的记录。
   */
  append(record: unknown): void {
    const fd = openSync(this.path, 'a+', 0o600)
    try {
      const size = fstatSync(fd).size
      if (size > 0) {
        const tail = Buffer.alloc(1)
        readSync(fd, tail, 0, 1, size - 1)
        if (tail[0] !== 0x0a) writeSync(fd, '\n')
      }
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.cache = undefined
    this.compactIfLarge()
  }

  /**
   * 以原子替换的方式重写整本账本。
   *
   * 先写 `*.tmp` 再 rename：rename 在同一目录内是原子的，进程在写临时文件期间
   * 被杀也只会留下垃圾临时文件，原账本保持完整。
   * @param records - 需要保留的记录（已是完整记录对象）。
   */
  rewrite(records: readonly unknown[]): void {
    ensurePrivateDir(this.dir)
    const temp = `${this.path}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      for (const record of records) writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.path)
    this.cache = undefined
  }

  /**
   * 读取全部原始文本；文件不存在时返回空串。
   *
   * 命中缓存时（size 与 mtime 都没变）不再读盘：账本几乎每次 send 都会被查询。
   * @returns 文件内容。
   */
  read(): string {
    let stats
    try {
      stats = statSync(this.path)
    } catch {
      return ''
    }
    const signature = `${stats.size}:${stats.mtimeMs}`
    if (this.cache !== undefined && this.cache.signature === signature) return this.cache.raw
    const raw = readFileSync(this.path, 'utf8')
    this.cache = { signature, raw }
    return raw
  }

  /**
   * 逐行解析 JSON 记录；非法 JSON（崩溃残行）直接跳过，不影响后续记录。
   * @param visit - 每条合法记录对象的回调。
   */
  forEach(visit: (record: Record<string, unknown>) => void): void {
    for (const line of this.read().split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      visit(parsed as Record<string, unknown>)
    }
  }

  /** 体积超过阈值时交给仓储压缩；读取失败忽略。 */
  private compactIfLarge(): void {
    if (this.onSizePressure === undefined) return
    try {
      if (statSync(this.path).size <= COMPACT_THRESHOLD_BYTES) return
    } catch {
      return
    }
    this.onSizePressure()
  }
}
