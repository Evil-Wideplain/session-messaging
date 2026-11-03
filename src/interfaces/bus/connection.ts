/**
 * 总线连接处理（接口层）。
 *
 * 一次连接 = 一条 JSON 请求（换行或 EOF 结束）+ 一条 JSON 响应。连接只解析
 * **第一份**文档：解析成功后转入「已解析」状态，后续字节一律不再 dispatch，
 * 出现第二份文档按协议错误结束——否则同一连接可以悄悄执行两条 send（重复
 * 投递），或把尾随字节静默丢掉。请求体还必须是普通 JSON 对象：`null`/数组/
 * 标量直接 `bad_request`，不能落到读字段的 TypeError 上。
 *
 * 用 `setEncoding('utf8')` 让 Node 内部用 StringDecoder 跨 chunk 保持 UTF-8 状态：
 * 手工 `chunk.toString('utf8')` 会把跨 chunk 的多字节字符解成 U+FFFD，中文正文乱码。
 *
 * @module dsh-plugin-session-messaging/interfaces/bus/connection
 */

import type { Socket } from 'node:net'
import {
  CONNECTION_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  badRequest,
  failedResponse,
  invalidJsonResponse,
  timeoutResponse,
  tooLargeResponse,
  trailingDocumentResponse,
} from './protocol.ts'
import type { BusRequest, BusResponse } from './protocol.ts'

/**
 * 写一行响应并关闭连接。
 * @param socket - 连接。
 * @param response - 响应体。
 */
function reply(socket: Socket, response: BusResponse): void {
  const line = `${JSON.stringify(response)}\n`
  socket.end(line, () => { socket.destroy() })
}

/**
 * 请求体必须是一个普通 JSON 对象。
 *
 * `null`、数组和标量都不构成一次请求：直接读 `token` 会抛 TypeError，被当成
 * `failed` 返回，既不对齐协议也让脚本看到内部报错文本。
 * @param value - 解析后的任意 JSON 值。
 * @returns 是否为普通对象。
 */
function isRequestObject(value: unknown): value is BusRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 接管一条连接：读一条请求、答一次、关闭。
 * @param socket - 已建立的连接。
 * @param dispatch - 执行一条已解析请求（鉴权 + 业务）。
 */
export function attachConnection(
  socket: Socket,
  dispatch: (request: BusRequest) => Promise<BusResponse>,
): void {
  socket.setTimeout(CONNECTION_TIMEOUT_MS)
  // 让 Node 内部用 StringDecoder 跨 chunk 保持 UTF-8 状态；手工逐 chunk
  // toString('utf8') 会把被切断的多字节字符变成 U+FFFD。
  socket.setEncoding('utf8')
  socket.on('timeout', () => {
    reply(socket, timeoutResponse())
  })
  socket.on('error', () => { socket.destroy() })

  let buffer = ''
  /** 是否已经解析过第一份文档；置真后进入「只读不解析」状态。 */
  let parsed = false
  let settled = false
  const settle = (response: BusResponse): void => {
    if (settled) return
    settled = true
    reply(socket, response)
  }

  socket.on('data', (chunk: string) => {
    if (parsed) {
      // 已经处理过一条请求：再来的字节就是第二份文档，按协议错误结束。
      // 这里绝不能再次 dispatch——否则同一连接能执行两条 send，而客户端只收到一条响应。
      settle(trailingDocumentResponse())
      return
    }
    buffer += chunk
    // 上限按字节而不是 UTF-16 码元判断，中文正文才不会被高估 3 倍或低估。
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      parsed = true
      settle(tooLargeResponse())
      return
    }
    const newline = buffer.indexOf('\n')
    const candidate = newline >= 0 ? buffer.slice(0, newline) : buffer
    let document: unknown
    try {
      document = JSON.parse(candidate.trim())
    } catch {
      // 没有换行可能只是半帧（UTF-8 安全的分块），继续等；已经换行仍解析失败
      // 才是真的非法 JSON。
      if (newline >= 0) {
        parsed = true
        settle(invalidJsonResponse())
      }
      return
    }
    parsed = true
    if (newline >= 0 && buffer.slice(newline + 1).trim() !== '') {
      // 一行之后还有字节（同一 chunk 的尾随内容）：一次连接只能携带一个文档，
      // 不执行、不静默丢弃，直接按协议错误结束。
      settle(trailingDocumentResponse())
      return
    }
    if (!isRequestObject(document)) {
      settle(badRequest('请求体必须是 JSON 对象'))
      return
    }
    void dispatch(document).then(settle, (error: unknown) => {
      settle(failedResponse(error))
    })
  })

  socket.on('end', () => {
    // 只有「从未解析成功」时残留的 buffer 才是未完成的文档；解析成功后
    // buffer 里剩下的字节已经在 data 阶段按第二份文档处理过。
    if (!parsed && buffer.trim() !== '') {
      settle(trailingDocumentResponse())
    }
  })
}
