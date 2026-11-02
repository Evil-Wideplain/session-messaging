# 路线二 & "把 Agent Team 的子 agent 固化到 session" 设计评估

> 依据：`C:\Code\deepseek-harness`（0.1.3-alpha.1 线，MIT）源码只读核对；前序结论见 [../research/README.md](../research/README.md)。
> 本文回答两个问题：① 路线二到底指什么、值不值得做；② 把 Agent Team 的子 agent 实现"固定到 session 会话上"是否可行、怎么做。

---

## 0. TL;DR

1. **路线二 = 完整 Session Bus**：L1 服务（`ctx.sessionBus`）+ 持久 outbox + Remote 双面 + 可选 Web UI。它不是"多写几个工具"，而是把"会话图"做成产品形态；成本约 **2~4 周**（路线一薄工具层是 **2~5 天**）。
2. **"把 team 的子 agent 固化到 session"方向正确，而且比想象中近**：`TeamId` 本来就是 root `SessionId`，teammate 本来就是一个 subagent 会话。真正要泛化的只有三件事：**地址键（名字 → SessionId）、成员类型（只允许 subagent → 允许普通会话）、mailbox 归属（Lead 日志 → 发送方日志）**。
3. **推荐做法**：插件自建 `sessionBus`，成员分 `derived`（subagent 会话）与 `peer`（普通会话）两种，消息 outbox 记在**发送方**会话日志里；照抄 team 的"queued → 投递 → target 侧 ack"三段式。**不要**直接依赖 `@deepseek-ai/dsh-experimental-agent-team`（private、未发布），也**不建议** fork 上游改。

---

## 1. 路线二到底是什么

### 1.1 定义

路线二 = 把"会话之间能互相发消息"从**插件里的几条工具**升级成**宿主级能力**，也就是一个真正的 Session Bus：

| 层 | 内容 | 路线一 | 路线二 |
|---|---|---|---|
| L0 | 复用官方 `ctx.agents` / `ctx.sessions` / `ctx.subagents` / `ctx.sessionQuery` / `ctx.permissionPresets` | ✅ | ✅ |
| L1 | **新服务** `ctx.sessionBus`：会话注册表、outbox/inbox、投递调度、等待/订阅、生命周期回收 | ❌ | ✅ |
| L2 | 模型工具 `session_create/list/send/wait/inspect` | ✅ | ✅ |
| L3 | **Remote 双面**：`@Remote` 让浏览器 / 外部客户端也能发消息、看会话图 | ❌ | ✅ |
| L4 | **Web UI**：会话图 / 消息面板 / 侧栏集成（可选） | ❌ | 可选 |

一句话：路线一是"给模型加几个工具"；路线二是"给 DSH 加一条会话间通信总线，模型和 UI 都是它的客户端"。

### 1.2 成本参照（官方 team 实现的实际规模）

| 模块 | 文件 | 行数 | 路线二对应物 |
|---|---|---|---|
| 事务/日志 | `packages/experimental/agent-team/src/journal.ts` | 73 | outbox journal（按发送方） |
| 名册/创建/回收 | `roster.ts` | 487 | session registry + 创建/回收 |
| mailbox | `mailbox.ts` | 331 | outbox 投递/ack/恢复 |
| 事件投影 | `projection.ts` | 316 | 会话图投影 |
| 任务板 | `task-board.ts` | 297 | 可选（保留团队语义才需要） |
| 等待 | `activity.ts` | 87 | 直接复用 |
| 类型/校验 | `types.ts` + `validation.ts` + `error.ts` + `persisted.ts` + `invariant.ts` + `session-message.ts` | 约 350 | 大部分直接复用 |
| **合计** | | **约 2 400 行**（另有 ~1 000 行测试） | 自建 ≈ 1 200~1 800 行 |

### 1.3 什么时候才值得上路线二

| 需求 | 路线一够吗 | 需要路线二 |
|---|---|---|
| 模型能建会话、给会话发消息、等结果 | ✅ | — |
| 浏览器 / 其他进程也能发消息、看会话图 | ❌ | ✅ |
| 消息可恢复（发送后崩溃，重启继续投递） | ❌（尽力而为） | ✅ |
| 多会话协作任务板 / 状态可视化 | ❌ | ✅ |
| 只是内部 agent 协作（本会话这种形态） | ✅ 直接启用 Agent Teams | — |

