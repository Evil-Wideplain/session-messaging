/**
 * e2e 运行时 headless 驱动与日志断言工具。
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ARTIFACTS, PROFILE, RUN_TIMEOUT_MS, apiKey, dshHome, runDsh } from './env.mjs'
import { fail } from './checks.mjs'

/**
 * 解析按行分隔的 JSON。
 * @param {string} text stdout 文本。
 * @returns {any[]} 解析出的事件。
 */
export function decodedEvents(text) {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/**
 * 跑一轮 headless，返回解析后的事件流。
 * @param {string} step 步骤名（artifacts 文件名）。
 * @param {string} task 提示词。
 * @param {{ sessionId?: string }} [options] 选项。
 * @returns {{ events: any[], sessionId?: string, final: string }} 运行结果。
 */
export function runHeadless(step, task, options = {}) {
  const args = ['--profile', PROFILE, 'headless', '--json']
  if (options.sessionId !== undefined) args.push('--session-id', options.sessionId)
  // 任务作为一个 argv 元素传入：shell 看不到它，提示里的引号与换行原样保留。
  args.push(task)
  const result = runDsh(args, { env: { DEEPSEEK_API_KEY: apiKey() }, input: task })
  writeFileSync(join(ARTIFACTS, `${step}.json`), result.stdout ?? '', 'utf8')
  writeFileSync(join(ARTIFACTS, `${step}.err`), result.stderr ?? '', 'utf8')
  if ((result.status ?? 1) !== 0) {
    const tail = (result.stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    fail(`headless run ${step} failed with exit ${result.status}: ${tail}`)
  }
  const events = decodedEvents(result.stdout ?? '')
  const sessionId = events.find(event => event.type === 'session')?.sessionId
  const final = [...events].reverse().find(event => event.type === 'final')?.text ?? ''
  return { events, sessionId, final }
}

/**
 * 工具结果；按 callId 与调用配对。
 * @param {any[]} events 事件流。
 * @param {string} toolName 工具名。
 * @returns {{ input: any, result?: any }[]} 调用记录。
 */
export function toolResults(events, toolName) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool === toolName) calls.set(event.callId, { input: event.input })
    if (event.type === 'tool_result' && calls.has(event.callId)) calls.get(event.callId).result = event.result
  }
  return [...calls.values()]
}

/**
 * 解压后的单会话持久日志（多帧 zstd）。
 * @param {string} sessionId 会话 id。
 * @returns {string} 解压后的日志文本。
 */
export function sessionLog(sessionId) {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return ''
  for (const workspaceKey of readdirSync(root)) {
    const file = join(root, workspaceKey, sessionId, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const decoded = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_TIMEOUT_MS })
    if (decoded.error !== undefined) fail(`cannot decode ${file} with zstd: ${decoded.error.message}`)
    return decoded.stdout ?? ''
  }
  return ''
}

/**
 * 日志里是否提到过转发的正文（历史或待认领 inbox）。
 * @param {string} log 会话日志。
 * @param {string} text 正文。
 * @returns {boolean} 是否提到。
 */
export function relayMentioned(log, text) {
  return log.includes('"kind":"session-message"') && log.includes(text)
}

/**
 * 正文是否已被认领进持久对话历史。
 * @param {string} log 会话日志。
 * @param {string} text 正文。
 * @returns {boolean} 是否已进入历史。
 */
export function relayInHistory(log, text) {
  return decodedEvents(log).some(event => event.type === 'user/message'
    && event.data?.source?.kind === 'session-message'
    && JSON.stringify(event.data.content ?? '').includes(text))
}
