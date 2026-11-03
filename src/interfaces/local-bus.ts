/**
 * 本地总线（接口层）：shell 脚本访问本插件的传输入口。
 *
 * 每个系统用户一个端点（POSIX 是 unix socket，Windows 是命名管道），用每会话
 * 独立的 bearer token 鉴权。token 是「连接 = 某个发送方身份」的唯一依据；
 * 它通过 `ctx.shellEnv` 注入 bash/pwsh 环境，因此脚本的身份就是它所在的会话。
 *
 * 协议：一次连接 = 一条 JSON 请求（换行或 EOF 结束）+ 一条 JSON 响应。
 *
 * ```text
 * {"token":"<token>","op":"list","include_subagents":false,"limit":20}
 * {"token":"<token>","op":"send","to":"<name-or-id>","message":"...","summary":"...","dedupe":true}
 * ```
 *
 * bus 只有 list / send；入站审批只能由目标会话自己的模型通过
 * `review_session_messages` 完成，避免 shell 侧绕过审批。
 *
 * 实现要点：
 * - 连接用 `setEncoding('utf8')`：手工 `chunk.toString('utf8')` 会把跨 chunk
 *   的多字节字符解成 U+FFFD，中文正文静默乱码。
 * - 请求参数与工具层同一套校验：静默忽略错类型会让脚本得到「成功但少行」的结果。
 * - 端点归属显式：POSIX 先连接探测是否有存活宿主，连不上（ECONNREFUSED、
 *   500ms 超时或其它连接错误）才当作陈旧 socket 文件清理，避免第二个宿主
 *   抢走端点、第一个宿主的 stop() 又删掉别人的 socket。
 *
 * 本文件只保留公开导出：实现分散在 `bus/` 子模块（protocol / connection /
 * listener / server / shell-env）。
 *
 * @module session-messaging/interfaces/local-bus
 */

export { LocalBus } from './bus/server.ts'
export { registerShellEnv } from './bus/shell-env.ts'
