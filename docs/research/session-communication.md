# DSH 会话间通信调研（可行性 / 可复用 API / 缺口）

> 调研对象：`C:\Code\deepseek-harness`（master，`@deepseek-ai/dsh` 0.1.3-alpha.1 线，只读）。
> 目的：为"DSH 会话创建 + 通信工具集"插件（工作目录 `C:\Code\session_history`）评估**会话间通信**方向可直接复用的官方能力。
> 方法：只读 `packages/**/src/*.ts`（排除 `*.test.ts`、`lib/` 产物），以源码为准，文档仅作定位。

---

## 0. 结论先行

### 0.1 一句话结论

DSH **已经有完整、生产级的"agent 之间投递消息"基础设施**，但它被切成三条**互不连通**的通道，且都以**血缘/成员资格**为准入门槛：

| 通道 | 谁能给谁发 | 寻址键 | 状态 |
| --- | --- | --- | --- |
| 相邻 agent 通道 | 直接父子（双向） | `SessionId`（agent id） | 稳定，默认启用 |
| Agent Team 通道 | 同一 Team 内任意两名成员（Lead ⇄ teammate、teammate ⇄ teammate） | 成员名 `name` / `lead` | 实验性，opt-in |
| 主机/RPC 通道 | 外部客户端 → 任意"普通会话"或"直接子代理" | `sessionId` / 子代理地址 | 稳定，但**不含模型工具** |

**不存在**"向任意已存在会话（不限血缘、不限 Team）发消息"的官方一体化 API，也**不存在统一 mailbox 服务**（`TeamMailbox` 是 `agent-team` 包内部类，未注册为 `ctx.*` 服务）。这正是本插件要补的空白。

### 0.2 可用性评级

| 评级 | 含义 | 本调研中的对象 |
| --- | --- | --- |
| **A（可直接复用，默认启用）** | 公开 `ctx.*` 服务 / 已注册模型工具，在 `standard` 预设中默认装配 | `ctx.subagents.sendMessage/interrupt/listChildren/listDescendants`、`Agent.steer/followup/inject/send/cancel/whenIdle`、`ctx.agents.get/list/create/resume`、`ctx.sessions`、`ctx.sessionQuery`、`send_message`/`interrupt_agent`/`list_agents`、`subagent`/`subagent_fork` |
| **B（可用但需 opt-in / 实验）** | `private: true` 包、需专用 profile 层，API 可能变动 | Agent Team 全家桶（`ctx.agentTeams`、`spawn_teammate`、`team_task_*`、`wait_agent`） |
| **C（仅 Host/Remote 侧，模型不可见）** | 只能在 Host 进程内调用或经 WebSocket RPC 调用，没有模型工具 | `sessionController.create/prompt/fork/list/search`、`subagents.prompt`（Remote）、`ctx.agents.resume`、`ctx.agents.create`、SDK `session/prompt`、ACP `session/prompt` |
| **D（需自建）** | 官方无实现 | 统一 mailbox、任意会话寻址、跨 workspace 投递策略、消息级权限、`wait`/订阅式回调工具 |

### 0.3 缺口速览（详见 §7）

1. **无统一 mailbox**：只有 Team 内部的 `TeamMailbox`（durable、有 ack、有恢复），普通会话之间没有任何队列语义。
2. **普通会话不可由模型寻址**：`send_message` 只接受"直接子代理/直接父级"；普通根会话只能靠 Host 侧 `sessionController.prompt`（需客户端 RPC，且以 `source:{kind:'user', rpcId}` 记为用户输入）。
3. **无 `wait` 类工具**：稳定工具集里没有 `wait`/`wait_agent`；`wait_agent` 只存在于实验性 Team；子代理完成是**推送式**（`subagent-settled` notice）而非可等待。
4. **跨 workspace 无策略**：子代理 `cwd` 强制继承父会话（`child-agent.ts:146`），但"给另一个 workspace 的会话发消息"既无 API 也无约束模型。
5. **消息级权限缺失**：只有血缘/成员资格授权，没有"这条会话是否允许被谁唤醒"的权限模型；也没有频率/大小限制的通用层（Team 内部有 `maxPendingMessagesPerMember=64`、`maxMessageBytes=65536`，不可复用）。

---

## 1. 模型侧工具全景（逐个源码核对）

### 1.1 相邻 agent 通信工具（`packages/subagent/tool-subagent-control`）

包 `@deepseek-ai/dsh-tool-subagent-control`（**公开包，默认启用**：`packages/preset/agent-presets/presets/standard/agent.cordis.yml:174-178` 装载 `tool-subagent-control` + `tool-subagent-control/list-agents`；`cordis`/`ptc` 预设同）。

