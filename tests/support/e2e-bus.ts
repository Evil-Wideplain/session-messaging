/**
 * 包级端到端测试的共享夹具：通过真实 socket / 命名管道访问本地总线。
 */

import { connect } from 'node:net'

/** 通过真实端点发一条总线请求（端点来自 shell 环境变量）。 */
export async function busRequest(
  endpoint: string,
  token: string,
  request: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`)
    })
    socket.on('data', (chunk: string) => { buffer += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as { ok: boolean })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** 轮询等待总线服务可连接。 */
export async function waitForBus(endpoint: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      await busRequest(endpoint, 'probe', { op: 'list' })
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}