---

## 2. 现状盘点：Agent Team 离"session 化"有多远

先纠正一个直觉：**Agent Team 并不是"另一套 agent 实现"，它本来就架在 session 上。**

| 维度 | 现状 | 已 session 化？ |
|---|---|---|
| 团队身份 | `TeamId` = root `SessionId`（`types.ts:15-25`，注释原文 "Identifies the implicit team rooted at one top-level Session"） | ✅ |
| 成员身份 | 每个 teammate 有 durable `SessionId`（`TeamMemberSnapshot.id`） | ✅ |
| 成员创建 | `roster.spawnAdmitted()` → `ctx.subagents.startContinuable({childId, provider, prompt, parent})`，本质是建 subagent 会话；`context: fresh/fork` 只映射 provider `spawn/fork` | ✅（但 `origin:'subagent'`） |
| 持久状态 | 团队事件写在 **root（Lead）会话日志**：`team/member`、`team/message/queued`、`team/message/delivered`、`team/task`（`projection.ts`） | ⚠️ 绑定 root |
| 消息来源 | `user/message` + `source.kind='team-message'`（复用官方 `form:'relay'` 语义） | ✅ 可复用 |
| 去重/恢复 | `messageAccepted()` 折叠 user/message + inbox；`agent/session-start` 时 `recoverFor()` 重放 | ✅ 可复用 |
| 工具注册 | 每个 agent scope 注册（`tool-agent-team` 监听 `agent/created`；非成员不装） | ✅ 可复用 |
| 等待 | `TeamActivity.wait(10s–1h)`，journal commit 与 `agent/status` 触发 | ✅ 直接复用 |
| 成员可见性 | 不 `prompt` 的 blank 会话侧栏隐藏；`origin:'subagent'` 被 list/tree 过滤，用户打不开 | ❌ |
| 寻址 | 成员名（不可变、kebab-case），不是 SessionId | ❌ |
| 权限硬化 | 只在 subagent seam：sandbox 继承父会话显式 override、approval 钉死 `'never'`、深度 +1 | ⚠️ 仅 derived |

**结论：所谓"固化到 session"，真正缺的不是底层，而是三个语义决定。**

---

## 3. 三种"固化"解读，以及各自要做什么

### 解读 R1：只换寻址键（成员仍是 subagent 会话）

- 保留 `startContinuable` 建成员；把 roster/工具参数从"名字"换成 `SessionId`，事件从 `team/*` 换成 `session-node/*`。
- 得到：与 Team 语义解耦、任意 `SessionId` 寻址、可以在自己的插件里按需注册。
- 不改：成员仍是 `origin:'subagent'`（侧栏不可见、用户不可接管）。
- 工作量：**小**（主要改名册与工具层，mailbox 与投影照抄）。

### 解读 R2：把子 agent 变成普通会话（peer 成员）

- 成员用 `ctx.sessionController.create()` / `ctx.agents.create()` 创建（root、`origin` 为空、侧栏可见），用户可自己打开、继续对话；也可能**收编已存在的会话**。
- 代价：**失去 subagent seam 的三件硬化**（sandbox 继承、approval `'never'`、深度 +1），必须自己补：
  - 创建后显式复制调用者有效权限（`ctx.permissionPresets.set`；`custom` 时退回写 `sandbox/mode` + `approval/policy` 事件）；
  - 自己维护 `delegationDepth` + `maxDepth`（`ctx.subagents` 的 helper 只对 subagent 生效）；
  - 自己的配额（maxNodes / maxPending / maxBytes / 频率）。
- 得到：**会话即代理**——用户能看见、能接管、能被其他会话寻址；可把已有会话拉进协作网络。
- 工作量：**中**（多一套授权/配额/可见性策略）。

### 解读 R3：人人皆 Lead（每个会话都能拥有自己的子图）