| 工具 | 参数 | 返回 | 源码 |
| --- | --- | --- | --- |
| `send_message` | `agent_id`（直接可继续子代理 id，或本人为常驻子代理时的直接父级 id）、`message` | `{ messageId }` | `src/index.ts:28-74` |
| `interrupt_agent` | `agent_id`（直接子或更深后代） | `{ accepted: true }` | `src/index.ts:76-116` |
| `list_agents` | `scope?: 'children' \| 'descendants'` | `Array<{kind:'child', id, label, status, parent?, depth?} \| {kind:'diagnostic', reason}>` | `src/list-agents.ts:92-192` |

关键语义（全部来自源码/工具 description，非 README）：

- **寻址**：`agent_id` 就是 `SessionId`，经 `brandString<SessionId>` 直接喂给 `ctx.subagents.sendMessage(sender, targetId, content, {signal})`。`list_agents` 的 `descendants` 只用于发现，**`send_message` 仅限 depth-1 条目**，"更深条目只能作为 `interrupt_agent` 候选"（`src/list-agents.ts:105-106`）。
- **状态三态**：`running`（有活驱动）/`idle`（常驻 Agent 在轮次之间，可能在等自己启动的子代理）/`ready`（只剩持久记录，可冷恢复）。由 `statusOf()` 用 `ctx.agents.get(id)` 实时采样（`src/list-agents.ts:59-63`）——**不是**持久结论。
- **单向限制**：子代理只能发给**直接父级**，且要求自己是"常驻可继续子代理"（`continuation.ts:597-608`：非常驻则抛 `UNAUTHORIZED`）。
- **投递语义**：模型侧 `send_message` **固定 steer**（`continuation.ts:610-613`），即"running 目标在最近 step 边界消费；idle/ready 目标开新 turn"。
- **快照不是投递承诺**：`list_agents` 明确声明 snapshot 不保证投递成功，`send_message` 才做权威检查（`src/list-agents.ts:101-102`）。
- **失败即未送达**：`send_message` 的 tool description 明确 "A failure means the message was NOT delivered"。

### 1.2 Agent Team 工具（`packages/experimental/tool-agent-team`，**实验性**）

`@deepseek-ai/dsh-experimental-tool-agent-team`，`"private": true`，仅在 `agent-team-profile` 这一私有 profile 层里装配（`packages/experimental/agent-team-profile/cordis.patch.yml`），并且该层会**先 disable 全局 `tool-subagent-control` / `tool-subagent-list-agents`**，再由 scoped Team 工具接管同名 `send_message` / `list_agents` / `interrupt_agent`（避免重名冲突，见 patch 文件头注释）。

工具集（`packages/experimental/tool-agent-team/src/index.ts`）：

| 工具 | 说明 | 关键行 |
| --- | --- | --- |
| `spawn_teammate` | `name`(kebab-case)/`description`/`prompt`/`context:'fresh'\|'fork'`；**仅 Lead** | 173-199 |
| `send_message` | `target`: 成员名或 `lead`；`message`；返回 `{messageId, status:'accepted'\|'queued'}` | 201-216 |
| `list_agents` | 无参数，返回 Lead+所有 teammate 的 `TeamMemberView[]` | 218-226 |
| `wait_agent` | `timeout_ms`（10000–3600000，默认 30000）；`noProgress` 短路 | 228-261 |
| `interrupt_agent` | `target`: 成员名；**仅 Lead**；保留 pending inbox | 263-276 |
| `team_task_create` | `subject`/`description`/`blocked_by[]`/`write_scopes[]` | 278-300 |
| `team_task_list` | `status?`/`owner?`/`ready?`/`cursor`/`limit(1..100)` | 302-332 |
| `team_task_get` | `task_id` | 334-347 |
| `team_task_update` | `task_id`/`expected_revision`/`action`（claim, release, edit, set_dependencies, complete, reopen, reassign, delete） | 349-380 |

- **注册机制特殊**：不是全局 `ctx.tools.register`，而是 `install(agent, ...)` 在**每个 Team 成员的 agent scope** 上注册（`scoped.tools.register`），并挂一段 `team:policy` system prompt section（`src/index.ts:158-171, 391-411`）。因此 Team 工具对非成员不可见——这是"按会话作用域暴露工具"的官方范例，值得本插件直接照抄。
- **工具与状态机解耦**：所有工具都是 `ctx.agentTeams` 的薄适配器，业务在 `packages/experimental/agent-team/src/{roster,mailbox,task-board,activity}.ts`。

