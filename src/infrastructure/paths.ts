/**
 * 文件系统位置（基础设施层）。
 *
 * 账本与 bus 的落点：默认在 `$DSH_HOME/session-messaging/` 下；POSIX 的 bus
 * 端点放临时目录，Windows 用命名管道（管道名带 socketDir 的哈希，见
 * {@link busEndpoint}）。所有目录都以 0700 权限创建；bus 端点目录用严格模式，
 * 权限收紧失败时宁可让总线不启动。
 *
 * @module dsh-plugin-session-messaging/infrastructure/paths
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 端点名里用目录哈希做的区分串长度（十六进制字符数）。 */
const ENDPOINT_HASH_LENGTH = 8

/**
 * 当前系统用户标识；平台没有时回退为 `win`。
 * @returns 用于拼接端点名的用户标识。
 */
function userId(): string {
  const getuid = process.getuid
  return typeof getuid === 'function' ? String(getuid()) : 'win'
}

/**
 * DSH 主目录：优先 `$DSH_HOME`，否则 `~/.dsh`。
 * @returns 绝对路径。
 */
export function dshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * 出站账本默认目录。
 * @returns 绝对路径。
 */
export function defaultOutboxDir(): string {
  return join(dshHome(), 'session-messaging', 'outbox')
}

/**
 * 入站（审批）账本默认目录。
 * @returns 绝对路径。
 */
export function defaultInboundDir(): string {
  return join(dshHome(), 'session-messaging', 'inbound')
}

/**
 * bus 的默认目录（每用户一个）。
 *
 * Windows 下这个目录仍会被创建，但它现在只用来派生管道名哈希；目录本身不影响
 * 端点形式。默认目录保持不变，GUI 与 CLI 因此继续共享同一条总线。
 * @returns 绝对路径。
 */
export function defaultSocketDir(): string {
  return join(tmpdir(), `dsh-session-messaging-${userId()}`)
}

/**
 * 目录的端点哈希：`sha256(规范化绝对路径)` 的前 8 个十六进制字符。
 *
 * 只有在 win32 下才把路径转小写：Windows 文件系统大小写不敏感，`C:\A` 与
 * `c:\a` 指的是同一个目录，必须映射到同一条命名管道。哈希是纯函数（不掺入
 * 时间、进程号、随机数），因此同一目录在不同进程里算出的端点完全一致。
 * @param dir - 端点目录；内部会 resolve 成绝对路径。
 * @returns 8 个十六进制字符。
 */
function endpointHash(dir: string): string {
  const absolute = resolve(dir)
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return createHash('sha256').update(normalized).digest('hex').slice(0, ENDPOINT_HASH_LENGTH)
}

/**
 * bus 端点：Windows 是命名管道，POSIX 是目录下的 socket 文件。
 *
 * Windows 管道名形如 `\\.\pipe\dsh-session-messaging-<uid>-<hash>`，hash 由
 * socketDir 决定：同一目录稳定复用同一条管道（GUI 与 CLI 共享默认目录的总线仍
 * 是有意设计），不同目录则各用各的管道——测试进程或第二个宿主不会再和正在运行
 * 的 GUI 抢同一条管道（`EADDRINUSE`）。
 * @param dir - 端点目录：Windows 用于生成管道名哈希，POSIX 是 socket 文件所在目录。
 * @returns 端点路径。
 */
export function busEndpoint(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-session-messaging-${userId()}-${endpointHash(dir)}`
    : join(dir, 'bus.sock')
}

/** `ensurePrivateDir` 的选项。 */
export interface EnsurePrivateDirOptions {
  /**
   * 严格模式：chmod 失败时抛错，而不是只失去额外收紧。
   *
   * bus 端点目录必须真的只有属主可访问（socket 文件与 token 都在里面），门禁
   * 失败时宁可让总线不启动；账本目录用宽松模式，权限不足不该阻断插件。
   */
  readonly strict?: boolean
}

/**
 * 递归创建目录并收紧为属主专用权限。
 *
 * `mkdirSync` 的 `mode` 只对「本次新建」生效：目录已存在时（例如同机其他用户
 * 在共享临时目录里预建了同名目录）权限会原样保留，消息正文就会落到别人可读的
 * 位置。因此已存在的目录要显式 chmod 一次；默认忽略 chmod 失败（非属主/Windows
 * 无语义），`strict` 模式下则抛错，由调用方决定是否继续启动。
 * @param dir - 目标目录。
 * @param options - `strict: true` 时把 chmod 失败升级为错误。
 * @throws 严格模式下目录权限无法收紧到 0700。
 */
export function ensurePrivateDir(dir: string, options: EnsurePrivateDirOptions = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch (error) {
    if (options.strict === true) {
      throw new Error(`无法把目录收紧为属主专用权限：${dir}`, { cause: error })
    }
    // 非属主或文件系统不支持权限位：保持现状，仅失去额外收紧。
  }
}