- 目标：任意会话都能像 Lead 一样 spawn 自己的成员（嵌套团队）。
- 现状：部分已支持——`tryMembership()` 对"无 parent 的 root"和"不在 roster 里的普通直接子会话"都返回 `role:'lead'`；只有 subagent descriptor 会话不获得嵌套 Team 身份（`roster.ts:88-118`）。限制是工具只在 `agent.created` 时按 membership 安装，且 mailbox 绑定自己的 root。
- 工作量：R1 完成后基本免费（每个会话一个自己的 session 图根）。

### 推荐：**R1 + R2 混合成员**

一个 `SessionBus` 注册表，成员带 `kind`：

| kind | 创建方式 | 可见性 | 硬化 | 适用 |
|---|---|---|---|---|
| `derived` | `ctx.subagents.startContinuable` | 隐藏（侧栏子代理树/计数） | ✅ 自动（沙箱/审批/深度） | 模型派生的一次性/可继续协作者 |
| `peer` | `ctx.sessionController.create` 或收编已有会话 | ✅ 侧栏可见（需已 prompt，blank 会话会被隐藏）、用户可接管 | ⚠️ 插件自补 | 用户想一起看的"工作线索"、跨会话协作 |

工具与 mailbox **统一按 `SessionId` 寻址**，`kind` 只决定"怎么创建、怎么授权、怎么硬化"，不决定"能不能发消息"。

---

## 4. 目标架构

### 4.1 模型

```
SessionGraph
  node  = SessionId（唯一地址，name 只是 label）
  edge  = derived(parent→child) | peer(group) | adopted(用户显式收编)
  root  = 可选锚点（沿用 Team 的 root 概念，但不再要求"Lead 独占 mailbox"）
```

### 4.2 事件设计（关键决定：outbox 归属）

| 方案 | 谁拥有 queued 记录 | 优点 | 缺点 |
|---|---|---|---|
| **S1 发送方日志（推荐）** | 发送方自己的 session log：`session-message/queued`、`session-message/delivered` | 天然跨 root；不依赖"某个中心会话还在"；符合"会话日志是唯一真源" | ack 需要 flush 目标日志；inbound 列表要 fold 自己的 user/message |
| S2 中心 hub（= 现状 Team） | root/Lead 日志 | 实现已验证；顺序与 ack 简单 | 必须共用同一个 root；跨 root 无解 |

S1 落地要点（照抄 Team 的三段式，只换"账本位置"）：

1. `send`：先在**发送方**日志 `append + flush` 一条 `session-message/queued { id, targetId, content, senderId }`（`journal.transact` 串行化）。
2. 投递：目标 live → `steer`（running）/ `followup`（idle）；目标冷 → 先读持久日志判重，再 `ctx.agents.resume({ resumeSessionId })` + `followup`。
3. ack：目标日志出现 `user/message` 且 `source.kind='session-message'`、`source.messageId` 匹配 → 在**发送方**日志写 `session-message/delivered`（先 `ctx.sessions.flush(target)`，再 ack）。
4. 恢复：`ctx.on('agent/session-start')` 重放发送方日志里未 ack 的 queued；`messageAccepted()` 做持久去重（直接复用 `agent-team/src/session-message.ts`，31 行）。
5. 消息来源：`declare module '@deepseek-ai/dsh-llm'` 增加 `session-message`（`form: 'relay'`，带 `messageId/senderId/senderName`），UI 白拿 relay 渲染。

### 4.3 投递路由（插件里的地址解析层）

```
target SessionId
 ├─ ctx.agents.get(id) 命中
 │    ├─ status==='running' → agent.steer(msg)      // 最近 step 边界
 │    └─ status==='idle'    → agent.followup(msg)   // 开新 turn
 ├─ 未命中 且 kind==='derived'
 │    └─ sender 是父 → ctx.subagents.sendMessage(...)（自带血缘校验）
 │       sender 非父 → 需要 host prompt 通道（`steerHostSubagentPrompt`，deep import，稳定性差）
 │                     或改走"父会话转发"（推荐，不碰 internal）
 ├─ 未命中 且 kind==='peer'
 │    └─ 读持久头 → ctx.agents.resume({ resumeSessionId }) → followup
 └─ 每次投递前：授权检查（见 4.4）
```