### 1.3 一次性委派与编排

| 工具 | 包 | 语义要点 |
| --- | --- | --- |
| `subagent` / `subagent_fork` | `packages/subagent/tool-subagent` | 由 `config.toolName` + `config.provider` 决定名字；`backgroundMode: 'one-shot' \| 'continuable'`（默认 `one-shot`，`src/index.ts:109`）。**`standard` 预设里两者都是 `continuable`**（`presets/standard/agent.cordis.yml:180-197`；Web 端默认 preset 即 `standard`，见 `packages/bundle/web-app/cordis.patch.yml:449`），因此默认就能被 `send_message` 继续 |
| `workflow` | `packages/workflow/tool-workflow` | JS 脚本内 `agent()/parallel()/pipeline()/phase()/log()`；**前台阻塞**父轮次，模型只看到最终返回值，"中间子 agent 消息永不进入父对话"（`README.zh.md`）——不适合做通信底座 |
| `ralph` | `packages/workflow/tool-ralph` | 循环式委派 |
| `goal` 系列（`create_goal/get_goal/update_goal`） | `packages/goal/tool-goal` | 会话内长期目标，不是跨会话通信；但其 `MessageSourceMap` 注入 `goal` + `goal/change` 会话事件是"插件扩展会话日志"的范式 |
| `subagent_codex` / `subagent_claude_code` | `tool-subagent` 多 provider | 预设里默认 `disabled: true`；`maxDepth: provider-managed` |

---

## 2. 消息如何进入目标会话（核心链路）

这是本插件最需要复用/理解的一段。**所有路径最终都收敛到 `Agent` 的四个原语**（`packages/core/agent/src/runtime-types.ts:150-188`）：

```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
followup(message: UserMessage): void   // 排队为一个独立普通 turn 并唤醒 driver
steer(message: UserMessage): void      // 最近 step 边界消费；idle driver 开 turn
inject(message: UserMessage): void     // 只等下一个 pre-step 批次，不唤醒
```

### 2.1 端到端链路图

```
调用方（模型工具 / Host 插件 / Remote RPC / SDK / ACP）
   │
   ├─ 模型侧相邻通道:  ctx.subagents.sendMessage(sender, targetId, content, {signal})
   │        └─ continuation.ts:583  → 校验 exact live sender / 父子邻接
   │           ├─ 发给父级 → sendToParent()            (continuation.ts:780)
   │           └─ 发给子级 → deliverToChild()          (continuation.ts:654)
   │                 ├─ 有常驻 Activation → submit()   (continuation.ts:1359)
   │                 └─ 无常驻 → coldResume()          (continuation.ts:1067, 从持久化重放)
   │
   ├─ Team 通道:  ctx.agentTeams.sendMessage(caller, {target, content, signal})
   │        └─ TeamMailbox.send()  (agent-team/src/mailbox.ts:55)
   │           ① 事务性写 Lead 日志 `team/message/queued`（durable！）
   │           ② dispatchOnce()：live 目标 → steerHostSubagentPrompt()；Lead 本人 → root.steer()
   │           ③ 冷恢复目标 → 先读持久日志判重，再走同一投递
   │           ④ target session 出现 `user/message`（source.kind='team-message'）→ 写 `team/message/delivered`
   │
   ├─ Host/Remote 通道（普通会话）:  sessionController.prompt({sessionId, mode, content, requestId})
   │        └─ ApiSessionAgentController.resolveAgent()  // 未 live 则 ctx.agents.resume()
   │           → agent.steer(msg) 或 agent.followup(msg)     (session-controller/src/commands.ts:293-353)
   │
   ├─ SDK: HarnessSdkJsonRpcServer.prompt({sessionId, contentBlocks})
   │        └─ getOrCreateSession() → agent.followup(msg)     (sdk/server/src/server.ts:176-197)
   │
   └─ ACP: AcpSession.prompt() → agent.followup(msg)          (acp/acp/src/session.ts:302)
   │
   ▼
Agent 内核（packages/core/agent/src/inbox.ts）
   Inbox.append('next-turn' | 'next-step', message)
     → session.append('agent/inbox/spliced', {...})    ← 持久、可回放
     → 通知 agent/inbox/inserted → driver 被唤醒 (agent/status → 'running')
   ▼
Turn / Step 边界（packages/core/agent-loop/src/agent.ts:258-315）
   turn():  session.append('turn/start')
     loop:  preStep(target) → Inbox.claim(target, turn)  ← 一次性取走整批 next-step (+1 个 next-turn)
            session.append('step/start')
            for (m of claimed) session.append('user/message', m)   ← ← 模型真正"看见"
            → LLM 请求 → session.append('step/end')
   ▼
模型上下文
```

