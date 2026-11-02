# Session 间主动通信：方案与复用评估

> 目标：让任意（授权范围内）会话能**主动**给另一个会话发消息，并唤醒 idle / 冷会话；
> 依据：`C:\Code\deepseek-harness`（0.1.3-alpha.1，MIT）源码核对 + Agent Teams 设计笔记。
> 关联：[../research/session-communication.md](../research/session-communication.md)、[session-bus.md](./session-bus.md)。

---

## 0. 结论先行

**不能整包直接复用；能复用约 70% 的模式与代码，必须改 3 处。**

| 复用方式 | 可行性 | 结论 |
|---|---|---|
| 直接启用 `@deepseek-ai/dsh-experimental-agent-team` | ✅ 本机已启用 | 只能覆盖"一个 root + 它自己 spawn 的 teammate"；**不能给任意已存在会话发消息** |
| 依赖该包做二次封装 | ❌ | 包是 `private: true`，不发布；roster 没有 "adopt 一个已有会话" 的 API |
| 复制其模式与代码（MIT） | ✅ 推荐 | mailbox 三段式、`messageAccepted`、`TeamActivity`、scoped 工具安装、限额校验可原样搬 |
| 自己重写底层投递 | ❌ 不必要 | `Agent.steer/followup`、`ctx.sessions.flush`、`ctx.agents.resume` 已够用 |

**唯一必须新写的 3 件事**：

1. **账本归属**：Team 的 mailbox 记在 **Lead 日志**（只能一个中心）；任意会话互通必须改成 **sender-owned outbox**（发送方自己的日志）。
2. **寻址**：Team 用**成员名**（且必须是 roster 成员）；改成 **`SessionId`**。
3. **准入**：Team 的成员只能由 `startContinuable` 创建；改成"已存在的普通会话也能作为目标"（peer），并自己补授权。

---

## 1. "直接复用"的边界（先看清楚）

| 想要的场景 | 现在能不能做 | 用什么 |
|---|---|---|
| 我给自己的 `subagent`（continuable）发消息 | ✅ | `send_message({agent_id})`（默认装载） |
| 子代理给我回消息 / 通知我完成 | ✅ | 子代理结算通知 + `send_message` 回父级 |
| 同一 Team 内 Lead ⇄ teammate、teammate ⇄ teammate | ✅（需启用 Agent Teams） | `spawn_teammate` + `send_message({target: name})` |
| **给另一个已存在的普通会话主动发消息** | ❌ | 无工具、无 API（`sessionController.prompt` 是 Host 侧 RPC，且拒收子代理会话） |
| 冷会话（未加载）被唤醒 | ⚠️ 仅 Team/子代理通道 | `agents.resume` 没有模型工具 |

所以：**"同 root 的派生会话"可以零代码；"跨任意会话"必须写插件。**

---

## 2. 方案总览

```
L2 模型工具        session_send · session_list · session_wait · session_inspect
                        │（薄适配，授权/呈现）
L1 服务（可选）     ctx.sessionBus：outbox、投递调度、等待、恢复
                        │
L0 官方原语         Agent.steer/followup · ctx.agents.get/resume · ctx.sessions.flush
                   ctx.sessionPersistence.open · ctx.sessionQuery.observeSession
                   事件：session/event · agent/status · agent/session-start
```

- **L1 可以省略**（P0 阶段直接写在工具层）；但只要将来要 Remote/UI 复用，就值得单独做服务。
- **L2 的 4 个工具**就是路线一的工具集；本文只把其中的"通信"部分讲透。

---

## 3. 数据与事件设计：sender-owned outbox

### 3.1 消息来源类型（复用官方扩展点）

```ts
// 与 Team 的 TeamMessageSource 同构；form:'relay' 是官方语义"另一个 agent 发给本 agent 的消息"
export interface SessionMessageSource {
  readonly kind: 'session-message'
  readonly form: 'relay'
  readonly messageId: string
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'session-message': SessionMessageSource }
}
```

> 客户端对未知 source kind 有兜底渲染（`ui-conversation/context-provenance.ts`：未知 kind 也会显示，label 取裸 kind），
> 所以新 kind 不会让 UI 崩；带 `form:'relay'` 还能拿到 relay 语义。

