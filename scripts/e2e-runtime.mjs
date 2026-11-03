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
 *
 * 实现拆在 `scripts/e2e/`：env（profile/凭据/CLI）、profile（patch 备份还原）、
 * headless（驱动与日志断言）、checks（结果汇总）。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { record, finish } from './e2e/checks.mjs'
import {
  APPROVAL_WINDOW_MS,
  ARTIFACTS,
  EXPIRY_DEADLINE_MS,
  PROFILE,
  WORKSPACE,
  apiKey,
  checkProfile,
  checkZstd,
  runDsh,
} from './e2e/env.mjs'
import { snapshotPatch, restorePatch, writePatch } from './e2e/profile.mjs'
import {
  relayInHistory,
  relayMentioned,
  runHeadless,
  sessionLog,
  toolResults,
} from './e2e/headless.mjs'

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

  finish({ targetId, artifacts: ARTIFACTS })
}

try {
  await main()
} catch (error) {
  process.stderr.write(`e2e runtime failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  restorePatch()
}