### 2.2 官方如何"表述"一条跨会话消息（关键扩展点）

给一条消息标注来源，是 `MessageSourceMap` 的 **declaration merging**（`packages/llm/llm/src/message.ts:102-107` + 各包 `declare module`）。现存实现：

| `source.kind` | `form` | 生产者 | 位置 |
| --- | --- | --- | --- |
| `user` | — | 人类/浏览器 | 基础 |
| `plugin` | 任意 `ContextForm` | 插件自造（如 `schedule`） | 基础 |
| `model` | — | 模型自身 | 基础 |
| `agent-message` | `relay` | **相邻 agent 消息**（`senderSessionId`） | `subagent/src/continuation.ts:48-56, 283-300` |
| `subagent-settled` | `notice` | 子代理结算通知（含 `summary`） | `continuation.ts:60-70` |
| `team-message` | — | Team mailbox（`teamId/messageId/senderId/senderName`） | `agent-team/src/types.ts:114-127` |
| `session-reference` | `recall` | 跨会话引用（把别的会话日志摘出来） | `context/session-reference/src/types.ts:16-40` |
| `goal` | — | goal 续跑轮次 | `goal/goal/src/domain.ts:56-62` |
| `user-rpc` | — | 浏览器 prompt 的 `rpcId`/时区 | `api/session-controller/src/types.ts:369-373` |
| `webhook` | `notice`（含 `provider/source/deliveryId/ruleId/summary`） | webhook 创建会话的首条 prompt | `webhook/webhook/src/types.ts:72-83` |

`ContextForm` 语义表（`message.ts:50-96`）里 **`relay` = "另一个 agent 发给这个 agent 的消息"**，`notice` = "一次性事件通报"，`recall` = "从别的会话日志里摘出来的材料"。**本插件应当复用 `form: 'relay'`**，并自定义 `kind`（例如 `plugin: 'session-comm'` 或独立 `kind: 'session-message'`）以携带 messageId/senderSessionId 做去重——这正是 Team mailbox 的做法（`mailbox.ts:307-313` 的 framing + `session-message.ts` 的 `messageAccepted()` 去重折叠）。

模型可见 framing 的两个官方范本：

- 相邻通道：`Agent ${sender.id} sent a message:` + 正文（`continuation.ts:296-300`）
- Team 通道：`Team message ${id} from ${senderName}:` + 正文（`mailbox.ts:308-313`）

### 2.3 三种"目标不活跃"情形的官方处理

| 情形 | 判定 | 官方动作 |
| --- | --- | --- |
| 目标 `running` | `agent.status === 'running'` | `steer()` → 最近 step 边界 |
| 目标 `idle` | `agent.status === 'idle'`（常驻但无驱动） | `followup()`/`steer()` 开新 turn |
| 目标只剩持久记录（`ready`/`inactive`） | `ctx.agents.get(id) === undefined` | **冷恢复**：`ctx.agents.resume({resumeSessionId})`（子代理走 `continuation.coldResume`，普通会话走 `ApiSessionAgentController.resume`） |
| Team 特有 `provisioning` | roster `phase === 'provisioning'` | `wait_agent` 视为"活跃对端"（`ACTIVE_WAIT_STATUSES`，tool-agent-team/src/index.ts:39）；`recoverFor()` 重试 mailbox |
| Team 特有 `failed` | roster `phase === 'failed'` | 不可投递（`resolveActiveMember` 只接受 `active`，roster.ts:52-60） |

**休眠 → 唤醒的关键点**：冷恢复不是"重发"，而是重新 materialize 一个 Activation/handle 后再 `steer` 一次；Team mailbox 更进一步——**先写 durable queued，再投递，最后等 target session 出现该 messageId 才标 delivered**，因此进程崩了也能在下次 `agent/session-start` 时 `recoverFor()` 重放（`agent-team/src/index.ts:110-126, 288-303`）。

---

## 3. 寻址模型对照

