/**
 * 跨装载行共享的 Cordis 服务契约。
 *
 * 组合包在 `cordis.patch.yml` 里拆成两行（两个组件）：
 * - `session-messaging`：主行，装配运行时并注册 list / send / review 三个工具；
 * - `session-creation`：创建行，只注册 `create_session_agent`。
 *
 * 两行在同一进程里，但插件闭包不共享，所以主行把创建会话服务 provide 到
 * {@link SESSION_MESSAGING_SERVICE}，创建行 inject 它。关掉创建行只少一个工具，
 * 不影响主行；关掉主行则创建行等依赖、工具一并消失（这是有意的依赖方向）。
 *
 * @module session-messaging/shared/service
 */

import type { SessionCreationService } from '../application/session-creation-service.ts'

/** Cordis 服务名：主行 provide，创建行 inject。 */
export const SESSION_MESSAGING_SERVICE = 'sessionMessaging' as const

/** 主行提供给创建行的运行时切片。 */
export interface SessionMessagingRuntimeService {
  /** 创建会话应用服务；与主行共用同一份配置、目录与限额。 */
  readonly creation: SessionCreationService
}