> 注意：`ctx.subagents.sendMessage` 内部校验"直接父子"；Team 之所以能跨成员发，是因为它 deep import 了 `@deepseek-ai/dsh-subagent/internal` 的 `steerHostSubagentPrompt`（`mailbox.ts:281`）。第三方插件走这条路要接受"internal 可能变"的风险；更稳的是让父会话做转发，或只允许父 → 子。

### 4.4 授权模型（三层，缺一不可）

1. **图边授权**：`derived` 只允许父 ↔ 子（复用 subagent 语义）；`peer` 需要显式边（同一 `cwd`、显式 allowlist、或用户配置的组）。
2. **工作区授权**：跨会话读取/写入沿用 `cwd` 字符串严格相等（`tool-session-query/workspace-access.ts` 的规则），未授权与"不存在"表现一致（防探测）。
3. **用户权限继承**：发消息 = 驱动对方 agent，等于"以调用者身份触发一次 turn"。`peer` 会话的权限必须在创建/收编时显式复制调用者当前有效权限；**绝不能让新会话拿到更高的默认权限**（`pinInitialPermission` 给的是用户默认 preset，不是调用者当前权限）。
4. **破坏性操作**（interrupt / close / delete）挂到 `tools/pre-execute` 的 `ask` 决策，不要硬编码在工具里。

### 4.5 与现有 Team 的关系

- 短期：**并存**。Team 继续负责"本 session 内的隐式团队 + 任务板 + 成员名"；SessionBus 负责"跨会话、按 id、可 peer"。
- 中期：把 Team 变成 SessionBus 的一个 **profile**：teammate 变成 `kind:'derived'` 成员；`team_task_*` 保留为可选能力；`spawn_teammate` 变成 `session_create({kind:'derived'})` 的薄封装。
- 这样避免两套 mailbox 语义长期漂移。

---

## 5. 从 Agent Team 直接复用的清单

| 能力 | 源码 | 复用方式 |
|---|---|---|
| 事务串行化 | `journal.ts` `transact/appendAndFlush` | 按"发送方 SessionId"分尾，逻辑几乎不变 |
| 三段式投递 | `mailbox.ts` `sendAdmitted/tryDispatch/dispatchOnce/checkpointDelivered` | 只换 ack 落点与 target 解析 |
| 去重折叠 | `session-message.ts` `messageAccepted` | **原样复制**（31 行） |
| 冷恢复重放 | `mailbox.ts` `recoverFor` + `agent/session-start` 监听 | 改为按发送方重放 |
| 等待 | `activity.ts` | **原样复制**（87 行，含超时/abort 竞态的边界处理） |
| 事件投影 | `projection.ts` | 改成 `sessionBus` 投影（新事件类型） |
| 成员创建 | `roster.spawnAdmitted` → `startContinuable` | `derived` 成员原样；`peer` 成员换 `sessionController.create` |
| scoped 工具安装 | `tool-agent-team/src/index.ts:396-411` | **原样照抄**（`agent/created` + `tryMembership`） |
| 配额/限流 | `maxMembers/maxPendingMessagesPerMember/maxMessageBytes` | 直接沿用默认值（8/64/65536） |

> 许可证：DSH 与 team 包均为 **MIT**；复制代码需保留版权与许可声明（项目 LICENSE 里加第三方声明即可）。

---

## 6. 分阶段实施

| 阶段 | 内容 | 工作量 | 产出 |
|---|---|---|---|
| **P0** | 路线一薄工具：`session_create/list/send/wait/inspect`；`derived` 走 `startContinuable`，`peer` 走 `sessionController.create`；`send` 尽力而为（无 mailbox） | 2~5 天 | 模型可用；风险最低 |
| **P1** | sender-owned outbox：`session-message/queued|delivered` + `messageAccepted` + 冷恢复重放 + `session_wait` 基于 `agent/status`/journal | +3~5 天 | 消息不丢、可恢复 |
| **P2** | `ctx.sessionBus` 服务化 + `@Remote`（浏览器可发/可看）+ 可选 Web 面板 | +1~2 周 | 路线二完整形态 |
| **P3（可选）** | 把 Team 收敛为 SessionBus 的一个 profile（团队视图 = 会话图 + 任务板） | +3~5 天 | 一套语义 |

