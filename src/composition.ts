/**
 * 组合根：把领域模型、应用服务、基础设施适配器装配成一个可用的运行时。
 *
 * 这是唯一知道「接口 → Cordis 实现」映射的地方；`interfaces/` 与 `application/`
 * 都不直接 new 基础设施类，测试可以用假的上下文或假适配器替换。
 *
 * @module dsh-plugin-session-messaging/composition
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { MessagingService } from './application/messaging-service.ts'
import type { InboundRepository, OutboxRepository } from './application/ports.ts'
import { CordisDeliveryGateway } from './infrastructure/cordis-delivery-gateway.ts'
import { CordisSessionDirectory } from './infrastructure/cordis-session-directory.ts'
import { JsonlInboundRepository } from './infrastructure/jsonl-inbound-repository.ts'
import { JsonlOutboxRepository } from './infrastructure/jsonl-outbox-repository.ts'
import { defaultInboundDir, defaultOutboxDir } from './infrastructure/paths.ts'

/** 装配好的运行时。 */
export interface MessagingRuntime {
  /** 应用服务（工具/总线入口）。 */
  readonly service: MessagingService
  /** 出站账本目录（诊断/测试用）。 */
  readonly outboxDir: string
  /** 入站账本目录（诊断/测试用）。 */
  readonly inboundDir: string
  /** 释放网关持有的恢复句柄。 */
  dispose(): void
}

/**
 * 按有效配置装配插件运行时。
 * @param ctx - Cordis 插件上下文。
 * @param config - 已补齐默认值的配置。
 * @returns 应用服务及其生命周期控制。
 */
export function createMessagingRuntime(ctx: Context, config: ResolvedConfig): MessagingRuntime {
  const outboxDir = config.outboxDir ?? defaultOutboxDir()
  // 显式配置 outboxDir 时，入站账本放在它的 inbound 子目录，避免污染全局目录。
  const inboundDir = config.outboxDir === undefined
    ? defaultInboundDir()
    : join(config.outboxDir, 'inbound')
  const log = (message: string): void => { ctx.logger?.warn?.(message) }

  const outboxes = new Map<string, OutboxRepository>()
  const inbounds = new Map<string, InboundRepository>()
  const directory = new CordisSessionDirectory(ctx)
  const gateway = new CordisDeliveryGateway(ctx, log)
  const service = new MessagingService({
    config,
    directory,
    gateway,
    log,
    outbox: (senderId) => {
      const existing = outboxes.get(senderId)
      if (existing !== undefined) return existing
      const created = new JsonlOutboxRepository(outboxDir, senderId)
      outboxes.set(senderId, created)
      return created
    },
    inbound: (targetId) => {
      const existing = inbounds.get(targetId)
      if (existing !== undefined) return existing
      const created = new JsonlInboundRepository(inboundDir, targetId)
      inbounds.set(targetId, created)
      return created
    },
  })
  return { service, outboxDir, inboundDir, dispose: () => gateway.dispose() }
}
