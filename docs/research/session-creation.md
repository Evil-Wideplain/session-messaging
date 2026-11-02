# DSH 会话创建能力调研（可行路径 / 可复用 API / 缺口）

> 调研对象：`C:\Code\deepseek-harness`（master，`@deepseek-ai/dsh` 0.1.3-alpha.1 线，**只读**）。
> 目的：为「DSH 会话创建 + 通信工具集」插件（工作目录 `C:\Code\session_history`）评估**会话创建**方向可直接复用的官方能力。
> 方法：只读 `packages/**/src/**/*.ts`（排除 `*.test.ts` 与 `lib/` 编译产物），文档（`docs/subsystems/*.zh.md`）仅用于定位；所有结论均给出源码符号。
> 相关文档：[`session-communication.md`](./session-communication.md)（通信方向）、[`plugin-capabilities.md`](./plugin-capabilities.md)（插件机制 / preset 组合）。

---

## 0. 结论先行

### 0.1 一句话结论

**"创建会话"在 DSH 中是成熟的核心能力，但它只存在于代码层（Host 进程内），模型侧一个工具都没有。**
`ctx.agents.create()`（`@deepseek-ai/dsh-agent` → 由 `@deepseek-ai/dsh-agent-loop` 实现）是**唯一"完整"的会话创建入口**：它同时建立 `Session` + `Agent` + 持久化写句柄 + 目录元数据 + 三条创建公告。其余所有官方创建路径（Web RPC、ACP、SDK、headless、webhook、subagent、workflow、Team）都是它的**不同装箱方式**，不是并列机制。

因此本插件的"创建"半边主要是**挑选正确的已有入口 + 补授权语义**，而不是发明新机制；真正缺的是 §8 的 P0/P1 事项（创建即授权、深度配额、跨会话寻址、完成通知）。

### 0.2 可用性评级

| 评级 | 含义 | 本调研中的对象 |
| --- | --- | --- |
| **A（可直接复用）** | 公开 `ctx.*` 服务方法，`standard` 组合默认装配，签名稳定 | `ctx.agents.create/resume/get/list/roots/isOwnedBy`、`ctx.sessions.create/prepare/enter/announce/fork/get/list/flush`、`ctx.agentPresets.mount/resolve`、`ctx.workspaceRegistry.create/get/list/resolveByPath`、`ctx.sessionPersistence.create/open`、`ctx.sessionQuery.observeSession/listSessions`、`ctx.sessionTitle.rename`、`ctx.permissionPresets.set/derived`、subagent 组合辅助函数（`childSessionMeta` / `applyChildComposition` / 深度 helper） |
| **B（可用但需胶水或有约束）** | 能用，但要么需自己补 preset 组合/授权，要么受所有权/Fiber 生命周期约束，要么需 deep import | `ctx.sessionController.create`（需 `sessionController` 装配）、`ApiSessionAgentController`（未从包根导出）、`ctx.sessions.prepare(seedSource:'persistence')`（冷读用法）、`ctx.agentPresets.composeFrom`（子会话才用） |
| **C（仅 Host / 无模型工具）** | 有 API 但没有模型侧工具，必须新写工具 | 所有创建路径；会话创建**没有任何**模型工具 |
| **D（缺失需自建）** | 官方无实现 | 通用 `create_session` / `fork_session` 工具、跨会话寻址与授权、等待"别的会话结束"、普通的会话间完成通知 |

### 0.3 三个必须先内化的判据

1. **谁调用 `ctx.agents.create()`，新会话就算谁的孩子。** 运行时所有权由**调用方 ctx 的 `ctx.agent`** 决定（`AgentRegistry.enter(agent, ownerCtx.agent)`）。从工具里用 `exec.agent.ctx` 创建 → 新会话被登记为"子代理会话"，会被 Web/API 层**拒绝普通路由**（`hasApiSessionSubagentOwner`）。用插件自身的 ctx 创建 → 才是 root 级普通会话。
2. **只有走 `ctx.agents.*` 才落盘。** `ctx.sessions.create()` 造出来的会话**不持久化**（`SessionStore` 类注释原文："a session published outside that lifecycle persists nothing"）；`sessionPersistence.create()` 全仓只有一个调用点，在 `agent-loop`。
3. **没有 `cwd` 的会话在 UI 里不存在。** `ApiSessionList.list()` 直接 `continue` 掉 `header.cwd === undefined` 的记录；且 `blank`（尚无 `turn/start`）会话只在"当前选中"时可见。**创建完不 prompt 一句，侧栏里看不到。**

---

## 1. 分层模型：一个原语，八种装箱

```
L3 装箱层（每个端一种）   api/session-controller · acp · sdk/server · bundle/headless · webhook · subagent · workflow · team
        │  各自补：preset 组合 / cwd / workspace attach / 授权 / 结果收集
        ▼
L2 产品入口层            ctx.sessionController.create()  →  ApiSessionAgentController.createOrAdopt()
        │  负责：workspace→cwd 解析、mkdir、preset 组合、幂等 (re)adopt、事件广播
        ▼
L1 Agent 层              ctx.agents.create(CreateAgentOptions) → AgentHandle      ← 唯一"完整"入口
        │  负责：Session + Agent + 持久化 + 三条创建公告 + 有序拆除
        ▼
L0 会话存储层            ctx.sessions.create/prepare/enter/announce/fork        ← 纯内存、无 Agent、不落盘
```

### 1.1 全仓生产级创建调用点（`ctx.agents.create` / `ctx.sessions.prepare`，已剔除测试与 `lib/`）