**验收点**（每阶段都要有）：`ctx.tools.schemas()` 含全部工具；未授权目标返回"不存在"；崩溃恢复后 queued 消息重投且不重复；`derived` 的沙箱/审批未被放宽；`peer` 会话权限不高于调用者；插件卸载后无 agent 泄漏。

---

## 7. 风险与不推荐做法

| 风险 | 说明 | 规避 |
|---|---|---|
| 依赖 private 包 | `@deepseek-ai/dsh-experimental-agent-team` 是 `private:true`，不随 npm 发布 | 复制模式，不 `import` 它 |
| fork 上游 | 直接改 `packages/experimental/agent-team`，升级即冲突 | 想上游化就提 PR（把 `TeamId` 泛化成 `SessionId`），否则插件自建 |
| deep import internal | `@deepseek-ai/dsh-subagent/internal` 无稳定性承诺 | 优先"父会话转发"；必须直连时在 README 标注版本风险 |
| 可见性语义 | `peer` 会话会出现在侧栏；`derived` 不会；用户可能困惑"哪些是我的会话" | 创建时带标题/描述；`session_list` 区分 kind |
| 权限提升 | 新建 `peer` 会话默认拿用户默认权限 | 显式复制调用者有效权限；`custom` 时写事件 |
| 事件兼容 | 新 `SessionEventMap` 成员进日志；旧版本读不到会怎样 | 只在插件启用时产生；迁移/降级路径写进 README |
| 配额滥用 | 模型可无限建会话、刷消息 | `maxNodes / maxPending / maxBytes / 频率`，超限返回结构化错误 |

---

## 8. 需要拍板

1. **范围**：只做 R1（换键，成员仍是 subagent）？做 R1+R2（混合成员）？还是连 R3（人人皆 Lead）一起？
2. **peer 成员**：允不允许用户接管（侧栏可见、可手动继续）？还是只做"模型可见、用户只读"？
3. **outbox**：S1（发送方日志，推荐）还是 S2（中心 hub，= 现 Team）？
4. **上游化**：要不要给 DSH 提 PR，把 Team 泛化成 session-native？还是长期自己维护插件？
5. **UI**：P2 的 Web 面板是否真的要（不做的话，`pluginInventory` + 侧栏已能看"装没装、有哪些会话"）？

---

## 附录 A：官方 Agent Teams 为什么这样设计（以及哪些约束我们必须继承）

依据：`.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md`、`.agents/notes/implemented/simplification/2026-08-30-team-send-message-steer.zh.md`、
`.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md`、`packages/experimental/agent-team/README.zh.md`。

### A.1 它要解决的问题

subagent seam 已经有 fresh/fork provider、持久 child Session、FIFO follow-up、可冷恢复 Activation，但缺三样：**peer 通讯、稳定具名 roster、共享任务 owner**。同时同进程 agent 共享一个 checkout，文件系统 CAS 之外的写入（bash、formatter、codegen、外部 writer）无法拦截。Team 因此不是"另一个 agent 运行时"，而是在既有 session/subagent 之上补协作语义。

### A.2 关键决策与"为什么不选另一种"