| 通道 | 寻址键 | 校验 | 是否允许"跨血缘" |
| --- | --- | --- | --- |
| `send_message`（subagent control） | `agent_id` = `SessionId` | `sendMessage()` 先判"发给父级"：`senderActivation.parentSession === targetId`；否则若非常驻子代理尝试发父级 → `UNAUTHORIZED`；再走 `deliverToChild → authorizeLineage`：要求 `target.header.parentSession === sender.id` 且 sender 是 exact live agent（`continuation.ts:597-608, 1442-1456`） | ❌ 只允许直接父子 |
| `interrupt_agent`（subagent control） | `agent_id` | `kind:'ancestor', agent: caller`，要求 caller 在 target 记录的活血缘上（`continuation.ts:724-770`） | ❌ 只允许祖先 → 后代 |
| `send_message`（Team） | 成员名 / `lead` | `roster.membership(caller)` 必须存在；`resolveActiveMember()` 只解析 `phase==='active'`；禁止自消息（`TEAM_SELF_MESSAGE`） | ✅ 同 Team 内任意两人 |
| `subagents.prompt`（Remote） | `{parentSessionId, childSessionId, mode}` | 父必须 live；`subagent/unauthorized` 等 8 个错误码（`control-types.ts:129-145`） | ❌ 直接父子 |
| `sessionController.prompt`（Remote） | `sessionId` | `resolveAgent()` 会冷恢复；**拒绝被 subagent 拥有的会话**（`hasApiSessionSubagentOwner` → `apiSessionSubagentOwnershipError`） | ✅ 任意**普通**会话（不含子代理） |
| SDK `session/prompt` | `sessionId`（未知 id 懒创建） | 仅本 server 创建的 agent；`assertLiveAgent()` | n/a |
| ACP `session/prompt` | ACP session → 单个 DSH 会话 | 一个 ACP session 同时只允许 1 个 in-flight prompt | n/a |
| `webhookRuntime.dispatch` | 规则 → **新会话** | 只能创建新 root session，不能写已有会话 | ❌ |

**可见的一处"近似通用寻址"**：`SessionAddress`（`api/session-controller/src/types.ts:377-384`）已经定义了
`{kind:'session', sessionId}` 与 `{kind:'subagent', parentSessionId, childSessionId, mode}` 两种地址；`SubagentAddress`（`control-types.ts:87-95`）与之同构。**建议新插件沿用这套地址词汇**，避免再造第三套 id 语义。

---

## 4. 投递语义、失败与超时

| 维度 | 相邻 agent 通道 | Team 通道 | Host/Remote |
| --- | --- | --- | --- |
| 持久化 | 只有 message 进 inbox 后的 `agent/inbox/spliced`；无独立 queued 记录 | ✅ 先 `team/message/queued` 落 Lead 日志，再投递 | 无（`agent.steer` 直接进 inbox） |
| 去重 | 无显式去重；靠 inbox 内 `message.id` 唯一（`inbox.ts:213-217` 拒绝重复 id） | ✅ target 日志里 `source.messageId` 折叠比对（`session-message.ts:25-31`） | `requestId`（`hasPromptRequest` 幂等） |
| 回执 | `MessageId`（= inbox id），即"accepted" | `{messageId, status:'accepted'\|'queued'}` | `{accepted:true}` |
| 失败 | 抛 `SubagentError`：`UNAUTHORIZED` / `NOT_RESUMABLE` / `PARENT_UNAVAILABLE` / `ACTIVATION_CLOSING` | `TeamError`：`TEAM_MEMBER_NOT_FOUND` / `TEAM_MAILBOX_FULL` / `TEAM_MESSAGE_TOO_LARGE` / `TEAM_SELF_MESSAGE` / `TEAM_NOT_MEMBER` / `TEAM_LEAD_REQUIRED`；**投递阶段**失败不抛错，返回 `status:'queued'` 并 warn（等恢复重放） | `RemoteError` 码表 |
| 超时 | 无内建超时；只吃 caller `signal`（"owns the operation only until inbox acceptance"） | 无投递超时；`wait_agent` 有 10s–1h 的**等待**超时（非投递超时） | 无 |
| 完成通知 | **推送式**：子代理结算时向父级投 `subagent-settled`（idle→`followup`、busy→`steer`、父在 teardown→`inject`），`continuation.ts:1630-1680` | 无（用 `wait_agent` 拉） | 事件流 `session/event` |
| 取消/中断 | `interrupt_agent` / `ctx.subagents.interrupt(id, {kind:'ancestor'|'user'})`，`keepInbox:true` 保留未领取工作 | 同左 + 仅 Lead 可调 | `sessionController.cancel`（`keepInbox: true`） |

**重要边界语义（可直接写进插件文档）**：

