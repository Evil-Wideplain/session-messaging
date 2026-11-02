# DSH「会话创建 + 通信」工具集 —— 前期调研总结

> 调研对象：`C:\Code\deepseek-harness`（master，`@deepseek-ai/dsh-*@0.1.3-alpha.1` 线，**只读**）。
> 目的：在动手设计「会话创建 / 会话间通信」工具集之前，先查清官方已有的现成能力，避免重造轮子。
> 细节见三份分方向报告：
> - [session-creation.md](./session-creation.md) —— 会话创建：路径、所有权、preset 组合、权限
> - [session-communication.md](./session-communication.md) —— 通信：投递原语、三条通道、mailbox、事件
> - [plugin-capabilities.md](./plugin-capabilities.md) —— 插件机制：bundle/preset 平面、工具注册、模板、版本坑
>
> 结论日期：2026-11-01

---

## 0. 一句话回答

**框架有、底座有、成品没有。**

- **服务层（A 级，可直接复用，不要重写）**：建会话 `ctx.agents.create` / `ctx.sessionController.create`、preset 组装 `ctx.agentPresets.mount`、发消息 `Agent.steer/followup/inject`、父子投递 `ctx.subagents.sendMessage`、团队投递 `ctx.agentTeams.sendMessage`、读取检索 `ctx.sessionQuery`、持久化 `ctx.sessionPersistence`。
- **工具层（只有"专用版"，没有"通用版"）**：`subagent`（委派子会话）、`spawn_teammate`（团队成员，**实验性、默认禁用**）、`send_message`/`interrupt_agent`/`list_agents`（**默认装载，但锁死"直接父 ↔ 直接可继续子"**）。全库 grep `create_session` / `list_sessions` / `new_session` **零命中**。
- **成品插件（不存在）**：没有任何可直接 `dsh plugin add` 的官方或社区插件提供这套能力；唯一被官方点名的第三方 bundle 示范是 `turtle-ui`（Web 皮肤）。

> 一个重要的现状补充：**你这台 GUI 当前已经启用了 Agent Teams**（本会话里就有 `spawn_teammate` / `send_message` / `wait_agent` / `team_task_*` 9 个工具，来自 `packages/experimental/agent-team-profile` 这个 opt-in 层）。所以"持久子会话 + 发消息 + 等待 + 任务板"这套**现在就能用**，只是它被绑定在"隐式 Team Lead"身份上，且是实验性 `private: true` 包。

---

## 1. 结论矩阵：想要的能力 vs 官方现状

| 目标能力 | 现成最接近的东西 | 它是什么 | 缺口 | 需要自写？ |
|---|---|---|---|---|
| `create_session`（建普通 root 会话） | `ctx.sessionController.create()` / `ctx.agents.create()` + `agentPresets.mount()` | L1/L2 服务层，**无模型工具** | 中性工具、授权、深度配额、幂等语义 | ✅ 要（薄层） |
| `list_sessions`（列会话） | RPC `session/list`（Web 侧）、`ctx.sessionQuery.listSessions()` | Host/服务层，模型够不到 | 工具 + workspace 授权 | ✅ 要（薄层） |
| `send_message`（发给任意会话） | `send_message`（tool-subagent-control，默认装载）、Agent Team 的 `send_message` | 只允许**直接父子**或**同 Team 成员** | 按 `SessionId` 任意寻址 | ✅ 要（核心） |
| `wait_session`（等某会话结束） | `wait_agent`（仅 Team）、`Agent.whenIdle()`、`job_output` | 需 Team 身份 / 活 Agent 引用 | 通用等待 + 完成通知 | ✅ 要（中等） |
| `fork_session` | RPC `session.fork`、`ctx.sessions.fork()` | 前者可吃冷会话，后者只吃活会话 | 统一包装 + `turn/end` 对齐 | ✅ 要（薄层） |
| 读取历史/检索 | `session_search` / `session_event_*` / `session_trace`（5 个，**opt-in 未默认装载**） | 只读，cwd 授权 | 无（直接复用/启用） | ❌ 不用写 |
| 会话创建原语 | `ctx.sessions.prepare/enter/announce/fork` | 纯内存、不落盘 | — | ❌ 不用写 |
| 持久 subagent + 通信 + 等待 + 任务板 | `@deepseek-ai/dsh-experimental-tool-agent-team` 9 工具 | 实验性、默认禁用、绑定 Team 身份 | 通用化 / 去 Team 化 | ⚠️ 可选：直接启用 vs 自写 |