| 决策 | 理由 | 被拒绝的替代方案 |
|---|---|---|
| 每个 root 隐式一个 Team，`TeamId`=`root SessionId`，无 creation event | 不新增生命周期聚合与 join/leave；root 身份即团队身份；fork 继承的 ancestor `TeamId` 记录天然被排除 | — |
| teammate = 预留 `SessionId` 的 continuable 直接 child | 复用持久 child Session、冷恢复、sandbox 继承、`approval:'never'`、`delegationDepth`；reserved id 允许 child 存在前就持久登记 provisioning | 把 peer 权限加进 continuation seam（会削弱 exact-parent authorization，且 roster/task 仍无持久 owner） |
| 只有 Lead 能 spawn / interrupt | 权限边界清晰，防止 teammate 无限繁殖；与"显式权限"哲学一致 | — |
| mailbox 事务 owner 是 **Lead 日志** | Lead 始终 live；提交发送后 target materialization/准入仍可能失败，target 侧只能做 ack 与去重边界 | 把 mail 存进每个 target Session（入队后 target 准入仍可能失败）；内存 mailbox（child settlement/HMR/中断会丢已接受状态） |
| 三段式 `queued → 投递 → delivered` | "成功 = 已持久化"；投递失败留 queued 等恢复；target 日志出现 `user/message` 才算 ack；崩溃窗口由 target 侧 source 折叠去重 | 直接投递（失去入队持久化、恢复、稳定 id、去重） |
| 名字不可变小写 kebab-case，永久占用（含失败） | 模型需要稳定、可读、可复述的地址；`SessionId` 是 opaque 长串；名字不可变避免重映射；失败也占名避免"同名不同人" | — |
| 单一 Steer 调度（无 `followup_task`、无 quiet send） | 两种语义会让模型选择"实现策略"而不是"消息目标"；quiet 消息会为 inactive 目标无限累积；与既有 continuable `send_message` 保持一致 | quiet `send_message` + waking `followup_task`；`followup_task` 做 Steer 别名（只增加工具选择错误） |
| 任务板 CAS `expectedRevision` + DAG + tombstone + `writeScopes` 仅警告 | owner 是持久状态，不因 idle/中断/退出自动释放；陈旧更新必须被拒绝；前缀重叠不能证明语义独立，**假互斥比明确警告更危险** | 把 task owner / write scope 当锁（外部 writer 会绕过，崩溃 owner 永久占用） |
| `wait_agent` 只观察**调用之后**的变化 + `noProgress` 短路 | 目的是替代轮询而非回放历史；调用方醒来后重读权威状态；没有活跃对端时立即返回，避免死等 | — |
| 工具 scoped per agent + 私有 profile + 默认禁用 | 与 `dsh-base` 同名工具冲突（`send_message`/`list_agents`/`interrupt_agent`），所以 profile 先 disable 旧的；主动委派会给简单任务增加延迟与 token；约定未定前不进发布依赖图 | 在默认工具目录启用 Team；把 Team 留在产品职责组只标"显式启用" |
| 每个工具声明完整 result schema + 紧凑 JSON 渲染 | 编译期保证 `execute` 与对模型的承诺一致；避免缩进浪费 token | 未类型化 JSON |
| 不自动创建隔离 worktree | worktree/branch/merge/cleanup 是部署选择；Team 领域不推断；保持 same-world subagent 与 sandbox 契约 | 自动 worktree（改变既有 subagent 行为，且 merge 策略不应由领域猜） |

### A.3 四条设计哲学（README 原话）

1. **持久日志，派生状态**：Lead 日志是唯一真源，roster/mailbox/task 每次从日志回放。
2. **进程内归属**：所有协作在一个进程内，保证是"重试 + 去重"，**不是**跨进程共识。
3. **显式权限**：每个服务方法都接收精确的 live 调用 `Agent`；只有 Lead 能 spawn/reassign/interrupt。
4. **边界大声失败**：限额是校验过的部署值，耗尽时报告类型化错误，绝不复用 id 或名字。

### A.4 代价（官方承认的）

- Lead Session 会随完整 task/member 快照与 ack 增长（用"可独立检查的恢复能力"换"紧凑 delta"）。
- `inactive` 不代表失败；send 可能触发冷恢复延迟。
- 失败成员永久占用名字与 member slot。
- 协调只降低 checkout 冲突概率，不能消除；最终 diff 与测试仍是 Lead 的集成边界。

### A.5 对我们的硬约束 vs 可自由选择

| 必须继承 | 可以重新选择 |
|---|---|
| 事务 owner 唯一 + ack 以 target 日志为准（否则消息会丢/重复） | mailbox 归属：跨 root 时改成 sender-owned（S1） |
| 地址稳定、不复用（名字或 SessionId 均可，但要永久） | 主键用 `SessionId`、名字降为 label |
| 单一调度语义（避免模型选策略） | 是 steer 还是 followup 作为默认（但只给一个） |
| 工具按 agent scope 注册，避免污染与重名 | 是否复用 Team 的任务板 |
| 限额校验 + 类型化错误 + 大声失败 | 具体限额数值 |
| 成员创建复用 subagent 硬化（derived） | peer 成员是否允许（要自己补权限/配额） |