| # | 文件 | 符号 | 语义 |
| --- | --- | --- | --- |
| 1 | `packages/core/agent-loop/src/index.ts:754` | `AgentLoop.createAgent()` | **所有 `ctx.agents.create()` 的唯一实现**（factory） |
| 2 | `packages/core/agent-loop/src/index.ts:689` | `AgentLoop.create()` | 配置驱动的启动期建会话（`new ReactLoopAgent` 直连） |
| 3 | `packages/core/agent-loop/src/index.ts:831` | `AgentLoop.resume()` | 从持久化恢复（唯一 resume 实现） |
| 4 | `packages/api/session-controller/src/agent.ts:435` | `ApiSessionAgentController.createOrAdopt()` | **Web/GUI 的普通会话创建**（L2） |
| 5 | `packages/api/session-controller/src/commands.ts:252` | `SessionCommandController.fork()` | Web 侧 fork（**不**走 `sessions.fork`，见 §4.5） |
| 6 | `packages/acp/acp/src/session.ts:128` | `AcpSession.create()` | ACP `session/new` |
| 7 | `packages/sdk/server/src/server.ts:274` | `DshSdkServer.createSession()` | SDK JSON-RPC 运行时 |
| 8 | `packages/bundle/headless/src/index.ts:184` | `run()` | `dsh -p "<task>"` 一次性任务 |
| 9 | `packages/webhook/webhook/src/session.ts:136` | `createWebhookSession()` | Webhook 触发的普通会话 |
| 10 | `packages/subagent/subagent-in-process-driver/src/index.ts:134` | `startInProcessRun()` | 一次性子代理（spawn / fork provider） |
| 11 | `packages/subagent/subagent/src/continuation.ts:1214` | `SubagentContinuationManager.materializeTracked()` | 可继续子代理（首建 or 冷恢复二选一） |
| 12 | `packages/session-query/session-query/src/observation.ts:119` | `observeSession()` | **只读**：`prepare(..., seedSource:'persistence')` 造 detached 会话，不进 store |
| 13 | `packages/core/agent-loop/src/index.ts:425` / `:480` | `AgentLoop` 构造器遍历 `config.agents` → `create()` / `restoreOrCreateConfigured()` | **声明式配置建会话**（boot 时一次性，见下） |

> **第 13 行是一个容易被忽略的创建通道**：`agent-loop` 的 `Config.agents: (AgentOptions & { id, sessionId?, cwd?, resumeSessionId? })[]`（`index.ts:318-335`），挂载时逐个 `create` 或 `resume`。其 `restoreOrCreateConfigured()` 的语义正好是"**先尝试 resume，只有 `SessionPersistenceNotFoundError` 才新建**"，可作为 `create_session` 幂等语义的官方范式；但它**只在插件启动时消费一次**（JSDoc 明确："`agents` is a boot-time composition array consumed once"），不能用于运行期按需创建。

> 值得注意：**没有任何调用点使用 `ctx.sessions.create()`**（除 `ctx.sessions.fork()` 内部）。生产代码一律走 `prepare`/`enter`/`announce` 或 `ctx.agents.create`。`sessions.create()` 是"便利原语 + 测试/工具"通道。

---

## 2. L0：`ctx.sessions` / `SessionStore`（纯存储层）

源码：`packages/core/session/src/index.ts`（1254 行）、`packages/core/session/src/types.ts`。

### 2.1 签名（逐字）

```ts
// packages/core/session/src/index.ts:925
create(id?: SessionId, options?: CreateSessionOptions): Session
// :958  —— 只构造，不进 store；不 emit session/created
prepare(id?: SessionId, options?: PrepareSessionOptions): Session
// :1008 —— 进 store 并装发布钩子，返回 detach disposer；仍不 emit
enter(session: Session): () => void
// :1063 —— 恰好一次 session/created（同步抛可否决发布）
announce(session: Session): void
// :1117 —— 唯一 flush 入口，返回"是否有 listener 参与"
flush(session: Session): Promise<boolean>
// :1150 / :1158
get(id: SessionId): Session | undefined
list(): Session[]
// :1176
fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session
```

**没有 `resume()`、没有 `load()`、没有 `delete()`。** 恢复由 `ctx.agents.resume()` + `sessionPersistence` 负责；销毁由创建它的 Fiber 负责（`ctx.effect` 里 yield detach disposer）。

### 2.2 `CreateSessionOptions`（`types.ts`）

```ts
interface CreateSessionOptions {
  readonly seed?: readonly SessionEvent[]
  readonly inheritedEventCount?: SessionLogOffset   // meta.isSeeded 为 true 时必填
  readonly meta?: {
    readonly cwd?: string                 // 必须绝对路径（isAbsolute 校验）
    readonly parentSession?: SessionId    // 血缘
    readonly createdAt?: number           // 仅 internal（持久化重建）
    readonly isSeeded?: boolean           // fork 标记
    readonly origin?: 'subagent'          // 只允许这一个字面量
    readonly delegationDepth?: number     // 非负安全整数
    readonly agentPreset?: string
  }
}
```

**注意 `agentPreset` 在 `meta` 里，不在顶层**（任务描述里的"agentPreset 选项"即此处）。

### 2.3 校验到哪一步

| 校验 | 位置 | 说明 |
| --- | --- | --- |
| `id` 冲突 | `prepare` / `enter`（两处都查） | `enter` 是唯一权威碰撞边界（`prepare` 与 `enter` 之间可插任意代码） |
| `cwd` 绝对路径 | `validateSessionHeader()` (`index.ts:112`) | **只校验绝对路径**，不校验存在/可写/是否 workspace |
| `origin` 枚举 | `index.ts:124` | 只接受 `'subagent'` |
| `delegationDepth` | `index.ts:126` | 只校验"非负安全整数"，**不执行任何递归上限** |
| seed 连续性 / JSON 可序列化 / surface 合法 | `Session` 构造函数 `index.ts:541-600` | seed 必须从 seq 0 连续 |
| `isSeeded` ↔ `inheritedEventCount` 一致性 | `index.ts:583-598` | 不一致直接抛 |

结论：**存储层不做权限/工作区/配额校验**。`delegationDepth` 的执行方在 subagent seam（`resolveChildDepth` / tool 的 `maxDepth`），不在 core。

### 2.4 三个"未发布"原语为什么要公开

`prepare` + `enter` + `announce` 的拆分是**契约不是风格**：`agent-loop` 需要把"会话生命周期"折叠进"agent 的同一个 `ctx.effect`"，否则卸载时两个 sibling effect 竞争，driver 的收尾事件会被丢（`prepare` 的 JSDoc 明确写了这一点）。这直接决定了**插件不应自己拼 `sessions.create()` + `agents.register()`**。

### 2.5 detached 会话（`Session.create` / `Session.fromRestore`）

- `Session.create(id, seed?, header?, inheritedEventCount?)`（`index.ts:513`）→ 校验+深拷贝 seed 的**游离对象**，不进 store、不 emit、可多次创建。
- `Session.fromRestore(...)`（`:532`）→ 接管所有权（不拷贝、原地冻结），仅持久化路径用。
- 实际用途：`session-query` 冷读（`observation.ts:119` 用 `prepare(..., {seedSource:'persistence'})` 造短生命周期 detached 会话，`using` 释放）、测试、descriptor 折叠。
- **对一个"创建"工具没有意义**（detached 会话没有 Agent、没人驱动、不落盘）。

### 2.6 持久化边界（最关键的一条）

```
sessionPersistence.create() 的唯一调用点 → packages/core/agent-loop/src/index.ts:720 createStoredSession()
```

