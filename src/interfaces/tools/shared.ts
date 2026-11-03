/**
 * 模型工具共用件：参数校验、调用方派生、文本清洗与共享 schema。
 *
 * 这些函数只做「形状 + 类型」校验，错误文案稳定可测；业务规则仍在应用服务
 * 与领域层。四个工具的 schema 里共用 target / held / outcome 三段，集中在这里
 * 避免各工具各自复写一遍。
 *
 * render 的输出是「一行一条」的结构化文本，而其中 sender、summary、会话名、
 * title、cwd 等字段来自其他会话或模型本身：它们只要带一个换行，就能伪造出
 * 新的结果行（例如假冒一条已裁决记录），所以动态文本一律先过 {@link inlineText}。
 *
 * @module session-messaging/interfaces/tools/shared
 */

import type { ReviewOutcome } from '../../application/dto.ts'
import type { Caller } from '../../application/ports.ts'
import type { ToolExecution } from '../../types.ts'
import { identityOf } from '../../domain/authorization.ts'

/** 拒绝非普通对象参数。 */
export function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('参数错误：需要一个对象')
  }
  return args as Record<string, unknown>
}

/** 读取必填字符串参数。 */
export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数错误："${key}" 必须是非空字符串`)
  }
  return value
}

/**
 * 读取必填字符串参数，但允许空白内容。
 *
 * 只给 `create_session_agent` 的 prompt 用：空/纯空白不是参数格式错误，而是
 * 应用层要判定的业务拒绝（refused）。工具层如果先抛错，就会把文档承诺的
 * `refused` 语义变成工具异常，模型拿不到可辨认的状态。
 * @param args - 已确认是普通对象的参数。
 * @param key - 参数名。
 * @returns 原样字符串（不 trim，空白判定交给应用层）。
 */
export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`参数错误："${key}" 必须是字符串`)
  }
  return value
}

/** 读取可选字符串参数。 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`参数错误："${key}" 必须是字符串`)
  return value
}

/** 读取可选布尔参数。 */
export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`参数错误："${key}" 必须是布尔值`)
  return value
}

/** 读取可选整数参数并校验闭区间。 */
export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`参数错误："${key}" 必须是 [${minimum}, ${maximum}] 范围内的整数`)
  }
  return value
}

/**
 * 拒绝宿主未拦截的未知顶层参数（宿主不执行 `additionalProperties`）。
 *
 * 多个未知参数时按字典序取第一个报错，保证错误文案稳定可测。
 * @param args - 已确认是普通对象的参数。
 * @param allowed - 该工具声明的顶层参数名。
 */
export function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key)).sort()
  const first = unknown[0]
  if (first !== undefined) throw new Error(`参数错误：未知参数 "${first}"`)
}

/**
 * 按字符（码点）截断文本，超出时以省略号结尾。
 * @param text - 原始文本。
 * @param maximum - 最大显示字符数（含省略号）。
 * @returns 截断后的文本。
 */
export function clipText(text: string, maximum: number): string {
  const points = [...text]
  if (points.length <= maximum) return text
  return `${points.slice(0, Math.max(maximum - 1, 0)).join('')}…`
}

/**
 * 把动态文本压成不会破坏渲染结构的单行文本。
 *
 * 换行、U+2028/U+2029（行/段分隔符）与 C0/C1 控制字符都替换成空格：render
 * 按「一行一条」组织输出，残留的换行或行首 `- ` 会被模型当成新的结果行。
 * 连续空白折叠后 trim；可选按 {@link clipText} 截断，避免对端用超长文本撑爆
 * 模型上下文。
 * @param value - 原始文本；`undefined` 视为空串。
 * @param maximum - 可选的显示字符上限（含省略号）。
 * @returns 单行、已 trim、可选截断的文本。
 */
export function inlineText(value: string | undefined, maximum?: number): string {
  const flattened = (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return maximum === undefined ? flattened : clipText(flattened, maximum)
}

/** 挂起消息在模型可见渲染里的 preview / summary 上限（字符）。 */
export const RENDER_PREVIEW_CHARS = 120

/** 取运行时验证过的调用方；缺失时直接失败。 */
export function callerOf(exec: ToolExecution, tool: string): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${tool} 需要调用方 Agent（exec.agent 为空）`)
  }
  return { agent, identity: identityOf(agent) }
}

/** 目标 id/name 对，发送结果与候选共用。 */
export const targetSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['id', 'name'],
}

/** 呈现给审批者的一行挂起消息。 */
export const heldSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string' },
    sender: { type: 'string' },
    sender_id: { type: 'string' },
    summary: { type: 'string' },
    preview: { type: 'string' },
    created_at: { type: 'integer' },
    expires_at: { type: 'integer' },
  },
  required: ['message_id', 'sender', 'sender_id', 'summary', 'preview', 'created_at', 'expires_at'],
}

/** 挂起消息的裁决终态；schema enum 与 DTO `ReviewOutcome.status` 对齐。 */
const OUTCOME_STATUSES: readonly ReviewOutcome['status'][] = [
  'accepted',
  'refused',
  'denied',
  'failed',
  'expired',
  'not_found',
]

/** 一条裁决结果。 */
export const outcomeSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string' },
    sender: { type: 'string' },
    status: { type: 'string', enum: OUTCOME_STATUSES },
    detail: { type: 'string' },
  },
  required: ['message_id', 'sender', 'status'],
}
