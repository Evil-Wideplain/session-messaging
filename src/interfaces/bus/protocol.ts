/**
 * 本地总线协议（接口层）。
 *
 * 定义一次连接上的一问一答：请求体形状、参数校验与错误文案。校验与工具层保持
 * 同一套规则——静默忽略错类型会让脚本得到「成功但少行」的结果，而不是报错。
 * `limit` 上限直接复用应用层常量，避免「脚本校验通过、服务端静默 clamp」的漂移。
 *
 * @module dsh-plugin-session-messaging/interfaces/bus/protocol
 */

import { LIST_MAX_LIMIT } from '../../application/messaging/deps.ts'

/** 单个请求体的硬上限。 */
export const MAX_REQUEST_BYTES = 1024 * 1024

/** 单连接空闲预算。 */
export const CONNECTION_TIMEOUT_MS = 30_000

/** 一次请求触发的投递工作预算。 */
export const REQUEST_TIMEOUT_MS = 25_000

/** `list` 允许的返回上限：复用应用层 `LIST_MAX_LIMIT`，不在这里另立一份。 */
export const MAX_LIMIT = LIST_MAX_LIMIT

/** 一条解析后的总线请求（字段都未经校验）。 */
export interface BusRequest {
  /** 请求体里的 bearer token；身份只由它决定，正文/其它字段都无法冒充发送者。 */
  readonly token?: unknown
  /** 操作名；目前只支持 `list` / `send`。 */
  readonly op?: unknown
  /** `send` 的目标：显示名或精确 session id。 */
  readonly to?: unknown
  /** `send` 的消息正文（非空，且受 `maxMessageBytes` 约束）。 */
  readonly message?: unknown
  /** `send` 的一行摘要，写进消息 `source` 供目标辨认。 */
  readonly summary?: unknown
  /** `send` 是否启用去重；false 表示强制投递。 */
  readonly dedupe?: unknown
  /** `list` 是否额外列出其他会话的子代理。 */
  readonly include_subagents?: unknown
  /** `list` 的返回行数上限（1..{@link MAX_LIMIT} 的整数）。 */
  readonly limit?: unknown
}

/** 一条总线响应。 */
export interface BusResponse {
  /** 成功为 true；失败时只带 `error`。 */
  readonly ok: boolean
  /** 成功时的结果，字段与应用服务 DTO 同源。 */
  readonly result?: unknown
  /** 失败时的错误码与说明（取值见下方各 Response 构造函数）。 */
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * 构造一条 `bad_request` 响应。
 * @param message - 面向脚本的英文/中文错误说明。
 * @returns 错误响应。
 */
export function badRequest(message: string): BusResponse {
  return { ok: false, error: { code: 'bad_request', message } }
}

/** 连接空闲超时的响应。 */
export function timeoutResponse(): BusResponse {
  return { ok: false, error: { code: 'timeout', message: '请求超时' } }
}

/** 请求体超过上限的响应。 */
export function tooLargeResponse(): BusResponse {
  return { ok: false, error: { code: 'too_large', message: '请求体过大' } }
}

/** 请求不是合法 JSON 的响应。 */
export function invalidJsonResponse(): BusResponse {
  return { ok: false, error: { code: 'bad_request', message: '请求不是合法 JSON' } }
}

/** 连接已结束但缓冲区还有残留内容的响应。 */
export function trailingDocumentResponse(): BusResponse {
  return { ok: false, error: { code: 'bad_request', message: '一次连接只能携带一个 JSON 文档' } }
}

/**
 * 处理请求抛出未预期异常时的响应。
 * @param error - 任意抛出物。
 * @returns `failed` 响应。
 */
export function failedResponse(error: unknown): BusResponse {
  return {
    ok: false,
    error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
  }
}

/** 通过校验的 list 参数。 */
export interface ListInput {
  /** 是否包含子代理会话。 */
  readonly includeSubagents: boolean
  /** 返回条数上限（缺省由应用层决定）。 */
  readonly limit?: number
}

/** 通过校验的 send 参数。 */
export interface SendInput {
  /** 目标地址（名称或会话标识）。 */
  readonly to: string
  /** 消息正文。 */
  readonly message: string
  /** 可选的一行摘要。 */
  readonly summary?: string
  /** 是否启用去重。 */
  readonly dedupe?: boolean
}

/**
 * 校验 list 请求参数。
 * @param request - 已解析的请求体。
 * @returns 通过校验的参数，或一条 `bad_request` 响应。
 */
export function listInputOf(request: BusRequest): ListInput | BusResponse {
  if (request.include_subagents !== undefined && typeof request.include_subagents !== 'boolean') {
    return badRequest('"include_subagents" 必须是布尔值')
  }
  const limit = request.limit
  if (limit !== undefined
    && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    return badRequest(`"limit" 必须是 1..${MAX_LIMIT} 的整数`)
  }
  return {
    includeSubagents: request.include_subagents === true,
    ...limit === undefined ? {} : { limit },
  }
}

/**
 * 校验 send 请求参数。
 *
 * 与工具层一样拒绝空白正文：只查 typeof 会让脚本收到「ok:true + refused」，
 * 而模型侧同一份参数会得到参数错误，两条入口的语义就对不上了。
 * @param request - 已解析的请求体。
 * @returns 通过校验的参数，或一条 `bad_request` 响应。
 */
export function sendInputOf(request: BusRequest): SendInput | BusResponse {
  if (typeof request.to !== 'string' || request.to.trim() === ''
    || typeof request.message !== 'string' || request.message.trim() === '') {
    return badRequest('"to" 与 "message" 必须是非空字符串')
  }
  if (request.summary !== undefined && typeof request.summary !== 'string') {
    return badRequest('"summary" 必须是字符串')
  }
  if (request.dedupe !== undefined && typeof request.dedupe !== 'boolean') {
    return badRequest('"dedupe" 必须是布尔值')
  }
  return {
    to: request.to,
    message: request.message,
    ...request.summary === undefined ? {} : { summary: request.summary },
    ...request.dedupe === undefined ? {} : { dedupe: request.dedupe },
  }
}
