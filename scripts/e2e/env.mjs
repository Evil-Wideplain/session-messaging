/**
 * e2e 运行时环境：常量、凭据、隔离 profile 校验与 dsh CLI 调用。
 *
 * 只做「找到并启动 dsh」；业务流程在 scripts/e2e-runtime.mjs。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fail } from './checks.mjs'

export const PROFILE = process.env['DSH_E2E_PROFILE'] ?? 'session-messaging-e2e'
export const REPO = resolve(import.meta.dirname, '..', '..')
export const WORKSPACE = join(REPO, 'e2e-workspace')
export const ARTIFACTS = join(WORKSPACE, 'artifacts')
export const APPROVAL_WINDOW_MS = 60_000
export const EXPIRY_DEADLINE_MS = 1_500
export const RUN_TIMEOUT_MS = 300_000

/**
 * 解析 DSH_HOME。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * 读取 DeepSeek API key，且永不打印。
 * @returns {string} 凭据。
 */
export function apiKey() {
  const exported = process.env['DEEPSEEK_API_KEY']
  if (exported !== undefined && exported !== '') return exported
  const credentials = join(dshHome(), '.credentials.yaml')
  if (!existsSync(credentials)) fail(`DEEPSEEK_API_KEY is not exported and ${credentials} does not exist`)
  const match = /^\s*DEEPSEEK_API_KEY:\s*(?<value>.+)$/mu.exec(readFileSync(credentials, 'utf8'))
  const raw = match?.groups?.['value']?.trim()
  if (raw === undefined || raw === '') fail(`DEEPSEEK_API_KEY is not present in ${credentials}`)
  return raw.replace(/^['"]|['"]$/gu, '')
}

/**
 * profile 目录。
 * @returns {string} 绝对路径。
 */
export function profileDir() {
  return join(dshHome(), 'profiles', PROFILE)
}

/**
 * 校验隔离 profile 名与存在性。
 *
 * 脚本会改写 profile 的 `cordis.patch.yml`，因此只允许跑在名字以 `-e2e` 结尾的
 * 专用 profile 上：否则一次误用就会把用户真实 profile 的插件组合改掉。
 * @returns {{ readonly linked: string, readonly dir: string }} profile 摘要。
 */
export function checkProfile() {
  if (!PROFILE.endsWith('-e2e')) {
    fail(`refusing to run against profile ${PROFILE}: the profile name must end with "-e2e"`)
  }
  const dir = profileDir()
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) {
    fail(`profile ${PROFILE} is missing. Create it with: dsh plugin --profile ${PROFILE} add "${REPO}"`)
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  const linked = parsed.dependencies?.['session-messaging']
  const bundle = parsed.dsh?.profile?.bundles?.includes('session-messaging')
  if (linked === undefined) fail(`profile ${PROFILE} has no session-messaging dependency`)
  if (bundle !== true) fail(`profile ${PROFILE} does not list session-messaging as a bundle`)
  if (!existsSync(join(REPO, 'lib', 'index.js'))) fail('lib/index.js is missing; run npm run build first')
  return { linked, dir }
}

/**
 * dsh CLI 入口；解析路径以避开 shell 引号问题。
 * @returns {{ command: string, prefix: string[], shell: boolean }} 启动参数。
 */
export function dshCommand() {
  const npmRoot = process.env['APPDATA'] === undefined
    ? undefined
    : join(process.env['APPDATA'], 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (npmRoot !== undefined && existsSync(npmRoot)) {
    return { command: process.execPath, prefix: [npmRoot], shell: false }
  }
  return { command: 'dsh', prefix: [], shell: process.platform === 'win32' }
}

/**
 * 执行一次 dsh CLI，参数不经过 shell。
 * @param {string[]} args CLI 参数。
 * @param {{ cwd?: string, env?: Record<string, string>, timeout?: number, input?: string }} [options] 选项。
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 执行结果。
 */
export function runDsh(args, options = {}) {
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

/** 会话日志是多帧 zstd，缺少 zstd 命令时无法验证落盘结果。 */
export function checkZstd() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || (probe.status ?? 1) !== 0) {
    fail('zstd binary is required to decode session logs; install zstd or add it to PATH')
  }
}