### 3.2 事件（写在**发送方**会话日志）

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 入队：先落盘再投递，保证"发送成功 = 已持久化" */
    'session-message/queued': {
      version: 1
      messageId: string
      senderId: SessionId
      senderName: string
      targetId: SessionId
      content: ContentBlock[]
      createdAt: number
    }
    /** 回执：目标会话日志已出现该 messageId */
    'session-message/delivered': {
      version: 1
      messageId: string
      targetId: SessionId
      deliveredAt: number
    }
  }
}
```

- **不放进目标日志**：未投递的消息不属于目标历史（Team 也是这么做的）。
- **不用中心 hub**：否则跨 root 无解、且中心会话不 live 时无法发送。
- **不需要额外投影（P1）**：outbox 状态 = 发送方日志前缀折叠（`queued` 集合 − `delivered` 集合），发送时读 live session suffix 即可；P2 要 UI 再注册 projection。

### 3.3 关键正确性规则：只用 **non-inherited suffix**

fork 会继承父会话事件。所有"这条消息发过/收过没有"的判断都必须只扫**本会话自己的事件**：
live 用 `session.ownEvents()`（等价于 `snapshotEvents(session.inheritedEventCount)`），
冷会话用 `handle.read(0)` 后从 `inheritedEventCount` 切分。
否则一个 fork 出来的会话会把祖先的 outbox 当成自己的，重发历史消息。

---

## 4. 投递算法

### 4.1 发送（工具调用内）

```ts
async function send(caller: Agent, targetId: SessionId, text: string, signal: AbortSignal) {
  authorize(caller, targetId)                       // §6，先授权再判存在性
  const content = [{ type: 'text', text }]
  assertLimits(caller, targetId, content)           // 单条 ≤ maxMessageBytes；target pending ≤ maxPending
  const message = { messageId: `session-message-${randomUUID()}`, senderId: caller.id,
                    senderName: labelOf(caller), targetId, content, createdAt: Date.now() }

  await journal.transact(caller.id, async () => {   // 每个 sender 一条串行队列
    caller.session.append('session-message/queued', { version: 1, ...message })
    await ctx.sessions.flush(caller.session)        // 入队先持久化
  })

  const accepted = await dispatch(caller, message, signal)   // 失败不抛，留 queued
  return { messageId: message.messageId, status: accepted ? 'accepted' : 'queued' }
}
```

### 4.2 投递（幂等、可重入）

```ts
// frame(msg)：把 outbox 记录变成目标会话能接受的 user message
const frame = (msg: QueuedMessage) => createUserMessage({
  content: msg.content,
  source: { kind: 'session-message', form: 'relay', messageId: msg.messageId,
            senderId: msg.senderId, senderName: msg.senderName },
})

async function dispatch(sender: Agent, msg: QueuedMessage, signal: AbortSignal): Promise<boolean> {
  const target = ctx.agents.get(msg.targetId)

  // 1) 活目标：已经记录过 → 直接 ack
  if (target !== undefined && recorded(target.session, msg.messageId)) return await ack(sender, msg)

  // 2) 活目标：投递（固定 steer，与 Team 一致）
  if (target !== undefined) {
    target.steer(frame(msg))                       // running→最近 step 边界；idle→开 turn
    await ctx.sessions.flush(target.session)       // 等它落盘
    return recorded(target.session, msg.messageId) ? await ack(sender, msg) : false
  }

  // 3) 冷目标：先读持久日志判重，避免重复投递
  const stored = await readPersistedSession(ctx.sessionPersistence, msg.targetId, signal)
  if (recordedEvents(stored.events.slice(stored.inheritedEventCount), msg.messageId)) return await ack(sender, msg)
  if (stored.header.cwd === undefined) return false            // 无 cwd 无法 resume，留 queued

  // 4) 冷恢复 → 投递（同一目标并发 resume 要去重）
  const handle = await resumeOnce(msg.targetId)                // Map<SessionId, Promise<AgentHandle>>
  handle.agent.steer(frame(msg))
  await ctx.sessions.flush(handle.agent.session)
  return recorded(handle.agent.session, msg.messageId) ? await ack(sender, msg) : false
}