**判定**：真正要新写的是**一层薄工具 + 授权/寻址/等待语义**，而不是服务层。工作量集中在 3 个点（见 §4）。

---

## 2. 现状全景：三条通信通道，互不连通

| 通道 | 谁能给谁发 | 寻址键 | 默认启用 | 持久性 | 实现位置 |
|---|---|---|---|---|---|
| **相邻 agent 通道** | 直接父子（双向） | `SessionId` | ✅ 默认装载 | 消息落 inbox 事件 | `packages/subagent/tool-subagent-control` + `ctx.subagents` |
| **Agent Team 通道** | 同一 Team 内任意两人（Lead⇄teammate、teammate⇄teammate） | 成员名 / `lead` | ❌ 实验性 opt-in（`agent-team-profile`） | ✅ durable mailbox（queued → delivered 三段式 + 冷恢复重放） | `packages/experimental/agent-team` + `tool-agent-team` |
| **Host/RPC 通道** | 外部客户端 → 任意**普通会话** / 直接子代理 | `sessionId` | ✅ 但**无模型工具** | 无独立 queued 记录，靠 inbox 事件 | `packages/api/session-controller`、SDK、ACP |

**核心事实**：

1. 所有投递最终收敛到 `Agent.send / followup / steer / inject`（`packages/core/agent/src/runtime-types.ts:150-188`）——这是唯一应该复用的底座。
2. 消息来源有官方扩展点：`MessageSourceMap` declaration merging，`form: 'relay'` 的语义就是"另一个 agent 发给本 agent 的消息"（`packages/llm/llm/src/message.ts:50-128`），插件应复用 `relay` 并自定义 `kind` 携带 `messageId` 做去重。
3. **不存在**"按 session id 给任意会话发消息"的一等 RPC/工具；`sessionController.prompt` 还会**拒绝**被 subagent 拥有的会话（`hasApiSessionSubagentOwner`，`packages/api/session-controller/src/agent.ts:80`）。
4. **不存在**统一 mailbox 服务：`TeamMailbox` 是 `agent-team` 包内部类，没有 `declare module` 到 `ctx.*`。

---

## 3. 创建会话的"正确姿势"与四个坑

**唯一完整入口**：`ctx.agents.create(CreateAgentOptions)`（`AgentLoop` 实现）——同时建 `Session` + `Agent` + 持久化写句柄 + `session/created` / `agent/created` / `agent/session-start` 三条公告。`ctx.sessions.create()` 只造内存会话，**不落盘**（重启即消失）。

推荐直接复用产品入口 `ctx.sessionController.create({ workspaceId?, cwd?, sessionId?, agentPreset? })`（`packages/api/session-controller/src/index.ts:236`）：它帮你做 workspace→cwd 解析、`mkdir`、preset 组装、幂等 adopt、cwd/preset 冲突检测、`api-session/added` 广播。

四个必须避开的坑：

| # | 坑 | 事实 | 规避 |
|---|---|---|---|
| 1 | **建出裸 agent** | 模型侧工具在 **agent preset**（`standard`），不在 bundle；不 `ctx.agentPresets.mount(agentCtx, id)` 就没有 bash/fs/子代理 | 抄 `composeAgent()`（`session-controller/src/agent.ts:374`） |
| 2 | **所有权落在调用方 ctx 上** | `ctx.agents.create` 的 owner 是**调用 ctx 的 `ctx.agent`**；在工具里用 `exec.agent.ctx` 创建 → 会话被判定为子代理，Web 侧永久 `session/agent-busy` | 用**插件闭包 ctx** 或走 `ctx.sessionController.create` |
| 3 | **没有 cwd 的会话在 UI 里不存在** | `ApiSessionList.list()` 直接跳过 `header.cwd === undefined`；blank（未 prompt）会话只在选中时可见 | 显式给 cwd；创建后尽量紧随一次 prompt，或接受"侧栏暂时不可见" |
| 4 | **权限不跟着调用者走** | `pinInitialPermission` 给新会话套**用户默认 preset**，不是调用者当前（可能已降权的）preset | 创建后显式 `ctx.permissionPresets.set(newSession, callerPreset)`；`custom` 时退回写 `sandbox/mode` + `approval/policy` 事件 |