`packages/session/session-persistence-jsonl/src/storage.ts:501-520` 的 `install()` 只订阅 `session/event` / `session/flush` / `session/disposed`，并按 `session.id` 路由到**已存在的 writer**。

推论：
- `ctx.sessions.create()` → 无 writer → 事件被丢弃 → **重启即消失**（`ctx.sessions.get()` 也只在当前进程有效）。
- `ctx.agents.create()` → 有 writer → 落盘 → 重启后可由 `sessionQuery` / `sessionController` 冷读或 `ctx.agents.resume()` 恢复。
- 没有挂 `session-persistence` 后端时，**一切创建都是纯内存**（`AgentLoop.createStoredSession()` 里 `persistence === undefined` 直接返回 undefined）。

### 2.7 权限：不在创建时授予，而在 `session/created` 时自动补

`packages/interaction/permission-presets/src/index.ts:245`：

```ts
ctx.on('session/created', (session) => { this.pinInitialPermission(session) })
```

`pinInitialPermission()`（`:404`）语义：
- **全新会话**（无 preset/无 sandbox/无 approval/未 seeded）→ 套用**用户默认 preset**（`this.defaultPreset`）。
- **已被写入过 knobs 的会话**（如 subagent 在 setup 窗口 append 的委派策略）→ 保留已有值，只补缺失项，并把当前 knob 反推成一个 preset 名写入 `permission/preset`。

⚠️ **安全含义**：工具创建的普通会话拿到的是**用户默认权限**，不是**调用者当前会话的权限**。若用户在当前会话里已降权（如只读），新会话反而会以默认（可能更高）权限开跑。要收紧必须像 webhook 那样显式写：

```ts
ctx.permissionPresets.set(handle.agent.session, resolved.permissionPreset)   // webhook/src/session.ts:150
```

subagent 路径则更严格（见 §6.3）：sandbox 继承父会话显式 override，approval 一律钉死 `'never'`。

---

## 3. L1：`ctx.agents` / `AgentRegistry`（唯一完整入口）

源码：`packages/core/agent/src/index.ts`（`AgentRegistry`，`create` 在 `:400`、`resume` 在 `:419`）、实现 `packages/core/agent-loop/src/index.ts`（`createAgent` 在 `:754`）。

### 3.1 `CreateAgentOptions`（`core/agent/src/index.ts:71`）

```ts
interface CreateAgentOptions {
  readonly sessionId: SessionId            // 必填：agent 身份 === 会话身份（1:1）
  readonly meta?: {                        // 与 CreateSessionOptions.meta 同构（去 createdAt）
    cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset?
  }
  readonly inheritedEventCount?: SessionLogOffset
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions     // provider/model/reasoningEffort/maxTokens
  readonly signal?: AbortSignal            // 仅创建期取消
  readonly setup?: AgentSetup              // 发布前的 scoped 组合窗口
}
```

`AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<...> | void`。JSDoc 的一句硬约束值得引用：

> **"Setup composes, it never drives"** —— setup 里只允许组合（注册工具/提示词/模型选择/restrict），不允许驱动 agent。

### 3.2 返回句柄与生命周期

```ts
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
```

`dispose()` = 停 loop → 等退出 → 注销 agent → 从 session store 移除 → 卸载 scoped 世界。**`ctx.agents.get(id)` 只返回裸 `Agent`，句柄只给创建者**。

`AgentLoop.createAgent()` 内部顺序（`:754-830`）：
1. `ctx.sessions.prepare(sessionId, {seed, meta, inheritedEventCount})` → `SessionPreparation`
2. `createStoredSession()` → `sessionPersistence.create(header, {inheritedEventCount})`
3. `setupAndPublish()`：`await setup(agentCtx)` → `setupCommit.commit()` → `appendUnstoredSuffix()`（把 setup 窗口内 append 的事件补写）→ `prepared.publish(source)`
4. `publish()` 内按序：`sessions.enter` → `agents.enter(agent, ownerCtx.agent)` → `sessions.announce`（emit `session/created`）→ `agents.announce`（emit `agent/created`）→ emit `agent/session-start`
5. 任一步失败 → 回滚（关闭持久化 handle、卸载 scoped 世界、配对 disposed）

`AgentLoop.resume()`（`:831`）要求**必须挂 `sessionPersistence`**，否则抛 `cannot resume: session persistence is not configured`。恢复时先用 `persistence.open(id,'write')` 抢占写所有权，再 `read(0)` + `interruptedTurnClosers()` 补写崩溃尾，然后进同一个 publish 事务。

### 3.3 `Agent` 的运行时面（`core/agent/src/runtime-types.ts:110-190`）

```ts
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  readonly status: 'idle' | 'running'
  readonly ctx: Context            // agent 作用域（子代理靠它 join preset）
  send(message, target: 'next-turn'|'next-step', wakeup: boolean): void
  followup(message): void          // 排一轮普通 turn 并唤醒
  steer(message): void             // 就近 step 边界插入；空闲则起一轮
  inject(message): void            // 只投上下文，不唤醒
  cancel(cause, options?): void
  whenIdle(): Promise<void>
  runMaintenance(task): Promise<T>
}
```

这就是"创建完怎么驱动"的答案：**`followup()` 起轮，`whenIdle()` 等停**（headless 与 in-process driver 都是这两步）。

### 3.4 所有权与身份（决定"能不能被 Web 再寻址"）

| 成员 | 位置 | 用途 |
| --- | --- | --- |
| `get(id)` | `:578` | 按 agent/session id 取活 agent |
| `list()` | `:598` | 所有活 agent（注册序） |
| `roots()` | `:608` | **所有 root agent**（`owner === undefined`）——枚举普通顶层会话的现成入口 |
| `isOwnedBy(id, owner)` | `:590` | 运行时所有权判定（与 durable 血缘无关） |
| `register` / `enter` / `announce` | `:445/:469/:544` | 低层原语，供自定义 driver |

`origin: 'subagent'` 是**持久化**分类；`isOwnedBy` 是**进程内**关系；两者都会被 `hasApiSessionSubagentOwner()` 用来拒绝普通路由（见 §4.4）。

---

## 4. L2：`sessionController` / `ApiSessionAgentController`（产品级普通会话入口）

源码：`packages/api/session-controller/src/{index,commands,agent}.ts`。

### 4.1 推荐入口：`ctx.sessionController.create(request)`

```ts
// packages/api/session-controller/src/index.ts:236
@Remote('create')
create(request: SessionCreateRequest): Promise<SessionCreateValue>   // { sessionId, agentPreset? }
```