- "steer 只影响最近 step；被拒绝的 step 会让 steering 滞留在 inbox 直到下一次唤醒；cancel/dispose 会丢弃未领取的 steering"（`runtime-types.ts:170-177`）。
- "`inject()` 不唤醒 driver；可能在 pre-step 已取批后错过一次请求"（`runtime-types.ts:179-187`）。
- 中断是"fire-and-return"：返回 `accepted` 时目标可能还在跑；已 claim 进当前 turn 的工作**不会**重新入队（`continuation.ts:735-770`）。

---

## 5. 事件总线：跨会话监听/转发的可行接口

全局 `ctx.on/ctx.emit`（Cordis）是插件的天然挂点。`**scope-filtered dispatch**` 是关键：agent-scoped 监听器只收到该 agent 的会话事件，root 上下文监听器收到全部。

| 事件 | 载荷 | 用途 | 定义 |
| --- | --- | --- | --- |
| `session/created` / `session/disposed` | `Session` | 发现新会话（含冷恢复发布的会话） | `packages/core/session/src/index.ts:51,61` |
| `session/event` | `(session, event)` | **逐条会话日志事件**；Team mailbox 的 ack、SDK server 的通知流都用它 | `session/src/index.ts:73` |
| `agent/created` / `agent/disposed` | `{agent}` | 注册 scoped 工具（Team 工具即用此） | `agent/src/runtime-types.ts:204,213` |
| `agent/status` | `{agent, status:'idle'\|'running'}` | 活跃度探测 / `wait` 实现 | `runtime-types.ts:223` |
| `agent/inbox/inserted` / `claimed` / `discarded` | `{agent, message, turn?}` | 消息生命周期观测 | `runtime-types.ts:231,242,250` |
| `agent/session-start` | `{agent, source}` | 冷恢复后的 mailbox 重放（Team 用） | 见 `agent-team/src/index.ts:111` |
| `agent/turn-stopping` | `{turn, signal}` | serial 可拦截的 turn 收尾点 | `agent-loop/src/agent.ts:307` |

另有 `ctx.sessions`（`SessionStore`，`get(id)`/`flush(session)`）与 `ctx.sessionQuery`（`SessionQueryEngine`：`listSessions/observeSession/readSession/filterSessions/filterEvents/readSurface/traceSession/traceEvent/readEvent`，`packages/session-query/session-query/src/index.ts:97-353`）——**跨会话读取与血缘追踪的官方唯一入口**，比自建 JSONL 扫描更安全。

`packages/hooks/*` 只做 Claude-Code/Codex 外部 hooks 桥接（阻塞提示、附加上下文），不是会话间通信；`packages/webhook/*` 只能"创建新会话"，两者都不适合作为本插件底座。

---

## 6. 传输层事实（对外部客户端 / 其他进程）

| 层 | 入口 | 能力 | 关键路径 |
| --- | --- | --- | --- |
| Web GUI | 单一 WebSocket `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` 承载所有 Typert Remote stream + 转发的 Cordis 事件流（`$events`） | 浏览 ↔ Host 双向；`session.prompt` / `subagents.prompt` / `agentTeams.view` 均走这里 | `api/gateway/src/stream-protocol.ts:5-8` |
| Session Remote | `session.create/list/search/fork/rename/prompt/attachment/updateQueue/cancel/page` + 2 个 stream | `create` 收 `{workspaceId?, cwd?, sessionId?, agentPreset?}` → 返回 `sessionId`；`prompt` 收 `{requestId, sessionId, mode:'queue'\|'steer', content}` | `api/session-controller/src/index.ts:215-395`、`types.ts:259-322` |
| Subagent Remote | `subagents.prompt`（`{parentSessionId, childSessionId, mode:'continuable', requestId, content}`）、`interrupt`、`list` | 父必须 live；投递走 `'queue'`（≠ 模型侧 steer） | `subagent/subagent/src/index.ts:415-470` |
| AgentTeam Remote | 仅 `view` / `createTask` / `updateTask`（`@Remote`） | **没有** `sendMessage` 的 Remote 面；Team 发消息只有模型工具一条路 | `agent-team/src/index.ts:242-270` |
| SDK（stdio JSON-RPC） | `initialize` / `session/prompt` / `shutdown` + 4 个通知（`session.event`/`session.status`/`subagent.started`/`subagent.finished`） | 外部进程可驱动**本进程内**会话；未知 sessionId 懒创建 | `sdk/protocol/src/types.ts:110-118` |
| ACP（stdio JSON-RPC） | 标准 ACP：创建/恢复/列出会话、发送/取消工作、MCP 挂载 | 进程外 subagent 走的通道；`packages/subagent/subagent-acp` 是自带客户端 | `acp/acp/src/{index,session}.ts` |