另外：`ctx.sessions.fork()` 只接受**活会话**；要 fork 冷会话必须走 RPC 路径（observe → 找 `turn/end` ≥ atSeq → 对齐到下一个 `turn/start` → create with seed）。

---

## 4. 缺口清单（合并三份报告，按优先级）

**P0（不补就做不出可信的工具集）**

1. 无模型侧"建普通会话"的入口（现有 `subagent` / `spawn_teammate` 都绑定角色语义）。
2. 无"创建即授权"：新会话默认拿用户默认权限，可能高于调用者当前权限；subagent 的 sandbox 继承 + `approval:'never'` 收敛逻辑是 subagent seam 私有，未导出。
3. 无深度/配额执行方：`meta.delegationDepth` 只校验类型，无上限；官方没有任何 per-parent 会话数限制。
4. 所有权语义隐形：用错 ctx 会静默造出"UI 打不开"的会话，无报错提示。

**P1（决定好不好用）**

5. 无跨会话寻址（`send_message` 锁定直接父子 / Team 成员）。
6. 无通用"等待某会话结束"（`whenIdle()` 需要活 Agent 引用；`subagent-settled` 只对子代理）。
7. 普通会话无"完成通知"等价机制。
8. blank 会话被侧栏隐藏（`ui-workspace/src/client/tree.ts:145`）。
9. fork 能力分裂（活/冷两条路径）。

**P2（工程细节）**

10. 工具名雷区：`send_message` / `interrupt_agent` / `list_agents` 已占用，**同层重名注册直接失败** → 新工具必须用 `session_*` 前缀（或像 agent-team-profile 那样先 disable 既有行，不推荐）。
11. prompt 段没有官方槽位：`getSectionOrder()` 只认封闭常量表 → 复用 `TOOL_SUBAGENT` 等既有 key 或直接给数字 `order`。
12. npm 版本坑：官方包 `latest` 停在 `0.0.1-rc.1`，checkout 的 `0.1.3-alpha.1` 未发布，`^0.1.3-alpha.2` 匹配不到 `0.1.5-alpha.1` / `0.2.x` → 建议只用 `import type` + 原始 JSON Schema `ToolDefinition` 注册，`dsh-tools` 仅作 devDependency。
13. 运行时版本待核对：本机 GUI 是 asar 打包，未解包确认内部 `@deepseek-ai/dsh-*` 版本线。

---

## 5. 三条可选路线（这是需要你拍板的核心选择）

### 路线 0：不写代码，直接启用官方 Agent Teams（零开发）

- 现状：`packages/experimental/agent-team-profile` 一个 patch 层就能启（**你这台机器已经启用了**）。
- 得到：`spawn_teammate`（持久 teammate）、`send_message`（成员名寻址）、`wait_agent`、`list_agents`、`team_task_*` 共享任务板、durable mailbox。
- 局限：绑定"隐式 Team Lead"身份；实验性 `private: true`，API 可能变；**普通会话不可寻址**；在 root 层 disable 了原有的 `tool-subagent-control` 同名工具。
- 适合：内部协作型工作流（就是本会话正在用的形态）。

### 路线 1（推荐）：薄工具层 + bundle 组合层，新写 `session_*` 工具

内部再分三种创建语义（互不替代）：

| 工具/模式 | 底层 | 产物 |
|---|---|---|
| `session_create` | `ctx.sessionController.create`（fallback：`ctx.agents.create` + 手抄 `composeAgent`） | root 普通会话，侧栏可见、用户可接管 |
| `session_fork` | 冷源抄 RPC fork（observe → `turn/end` 对齐）；活源用 `ctx.sessions.fork` | root 子会话（`parentSession` + `isSeeded`） |
| `derived: true` | `ctx.subagents.startContinuable` | `origin:'subagent'` 子代理：自带 sandbox 继承、`approval:'never'`、深度 +1、`send_message`/`interrupt`/完成通知 |