`SessionCreateRequest`（`types.ts`）：`{ workspaceId?, cwd?, sessionId?, agentPreset? }`。
**`workspaceId` 与 `cwd` 互斥**（同传抛 `gateway/bad-request`）。

`SessionCommandController.create()`（`commands.ts:78`）的完整步骤：

```ts
1  if (workspaceId && cwd) throw RemoteError('gateway/bad-request')
2  sessionId = request.sessionId ?? `session-${randomUUID()}`
3  workspace = workspaceRegistry.get(workspaceId)            // 未知 → workspace/not-found
4  cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
5  adopted = await this.agents.ensureSession(sessionId, cwd,
                /* checkPersistedIdentity */ request.sessionId !== undefined,
                request.agentPreset)
6  if (workspace) await workspace.attachSession(sessionId)     // 失败 → session/workspace-attach-failed
7  return { sessionId, agentPreset: this.agents.presetForSession(adopted.session) }
```

### 4.2 `ensureSession` → `createOrAdopt`（幂等 + (re)adopt）

`ApiSessionAgentController.ensureSession()`（`agent.ts:232`）用 `creations: Map<SessionId, Promise<Agent>>` 去重；`createOrAdopt()`（`:435`）：

1. 已有活 agent → 直接返回（幂等）。
2. `checkPersistedIdentity`（= 调用方显式给了 `sessionId`）→ `sessionQuery.observeSession()` 查持久化：
   - 存在 → **resume**（adopt），并校验 `cwd` 与 `agentPreset` 不得冲突（`ApiSessionCwdConflict` / `ApiSessionPresetConflict`）。
   - 不存在 → 落到新建。
3. `mkdir(cwd, { recursive: true })`（**仅新建路径**）。
4. `composition = await this.composeAgent(presetId)`：
   ```ts
   // agent.ts:374
   const presets = ctx.get('agentPresets')
   if (!presets) return { setup: agentCtx => this.installSelection(agentCtx) }
   const resolvedId = (await presets.resolve(presetId)).id
   return { agentPreset: resolvedId, setup: async agentCtx => {
     this.installSelection(agentCtx)          // 模型选择
     await presets.mount(agentCtx, resolvedId)  // 把 preset 装进 agent 作用域
   }}
   ```
5. `ctx.agents.create({ sessionId, agentOptions: ctx.agentDefaultModel.currentSelection(), meta: { cwd, agentPreset }, setup })`

> **`composeAgent` 是"在 tool 里自建会话"必须抄的那一段**：不 `mount` preset 就建出**裸 agent**（无工具、无提示词）。`plugin-capabilities.md` §2.4 已从组合平面角度讲过同一结论。

### 4.3 创建后的事件广播（为什么 UI 会自动出现）

`packages/api/session-controller/src/index.ts:138`：

```ts
ctx.on('session/created', session => { ctx.emit('api-session/added', this.listState.summaryFor(session)) })
ctx.on('session/disposed', session => { ctx.emit('api-session/removed', session.id) })
```

→ 经 `packages/api/remotes/src/remote-events.ts` 的 `api-session/added` 推给所有客户端，客户端 `sessions.handleSessionAdded`。

**结论：任何走 store 的创建（含 `origin:'subagent'` 的子会话，只要带 cwd）都会立刻广播；插件不需要自己通知 UI。** 但是否**渲染**还受侧栏过滤规则约束（见 §6.1 的"侧栏可见"行、§8-#8）。

### 4.4 API 可寻址性判据（**本插件最容易踩的雷**）

```ts
// packages/api/session-controller/src/agent.ts:80
hasApiSessionSubagentOwner(ctx, session, agent): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)   // ← 运行时所有权
}
```

被判定为 true 时，`resolveAgent()` / `ensureSession()` 一律抛 `ApiSessionSubagentOwnership`（→ Remote 错误 `session/agent-busy`，"use subagent delivery"）。

因此：
- 工具里用 `exec.agent.ctx.agents.create({ meta: { parentSession: caller.session.id } })` → **子代理语义**（即使 `origin` 不填）→ Web 侧无法 resume / 无法 prompt，只能在 `send_message` 通道里活。
- 想要"普通会话"，必须满足：`origin` 非 `subagent` **且** 创建时的调用 ctx 无 `ctx.agent`（用插件自身的 ctx 或 `ctx.sessionController.create()`）。

### 4.5 `ctx.sessions.fork()` vs RPC `session.fork`（两条不同的 fork）

| | `ctx.sessions.fork(source, boundary?, childId?)` | RPC `sessionController.fork()` |
| --- | --- | --- |
| 位置 | `core/session/src/index.ts:1176` | `api/session-controller/src/commands.ts:193` |
| 源 | **必须是活会话**（`_resolveForkSource` 要求 `get(id) === source`，否则 `SESSION_NOT_LIVE`） | **可以是冷会话**（`sessionQuery.observeSession()`） |
| 边界语义 | 调用方给 `SessionSeq`，含该 seq 的前缀，禁止在 open turn 内结束 | 给 `atSeq` → 找**第一个 `turn/end` ≥ atSeq**，再向后对齐到下一个 `turn/start` |
| 产物 | 只有 `Session`（无 Agent、不落盘） | `ctx.agents.create({seed, inheritedEventCount, meta:{parentSession, isSeeded:true}})` + workspace attach |
| 错误码 | `SessionForkError`: `SESSION_NOT_FOUND / SESSION_NOT_LIVE / SESSION_ALREADY_EXISTS / INVALID_BOUNDARY / OPEN_TURN` | `session/fork-unavailable`（"has no completed turn to fork from"） |

**给插件 fork_session 的结论**：要"fork 一个可能已经冷掉的会话"，只能抄 RPC 路径（observe → 找 turn/end → create with seed）；`ctx.sessions.fork()` 只适合当前进程内的活会话。

---

## 5. L3：其余官方创建路径逐一核对