function recorded(session: Session, id: string): boolean {
  return messageAccepted(session.ownEvents(),
    m => m.source.kind === 'session-message' && m.source.messageId === id)
}
```

`messageAccepted()` 直接复制 `packages/experimental/agent-team/src/session-message.ts`（31 行）：
它同时折叠 `user/message` 与尚未被 claim 的 inbox 条目，覆盖"进 inbox 了但 turn 还没读到"的窗口。

### 4.3 回执

```ts
async function ack(sender: Agent, msg: QueuedMessage): Promise<boolean> {
  await journal.transact(sender.id, async () => {
    const state = foldOwnOutbox(sender.session)
    if (state.delivered.has(msg.messageId)) return
    sender.session.append('session-message/delivered',
      { version: 1, messageId: msg.messageId, targetId: msg.targetId, deliveredAt: Date.now() })
    await ctx.sessions.flush(sender.session)
  })
  return true
}
```

### 4.4 恢复

- 监听 `agent/session-start`：发送方恢复时，重放 `queued − delivered`（按日志顺序，逐 target 串行）。
- 插件挂载时对 `ctx.agents.list()` 里的每个 agent 也调度一次恢复（与 Team 的 `scheduleRecovery` 一致）。
- **顺序**：同一 sender→target 串行（`dispatchTails: Map<SessionId, Promise<void>>`，抄 Team `mailbox.ts` 的 `serializeDispatch`）。跨 sender 不保证顺序。
- **不承诺跨进程 exactly-once**：和 Team 一样，承诺"重试 + target 侧去重"。

### 4.5 失败语义

| 返回 | 含义 |
|---|---|
| `status:'accepted'` | 目标 inbox 已接受（可能还在排队等模型读） |
| `status:'queued'` | 已持久化，但目标暂时投不进去（冷恢复失败/持久化不可用/目标忙到无法确认） |
| 抛错 | 未授权 / 不存在 / 超限 / 自己发自己 —— 此时**没有**入队 |

---

## 5. 工具设计

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `session_send` | `{ target_id, message }` | `{ messageId, status }` | 主动发消息；固定 steer 语义 |
| `session_list` | `{ scope?: 'live'\|'workspace'\|'all', limit? }` | `[{ id, title, cwd, status, kind, lastActiveAt }]` | 发现目标；`kind: 'peer'\|'derived'\|'team'` |
| `session_wait` | `{ target_ids?, timeout_ms }` | `{ timedOut, changes }` | 等下一次会话状态/消息变化，不轮询 |
| `session_inspect` | `{ session_id, ... }` | 复用 session-query 的只读卡片 | 可选；直接复用官方 `session_event_read` 更好 |

- 名字用 `session_*` 前缀，**不要**叫 `send_message`（root 层已被 `tool-subagent-control` 占用，同层重名注册直接失败）。
- 每个工具声明完整 `output.schema` + 紧凑 `render`（Team 的教训：未声明结果类型会让 `execute` 悄悄偏离承诺、且浪费 token）。

---

## 6. 授权模型（这是"随便能发"和"能发"的分界线）

**身份只从 `exec.agent` 取，绝不从参数取。**

```
authorize(caller, target):
  1. target.id === caller.id                     → deny self
  2. target 是别人的 subagent（parent ≠ caller） → deny（allowlist 不参与本条判定）
  3. 是自己的直接 subagent                        → allow（走官方 subagent 通道）
  4. target.cwd 未知                              → 仅 allowlist 命中才放行
  5. 同 cwd（按路径段比较，Windows 大小写不敏感） → allow
  6. allowlist 命中（sessionId 或目录前缀）       → allow
  7. allowCrossWorkspace                          → allow : deny
  对外投影：任何 deny 都返回 not_found（与不存在同文案、同模板），
  具体原因只写插件日志——否则调用方可以用错误信息枚举会话（2026-11-02 校正）
