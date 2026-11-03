/**
 * 总线端点生命周期（接口层）。
 *
 * 每个系统用户一个端点（POSIX 是 unix socket，Windows 是命名管道）。POSIX 上
 * 先探测是否有存活宿主，只有连不上（ECONNREFUSED/超时）才当作陈旧 socket 文件
 * 清理，避免第二个宿主抢走端点、第一个宿主的 stop() 又删掉别人的 socket。
 *
 * 端点被别人占着不是错误场景——GUI 与 `dsh headless` 会同时运行，而默认端点
 * 每用户只有一个。此时退让到进程私有端点（同名加进程号），保证本进程里脚本
 * 注入的 socket/token 仍然可用；不去抢、也不共享别人的总线。
 *
 * @module dsh-plugin-session-messaging/interfaces/bus/listener
 */

import { chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { busEndpoint, defaultSocketDir, ensurePrivateDir } from '../../infrastructure/paths.ts'

/** 探测既有端点时允许的连接等待。 */
const PROBE_TIMEOUT_MS = 500

/** 每用户一个端点的监听生命周期。 */
export class BusListener {
  /** 实际使用的端点；正常等于 `busEndpoint(dir)`，被占用时改为进程私有端点。 */
  private endpointPath: string
  private readonly dir: string
  private server: Server | undefined
  /** 是否真正 listening：只有属主才能清理端点文件，抢端点失败的一方不许删。 */
  private listening = false
  /** 启动过程中被 dispose 时置真：start() 结束时据此自关，避免留下孤儿监听。 */
  private stopped = false
  /** 活动连接；stop 时要主动销毁，否则 server.close 会等到空闲超时。 */
  private readonly sockets = new Set<Socket>()

  /**
   * @param socketDir - 可选的 POSIX 目录覆盖。
   * @param log - 日志出口。
   * @param onConnection - 新连接回调（由 `LocalBus` 提供）。
   */
  constructor(
    socketDir: string | undefined,
    private readonly log: (message: string) => void,
    private readonly onConnection: (socket: Socket) => void,
  ) {
    this.dir = socketDir ?? defaultSocketDir()
    this.endpointPath = busEndpoint(this.dir)
  }

  /** 端点绝对路径（POSIX socket 文件或 Windows 管道名）。 */
  get endpoint(): string {
    return this.endpointPath
  }

  /**
   * 开始监听（端点被占用时退让到进程私有端点）。
   * @throws 私有端点也无法监听时抛错（调用方据此不导出 shellEnv）。
   */
  async start(): Promise<void> {
    // 目录权限是凭据边界的一部分：无法收紧到 0700 时宁可让总线不启动，
    // 也不能把可被同机他人写入的目录当作 token 的落脚点。
    ensurePrivateDir(this.dir, { strict: true })
    try {
      await this.listen(this.endpointPath)
    } catch (error) {
      const fallback = this.fallbackEndpoint()
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[session-messaging] 端点 ${this.endpointPath} 不可用（${detail}），改用进程私有端点 ${fallback}`)
      this.endpointPath = fallback
      await this.listen(this.endpointPath)
    }
    // 启动期间插件已被卸载：立刻关掉，别让一个没人引用的 server 继续监听。
    if (this.stopped) await this.stop()
  }

  /** 进程私有端点：Windows 是同名前缀加进程号，POSIX 是同目录下的 `bus-<pid>.sock`。 */
  private fallbackEndpoint(): string {
    if (process.platform === 'win32') return `${busEndpoint(this.dir)}-${process.pid}`
    return join(this.dir, `bus-${process.pid}.sock`)
  }

  /** 在指定端点上建立监听；失败时清理半成品 server。 */
  private async listen(path: string): Promise<void> {
    if (process.platform !== 'win32') {
      const owned = await this.probeExisting(path)
      if (owned) throw new Error(`端点已被另一个宿主占用（${path}），拒绝抢占`)
      await unlink(path).catch(() => {})
    }
    const server = createServer((socket) => {
      this.sockets.add(socket)
      socket.once('close', () => { this.sockets.delete(socket) })
      this.onConnection(socket)
    })
    await new Promise<void>((resolve, reject) => {
      // 这个监听器必须在成功路径上显式摘掉：留着的 once 会在之后任意一次服务错误时
      // 触发 server.close()，把正在服务的总线关掉。
      const onListenError = (error: Error): void => {
        server.close()
        reject(error)
      }
      server.once('error', onListenError)
      server.listen(path, () => {
        server.off('error', onListenError)
        resolve()
      })
    })
    this.server = server
    this.listening = true
    server.on('error', (error: Error) => {
      this.log(`[session-messaging] 总线服务错误: ${error.message}`)
    })
    if (process.platform !== 'win32') {
      // 目录是 0700，但 socket 文件默认按 umask 创建；显式收紧到 0600。
      await chmod(path, 0o600).catch(() => {})
    }
  }

  /** 停止监听并清理 POSIX socket 文件。 */
  async stop(): Promise<void> {
    this.stopped = true
    const server = this.server
    const owned = this.listening
    this.server = undefined
    this.listening = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    }
    // 只有属主可以删端点：start() 失败的一方若也 unlink，会删掉别人正在监听的 socket。
    if (owned && process.platform !== 'win32') {
      await unlink(this.endpoint).catch(() => {})
    }
  }

  /**
   * 探测端点上是否已有存活宿主。
   * @param path - 端点路径。
   * @returns 能连上返回 true（端点被占用）。
   */
  private async probeExisting(path: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const probe = createConnection(path)
      const done = (occupied: boolean): void => {
        probe.destroy()
        resolve(occupied)
      }
      probe.once('connect', () => done(true))
      probe.once('error', () => done(false))
      probe.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    })
  }
}