| # | 路径 | 关键代码 | cwd | preset | 持久化 | UI 可见 | 可再寻址 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Web/GUI 新建会话 | `sessionController.create()` | workspace 路径或显式 | ✅ `mount` | ✅ | ✅（非 blank 时） | ✅ |
| 2 | Web fork | `commands.fork()` | 继承源 | ✅ | ✅ | ✅ | ✅ |
| 3 | ACP `session/new` | `AcpSession.create()`（`acp/src/session.ts:128`） | `options.cwd` | ❌ 只装 MCP + 模型选择 | ✅ | ✅ | ✅（外部 ACP 客户端） |
| 4 | SDK 运行时 | `DshSdkServer.createSession()`（`sdk/server/src/server.ts:274`） | `this.cwd` | ❌ 显式注释"no preset composition" | ✅ | ✅ | 仅 SDK 会话内 |
| 5 | headless `dsh -p` | `run()`（`bundle/headless/src/index.ts:184`） | `process.cwd()` | ❌ | ✅ | ✅ | 否（进程即焚） |
| 6 | webhook | `createWebhookSession()`（`webhook/src/session.ts:136`） | workspace（自建） | ✅ `mount` + **显式 permissionPreset** | ✅ | ✅ | ✅ |
| 7 | subagent 一次性 | `startInProcessRun()`（`subagent-in-process-driver:134`） | 父 cwd | △ 只有 `applyChildComposition`（join 父 preset，不 mount 命名 preset） | ✅ | ❌ | `send_message` 拒绝（one-shot） |
| 8 | subagent 可继续 | `continuation.materializeTracked():1214` | 父 cwd（经 `childSessionMeta`） | join 父 preset | ✅ | ❌（仅父行下的计数） | ✅ `send_message` |
| 9 | Team 成员 | `roster.spawnAdmitted()` → `ctx.subagents.startContinuable()`（`agent-team/src/roster.ts:282`） | 父 cwd | join | ✅ | ❌（`list_agents`/侧栏子代理树） | ✅ `send_message`（成员名/`lead`） |
| 10 | workflow 子代理 | `host.ts:355` `this.subagents.start(this.provider, ...)` | 父 | 同 one-shot | ✅ | ❌ | ❌ |
| 11 | goal round | **不创建会话**，在现有 agent 上起轮（`goal-round-driver` 只 `whenIdle` / `sessions.flush`） | — | — | — | — | — |
| 12 | `cordis_define` + `cordis_run` | `packages/extensions/tool-cordis`，模型可写 Host 侧插件代码，理论上可调 `ctx.agents.create()` | 自定 | 自定 | 自定 | 自定 | 自定 |

> 第 12 行是**唯一现存的"模型侧间接创建会话"通道**：不是专用工具，而是"模型写代码 → 代码建会话"，重、危险、需 `dynamicCordisRunner` 装配，且不构成产品能力。

### 5.1 Web 侧"新建会话"的按钮链路（供对照）

`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:148,195` → `startSession()` → `ui-workspace/src/client/navigation.ts:114` `connectWorkspace()` → `sessions.create({ workspaceId })` → RPC `session.create`。

`connectWorkspace()` 有一个**复用空会话**的细节（`navigation.ts:99-107`）：同 Workspace 下已有 `blank && cwd === workspace.path && 未归档` 的会话就直接返回它。**这解释了为什么"创建了但没 prompt"的会话不会堆积——UI 自己会回收。** 插件若预建会话，需自己承担这个语义。

---

## 6. 会话语义对比表（创建方向的"决策矩阵"）

### 6.1 六种"会话"的权威对照

| 维度 | 普通会话（sessionController） | 一次性子代理（spawn/fork） | 可继续子代理（continuable） | Team 成员 | ACP 会话 | SDK 会话 |
| --- | --- | --- | --- | --- | --- | --- |
| 创建符号 | `ctx.agents.create` via `createOrAdopt` | `startInProcessRun` → `parent.ctx.agents.create` | `startContinuable` → `materializeTracked` | `startContinuable`（同左） | `AcpSession.create` | `createSession` |
| 继承父上下文 | ❌（全新） | spawn ❌ / fork ✅ 已完成轮前缀 | ✅ 由 provider 决定（spawn→无，fork→前缀） | context `fresh`/`fork` | ❌ | ❌ |
| `parentSession` | 通常无（fork 时有） | ✅ | ✅ | ✅ | ❌ | ❌ |
| `origin: 'subagent'` | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `delegationDepth` | 无（=0） | +1 | +1 | +1 | 无 | 无 |
| 持久化 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 侧栏可见 | ✅ | ❌ | ❌（父行计数） | ❌ | ✅ | ✅ |
| 模型可再寻址 | ❌ **无工具** | ❌ | ✅ `send_message` | ✅ `send_message`/`wait_agent` | ❌ | ❌ |
| 可等待结果 | ❌（只能 `whenIdle` 于活 agent） | ✅ `SubagentRun.result` | ❌（推送式 `subagent-settled` notice） | ✅ `wait_agent` | ✅ ACP prompt 响应 | ✅ JSON-RPC 响应 |
| 可中断 | ❌（无工具） | ✅ `run.dispose()` | ✅ `interrupt_agent` | ✅ `interrupt_agent` | ✅ ACP cancel | ✅ |

### 6.2 `tool-subagent` 与 Team `spawn_teammate` 的真实差别

- **`tool-subagent`**（`packages/subagent/tool-subagent/src/index.ts`）是**单次委派**：`parameters = {description, prompt, run_in_background?, provider/model/reasoning_effort?}`；`backgroundMode: 'one-shot'` 时后台=Job（`job_output`/`job_kill` 收集），`'continuable'` 时后台返回 durable 子会话 id（`send_message` 继续）。
- **`spawn_teammate`**（`packages/experimental/tool-agent-team/src/index.ts:174`）**不是另一种创建机制**：`context` ∈ `{fresh, fork}` 直接映射到 provider `spawn` / `fork`，然后调 `ctx.subagents.startContinuable({childId, provider, label, request:{prompt, parent: root}})`（`roster.ts:282`）。差别全在**上层编排**：Team 有 Lead/roster/journal、durable mailbox（`mailbox.ts`）、共享 task board（`team_task_*`）、`wait_agent`，且强制 `backgroundMode` 必为 continuable。
- 一句话：**`tool-subagent` = 委派原语（可能一次性）；`spawn_teammate` = 可继续子代理 + 团队簿记 + 命名寻址。**

### 6.3 subagent 路径的授权硬化（普通会话创建默认**没有**这一层）

`packages/subagent/subagent/src/child-agent.ts`：

```ts
// :49 resolveChildDepth —— 深度 = delegationDepthOf(parent)+1，超 maxDepth 抛 SubagentDepthError
// :138 childSessionMeta —— cwd/agentPreset 继承父、parentSession、origin:'subagent'、delegationDepth
// captureDelegatedPolicyOverrides —— 只捕获父会话【显式】sandbox override；approval 一律 'never'
// appendDelegatedPolicyOverrides —— 以 source:'delegation' 写 sandbox/mode、approval/policy
// applyChildComposition —— presets.composeFrom(childCtx, parent.ctx) + SUBAGENT_DELEGATION_CONTEXT + persona/toolFilter
```

