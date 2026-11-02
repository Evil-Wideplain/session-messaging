#!/usr/bin/env node
/**
 * dsh-plugin-session-messaging 的真运行时端到端验证。
 *
 * 与 `npm test`（用进程内假 DSH 上下文驱动构建产物）不同，本脚本启动真实的
 * `dsh` CLI，在隔离 profile 上让真实模型自行决定调用真实工具，验证那些只在
 * 运行中的 harness 里才成立的接线：profile bundle 解析、插件挂载、工具注册进
 * 模型的工具列表、会话持久化、通过 `--session-id` 恢复会话，以及跨两个 OS 进程
 * 的审批流程。
 *
 * 前置条件（创建一次后可反复使用）：
 *   <DSH_HOME>/profiles/session-messaging-e2e  隔离 profile
 *   dsh plugin --profile session-messaging-e2e add <本仓库>
 *
 * 脚本写入的 profile patch 会设置 `inbound: hold`，以便确定性地验证审批路径；
 * 在验收阶段与过期阶段之间，脚本会切换审批截止时间。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=<key> node scripts/e2e-runtime.mjs
 *
 * 未导出 `DEEPSEEK_API_KEY` 时，从受管凭据文件 `<DSH_HOME>/.credentials.yaml`
 * （Web 模型页写入的同一个文件）读取，且永不打印。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PROFILE = process.env['DSH_E2E_PROFILE'] ?? 'session-messaging-e2e'
const REPO = resolve(import.meta.dirname, '..')
const WORKSPACE = join(REPO, 'e2e-workspace')
const ARTIFACTS = join(WORKSPACE, 'artifacts')
const APPROVAL_WINDOW_MS = 60_000
const EXPIRY_DEADLINE_MS = 1_500
const RUN_TIMEOUT_MS = 300_000

const checks = []

function dshHome() {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function fail(message) {
  throw new Error(message)
}

/** 读取 DeepSeek API key，且永不打印。 */
function apiKey() {
  const exported = process.env['DEEPSEEK_API_KEY']
  if (exported !== undefined && exported !== '') return exported
  const credentials = join(dshHome(), '.credentials.yaml')
  if (!existsSync(credentials)) fail(`DEEPSEEK_API_KEY is not exported and ${credentials} does not exist`)
  const match = /^\s*DEEPSEEK_API_KEY:\s*(?<value>.+)$/mu.exec(readFileSync(credentials, 'utf8'))
  const raw = match?.groups?.['value']?.trim()
  if (raw === undefined || raw === '') fail(`DEEPSEEK_API_KEY is not present in ${credentials}`)
  return raw.replace(/^['"]|['"]$/gu, '')
}

function profileDir() {
  return join(dshHome(), 'profiles', PROFILE)
}

/**
 * 校验隔离 profile 名与存在性。
 *
 * 脚本会改写 profile 的 `cordis.patch.yml`，因此只允许跑在名字以 `-e2e` 结尾的
 * 专用 profile 上：否则一次误用就会把用户真实 profile 的插件组合改掉。
 */
function checkProfile() {
  if (!PROFILE.endsWith('-e2e')) {
    fail(`refusing to run against profile ${PROFILE}: the profile name must end with "-e2e"`)
  }
  const dir = profileDir()
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) {
    fail(`profile ${PROFILE} is missing. Create it with: dsh plugin --profile ${PROFILE} add "${REPO}"`)
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  const linked = parsed.dependencies?.['dsh-plugin-session-messaging']
  const bundle = parsed.dsh?.profile?.bundles?.includes('dsh-plugin-session-messaging')
  if (linked === undefined) fail(`profile ${PROFILE} has no dsh-plugin-session-messaging dependency`)
  if (bundle !== true) fail(`profile ${PROFILE} does not list dsh-plugin-session-messaging as a bundle`)
  if (!existsSync(join(REPO, 'lib', 'index.js'))) fail('lib/index.js is missing; run npm run build first')
  return { linked, dir }
}

/** dsh CLI 入口；解析路径以避开 shell 引号问题。 */
function dshCommand() {
  const npmRoot = process.env['APPDATA'] === undefined
    ? undefined
    : join(process.env['APPDATA'], 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (npmRoot !== undefined && existsSync(npmRoot)) {
    return { command: process.execPath, prefix: [npmRoot], shell: false }
  }
  return { command: 'dsh', prefix: [], shell: process.platform === 'win32' }
}

/** 执行一次 dsh CLI，参数不经过 shell。 */
function runDsh(args, options = {}) {
  const cli = dshCommand()
  return spawnSync(cli.command, [...cli.prefix, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? WORKSPACE,
    env: { ...process.env, ...options.env ?? {} },
    timeout: options.timeout ?? RUN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    shell: cli.shell,
    ...options.input === undefined ? {} : { input: options.input },
  })
}

/** 运行前的原始 patch 内容；`undefined` 表示文件原本不存在。 */
let originalPatch

/**
 * 备份 profile 的原始 patch。
 *
 * 只写 `[]` 不叫备份：它会把用户/其他工具设置的 patch 永久抹掉。原始内容同时落到
 * artifacts 目录，进程被强杀时也能手工恢复。
 */
function snapshotPatch() {
  const patch = join(profileDir(), 'cordis.patch.yml')
  originalPatch = existsSync(patch) ? readFileSync(patch, 'utf8') : undefined
  if (originalPatch === undefined) return
  writeFileSync(join(ARTIFACTS, 'cordis.patch.yml.orig'), originalPatch, 'utf8')
}

/** 把 profile patch 还原成运行前的样子（不存在则删除）。 */
function restorePatch() {
  const patch = join(profileDir(), 'cordis.patch.yml')
  if (!existsSync(profileDir())) return
  try {
    if (originalPatch === undefined) rmSync(patch, { force: true })
    else writeFileSync(patch, originalPatch, 'utf8')
  } catch (error) {
    process.stderr.write(`e2e runtime: failed to restore ${patch}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** 会话日志是多帧 zstd，缺少 zstd 命令时无法验证落盘结果。 */
function checkZstd() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || (probe.status ?? 1) !== 0) {
    fail('zstd binary is required to decode session logs; install zstd or add it to PATH')
  }
}

/** 写入本次运行使用的审批策略 patch。 */
function writePatch(expiryMs) {
  const patch = join(profileDir(), 'cordis.patch.yml')
  const lines = [
    '# Managed by scripts/e2e-runtime.mjs (runtime end-to-end test).',
    '# Restores to [] when the test is not in use.',
    '- id: session-messaging',
    '  config:',
    '    inbound: hold',
    `    holdExpiryMs: ${expiryMs}`,
    '',
  ]
  writeFileSync(patch, lines.join('\n'), 'utf8')
  return patch
}

/** 解析按行分隔的 JSON。 */
function decodedEvents(text) {
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

/** 跑一轮 headless，返回解析后的事件流。 */
function runHeadless(step, task, options = {}) {
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

/** 工具结果；按 callId 与调用配对。 */
function toolResults(events, toolName) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool === toolName) calls.set(event.callId, { input: event.input })
    if (event.type === 'tool_result' && calls.has(event.callId)) calls.get(event.callId).result = event.result
  }
  return [...calls.values()]
}

/** 解压后的单会话持久日志（多帧 zstd）。 */
function sessionLog(sessionId) {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return ''
  for (const workspaceKey of readdirSync(root)) {
    const file = join(root, workspaceKey, sessionId, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const decoded = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (decoded.error !== undefined) fail(`cannot decode ${file} with zstd: ${decoded.error.message}`)
    return decoded.stdout ?? ''
  }
  return ''
}

/** 日志里是否提到过转发的正文（历史或待认领 inbox）。 */
function relayMentioned(log, text) {
  return log.includes('"kind":"session-message"') && log.includes(text)
}

/** 正文是否已被认领进持久对话历史。 */
function relayInHistory(log, text) {
  return decodedEvents(log).some(event => event.type === 'user/message'
    && event.data?.source?.kind === 'session-message'
    && JSON.stringify(event.data.content ?? '').includes(text))
}

async function main() {
  const key = apiKey()
  record('credential available', key !== '')
  const profile = checkProfile()
  record('isolated profile links the plugin', true, `${PROFILE} (${profile.linked})`)
  checkZstd()
  record('zstd available to decode session logs', true)

  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  snapshotPatch()
  const patch = writePatch(APPROVAL_WINDOW_MS)
  record('approval patch written', existsSync(patch), `${APPROVAL_WINDOW_MS}ms approval window`)

  // 组合结果必须真正带上 patch 配置，而不只是挂载了插件。
  const dump = runDsh(['--profile', PROFILE, '--dump-config'], { timeout: 120_000 })
  const dumped = dump.stdout ?? ''
  const dumpDetail = dump.status === 0
    ? `${dumped.length} chars`
    : `exit ${dump.status}: ${(dump.stderr ?? '').trim().split('\n').slice(-2).join(' | ')}`
  record('composed config carries inbound: hold', /inbound: hold/u.test(dumped), dumpDetail)
  record('composed config mounts the plugin', /id: session-messaging[\s\S]{0,200}?name: dsh-plugin-session-messaging/u.test(dumped))

  // 1. 通过一次普通 headless 轮次创建目标会话。
  const target = runHeadless('01-target-create', 'Reply with exactly READY-B and nothing else.')
  const targetId = target.sessionId
  record('target session created', typeof targetId === 'string' && targetId.startsWith('session-'), targetId)
  record('target session answered', target.final.includes('READY-B'), target.final.slice(0, 40))

  // 2. 发送方会话用精确 id 寻址冷目标；hold 把它挂起。
  const sender = runHeadless('02-sender-hold', [
    'You are part of an automated end-to-end test of the session-messaging plugin.',
    `Call list_session_agents with no arguments. Then call send_session_message exactly once with to="${targetId}", message="e2e-hold-1", summary="e2e".`,
    'Then reply with exactly the status word from the send result. Do not call any other tool.',
  ].join(' '))
  const sends = toolResults(sender.events, 'send_session_message')
  record('sender called send_session_message', sends.length === 1)
  const holdResult = String(sends[0]?.result ?? '')
  record('hold policy reported status held', holdResult.startsWith('held'), holdResult.slice(0, 120))
  record('held message is not in the target conversation yet', !relayMentioned(sessionLog(targetId), 'e2e-hold-1'))

  // 3. 目标恢复自己的持久会话并批准消息。
  const review = runHeadless('03-target-accept', [
    'Call review_session_messages with action "list". Then call review_session_messages with action "accept".',
    'Then reply with the status values of the outcomes you received. Do not call any other tool.',
  ].join(' '), { sessionId: targetId })
  const reviews = toolResults(review.events, 'review_session_messages')
  const acceptResult = String(reviews.at(-1)?.result ?? '')
  record('target listed then accepted', reviews.length >= 2, `${reviews.length} review calls`)
  record('accept reported accepted', acceptResult.includes('accepted'), acceptResult.slice(0, 160))
  const targetLog = sessionLog(targetId)
  record('accepted message reached the target conversation', relayInHistory(targetLog, 'e2e-hold-1'))
  record('target session still holds its own history', targetLog.includes('READY-B'))

  // 4. 超过截止时间的挂起消息应当过期，而不是被投递。
  // 每次 dsh 运行都会重新装载 profile，因此可以随时换入更短的截止时间，
  // 不需要重启任何常驻进程。
  writePatch(EXPIRY_DEADLINE_MS)
  const second = runHeadless('04-sender-expiry', [
    'You are part of an automated end-to-end test of the session-messaging plugin.',
    `Call send_session_message exactly once with to="${targetId}", message="e2e-expire-1".`,
    'Then reply with exactly the status word from the send result. Do not call any other tool.',
  ].join(' '))
  const secondSends = toolResults(second.events, 'send_session_message')
  record('second send reported status held', String(secondSends[0]?.result ?? '').startsWith('held'))
  await new Promise(resolve => setTimeout(resolve, EXPIRY_DEADLINE_MS + 2_000))

  const expired = runHeadless('05-target-expire', [
    'Call review_session_messages with action "list". Then reply with the status values of the outcomes you received.',
    'Do not call any other tool.',
  ].join(' '), { sessionId: targetId })
  const expiredReviews = toolResults(expired.events, 'review_session_messages')
  const expiredResult = String(expiredReviews[0]?.result ?? '')
  record('expired held message reported expired', expiredResult.includes('expired'), expiredResult.slice(0, 160))
  record('expired message never entered the conversation', !relayMentioned(sessionLog(targetId), 'e2e-expire-1'))

  const failed = checks.filter(check => !check.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
  process.stdout.write(`artifacts: ${ARTIFACTS}\n`)
  process.stdout.write(`target session: ${targetId}\n`)
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map(check => check.name).join(', ')}\n`)
    process.exitCode = 1
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`e2e runtime failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  restorePatch()
}
