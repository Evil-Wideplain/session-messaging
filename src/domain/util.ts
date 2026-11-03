/**
 * 跨层共用的纯函数（领域层）。
 *
 * 错误文本化与「空白串按未提供处理」这两条规则原本在应用层、基础设施层和接口层
 * 各抄一份（`messageOf` 一度有 5 份副本）；它们不依赖任何 IO 或运行时服务，
 * 放在领域层可以被所有层安全复用，也避免各副本随重构漂移。
 *
 * @module session-messaging/domain/util
 */

/**
 * 把未知抛出物转成可读文本。
 * @param error - 任意抛出物（Error、字符串或其它）。
 * @returns 错误消息或字符串化结果。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 去掉首尾空白；全空白视为未提供。
 * @param value - 原始字符串（可能未提供）。
 * @returns 去空白后的值；未提供或全空白时返回 undefined。
 */
export function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