配合 tool 层 `tool-subagent.maxDepth`（默认 3）与 `assertSubagentMaxDepth`，构成**完整的递归预算 + 权限收敛**。

**任何自建 `create_session` 工具若不复用这些 helper，就会得到一个"无深度限制、无 sandbox 收敛、approval 取默认"的会话。** 这是本方向最大的授权缺口。

---

## 7. 官方是否已有"模型侧创建普通会话"的工具？——没有

### 7.1 现有"会创建东西"的模型工具全清单（已核对 `packages/**/src/**/*.ts` 中的 `tools.register`）

| 工具 | 包 | 创建什么 |
| --- | --- | --- |
| `subagent`（名可配） | `subagent/tool-subagent` | 一次性/可继续**子代理会话**（`origin:'subagent'`） |
| `list_subagent_models` | 同上 | —（只读） |
| `spawn_teammate` | `experimental/tool-agent-team` | **Team 成员**（= 可继续子代理） |
| `send_message` / `interrupt_agent` / `list_agents` | `subagent/tool-subagent-control` | —（控制，仅直接父子） |
| `team_task_*` / `wait_agent` | `experimental/tool-agent-team` | — |
| `workflow`（名可配） | `workflow/tool-workflow` | 脚本编排的子代理（`subagents.start`） |
| `ralph` | `workflow/tool-ralph` | 每轮一个全新子代理 |
| `cordis_define` / `cordis_run` | `extensions/tool-cordis` | 动态插件（间接可建会话，非产品语义） |
| `session_search` / `session_event_*` / `session_trace` | `session-query/tool-session-query` | —（只读，cwd 授权） |

**没有任何工具能创建"普通会话"（root、`origin` 为空、侧栏可见）。** 也没有 `fork_session` 工具（fork 只在 Web RPC 与 `sessions.fork()` 上）。

### 7.2 为什么不能"直接用 `subagent` 当 create_session"

| 需求 | `subagent` 工具 | 普通会话 |
| --- | --- | --- |
| 侧栏/`sessionController.list()` 里作为独立会话出现 | ❌ `origin:'subagent'` 被 `sessionVisible` 过滤 | ✅ |
| 用户能自己打开、继续对话 | ❌ 走 subagent 通道（`ApiSessionSubagentOwnership`） | ✅ |
| 会自然继承父会话的权限/深度收敛 | ✅（好事） | ❌ 默认无 |
| 作为"独立工作线索"与调用者平级 | ❌ 天然从属 | ✅ |

即：**语义不同，不能互相替代**（这也正是插件存在的理由）。

---

## 8. 缺口清单

### P0（不补就做不出可信的 create_session）

| # | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | **无模型侧创建普通会话的入口** | 工具清单（§7.1）无任何创建 root 会话者 | 必须新写工具 |
| 2 | **无"创建即授权"模型** | `pinInitialPermission` 用**用户默认 preset**（`permission-presets:404-413`）；subagent 的收敛逻辑（§6.3）是 subagent seam 私有 | 工具可越权造出比调用者权限更高的会话 |
| 3 | **无深度/配额约束** | `CreateSessionOptions.meta.delegationDepth` 仅校验类型（`session/index.ts:126`），无执行方 | 模型可无限造会话（资源耗尽） |
| 4 | **所有权语义隐形** | `hasApiSessionSubagentOwner`（`agent.ts:80`）由**调用 ctx** 决定结果 | 用错 ctx → 造出"UI 打不开"的会话，且无报错提示 |

### P1（决定插件好不好用）

| # | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| 5 | **无跨会话寻址** | `send_message` 要求 `parentSession === sender.id` + continuable descriptor（`continuation.ts:583/1442`）；`session-query` 只读且 cwd 授权 | 创建完无法再对话（通信方向已详述） |
| 6 | **无"等待别的会话结束"** | `Agent.whenIdle()` 需要**活 Agent 引用**；无 durable "settled" 事件给普通会话（`subagent-settled` 只对子代理） | 只能轮询 `status`/`list`，否则拿不到结果 |
| 7 | **无完成通知** | `subagent-settled` 由 continuation manager 专属投递（`subagent.zh.md`:"无条件投递"）；普通会话无等价机制 | 模型无法得知自建会话干完了 |
| 8 | **blank 会话被 UI 隐藏** | `ui-workspace/src/client/tree.ts:145` `sessionVisible()`：`!blank \|\| id === current` | 预建会话"看不见"，用户困惑 |
| 9 | **fork 能力分裂** | `sessions.fork` 只吃活会话；RPC fork 才能吃冷会话（§4.5） | fork_session 工具必须自己拼 turn/end 对齐 |

### P2（工程细节）

| # | 缺口 | 证据 |
| --- | --- | --- |
| 10 | `ApiSessionAgentController` 未从包根导出 | `session-controller/package.json exports` 只有 `.`/`./types`/`./client`/`./typert`/`./remote`/`./src/*` |
| 11 | `SUBAGENT_DELEGATION_CONTEXT` 未从包根导出 | `subagent/src/index.ts` 导出清单含 `applyChildComposition` 等，但不含该常量 |
| 12 | 创建工具没有统一"会话 id 命名"策略 | 各处自定：`session-${randomUUID()}`（web/rpc）、`session-${n}`（store 计数）、`randomUUID()`（subagent）、`webhook-${uuid}`、调用方传入（SDK / ACP） |
| 13 | 无会话级预算声明 | `AgentOptions` 只有 `provider/model/reasoningEffort/maxTokens`（且 `maxTokens` 是**单次请求**输出上限），没有回合预算或成本上限 |
| 14 | 无"从 workspace 目录列表 + 最近会话"辅助 | `workspaceRegistry.list()` + `sessionQuery.listSessions()` 需自己拼 |

---

## 9. 设计建议：三条路线

### 路线 A（**推荐**）：委托 `ctx.sessionController.create()`

```ts
// 伪代码
const { sessionId, agentPreset } = await ctx.sessionController.create({
  cwd: requestedCwd ?? caller.session.header.cwd,   // 或 workspaceId
  sessionId: modelProvidedId,                        // 显式 id → 幂等 adopt（可重试！）
  agentPreset: config.defaultPreset,
})
const agent = ctx.agents.get(sessionId)              // 已发布，可直接驱动
```

