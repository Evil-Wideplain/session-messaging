/**
 * e2e 运行时检查清单：收集 `record()` 结果并在结束时统一汇总。
 *
 * 拆成独立模块，避免长脚本单文件超过 200 行（TS/JS 开发规范）。
 */

/** 已执行的检查项。 */
export const checks = []

/**
 * 记录一条检查结果并立即打印。
 * @param {string} name 检查名。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 可选细节。
 */
export function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/**
 * 抛出一个可诊断的失败。
 * @param {string} message 失败原因。
 * @returns {never}
 */
export function fail(message) {
  throw new Error(message)
}

/**
 * 打印汇总并设置退出码。
 * @param {{ readonly targetId?: string, readonly artifacts: string }} options 汇总信息。
 */
export function finish(options) {
  const failed = checks.filter(check => !check.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
  process.stdout.write(`artifacts: ${options.artifacts}\n`)
  if (options.targetId !== undefined) process.stdout.write(`target session: ${options.targetId}\n`)
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map(check => check.name).join(', ')}\n`)
    process.exitCode = 1
  }
}