**结论**：想"从任意进程给任意会话发消息"，官方只有两条合法路径：① 走 Web Gateway 的 `session.prompt`（要 WS + Typert 握手），② 走 SDK/ACP（但只能驱动它自己创建/持有的会话）。**没有**"向任意 session id 投递"的一等 RPC。

---

## 7. 缺口清单（按对本插件的影响排序）

| # | 缺口 | 现状证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| G1 | **没有统一 mailbox 服务** | 全仓 `mailbox.ts` 只存在于 `packages/experimental/agent-team/src/`，`TeamMailbox` 是内部类，未 `declare module` 到 `Context` | 本插件若要"可恢复、可去重、可限流"的跨会话投递，必须自建 | 复用 TeamMailbox 的设计（queued→deliver→ack 三段日志）与 `messageAccepted()` 折叠算法；用 `source.kind` 自定义 + `messageId` 去重 |
| G2 | **普通会话不可被模型寻址** | `send_message` 的 `agent_id` 语义锁死直接父子（`continuation.ts:583-620`）；`sessionController.prompt` 无对应模型工具 | 模型无法"给同 workspace 的另一个会话留言" | 自建 `session_send` 工具：`ctx.agents.get(id)` → `agent.steer/followup`；不在 registry 时走 `ctx.agents.resume` 或 `sessionController.prompt` |
| G3 | **`sessionController.prompt` 会拒绝子代理会话** | `hasApiSessionSubagentOwner()` → `apiSessionSubagentOwnershipError` | 想用一条 API 覆盖全部会话会撞墙 | 分支：普通会话走 `sessionController`，子代理走 `ctx.subagents.sendMessage`，Team 成员走 `ctx.agentTeams.sendMessage` |
| G4 | **无 `wait` / 订阅式工具（稳定集）** | `wait_agent` 仅在 experimental Team；相邻通道只有推送式 `subagent-settled` | 模型只能"发完就忘"或反复 `list_agents` | 自建 `session_wait`：订阅 `agent/status` + `session/event` + `agent/inbox/*`，参考 `TeamActivity.wait()`（`agent-team/src/activity.ts`） |
| G5 | **跨 workspace 无策略** | 子代理 `cwd` 强制继承父（`subagent/child-agent.ts:146`）；`SessionReferenceCandidate.sameWorkspace` 只是提示字段（`session-reference/src/types.ts:60-66`） | "给别的项目会话发消息"没有语义定义（是同 cwd？同 workspace registry？） | 显式设计：默认同 `cwd` 才允许，跨 `cwd` 需 config 开关；用 `sessionQuery.listSessions()` 拿 `cwd` 做校验 |
| G6 | **消息级权限缺失** | 只有血缘/成员资格；`guard`/`permission-presets` 管的是工具执行审批 | 任意会话可被任意"有权限的 agent"唤醒，易滥用 | 复用 agent scope 注册模式（Team 的做法）+ config allowlist（如 `allowTargets`/`allowCwd`） |
| G7 | **无统一 id 词汇** | 三套：`SessionId`（agent id）、Team 成员 `name`、Remote `SessionAddress` | 工具参数容易歧义 | 插件统一用 `SessionId` 作为唯一真 id，`label` 只作展示；复用 `SessionAddress` 形状 |
| G8 | **Team 工具无 Host/Remote 发送面** | `agentTeams` 只 `@Remote` 了 view/createTask/updateTask | 浏览器侧无法代发 Team 消息 | 对本插件是机会：把 "发送" 做成 Remote + 工具双面 |
| G9 | **多 provider 子代理（codex/claude-code）不可 continue** | 预设里 `backgroundMode: 'one-shot'`，`maxDepth: provider-managed` | `send_message` 对它们无效（`list_agents` 直接过滤掉 one-shot，`list-agents.ts:77`） | 插件需在 `list` 输出里区分 "可继续/不可继续"，别让模型猜 |

---

## 8. 对本插件的直接复用建议（最小实现路径）

1. **不要重造投递原语**：任意 live agent 都能用 `agent.steer/followup/inject`；这是官方最底层、最稳定的接口（`runtime-types.ts:150-188`）。
2. **地址解析分层**：
   ```
   target sessionId
     ├─ ctx.agents.get(id) 命中 → 直接 steer/followup
     ├─ 未命中且是本会话的 continuable 子代理 → ctx.subagents.sendMessage(...)
     ├─ 未命中且是 Team 成员 → ctx.agentTeams.sendMessage(...)
     └─ 未命中且是普通持久会话 → ctx.agents.resume({resumeSessionId}) 或 sessionController.prompt
   ```