- ✅ 自动获得：workspace→cwd 解析、`mkdir`、**preset mount**、幂等 adopt、cwd/preset 冲突检测、`api-session/added` 广播、应用级生命周期所有权（不受插件 fiber 卸载影响）。
- ✅ 与 Web 完全同构 → 侧栏、标题、模型选择、权限 UI 全部正常。
- ⚠️ 需 `sessionController` 装配（`web-app` bundle 默认有；headless/CLI 没有 → 需要 fallback）。
- ⚠️ 仍是"用户默认权限"（§8-#2），**必须**在创建后把调用者的有效 preset 复制过去：`ctx.permissionPresets.set(newSession, ctx.permissionPresets.current(callerSession))`（`current()` 返回 `custom` 时 `set()` 会抛，需退回直接写 `sandbox/mode` + `approval/policy` 事件，参照 `appendDelegatedPolicyOverrides`）。
- ⚠️ 会阻塞等 `create` 完成（含 mkdir/observe），注意 `exec.signal` 传递（该方法**不接受** signal，取消只能靠外层 race）。

### 路线 B：直接 `ctx.agents.create()` + 自己抄 `composeAgent`

```ts
const presets = ctx.get('agentPresets')
const composition = presets === undefined
  ? {}
  : { agentPreset: (await presets.resolve(config.preset)).id }
const setup: AgentSetup = async (agentCtx) => {
  installModelSelection(agentCtx, { current: ctx.agentDefaultModel.currentSelection(), assembled: undefined })
  await presets?.mount(agentCtx, composition.agentPreset)
}
const handle = await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: composition.agentPreset }, agentOptions, setup, signal: exec.signal })
```

- ✅ 不依赖 `sessionController`（headless/CLI 也能用），能传 `signal`。
- ⚠️ 必须自己 `mkdir`、自己 `workspaceRegistry.attachSession`、**必须** mount preset；`api-session/added` 广播无需自己发（`sessionController` 已监听 `session/created`）。
- ⚠️ 所有权=插件 fiber：插件重载/卸载会拆掉会话 → 需要评估（或持有 handle 到插件生命周期，或接受）。
- ⚠️ 若在 `exec.agent.ctx` 上调用 → 变成子代理语义（§4.4）→ **务必用插件闭包 ctx**。

### 路线 C：复用可继续子代理通道

`ctx.subagents.startContinuable({ childId, provider, label, request: { prompt, parent: caller } })`

- ✅ 立刻获得：授权硬化（sandbox 继承 + approval `'never'` + 深度 +1）、durable descriptor、`send_message` 可寻址、`interrupt_agent`、`list_agents`、完成通知。
- ❌ 生成的是 `origin:'subagent'` 会话：侧栏不可见、Web 不能普通打开、不能作为独立线索继续。
- ✅ 适合作为插件的**"派生子会话"模式**（`derived: true`），与路线 A/B 并存。

### 推荐组合

| 模型请求 | 实现路线 | 结果语义 |
| --- | --- | --- |
| `create_session({cwd, title, preset})` | **A**（fallback B） | root、侧栏可见、用户可接管 |
| `fork_session({sessionId, atSeq?})` | 抄 RPC fork（observe + turn/end 对齐）或 `sessions.fork`（源活时） | root 子会话，`parentSession`+`isSeeded` |
| `create_session({derived: true, parent: ...})` | **C**（`startContinuable`） | 子代理，可 send_message / 等待 / 通知 |

---

## 10. 实施前必须核对的检查表

1. **【所有权】** 创建调用必须发生在**不携带 `ctx.agent`** 的 ctx 上（插件闭包 ctx 或 `ctx.sessionController`）。否则会话会被判定为子代理（`hasApiSessionSubagentOwner`），Web 侧永久 `session/agent-busy`。
2. **【cwd】** 必须绝对路径且已存在（`createOrAdopt` 会 `mkdir`）；**无 cwd 的会话不会出现在 list**（`list.ts:138`）。
3. **【blank】** 只创建不 prompt → `sessionListMetadata.blank === true` → 侧栏隐藏（除非当前选中）。要么创建后让模型/用户马上发一句话，要么接受"看不见"。
4. **【preset】** 不 mount preset = 裸 agent（无工具/无提示词）。`agentPresets` 缺席时（headless）跳过。
5. **【权限】** 创建后按调用者有效 preset 显式复制（`permissionPresets.current/ set`，`custom` 时退回写事件）；不要依赖默认值。
6. **【深度】** 若要支持 derived 会话，`delegationDepth: delegationDepthOf(caller) + 1`，并在工具层做 `maxDepth` 检查（复用 `assertSubagentMaxDepth`）。
7. **【持久化】** 依赖 `ctx.sessionPersistence` 存在；不存在时降级为内存会话，必须在工具结果里如实说明（否则模型会以为可以重启后再访问）。
8. **【id 冲突】** `AgentRegistry.enter()` / `SessionStore.enter()` 是唯一权威碰撞边界；乐观重试需捕获 `session "X" already exists`。
9. **【fork】** `sessions.fork` 只吃活源；冷源必须 observe + `turn/end` 对齐，且拒绝 open turn。
10. **【取消】** `ctx.agents.create` 支持 `signal`（创建期取消）；`sessionController.create` 不支持 → 需要外层 race + 失败后清理。

---

## 11. 关键文件索引

### 核心（必读）

| 文件 | 关键符号 | 行 |
| --- | --- | --- |
| `packages/core/session/src/index.ts` | `SessionStore.create/prepare/enter/announce/fork/flush/get/list`、`Session.create/fromRestore`、`SessionForkError` | 887 / 925 / 958 / 1008 / 1063 / 1117 / 1176 / 1150 / 1158；513/532 |
| `packages/core/session/src/types.ts` | `SessionHeader`、`CreateSessionOptions`、`PrepareSessionOptions`/`RestoredSessionOptions`、`SessionId`、`SESSION_FORMAT_VERSION=2` | 91 / 135 / 163 / 17 |
| `packages/core/agent/src/index.ts` | `CreateAgentOptions`、`ResumeAgentOptions`、`AgentHandle`、`AgentFactory`、`AgentRegistry.create/resume/get/list/roots/isOwnedBy` | 84 / 142 / 172 / 179 / 400 / 419 / 578 / 598 / 608 / 590 |
| `packages/core/agent/src/runtime-types.ts` | `Agent` 运行时面（`send/followup/steer/inject/cancel/whenIdle/session/ctx/options/status`）、`AgentOptions` | 110-190 / 27 |
| `packages/core/agent-loop/src/index.ts` | `AgentLoop.createAgent`（唯一 factory 实现）、`createStoredSession`、`resume`、`publish` 事务 | 754 / 720 / 831 / 652-685 |
| `packages/core/session/src/preparation.ts` | `SessionPreparation`（`using` 释放未发布会话） | 23 |