```

补充规则：

- **目标是被别人拥有的 subagent**（`origin:'subagent'` 或有 descriptor）：只允许其父会话投递，且必须走 `ctx.subagents.sendMessage`（它会做血缘校验）；我们的 outbox 不接管。
- **目标是 Team 成员**：若 caller 也是同 Team 成员，走 `ctx.agentTeams.sendMessage`（保留 Team 的 ack 语义）；否则按普通 peer 处理或拒绝（二选一，建议拒绝，避免两本账）。
- **权限不提升**：发消息等于以发送方身份触发目标 turn；目标会话的权限必须是它自己创建时的权限，不能因为收到消息而改变。
- **速率/体积**：`maxMessageBytes`（64KB）、`maxPendingPerTarget`（64）、可选每分钟条数。

---

## 7. 代码结构（建议）

```
src/
├─ index.ts            # name/inject/Config/apply：注册 4 个工具 + 1 个 prompt 段 + 恢复调度
├─ types.ts            # 事件/来源类型声明（declaration merging）
├─ journal.ts          # 抄 team 的 transact/appendAndFlush（按 sender 分尾）
├─ outbox.ts           # 折叠发送方日志：queued − delivered
├─ dispatch.ts         # §4.2 投递 + §4.3 ack + 每 target 串行
├─ recovery.ts         # agent/session-start 重放 + resumeOnce
├─ authorization.ts    # §6 矩阵（纯函数，单测友好）
├─ wait.ts             # 抄 team 的 TeamActivity（87 行）
├─ tools.ts            # defineTool × 4（或原始 JSON Schema；见下）
├─ presentation.ts     # 紧凑文本/卡片
└─ errors.ts           # 白名单错误码（脱敏）
```

依赖策略：**只用 `import type`**，工具用原始 JSON Schema `ToolDefinition` 注册（官方支持，MCP 工具就是这么进的），
`@deepseek-ai/dsh-tools` 只放 devDependency —— 避开 alpha 版本线的 peer 坑。

---

## 8. 测试清单

| 类别 | 用例 |
|---|---|
| 授权 | 同 cwd 允许；跨 cwd 默认拒绝且错误文本不泄露存在性；自己发自己；目标不存在；子代理目标只允许父 |
| 投递 | live running → steer；live idle → 开 turn；冷会话 → resume 后投递；目标无 cwd → 留 queued |
| 去重 | "进了 inbox 但没写 delivered" 后重放不重复；目标日志已有历史消息 → 直接 ack |
| 顺序 | 同 sender→target 两条消息按入队顺序；并发 sender 不破坏 target 顺序 |
| 限额 | 超 maxPending / maxBytes / 超时 |
| fork | fork 出来的会话不重发祖先 outbox（inherited suffix 正确切分） |
| 恢复 | sender 冷启动后重放 queued−delivered；插件卸载后无 agent 泄漏 |
| 组装 | `ctx.tools.schemas()` 含 4 个工具；与 base 工具无重名 |

---

## 9. 分阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0** | 4 个工具 + 授权 + 直接 `steer/followup`（无 outbox，尽力而为） | 2~3 天 |
| **P1** | sender-owned outbox + ack + 恢复 + 每 target 串行 + 限额 | +3~5 天 |
| **P2** | `ctx.sessionBus` 服务化 + `@Remote`（浏览器也能发）+ UI 面板 | +1~2 周 |

---

## 10. 复用清单（抄哪些、改哪些）

| 能力 | 源码 | 处理 |
|---|---|---|
| 事务串行 + append/flush | `agent-team/src/journal.ts` | 抄，key 从 root 改成 sender |
| 三段式投递 | `agent-team/src/mailbox.ts` | 抄骨架，改 ack 落点 + target 解析 |
| 去重折叠 | `agent-team/src/session-message.ts` | **原样复制** |
| 等待超时/abort | `agent-team/src/activity.ts` | **原样复制** |
| 冷读持久日志 | `agent-team/src/persisted.ts` | **原样复制**（33 行） |
| 限额校验 | `agent-team/src/index.ts` 配置段 | 抄 |
| scoped 工具安装 | `tool-agent-team/src/index.ts:396-411` | 抄（按 agent scope 注册 + agent/created） |
| 事件/来源类型 | `agent-team/src/types.ts` | 改 kind 与字段 |
| 名册/成员 | `agent-team/src/roster.ts` | **不抄**（我们不需要 roster，目标就是任意 SessionId） |
| 任务板 | `agent-team/src/task-board.ts` | 可选，第一版不做 |

---

## 11. 风险与决策点

| 风险 | 说明 | 缓解 |
|---|---|---|
| 冷恢复副作用 | 给冷会话发消息会把它 resume 成 live agent 并跑一轮 | 授权严格；目标无 cwd 不 resume；可配置 `allowColdWake` |
| 绕过 subagent 授权 | 直接 `agent.steer` 能碰到别人的子代理 | 显式拒绝 `origin:'subagent'` 目标（除非父会话 + 走 subagent 服务） |
| 双账本 | 同一个 Team 成员既收 Team mailbox 又收我们的 outbox | 目标是 Team 成员时改走 Team 通道或拒绝 |
| UI 兼容 | 新 source kind 在旧客户端怎么显示 | 已确认有兜底（未知 kind 也显示）；`form:'relay'` 拿 relay 语义 |
| 日志膨胀 | 每条消息两个事件，永不过期 | 限额 + 接受（Team 也这样；等 Session retention） |
| peer 会话权限 | 冷恢复的会话用**它自己**的权限 | 不提升；创建/收编时显式复制调用者权限 |

**需要拍板**：
1. 默认授权是"同 cwd 可发"还是"必须显式 allowlist"？（前者好用，后者安全）
2. 目标为 Team 成员时：走 Team 通道，还是当作普通 peer？
3. 是否允许唤醒冷会话（`allowColdWake` 默认 true 还是 false）？
4. P0 先不做 outbox（尽力而为）还是直接上 P1？
