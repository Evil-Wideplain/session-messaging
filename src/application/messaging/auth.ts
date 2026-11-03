/**
 * 用例共用的授权与身份辅助（应用层）。
 *
 * 把「运行时 Agent / Caller → 身份事实」和「策略拒绝文案」集中在这里：
 * 授权判定本身是领域纯函数（`domain/authorization.ts`），本模块只负责
 * 把依赖与配置投影成它的输入，并给用例提供统一的拒绝说明。
 *
 * @module dsh-plugin-session-messaging/application/messaging/auth
 */

import type { CallerIdentity } from '../../domain/authorization.ts'
import { authorize, identityOf } from '../../domain/authorization.ts'
import type { SessionTarget } from '../../domain/target.ts'
import type { Agent } from '../../types.ts'
import type { SendResult } from '../dto.ts'
import type { Caller } from '../ports.ts'
import type { MessagingContext } from './deps.ts'

/** 把 Agent 或 Caller 统一成 Caller。 */
export function toCaller(principal: Caller | Agent): Caller {
  if ('identity' in principal && 'agent' in principal) return principal
  return { agent: principal, identity: identityOf(principal) }
}

/** 取目标 cwd 作为调用方身份字段，遵循 exactOptionalPropertyTypes。 */
export function identityCwd(target: SessionTarget | undefined): { readonly cwd?: string } {
  return target?.cwd === undefined ? {} : { cwd: target.cwd }
}

/** 取目标 cwd 作为投递发送方事实字段（端口字段名是 senderCwd）。 */
export function senderFactsCwd(target: SessionTarget | undefined): { readonly senderCwd?: string } {
  return target?.cwd === undefined ? {} : { senderCwd: target.cwd }
}

/** 目标的团队名册成员名：目标自带优先，否则按名册查询。 */
export function teammateOf(ctx: MessagingContext, caller: Caller, target: SessionTarget): string | undefined {
  return target.teamMemberName ?? ctx.directory.teamMemberName(caller, target)
}

/** 是否允许向目标投递（不抛错，供 list 过滤）。 */
export function mayDeliver(
  ctx: MessagingContext,
  caller: Caller,
  target: SessionTarget,
  teammate: string | undefined,
): boolean {
  if (target.id === caller.identity.id) return false
  return authDenial(ctx, caller.identity, target, teammate) === undefined
}

/** 授权拒绝说明；允许时返回 undefined。 */
export function authDenial(
  ctx: MessagingContext,
  identity: CallerIdentity,
  target: SessionTarget,
  teammate: string | undefined,
): string | undefined {
  // 团队关系是显式名册授权：名册已经决定谁能联系谁，workspace 策略不覆盖它。
  if (teammate !== undefined) return undefined
  const decision = authorize(identity, target, {
    allowCrossWorkspace: ctx.config.allowCrossWorkspace,
    allowlist: ctx.config.allowlist,
    caseInsensitivePaths: ctx.config.pathCaseInsensitive,
  })
  return decision.allowed ? undefined : decision.reason ?? '没有投递授权'
}

/**
 * 冷唤醒前的 fail-closed 判定。
 *
 * 目标离线且不是队友时，冷唤醒关闭或归档状态不可判定都必须拒绝：唤醒归档
 * 会话会被门禁 blocked 收口，消息静默丢失。
 * @param ctx - 用例上下文。
 * @param target - 目标会话。
 * @param teammate - 目标在调用方团队里的成员名（队友走团队通道，不受此限制）。
 * @param info - 回包里的目标身份。
 * @param messageId - 本次消息标识。
 * @returns 拒绝回包；允许继续投递时返回 undefined。
 */
export function coldWakeRefusal(
  ctx: MessagingContext,
  target: SessionTarget,
  teammate: string | undefined,
  info: { readonly id: string; readonly name: string },
  messageId: string,
): SendResult | undefined {
  if (target.status !== 'offline' || teammate !== undefined) return undefined
  if (!ctx.config.allowColdWake) {
    return {
      status: 'refused',
      messageId,
      target: info,
      detail: '目标会话未运行且冷唤醒已关闭',
    }
  }
  if (!ctx.directory.archiveStateKnown()) {
    return {
      status: 'refused',
      messageId,
      target: info,
      detail: '无法读取会话归档状态，拒绝冷唤醒目标会话；请等目标在线或修复 Workspace 服务后重试',
    }
  }
  return undefined
}

/** 构造目标自己的目标视图（审批时作为接收方）。 */
export function selfTarget(ctx: MessagingContext, caller: Caller): SessionTarget {
  const title = ctx.directory.titleOf(caller.agent.id)
  return {
    id: caller.agent.id,
    ...caller.identity.cwd === undefined ? {} : { cwd: caller.identity.cwd },
    ...title === undefined ? {} : { title },
    kind: 'peer',
    status: caller.agent.status,
  }
}
