/**
 * 应用层发送守卫：频率限制与相同正文去重。
 *
 * 两者都是进程内状态、与领域规则无关的横切策略，因此放在应用层；
 * 换实现（如分布式限流）不影响领域模型和工具契约。
 *
 * @module session-messaging/application/guards
 */

/** 进程内状态的上限；超过后按时间淘汰，避免长期运行后无界增长。 */
const MAX_TRACKED_KEYS = 1024

/** 一分钟滑动窗口的发送频率限制。 */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>()
  private readonly windowMs: number

  /**
   * @param windowMs - 统计窗口（毫秒）。
   */
  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  /**
   * 占用一次配额；超限时返回 false 且不记录本次调用。
   * @param key - sender→target 组合键。
   * @param limit - 窗口内最大次数。
   * @param now - 当前时间戳。
   * @returns 是否放行。
   */
  take(key: string, limit: number, now: number): boolean {
    this.prune(now)
    const recent = (this.windows.get(key) ?? []).filter(at => now - at < this.windowMs)
    if (recent.length >= limit) {
      this.windows.set(key, recent)
      return false
    }
    recent.push(now)
    this.windows.set(key, recent)
    return true
  }

  /**
   * 清掉窗口已空的 sender→target 键；键空间随会话数增长，长驻进程必须回收。
   * @param now - 当前时间戳。
   */
  private prune(now: number): void {
    if (this.windows.size <= MAX_TRACKED_KEYS) return
    for (const [key, stamps] of this.windows) {
      if (stamps.every(at => now - at >= this.windowMs)) this.windows.delete(key)
    }
  }
}

/** 窗口内相同正文的去重记录。 */
export class DuplicateWindow {
  private readonly entries = new Map<string, { messageId: string; at: number }>()
  private readonly windowMs: number

  /**
   * @param windowMs - 去重窗口（毫秒）；0 表示关闭。
   */
  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  /**
   * 查询窗口内是否已经发过相同正文。
   * @param key - sender→target 加正文摘要的组合键。
   * @param now - 当前时间戳。
   * @returns 命中时返回第一次的 messageId。
   */
  find(key: string, now: number): string | undefined {
    if (this.windowMs <= 0) return undefined
    const hit = this.entries.get(key)
    if (hit === undefined || now - hit.at >= this.windowMs) return undefined
    return hit.messageId
  }

  /**
   * 记住一次发送，供窗口内后续调用去重。
   * @param key - 组合键。
   * @param messageId - 本次消息标识。
   * @param now - 当前时间戳。
   */
  remember(key: string, messageId: string, now: number): void {
    if (this.windowMs <= 0) return
    this.prune(now)
    // 超过上限时按插入顺序淘汰最旧的键：整表 clear() 会让紧邻的下一次相同正文
    // 逃过去重从而重复投递。
    while (this.entries.size >= MAX_TRACKED_KEYS) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { messageId, at: now })
  }

  /**
   * 清掉已过窗口的键，保证 Map 不随历史发送量无界增长。
   * @param now - 当前时间戳。
   */
  private prune(now: number): void {
    for (const [key, hit] of this.entries) {
      if (now - hit.at >= this.windowMs) this.entries.delete(key)
    }
  }
}
