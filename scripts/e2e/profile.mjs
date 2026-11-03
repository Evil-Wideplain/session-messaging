/**
 * e2e 运行时对隔离 profile patch 的备份、改写与还原。
 *
 * 备份原始内容而不是只写 `[]`：误跑时不能把用户/其他工具设置的 patch 永久抹掉；
 * 原始内容同时落到 artifacts，进程被强杀时也能手工恢复。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARTIFACTS, profileDir } from './env.mjs'

/** 运行前的原始 patch 内容；`undefined` 表示文件原本不存在。 */
let originalPatch

/** 备份 profile 的原始 patch。 */
export function snapshotPatch() {
  const patch = join(profileDir(), 'cordis.patch.yml')
  originalPatch = existsSync(patch) ? readFileSync(patch, 'utf8') : undefined
  if (originalPatch === undefined) return
  writeFileSync(join(ARTIFACTS, 'cordis.patch.yml.orig'), originalPatch, 'utf8')
}

/**
 * 把 profile patch 还原成运行前的样子（不存在则删除）。
 */
export function restorePatch() {
  const patch = join(profileDir(), 'cordis.patch.yml')
  if (!existsSync(profileDir())) return
  try {
    if (originalPatch === undefined) rmSync(patch, { force: true })
    else writeFileSync(patch, originalPatch, 'utf8')
  } catch (error) {
    process.stderr.write(`e2e runtime: failed to restore ${patch}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * 写入本次运行使用的审批策略 patch。
 * @param {number} expiryMs 审批截止时间（毫秒）。
 * @returns {string} patch 路径。
 */
export function writePatch(expiryMs) {
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
