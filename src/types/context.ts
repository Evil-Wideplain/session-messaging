/**
 * Cordis 上下文/事件总线的类型增补（`../types.ts` 的子模块）。
 *
 * 这些 `declare module '@deepseek-ai/cordis'` 增补必须与 `types.ts` 里的导出
 * 一起进入编译单元，否则 `ctx.tools`、`ctx.agents` 等成员在插件代码里不可见。
 * `types.ts` 通过副作用导入本模块来保证这一点。
 *
 * @module dsh-plugin-session-messaging/types/context
 */

import type {
  Agent,
  AgentDefaultModelService,
  AgentPresetsService,
  AgentTeamsService,
  PermissionPresetsService,
  SubagentsService,
} from './agent.ts'
import type {
  Session,
  SessionEvent,
  SessionPersistenceService,
  SessionQueryService,
  SessionTitleService,
} from './session.ts'
import type {
  AgentsService,
  SessionControllerService,
  SessionsService,
  WorkspaceRegistryService,
} from './services.ts'
import type { ShellEnvRegistry, ToolsService } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
    agents: AgentsService
    sessions: SessionsService
    sessionTitle?: SessionTitleService
    sessionQuery?: SessionQueryService
    sessionPersistence?: SessionPersistenceService
    agentTeams?: AgentTeamsService
    subagents?: SubagentsService
    shellEnv?: ShellEnvRegistry
    agentPresets?: AgentPresetsService
    agentDefaultModel?: AgentDefaultModelService
    workspaceRegistry?: WorkspaceRegistryService
    /** 普通会话创建/标题入口；只在 GUI/Web 组合里装配。 */
    sessionController?: SessionControllerService
    /** 权限预设服务；用于把调用方的有效权限复制给新会话。 */
    permissionPresets?: PermissionPresetsService
  }

  interface Events {
    'agent/created'(payload: { readonly agent: Agent }): void
    'agent/disposed'(payload: { readonly agent: Agent }): void
    'agent/error'(payload: { readonly agent: Agent; readonly error: Error }): void
    /** 会话日志事件；`turn/end` 的 `blocked` 是归档门禁的唯一可观察出口。 */
    'session/event'(session: Session, event: SessionEvent): void
  }
}