### 产品入口层

| 文件 | 关键符号 | 行 |
| --- | --- | --- |
| `packages/api/session-controller/src/index.ts` | `SessionController.create`（`@Remote('create')`）、`session/created → api-session/added` | 236 / 138 |
| `packages/api/session-controller/src/commands.ts` | `create()` 全流程、`fork()`（RPC fork） | 78 / 193 |
| `packages/api/session-controller/src/agent.ts` | `hasApiSessionSubagentOwner`、`ensureSession`、`composeAgent`、`createOrAdopt`、冲突错误类 | 80 / 232 / 374 / 435 / 33-62 |
| `packages/api/session-controller/src/list.ts` | `list()`（cwd 过滤）、`applySessionListMetadata`（blank） | 126 / 43-50 |
| `packages/client/ui-workspace/src/client/tree.ts` | `sessionVisible()`（`origin==='subagent'` 与 blank 过滤） | 145 |
| `packages/client/ui-workspace/src/client/navigation.ts` | `connectWorkspace()`（复用 blank 会话） | 90-115 |

### 组合 / 授权 / 持久化

| 文件 | 关键符号 | 行 |
| --- | --- | --- |
| `packages/preset/agent-presets/src/index.ts` | `resolve/mount/composeFrom/composedPreset/standingKeyFor` | 343/414/455/475/741 |
| `packages/interaction/permission-presets/src/index.ts` | `session/created` 监听、`pinInitialPermission`、`set` | 245 / 404 / 379 |
| `packages/workspace/workspace/src/index.ts` + `types.ts` | `workspaceRegistry.create/get/list/resolveByPath`、`Workspace.attachSession` | 157/180/276；79 |
| `packages/session/session-persistence/src/index.ts` | `create/open/stat/list`、`SessionPersistenceCreateOptions` | 146/161/190/197；61 |
| `packages/session/session-persistence-jsonl/src/storage.ts` | `install()`（`session/event|flush|disposed` 路由） | 499-520 |
| `packages/session/session-title/src/index.ts` | `sessionTitle.rename(session, title)` | 400 |

### 对照路径（子代理 / 编排）

| 文件 | 关键符号 | 行 |
| --- | --- | --- |
| `packages/subagent/subagent/src/child-agent.ts` | `childSessionMeta`、`resolveChildDepth`、`resolveChildAgentOptions`、`applyChildComposition`、`captureDelegatedPolicyOverrides`、`appendDelegatedPolicyOverrides` | 138 / 49 / 98 / 199 / 242 / 258 |
| `packages/subagent/subagent/src/depth.ts` | `delegationDepthOf`、`assertSubagentMaxDepth` | 28 / 42 |
| `packages/subagent/subagent-in-process-driver/src/index.ts` | `startInProcessRun()`（`parent.ctx.agents.create`） | 108-160 |
| `packages/subagent/subagent/src/continuation.ts` | `startContinuable`、`sendMessage`、`coldResume`、`materializeTracked`、`authorizeLineage` | 229 / 583 / 1067 / 1214 / 1442 |
| `packages/subagent/subagent/src/descriptor.ts` | `subagent/descriptor`、`SUBAGENT_DESCRIPTOR_VERSION=3` | 48 |
| `packages/subagent/tool-subagent/src/index.ts` | `apply`、`subagent` 工具注册、`backgroundMode` 策略 | 306 / 372 / 523-556 |
| `packages/subagent/tool-subagent-control/src/{index,list-agents}.ts` | `send_message`、`interrupt_agent`、`list_agents` | 29 / 77 / 75 |
| `packages/subagent/tool-subagent/src/list-models.ts` | `list_subagent_models` 注册 | 86 |
| `packages/experimental/agent-team/src/roster.ts` | `spawnAdmitted` → `startContinuable` | 282 |
| `packages/experimental/tool-agent-team/src/index.ts` | `spawn_teammate`、`context: fresh/fork` → provider | 174 / 195 |
| `packages/acp/acp/src/session.ts` | `AcpSession.create`（`session/new`） | 128 |
| `packages/sdk/server/src/server.ts` | `createSession`（无 preset 组合） | 274 |
| `packages/bundle/headless/src/index.ts` | `run()`（`agents.create` + `followup` + `whenIdle` + `sessions.flush`） | 184 |
| `packages/webhook/webhook/src/session.ts` | `createWebhookSession()`（含显式 permissionPreset + title） | 136 |
| `packages/session-query/session-query/src/observation.ts` | `observeSession()`（detached 冷读） | 119 |
| `packages/session-query/tool-session-query/src/workspace-access.ts` | `authorizeTarget`、`headerAuthorized`（cwd 字符串相等授权） | 75 / 96 |

### 官方文档（定位用）

- `docs/subsystems/session.zh.md` —— §"活跃会话 fork API"（:587）、`Session`/`SessionStore` 契约、`session/end-seed` 语义
- `docs/subsystems/subagent.zh.md` —— §"两类能力，两种发现方式"、`listChildren/listDescendants`（:263）、§"进程内后端：深度与种子"（:457）
- `docs/subsystems/agent-team.zh.md` —— `TeamId` = root `SessionId`、durable mailbox
- `docs/subsystems/persistence.zh.md`、`docs/subsystems/workspace.zh.md`（:122 "先建会话再 attach"）、`docs/capability-seams.zh.md`（:480 `ctx.sessions` 行）

---

## 12. 未验证 / 需要拍板

1. **`ctx.sessionController.create()` 在 headless / CLI 组合中是否存在**（`web-app` bundle 明确包含；`bundle/headless` 未确认）→ 决定路线 A 是否要 A/B 双实现。
2. **创建会话的插件 Fiber 生命周期取舍**：接受"插件卸载=会话被拆"，还是把 handle 交给更长寿命的 owner（目前没有现成的"应用根 owner"注入点）。
3. **是否允许模型指定 `cwd`**（跨目录/跨 workspace 创建）：官方所有路径都从调用者或 workspace 派生 cwd，没有"模型任意指定绝对路径"的先例；session-query 的授权模型是 **cwd 字符串相等**，若允许任意 cwd 则读侧授权需同步放宽。
4. **`derived: true` 模式的默认 provider 选择**：`spawn` 还是 `fork`（继承上下文）——取决于"派生会话是否应看到父会话历史"的产品决策。
5. **创建配额**：官方无任何 per-parent 会话数量限制；需要插件自己定（参照 Team 的 `maxMembers`、`maxPendingMessagesPerMember` 做法）。