3. **消息源自己扩一个 `kind`**：`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'session-message': {...} } }`，带 `messageId`/`senderSessionId`/`form:'relay'`，即可白拿 UI 的 relay 渲染 + 自己的去重键。
4. **工具按 agent scope 注册**（照抄 `tool-agent-team/src/index.ts:391-411` 的 `maybeInstall` + `agent/created` 监听），避免污染非目标会话的工具面板。
5. **durability 选择**：若要"消息不丢"，照 Team 的三段式（queued 事件 → 投递 → target 侧 ack 事件）；若只要"尽力而为"，直接用 `agent.steer` 并把失败如实抛给模型（官方相邻通道就是后者）。

---

## 9. 关键文件索引（repo 相对路径）

**通信原语 / 相邻通道**
- `packages/core/agent/src/runtime-types.ts` — `Agent` 的 `send/followup/steer/inject/cancel/whenIdle`、`AgentStatus`、全部 agent 事件声明
- `packages/core/agent/src/inbox.ts` — `Inbox.append/claim/splice`，`agent/inbox/spliced` 持久投影
- `packages/core/agent-loop/src/agent.ts:258-315` — turn/step 边界 → `Inbox.claim` → `user/message`
- `packages/subagent/subagent/src/continuation.ts` — `sendMessage` / `deliverToChild` / `coldResume` / `sendToParent` / `submit` / `interrupt` / `notifySettlement`；`AgentMessageSource`、`SubagentSettledMessageSource`
- `packages/subagent/subagent/src/internal.ts` — `steerHostSubagentPrompt` / `queueHostSubagentPrompt`（host 专用符号，绕过公开 Service Definition）
- `packages/subagent/subagent/src/control-types.ts` — `SubagentAddress` / `SubagentPromptRequest` / 错误码
- `packages/subagent/tool-subagent-control/src/{index,list-agents}.ts` — `send_message` / `interrupt_agent` / `list_agents`
- `packages/subagent/tool-subagent/src/index.ts` — `backgroundMode`、多 provider 委派工具

**Agent Team（实验性）**
- `packages/experimental/agent-team/src/{index,mailbox,roster,task-board,activity,types,session-message}.ts`
- `packages/experimental/tool-agent-team/src/index.ts` — 工具集 + agent-scope 注册 + `POLICY` 文本
- `packages/experimental/agent-team-profile/cordis.patch.yml` — opt-in 装配（并 disable 同名全局工具）

**Host / Remote / 传输**
- `packages/api/session-controller/src/{index,commands,agent,types}.ts` — `session.*` Remote、`resolveAgent`/`resume`、`SessionAddress`
- `packages/api/gateway/src/stream-protocol.ts` — `/api/remote.mux`、`$events`
- `packages/sdk/{protocol,server,client}/src` — `session/prompt` 与 4 个通知
- `packages/acp/acp/src/{session,index}.ts` — ACP prompt
- `packages/webhook/webhook/src/{index,session}.ts` — 只能创建新会话
- `packages/schedule/schedule/src/runtime.ts:255-285` — `agent.followup` + `source:{kind:'plugin',plugin:'schedule'}` 的定时投递范式

**发现 / 读取**
- `packages/session-query/session-query/src/index.ts` — `ctx.sessionQuery` 全 API
- `packages/core/session/src/index.ts` — `ctx.sessions`、`session/*` 事件
- `packages/context/session-reference/src/{index,types}.ts` — 跨会话 `recall`
- `packages/llm/llm/src/message.ts:50-128` — `ContextForm` / `MessageSourceMap` / `ContextFormed`

**文档（定位辅助，非权威）**
- `docs/subsystems/agent-team.zh.md`、`docs/subsystems/subagent.zh.md`、`docs/subsystems/session.zh.md`、`docs/subsystems/web.zh.md`、`docs/subsystems/goal.zh.md`、`docs/subsystems/workflow.zh.md`

---

## 10. 一句话给设计者

> "会话创建 + 通信"插件应把自己定位成**第四种寻址层**：不替代 `ctx.subagents`（父子）、`ctx.agentTeams`（Team）、`sessionController`（Host/普通会话），而是在它们之上提供一个**以 `SessionId` 为唯一键、可发现、可等待、有 durability 策略的统一门面**；投递原语和消息来源类型都有官方现成答案，真正要自己写的是 ①地址解析路由 ②可选 mailbox ③权限/workspace 策略。