- 单包（现有 `dsh-plugin-session-history` 骨架就是它），`cordis.patch.yml` 插一行，`apply()` 里注册 3~5 个 `defineTool` + 1 个 prompt 段。
- 复用：`ctx.sessionController.create`（或 `ctx.agents.create` + `composeAgent`）、`Agent.steer/followup`、`ctx.agents.get/list/roots`、`ctx.subagents.sendMessage`（父子场景）、`ctx.sessionQuery`（列/读/授权）、`permissionPresets`。
- 自写：地址解析路由、授权（cwd 相等 + 创建者/目标关系）、可选 mailbox、`wait` 实现、错误脱敏。
- 建议工具名（避开 root 层已占用）：
  - `session_create`、`session_list`、`session_send`、`session_wait`、`session_inspect`、`session_fork`（可选）
- 建议 Config：`defaultPreset`、`allowRootSessionCreation`（默认 false）、`inheritCwdOnly`（默认 true）、`maxChildSessions`、`maxSendBytes`、`waitTimeoutMs`、`authorizeByWorkspace`。
- 模板：`packages/session-query/tool-session-query/src/*`（6 文件结构 + workspace-access + service-boundary + presentation）、`tool-subagent-control/src/index.ts`（最薄工具层 60 行）、`session-controller/src/agent.ts#composeAgent`（建会话）。

### 路线 2：完整 Session Bus（服务层 + Remote + Web UI）

- 在路线 1 之上加：`ctx.sessionBus` 服务、durable mailbox（照抄 Team 的 queued→deliver→ack 三段式）、`@Remote` 双面（浏览器也能发）、Web 侧栏/面板。
- 成本高一个数量级，建议等路线 1 跑通、确有跨端需求再做。
- 详细设计（含"把 team 子 agent 固化到 session"的三种解读与实施阶段）见 [../design/session-bus.md](../design/session-bus.md)。

**推荐组合**：路线 1 为主；`derived` 模式（建"可继续子代理"）内部复用 `ctx.subagents.startContinuable`；确有需要时再评估路线 2。

---

## 6. 建议的最小插件蓝图（路线 1 落地版）

```
dsh-plugin-session-history/
├─ cordis.patch.yml            # insert: [{ id: session-tools, name: dsh-plugin-session-history, config: {...} }]
├─ src/index.ts                # name/inject/Config/apply：注册工具 + prompt 段
├─ src/input.ts                # JSON Schema + 参数归一化
├─ src/operations.ts           # 每个工具一个 execute*
├─ src/access.ts               # 调用者身份 + workspace 授权（抄 session-query/workspace-access.ts）
├─ src/service-boundary.ts     # 错误脱敏白名单（抄）
├─ src/presentation.ts         # 纯文本 + presentCall 卡片（抄）
└─ tests/index.test.ts         # 组装级：schemas() 里出现全部工具名 + 授权拒绝用例
```

关键约束：

- **身份只从 `exec.agent` 取**，`cwd`/`sessionId`/`preset` 由调用者会话派生，永不让模型自由指定 cwd（除非显式配置）。
- **所有权**：用插件闭包 ctx 创建（root 普通会话）或复用 `sessionController.create`；`derived` 模式才用调用者 ctx 建子代理。
- **工具名**：`session_*` 前缀，不碰 `send_message`/`interrupt_agent`/`list_agents`。
- **依赖**：`import type` + 原始 JSON Schema `ToolDefinition`，避免 peer 版本线被 prerelease 规则锁死。
- **持久性**：依赖 `ctx.sessionPersistence`；缺席时降级为内存会话并在工具结果里如实说明。
- **清理**：持有的 `AgentHandle` 用 `Map` + `ctx.effect` 统一 dispose，避免插件卸载后泄漏。

---

## 7. 待你拍板

1. **范围**：只做"父子/派生会话"（薄封装 `ctx.subagents`，工作量小）还是做"跨 lineage 任意会话寻址"（需自建授权 + 唤醒 + 去重，工作量大一个数量级）？
2. **形态**：路线 0（直接用 Agent Teams）够不够？还是必须做中性 `session_*` 工具？
3. **权限**：新会话是否要继承调用者当前权限（更安全，但要处理 `custom` preset）；是否允许模型指定 `cwd`（跨目录创建）？
4. **第一版是否做 Web UI**：建议不做（`plugin-inventory` 已能看"装没装、active 没 active"）。
5. **运行时版本**：是否需要先解包 `app.asar` 核对本机 `@deepseek-ai/dsh-*` 版本，再定 peer 依赖范围？
