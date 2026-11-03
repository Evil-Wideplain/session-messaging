# DSH Session 通信插件方案：list_session_agents / send_session_message

> **决策记录（2026-11-01）**
> 1. 工具名采用 DSH 风格：`list_session_agents` / `send_session_message`（不用 Claude 的 PascalCase）。
> 2. 不区分 live / cold：**冷会话也要能唤醒**（resume 后投递），`allowColdWake` 默认 true。
> 3. 跨 workspace：默认拒绝，配置开关放行，另支持 allowlist。
> 4. 一次性交付，不分 P0/P1/P2：工具 + 冷唤醒 + 落盘账本 + bash socket 通道一起做。
>
> 下文出现的 `ListAgents` / `SendMessage` 一律指本插件的两个工具，最终标识符为
> `list_session_agents` / `send_session_message`；P0/P1 字样仅保留作历史分期参考，实现按"一次性交付"执行。

> **运行时基线校正（2026-11-02）**：实现与本文档中涉及运行时事实的部分（bus 协议 §6.3、
> 归档门禁、投递判定、账本、文件清单 §13.1）按 DSH 0.2.x 校正；`docs/research/` 里的
> 0.1.3-alpha.1 调研保留为历史记录，不再视为当前接口。

> 目标：在 DSH 中提供与 Claude Code 同形的会话间通信能力——发现会话、发送消息，
> 并让 bash 脚本也能投递消息。
> 前置调研：[claude-code-session-messaging.md](../research/claude-code-session-messaging.md)（机制原理）、
> [session-messaging-plan.md](./session-messaging-plan.md)（DSH 投递/持久化设计）。

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| 一个插件够不够 | 够。两个工具 + 一个内部服务 + 一个可选 socket，全部在一个 bundle plugin 里 |
| 工具名 | 用 Claude Code 原名 `ListAgents`、`SendMessage`（PascalCase）。DSH 现有 `list_agents`/`send_message` 是小写且被 team/subagent 占用，PascalCase 天然不撞名 |
| 会话怎么命名 | 复用 DSH 已有的 `session/title`（用户在 UI 里 rename），插件只读不写；同名用短 id 消歧 |
| 目标范围 | live 会话 + **冷会话**（resume 后投递）；`allowColdWake` 默认 true |
| 发送语义 | 固定 `steer`：running 在最近 step 边界读，idle 起新 turn |
| bash 怎么发 | 插件注册 `ctx.shellEnv` 贡献者，给每次 bash/pwsh 调用注入 `DSH_SESSION_MESSAGING_SOCKET` + `DSH_SESSION_MESSAGING_TOKEN`，脚本连 socket 投递；协议为一行 auth + 一行 JSON |
| 持久性 | 插件自有 outbox 文件账本（`~/.dsh/session-messaging/outbox/*.jsonl`）+ 目标侧 ack；不用自定义 Session 事件 |

---

## 1. 需求拆解与 Claude Code 对照

| 能力 | Claude Code | 本插件 |
|---|---|---|
| 发现 | `ListAgents` 工具 + `/list-agents`；只列能收到消息的 live 会话 | `ListAgents` 工具：列 live agent，按授权过滤 |
| 发送 | `SendMessage`（`to` / `message` / `summary`，可选 `notify_when_idle`） | `SendMessage`（`to` / `message` / `summary`），v2 加 `notify_when_idle` |
| 地址 | 会话名（`/rename`、`--name`）与 id | `session/title` 派生名 + `SessionId` |
| 投递 | 注入为 user message；tool call 之间 / idle 起 turn | `agent.steer(createUserMessage(...))` |
| 入站控制 | `crossSessionInbound` accept/hold/refuse | config 三态 + `tools/pre-execute` ask（v2） |
| 脚本通道 | 每会话 inbox socket，env 暴露路径+token，脚本只能投自己 | 每用户 bus socket + 每会话 token，脚本可投任意授权目标 |
| 跨机 | Remote Control 服务器中转 | 不做（v2 可用 DSH RPC / webhook 代理） |

### 1.1 三个概念澄清（来自 Claude Code 的实现）

**① “用户在 prompt 里用 `@name` 可以让 Claude 直接寻址”是什么意思？**

这是**客户端层的寻址快捷方式**，不是新通道：

1. 用户在输入框打 `@`，typeahead 列出可寻址的会话；
2. 选中后，客户端把 `@api-worker` 这段文本插进 prompt，**同时**给模型附加一条元信息：“这个 mention 指的就是会话 `<id>`（名字 api-worker）”；
3. 模型拿到"文本 + 指向"后，可以直接调 `SendMessage({to: "api-worker"})`，**省掉一次 `ListAgents` 发现调用**。

所以：`@name` 只解决"知道发给谁"，发送仍然走 `SendMessage`；如果用户手打 `@name` 且有多会话重名，Claude 会先问清楚是哪一个。它不提高可达范围、不绕过授权/入站策略/限额。

**② `SendMessage` 也是走的这套逻辑吗？**

是。`@name` 与 `ListAgents` 都只是**解析地址**的前置步骤，最终都由 `SendMessage` 做：名字→会话（重名消歧）→ 检查可达性 → 写入对方 inbox（或 socket）→ 受入站策略约束。区别只在"地址从哪来"：@mention 是客户端预解析，ListAgents 是模型主动拉取。

**③ bash 工具为什么也能发消息？**

因为 Claude Code 给每个会话绑了一个 inbox socket，并把地址和 token 通过环境变量交给会话里的进程：

- `CLAUDE_CODE_MESSAGING_SOCKET`：socket 路径（`/status` 里 `Peer address` 的 `uds:` 前缀同款），hooks 和 Bash 命令都能拿到；
- `CLAUDE_CODE_MESSAGING_TOKEN`：每个会话的 token；
- 脚本连接后，**第一行**发 `{"type":"auth","token":"<token>"}`（Windows 必填；macOS/Linux 可选），随后发送消息行并关闭；连接后必须 30 秒内发完整行；
- 收到消息后走的**仍是同一套入站控制**（accept/hold/refuse），和工具发出的消息没有区别。

注意 Claude Code 暴露的是**会话自己的 inbox**，所以脚本的典型用法是"往自己会话里投一条消息"（例如长任务完成通知自己）；跨会话投递需要目标会话的地址。DSH 插件统一用一个 bus socket，脚本可投任意授权目标（见 §6）。

---

## 2. 总体架构

```
                    ┌─────────────────────────────┐
  模型 ──工具调用──► │ ListAgents / SendMessage     │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ SessionMessaging service     │
                    │  · 地址解析（name → id）      │
                    │  · 授权矩阵                   │
                    │  · 投递（steer / 路由）        │
                    │  · 限额与去重                 │
                    └──────┬──────────────┬────────┘
                           │              │
             ┌─────────────▼───┐   ┌──────▼─────────────────┐
             │ in-process 投递  │   │ Socket server（可选）    │
             │ agent.steer      │   │ 每用户 bus + 每会话 token │
             └─────────────────┘   └──────▲─────────────────┘
                                          │
                                   bash / pwsh 脚本
                              （shellEnv 注入 env 变量）
```

- 工具与 socket **共用**同一个投递核心，保证语义/授权/限额一致。
- 没有跨进程需求时，socket 可以关掉（`config.socket.enabled=false`）。

---

## 3. 地址与命名

### 3.1 地址

| 形式 | 说明 |
|---|---|
| `SessionId` | 永远可用、无歧义；返回结果里附带 |
| `name` | 最新 `session/title` 派生的名字（用户在 UI rename 即生效） |
| `@"名字 带空格"` | 带空格/特殊字符时用引号，和 Claude Code 一致 |

### 3.2 名字解析规则

```
resolve(nameOrId):
  1. 若精确匹配某个 live session id → 返回
  2. 读取所有 live session 的 title 快照（ctx.sessionTitle.get(session)）
  3. 大小写不敏感精确匹配 title；多个命中 → 报 AMBIGUOUS，附带候选 id + cwd
  4. 无命中 → 报 NOT_FOUND（不提示"是否存在但不可见"，防探测）
```

- title 为空的会话用 `session-<id 前 8 位>` 作为显示名，只能用 id 寻址。
- **不允许重名静默选择**：Claude Code 在用户 @mention 时会问，我们在工具层返回 `AMBIGUOUS` 并列出候选，模型可带 id 重发。
- 名字来源只读：插件不提供 rename 工具，沿用 UI 已有的 rename（`session/title` 事件）。

---

## 4. `ListAgents` 工具契约

**用途**：列出"我现在可以发消息的会话"（不是所有会话）。

```jsonc
// input
{
  "scope": "workspace",        // optional: 'workspace'（默认，同 cwd）| 'machine'（本机全部）| 'session'（仅自己）
  "include_subagents": false,  // optional: 是否额外列出其他会话的 subagent（标注不可发送）
  "limit": 50                  // optional, 1..200
}

// output
{
  "agents": [
    {
      "name": "api-worker",
      "id": "0f3c...",         // 完整 id 或 8 位短 id + 完整 id 字段
      "short_id": "0f3c9a1b",
      "cwd": "C:\\Code\\proj-a",
      "kind": "peer",          // peer | subagent | teammate
      "status": "idle",        // running | idle
      "title_source": "user"   // user | llm | fallback（可选，便于调试）
    }
  ],
  "omitted": 0,                // 因授权被过滤掉的数量（只给计数，不泄露细节）
  "note": "…"                  // 可选提示（如"跨 workspace 会话默认不可达"）
}
```

实现要点：

- 数据源：`ctx.agents.list()`（live）+ `ctx.sessionQuery.listSessions()`（持久化冷会话，标 `status: "offline"`）。冷会话也可被 `send_session_message` 寻址并唤醒。
- 过滤：`exec.agent` 存在；排除自己；归档会话不列出；按授权矩阵（§8）过滤不可达目标。
  `include_subagents=true` 时额外列出其他会话的子代理行（`sendable: false`，授权矩阵不允许发给他们）；自己的子代理总是列出。
- 标题：`ctx.sessionTitle.get(agent.session)`；取不到则回退短 id。
- 顺序：`status=running` 优先，其次最近活跃（`session.lastActivityAt` 或 header 时间），最后按名字。
- `omitted` 只给计数：避免用列表接口探测"有哪些会话存在但我不能发"。

---

## 5. `SendMessage` 工具契约

```jsonc
// input
{
  "to": "api-worker",        // name 或 SessionId（必填）
  "message": "…",            // 纯文本（必填）
  "summary": "schema 迁移完成"  // optional，5-10 词，≤200 字符，用于预览/日志
}

// output（工具不抛"业务失败"，统一返回结构化结果）
{
  "status": "accepted",      // accepted | queued | held | duplicate | refused | not_found | ambiguous | self
  "message_id": "…",
  "detail": "…",             // 人类可读说明；not_found 与「不存在」同模板、不含内部原因
  "target": { "name": "api-worker", "id": "0f3c…" },   // 仅在已解析出目标时出现
  "candidates": [{ "name": "…", "id": "…" }]           // 仅在 ambiguous 且候选可见（授权过滤后）时出现
}
```

### 5.1 核心算法（P0：直接投递）

```ts
async function sendMessage(exec: ToolExecution, input: SendMessageInput) {
  const caller = requireAgent(exec)                      // 没有调用者会话 → 拒绝
  const target = resolveAddress(input.to)                // §3.2
  authorize(caller, target)                              // §8
  assertLimits(caller, input)                            // §9

  const message = createUserMessage({
    content: [{ type: 'text', text: input.message }],
    source: { kind: 'session-message', form: 'relay',
              messageId: messageId, senderId: caller.id,
              senderName: nameOf(caller), summary: input.summary },
  })

  const routed = await route(caller, target, message)    // 子代理/团队成员走官方通道
  if (routed !== undefined) return routed
  target.agent.steer(message)                            // live 目标：直接注入
  return { status: 'accepted', messageId, to: {…} }
}
```

### 5.2 路由：优先使用已有通道

| 目标类型 | 处理 |
|---|---|
| 同一 Team 的 teammate（含 inactive） | `ctx.agentTeams.sendMessage(...)`（按成员名；保留 Team ack 语义并由它冷恢复 inactive 队友） |
| 自己的 **continuable subagent 子会话** | `ctx.subagents.sendMessage(...)`（官方血缘校验，可冷恢复已结束子代理） |
| 普通 live 会话（peer） | 本插件 `agent.steer(message)` |
| 冷会话 | 先 `ctx.agents.resume()` 唤醒，再 steer；`allowColdWake=false` 时返回 `cold` 错误（队友例外，由 team mailbox 恢复） |

团队关系优先于 subagent 血缘：队友即使同时是 Lead 的子代理，也必须走 team mailbox，否则会丢掉团队语义。
在线目标的官方通道失败可回落 inbox；离线目标不再回落（否则子代理会被当根会话唤醒、队友会丢团队授权），
直接保持 `queued`。这样避免"两本账"：每个目标只有一条投递路径。

### 5.3 落盘账本（取代 Session 自定义事件）

**不能把 outbox 写成自定义 Session 事件**：持久化读路径会拒绝"本 build 不认识的 event type"，
除非事件信封带 `ignorable: true`（`packages/core/session/src/known-event-types.ts`），而 `Session.append`
没有暴露设置该信封字段的 API。所以账本放在插件自己的目录：

```
~/.dsh/session-messaging/outbox/<senderSessionId>.jsonl
  {"op":"queued","messageId":…,"targetId":…,"text":…,"summary":…,"at":…}
  {"op":"delivered","messageId":…,"at":…}
```

- 发送：先追加 `queued` 行并 `fsync` → 投递 → 目标日志确认出现该 `messageId` → 追加 `delivered` 行；
- 确认：live 目标以 `steer` 成功（inbox 接收）即写 `delivered`；冷唤醒额外用短窗口捕获首轮错误，报错且消息未进历史时
  dispose 恢复实例并保持 `queued`；
- 恢复：真进程里由 `agent/created` 触发（0.2.x 生命周期事件表没有 `agent/session-start`；插件加载时对现有 Agent 补跑一次）。
  重放前用目标历史按 `messageId` 去重：已送达的直接写 `delivered`，不再重发；
- `status: 'queued'` 表示已落盘但暂未确认送达（通道失败/无路由/唤醒首轮失败）。

放进目标会话的那条消息本身仍是普通 `user/message`，只是 `source.kind = 'session-message'`；
持久化恢复只要求 source.kind 是非空字符串（`assertMessageEventShape`），所以这条是安全的。

---

## 6. 脚本通道：bash / pwsh 怎么发消息

### 6.1 与 Claude Code 的差异

| | Claude Code | 本插件 |
|---|---|---|
| socket 归属 | **每会话一个 inbox socket** | **每用户一个 bus socket**（外加可选每会话 socket 兼容模式） |
| 脚本能发给谁 | 只能投"自己会话"的 inbox（地址是自会话的） | 可投**任意授权目标**（`to` 字段） |
| 身份 | 靠"同 OS 用户 / 会话子进程"证明 | 每会话 token → 会话身份 |
| 入站控制 | 同一套 accept/hold/refuse | 同一套（v2 接 `tools/pre-execute`） |

采用 bus 的理由：Claude 的"自己的 socket"对脚本跨会话发消息不方便；DSH 没有每会话独立进程的天然边界，一个 bus + 每会话 token 更简单，也便于未来接 UI。

### 6.2 环境变量注入（关键）

DSH 已有 `ctx.shellEnv` 注册表（`packages/shell/shell-env`）：插件注册一个 contributor，
**每次模型调用 bash/pwsh 时**由 `ctx.shellEnv.collect(exec)` 求值注入，无需改 bash 工具实现。

```ts
ctx.shellEnv.register({
  name: 'session-messaging',
  variables: {
    DSH_SESSION_MESSAGING_SOCKET: { description: '本机会话通信 bus 的 socket 路径（脚本用）' },
    DSH_SESSION_MESSAGING_TOKEN: { description: '当前会话的通信 token（脚本鉴权用，勿外传）' },
  },
  resolve: exec => {
    const agent = exec.agent
    if (agent === undefined) return {}
    const endpoint = bus.endpointFor(agent)   // 建好则返回 {path, token}，否则 {}
    return endpoint === undefined ? {} : {
      DSH_SESSION_MESSAGING_SOCKET: endpoint.path,
      DSH_SESSION_MESSAGING_TOKEN: endpoint.token,
    }
  },
})
```

注意：

- 键名必须匹配 `^DSH_[A-Z][A-Z0-9_]*$`；`DSH_SESSION_ID`、`DSH_HOME`、`DSH_SHELL` 已被占用，不能注册；
- 依赖 `shellEnv` 服务存在（bash/pwsh 工具所在 profile 默认有）；用 `ctx.get('shellEnv')` 探测，没有就静默降级为"仅工具通道"。

### 6.3 socket 与协议

```
路径：
  POSIX   <tmpdir>/dsh-session-messaging-<uid>/bus.sock    （目录 0700、socket 0600）
  Windows \\.\pipe\dsh-session-messaging-<uid>-<sha256(resolve(dir).toLowerCase())[0:8]>
token：
  <sessionId> → 32 字节随机数的十六进制串，只存在于插件内存（每会话一个，重启后重新生成）；
  通过 ctx.shellEnv 注入该会话的 bash/pwsh 环境，不落盘
```

协议（实现见 `src/interfaces/local-bus.ts`）：

1. 一次连接携带**一个** JSON 请求（以换行或 EOF 结束）；token 与命令在同一个对象里，没有单独的 auth 帧。
   请求体上限 1 MiB（按 UTF-8 字节计）；服务端用 `setEncoding('utf8')` 读取，跨 chunk 的多字节字符不会被切成 U+FFFD；
2. 支持两个 op：
   - `{"token":"…","op":"list","include_subagents":false,"limit":20}` → 与 `list_session_agents` 同源；
   - `{"token":"…","op":"send","to":"api-worker","message":"…","summary":"…","dedupe":true}` → 与 `send_session_message` 同源。
   参数类型/范围与工具层同一套校验（`limit` 为 1–200 的整数、布尔字段必须是布尔值），错类型返回 `bad_request`，
   不再静默忽略；
3. 服务端回一行 JSON 后关闭连接；连接空闲 30 秒、单次请求处理 25 秒后返回超时；
4. 响应：`{"ok":true,"result":…}` 或 `{"ok":false,"error":{"code":"unauthenticated|bad_request|too_large|timeout|failed","message":"…"}}`；
5. 端点归属：POSIX 启动前先 connect 探测，能连上说明已有宿主，直接失败；只有连不上（陈旧 socket 文件）才清理。
   因此第二个宿主不会抢走端点，start() 失败的一方 stop() 也不会删掉属主的 socket；
6. 停止时主动销毁所有活动连接，再 `server.close()`，避免关闭流程被空闲连接拖到超时。

示例（bash，Linux/macOS，用 node）：

```bash
node -e '
const net = require("node:net")
const s = net.connect(process.env.DSH_SESSION_MESSAGING_SOCKET)
let out = ""
s.on("data", d => out += d)
s.on("end", () => console.log(out))
s.write(JSON.stringify({
  token: process.env.DSH_SESSION_MESSAGING_TOKEN,
  op: "send",
  to: "api-worker",
  message: "migration finished"
}) + "\n")
'
```

Windows 用命名管道时 Node 的 `net.connect(path)` 同样可用；PowerShell 可用 `[System.IO.Pipes.NamedPipeClientStream]`
或直接调同一段 node 脚本。

### 6.4 安全

- socket 目录 0700、socket 文件 0600（显式 chmod，不依赖 umask）；token 只在会话作用域内可见
  （shellEnv 只注入给该会话的 shell 调用），内存态、不落盘；
- 收到命令后仍走**同一授权矩阵**：token 决定 sender 身份，`to` 仍要过 §8；
- 脚本不能借 token 冒充别的会话（token→session 由服务端映射，不从消息里读 sender）；
- 沙箱/受限环境可能连不上 socket（Claude Code 也有同类限制），此时脚本会超时——文档要写明 fallback 是用工具。

---

## 7. 消息来源与账本

```ts
// 目标会话里看到的那条 user message（普通 user/message，只是 source 自定义）
interface SessionMessageSource {
  kind: 'session-message'
  form: 'relay'
  messageId: string
  senderId: SessionId
  senderName: string
  summary?: string
}
```

- 自定义 **event type 不能写进 Session 日志**（恢复期拒绝未知事件，见 §5.3），所以发送方的 `queued/delivered` 账本落在
  `~/.dsh/session-messaging/outbox/<senderId>.jsonl`，不进会话日志；
- 目标侧的消息仍是标准 `user/message`，恢复期只校验 `source.kind` 是非空字符串，自定义 kind 安全；
- 客户端已有未知 source kind 的兜底渲染（`ui-conversation/context-provenance.ts`），新增 kind 不会崩；带 `form:'relay'` 可拿到 relay 语义；
- 去重判断用 `messageAccepted`：同时扫 `user/message` 与 `agent/inbox/spliced`（见 §7.1）。

### 7.1 为什么去重要扫两处

DSH 的**消息队列底层是 Agent Inbox**：投递先进 inbox（`agent/inbox/spliced` 事件落盘），
turn/step 边界才被 `claim` 成 `user/message`。所以"目标是否收到"存在两阶段：

| 阶段 | 证据 |
|---|---|
| 已进队列、还没被模型看到 | `agent/inbox/spliced` 的 inserted 条目 |
| 已被 turn claim、进入模型历史 | `user/message` 事件 |

只扫 `user/message` 会在"投递成功但 turn 尚未 claim"的窗口里重复投递；两处都扫才是准确判据。

---

## 8. 授权矩阵

身份只从 `exec.agent` / socket token 取，**绝不从参数取**。

| 场景 | 结果 |
|---|---|
| `to` 解析到自己 | `self`，拒绝 |
| 目标不存在 | `not_found`（与无权限同文案） |
| 同 cwd 的普通 live 会话 | 允许（默认策略） |
| 跨 cwd | `config.allowCrossWorkspace`（默认 false）→ 否则拒绝，对外统一 `not_found` |
| 目标的 subagent（别人拥有） | 拒绝（`allowlist` 也不能绕过），对外统一 `not_found` |
| 自己的 continuable 子代理 | 允许，但路由到 `ctx.subagents.sendMessage` |
| 同 Team 的 teammate | 允许，路由到 `ctx.agentTeams.sendMessage` |
| 目标已 `cancel`/disposed 但仍在 registry | 允许 steer；恢复后重放未确认消息 |

`config.allowlist` 支持按 sessionId / cwd 前缀精确放行。

---

## 9. 限额、去重、防循环

| 项 | 默认 | 说明 |
|---|---|---|
| 单条消息大小 | 64 KiB | 超限直接 `refused`，写明上限 |
| 每 sender→target 频率 | 20 条/分钟 | 超出 `refused` 并提示合并；命中去重不消耗配额 |
| 相同内容去重窗口 | 10 秒 | `(sender,target,text,summary)` 命中 → 返回原 messageId 并标 `duplicate`；`dedupe=false` 可强制发送 |
| 目标待读队列 | 50 条 | 超出拒绝并提示对方忙 |
| `notify_when_idle`（v2） | 12 小时过期 | 只允许主会话订阅 |

这些是 Claude Code 的同款护栏，避免两个会话互刷。

---

## 10. 代码结构与依赖

```
src/
├─ index.ts                 # name/inject/Config/apply：服务 + 工具 + shellEnv + socket 生命周期
├─ types.ts                 # 事件与 source 的 declaration merging
├─ service.ts               # SessionMessaging：resolve/authorize/send/list
├─ names.ts                 # title 快照 → 名字；歧义/回退规则
├─ authorization.ts         # 纯函数矩阵（单测友好）
├─ route.ts                 # team / subagent / peer 三条路由（team 优先）
├─ deliver.ts               # steer + resume + outbox/ack
├─ transport-inproc.ts      # 工具通道
├─ transport-socket.ts      # bus server、token、协议、超时
├─ tools/
│  ├─ list-agents.ts
│  └─ send-message.ts
├─ presentation.ts          # 紧凑 render（表格/一行摘要）
└─ errors.ts                # 白名单错误码
```

`index.ts` 的关键形状：

```ts
export const name = 'session-messaging'
// Cordis 的 inject 只有两种写法：服务名数组或 name→config 映射，没有 required/optional 之分。
// 必需服务写进 inject；可选服务用 ctx.get('…') 探测，不存在就降级。
export const inject = ['tools', 'agents', 'sessions']
export const Config = z.object({
  messengerName: z.string().default('session-messaging'),
  allowCrossWorkspace: z.boolean().default(false),
  allowlist: z.array(z.string()).default([]),
  maxBytes: z.number().default(64 * 1024),
  socket: z.object({
    enabled: z.boolean().default(true),
    dir: z.string(),          // 默认 /tmp/dsh-session-messaging-<uid> 或 %TEMP%
  }).default({ enabled: true }),
})

export function apply(ctx: Context, config: Config) {
  const service = new SessionMessaging(ctx, config)     // 内部用 ctx.get('sessionTitle'/'shellEnv'/…)
  ctx.effect(() => () => service.dispose())
  registerTools(ctx, service)                           // 全局注册：所有 agent 都可见，身份由 exec.agent 决定
  ctx.on('agent/created', ({ agent }) => service.recover(agent))
}
```

> 如果想让 subagent 会话看不到这两个工具，可以改成"scoped 注册"（在 `agent/created` 里用 `agent.ctx` 注册），
> 代价是要给插件加载前就已存在的 agent 补注册。工具内部本来就会拒绝对 subagent 会话的越权操作，用全局注册即可。

工具注册用 `defineTool`（`@deepseek-ai/dsh-tools`，仅 devDependency + type-only import）或原始 `ToolDefinition` 对象；
必须提供 `output: { schema, render }`（否则 `tools.register` 直接抛错）。

依赖策略：

- 运行时只依赖 Cordis/schemastery（与 scaffold 现状一致）；
- 官方包全部 `import type` 或 `ctx.get(...)` 探测，避免被 alpha 版本引脚死；
- 工具定义里用**原始 JSON Schema**（`@deepseek-ai/dsh-tools` 接受），不引入 schema builder。

---

## 11. 里程碑

| 交付项 | 内容 | 验收 |
|---|---|---|
| 工具 | `list_session_agents` + `send_session_message`（名字解析、授权、steer、限额/去重） | 两个 GUI 会话互发；错误码齐全；typecheck + 单测通过 |
| 冷唤醒 | `ctx.agents.resume` + 每目标并发去重 + 唤醒后投递 | 关闭的会话被消息唤醒；无重复 resume |
| 落盘账本 | outbox JSONL + 重放 + `messageAccepted` 去重 | 崩溃窗口不重复投递；`status: queued` 可查 |
| bash 通道 | shellEnv 注入 + bus socket + 协议 | bash 脚本成功发消息；无权限/超时错误明确 |
| 可选收尾 | `notify_when_idle`、入站 hold | 视时间追加 |

### 测试清单

- 地址：id / name / 重名 `AMBIGUOUS` / 空 title 回退 / 带空格引号；
- 授权：同 cwd、跨 cwd、自己、不存在、别人的 subagent；
- 投递：running 收到 steer、idle 起 turn、目标刚 disposed；
- 限额：超 bytes、超频、10 秒内同内容去重；
- socket：auth 失败、超时、`to` 无权限、list 命令；
- 组装：`ctx.tools.schemas()` 含 `list_session_agents`/`send_session_message` 且无重名；插件卸载后 socket/监听器无泄漏。

---

## 12. 风险与决策点

| 风险 | 缓解 |
|---|---|
| 工具名固定为 `list_session_agents` / `send_session_message`，避开已占用的 `list_agents`/`send_message` | 名字已定，不再提供别名开关 |
| `ctx.shellEnv` 在某些 profile 不存在 | `ctx.get('shellEnv')` 探测；无则只用工具通道，并在工具描述里说明 |
| socket 在受限环境不可用 | 配置可关；文档给 tool 通道 fallback |
| 与 Team/subagent 双账本 | 目标类型路由到官方通道，绝不重复投递 |
| `sessionTitle` 服务缺失 | 回退短 id；`ctx.get('sessionTitle')` 探测 |
| 名字不可写导致模型没法"起名" | 沿用 UI rename（`session/title`）；插件不新增 rename 工具 |

**已定（2026-11-01）**：工具名 `list_session_agents`/`send_session_message`；冷会话可唤醒；跨 workspace 默认拒绝 + 开关 + allowlist；一次性交付（含 bash 通道）。

---

## 13. 实现状态（2026-11-01）

插件已在 `dsh-plugin-session-messaging` 里按本方案一次性实现（不分 P0/P1）：工具、冷唤醒、落盘账本、
bash/pwsh 通道一起交付。本节记录**实际落地**的形态与方案正文的差异，正文保持不变，作为设计依据。

### 13.1 实际文件

代码按 DDD 分层落地，目录即依赖方向：

| 路径 | 职责 |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply`：注册三个工具、启动 bus（成功后注入 shellEnv）、挂 `agent/created` 重放 |
| `src/composition.ts` | 组合根：端口 → 具体适配器；暴露 `MessagingRuntime` |
| `src/config.ts` | 扁平配置 + schemastery schema + 默认值 + 运行期派生项（`pathCaseInsensitive`） |
| `src/types.ts` | 本插件用到的 DSH 服务结构化契约 + Cordis `Context`/`Events` declaration merging |
| `src/domain/` | 纯规则：`target.ts` 寻址、`authorization.ts` 授权矩阵、`routing.ts` 通道路由、`message.ts` 消息构造与送达判定（含来源框架）、`inbound-policy.ts` 入站三态与容量、`held-message.ts` 待审实体、`outbox.ts` 账本模型 |
| `src/application/` | `messaging-service.ts` 用例编排（list/send/review/recover）、`dto.ts` 返回形状、`guards.ts` 频率与去重窗口、`ports.ts` 端口接口 |
| `src/infrastructure/` | `jsonl-ledger.ts` 追加式账本原语、`jsonl-outbox-repository.ts`、`jsonl-inbound-repository.ts`、`cordis-session-directory.ts`、`cordis-delivery-gateway.ts`、`persisted-session.ts`、`paths.ts` |
| `src/interfaces/` | `model-tools.ts` 三个工具的 JSON Schema 与参数校验、`local-bus.ts` 每用户 bus server + shellEnv 注入 |
| `scripts/e2e-runtime.mjs` | 真运行时 e2e（dsh CLI + 真模型）；只允许跑在名字以 `-e2e` 结尾的 profile，并备份/还原其 patch |

（v3 起为满足「每个 TS/JS 文件 ≤200 行」的工程规范，上表中的长文件已拆成
barrel/门面 + 子目录：`types/`、`application/messaging/`、`interfaces/tools/`、
`infrastructure/delivery/`、`infrastructure/directory/`、`interfaces/bus/`；
当前目录结构以 README 为准。）

### 13.2 与正文的差异

| 正文 | 实际 | 原因 |
|---|---|---|
| §10 拆成 `route.ts`/`deliver.ts`/`transport-*.ts`/`tools/*` | 按 DDD 分层：`domain/` + `application/` + `infrastructure/` + `interfaces/`，组合根本身只有 `index.ts`/`composition.ts` | 一次性交付后按依赖方向重整；端口/适配器边界比按动词切文件更能约束跨层引用 |
| §6.3 「每用户一个 bus」（正文） | **维持单 bus**；不采用 Claude Code 的每会话 socket | 脚本要给任意会话发消息、并唤醒冷会话；冷会话没有进程就没有监听者。隔离性由 token + 授权矩阵保证（2026-11-01 决策） |
| §5.2 subagent → `ctx.subagents.sendMessage`；team → `ctx.agentTeams.sendMessage` | **已接通**：自己的 continuable subagent 走 subagent 通道，团队成员走 team mailbox（成员名寻址、可跨 workspace、inactive 队友可冷恢复）；官方通道失败时在线目标回落 inbox，离线目标保持 `queued` | 0.2.x 服务已可用；回落策略避免绕过冷恢复/团队授权语义（2026-11-02） |
| §5.3 账本 `queued`/`delivered` | `queued`/`held` + 终态 `delivered`/`expired`/`refused`；JSONL 追加 + fsync，崩溃残行自动补换行，压缩用临时文件 + rename 原子替换；未知 op 不当作终态 | 授权在发送时已判定，重放按现状重新判定；账本只增不减会拖慢每次 send（2026-11-02） |
| 正文只放原始文本，来源信息只写 `source` | 正文内置来源框架：`Session message <id> from <name> (<sessionId>):` + 正文 | `user/message` 的正文会被原样投影给目标模型；不内置框架时模型无法区分「另一个会话的消息」与「人类指令」（2026-11-02） |
| 授权失败返回具体原因 | 未授权与不存在统一返回 `not_found`，原因只写日志 | 具体原因（跨 workspace/别人的 subagent）可被用来枚举会话（2026-11-02） |
| 归档预检查失败按「无归档」处理 | 读取失败 fail-closed：拒绝冷唤醒并保持 `queued` | 归档门禁会以 `turn/end blocked` 静默吞掉唤醒消息（2026-11-02） |
| 冷唤醒用 `ctx.agents.resume({ resumeSessionId })` | 三级降级：`preset + 记录路由` → `记录路由` → 纯宿主默认 | preset 被删/坏时不能把会话变成不可达；丢 preset 专属工具好过丢消息 |
| — | `ctx.agents.resume` 的 handle 由插件持有，`dispose()` 时统一释放 | 避免卸载插件后留下孤儿 agent |

### 13.3 验证

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck`（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`） | 通过 |
| `pnpm test`（108 个用例，其中 1 个平台相关跳过） | 通过 |
| `pnpm run build` | `lib/index.js` + `lib/types/**/*.d.ts` |
| 导入产物体检 | 导出 `Config` / `apply` / `inject` / `name`；`Config({})` 得到全部默认值 |

单测覆盖：地址规范化与回退、标题/模型路由折叠、`messageAccepted` 三态（inbox 待 claim / 已 claim / 已进历史）、
账本折叠、授权矩阵（self / 同 cwd / 跨 cwd / 开关 / allowlist / 直接子 agent / 别人的子 agent）、live 投递并确认、
按名字寻址、`not_found`、跨 workspace 拒绝与放开、相同正文去重、频率限额、**并发冷唤醒只 resume 一次**、
发送者重启时的账本重放。

尚未覆盖：真实 DSH 进程内的端到端（工具注册、`ctx.shellEnv` 注入、bus 连接）——需要把包装进 profile 后手工验证，
单测用结构化假 ctx 覆盖了服务层逻辑。

### 13.4 v1 范围外

- `ctx.subagents.sendMessage` / `ctx.agentTeams.sendMessage` 路由（continuable、team mailbox、任务板）；
- 入站 `accept` / `hold` / `refuse` 审批与 `notify_when_idle`；
- 每会话 socket 变体（只在需要「脚本只能投自己」的强隔离部署里才有意义）；
- 工具名的 camelCase 别名（已定只用 snake_case）。

---

## 14. v2 增补：官方通道路由与入站审批（2026-11-01）

§13 交付了「任意会话可达」的 v1。v2 补上正文原本就设计、但 v1 推迟的两块：§5.2 的官方通道路由，
以及 Claude Code `crossSessionInbound` 对应的入站 `accept / hold / refuse` 审批。第三次增补是验证层：
包级 e2e（加载 `lib/index.js`）与真运行时 e2e（`dsh` CLI + 真模型 + 两个 OS 进程）。

### 14.1 为什么现在补

- **路由**：v1 对 subagent 直接 `steer`，绕过了 `ctx.subagents.sendMessage` 的 continuable 授权与生命周期；
  对团队成员也没有走 team mailbox，导致同名工具（`list_agents`/`send_message`）与插件通道语义不一致。
- **审批**：没有入站策略时，任何被授权的会话都能把内容直接塞进另一个会话的上下文——这是权限矩阵之外的第二道
  边界。Claude Code 用「三态开关 + 审批对话框」表达它；本插件用「三态开关 + 目标侧工具」表达同一语义。

### 14.2 通道路由（正文 §5.2 的落地）

| 关系 | 判定 | 通道 | 成功语义 |
|---|---|---|---|
| 自己的 continuable subagent | `target.kind === 'subagent'` 且 `header.parentSession === caller.id` 且 `ctx.subagents` 存在 | `ctx.subagents.sendMessage(caller.agent, targetId, content, { signal })` | 官方通道 resolve 即 `delivered` |
| 同团队成员 | `ctx.agentTeams.membership(caller.agent)` 有值，且 target id 在 `listMembers(caller.agent)` 里 | `ctx.agentTeams.sendMessage(caller.agent, { target: memberName, content, signal })` | resolve（`accepted` 或 `queued`）即 `delivered` |
| 其余 | — | 会话 inbox：`wake` → `Agent.steer` → `flush` → `messageAccepted` | 只有 `messageAccepted` 为 true 才 `delivered` |

三条约束：

1. **一次投递只走一个通道**：官方通道成功就不再 steer，避免同一个 `messageId` 进两个账本；
2. **官方通道失败回落 inbox**：`ctx.subagents.sendMessage` / `ctx.agentTeams.sendMessage` 抛错时记 warn 并继续走
   `steer`，路由细节不能把消息丢掉；
3. **`messageAccepted` 只用于 inbox**：官方通道不写 `agent/inbox/spliced`，没有可折叠的投影，成功即确认。

团队通道用**成员名**而不是 session id：team mailbox 的地址空间是名册（`listMembers` 返回 `{ name, id }`），
名册关系本身就是授权，因此团队成员可以跨 workspace 投递——这与 v1 的 `cross-workspace` 拒绝策略不冲突，
是「显式关系优先于目录策略」。`list_session_agents` 的 `kind` 因此多出 `teammate`。

### 14.3 入站审批（Claude Code `crossSessionInbound` 的落地）

| 策略 | 行为 | 配置 |
|---|---|---|
| `accept` | 直接投递；v1 行为，也是默认值 | `inbound: accept` |
| `hold` | 不投递；写接收方 inbound 账本；在线时发一条节流 notice；接收方用 `review_session_messages` 决定；超时/超容量自动淘汰 | `inbound: hold` |
| `refuse` | 一律 `refused`，正文不落任何账本 | `inbound: refuse` |

`hold` 的数据流：

```text
sender.send
  -> sender outbox: {"op":"held", expiresAt}
  -> target inbound: {"op":"held", expiresAt}
  -> target 在线? -> notice（"N 条待审批"，notifyIntervalMs 节流）
  -> target review_session_messages action=accept
       -> 重新授权（sender 会话还在？cwd 还满足策略？）
       -> 投递到 target（走 §14.2 的路由）
       -> target inbound: {"op":"accepted"}
       -> sender outbox: {"op":"delivered"}
  -> action=refuse / 过期 / 容量淘汰
       -> target inbound: {"op":"refused"|"expired"}
       -> sender outbox: {"op":"refused"|"expired"}（在线 sender 收到 notice）
```

对齐 Claude Code 的两个参数：`holdExpiryMs` 默认 5 分钟（对应 `dialogExpiry`），`maxHeldPerTarget` 默认 100、
满了丢最旧（对应 max hold 100）。过期/淘汰是**惰性**的，三个时机：新 hold 入账前、目标 review 时、目标会话启动的
`recover` 里。发送方离线时只更新账本，不补发 notice（对应 Claude 的「可达时才通知」）。

### 14.4 为什么不用 `ctx.approval`

DSH 的审批服务要求**存在 open turn**（按 `turn/start`/`turn/end` 判定），且只有 agent 的 owner 能作答。
入站消息的审批发生在目标会话自己的工具调用里：目标看到 notice → 自己调 `review_session_messages` → 结果作为工具
返回进入它自己的 turn。把它塞进 `ctx.approval` 会出现「没有 open turn 可挂」和「answerer 不是目标」两个问题。
所以采用「目标侧工具 + notice」，语义上等价于 Claude 的审批对话框：**决定之前，消息不进入目标上下文**。

### 14.5 账本分账

| 文件 | 归属 | ops |
|---|---|---|
| `$DSH_HOME/session-messaging/outbox/<senderId>.jsonl` | 发送方 | `queued` / `held` → `delivered` / `expired` / `refused` |
| `$DSH_HOME/session-messaging/inbound/<targetId>.jsonl` | 接收方 | `held` → `accepted` / `refused` / `expired` |

`recover()` 只重放 `queued`：被 `hold` 的消息归接收方 inbound 账本管，绝不能因为发送方重启就绕过审批再投一次。
配置了 `outboxDir` 时 inbound 账本落在 `<outboxDir>/inbound/`，便于测试隔离。

### 14.6 验证

| 层 | 内容 | 结果 |
|---|---|---|
| 单测 | 21 个（寻址/授权/账本/去重/限额/冷唤醒/重放）+ 10 个（路由 + 入站审批 + 重新授权）+ 2 个（bus 协议） | 通过 |
| 包级 e2e | 直接加载构建产物 `lib/index.js`，假 DSH ctx 提供工具/总线/终端环境；断言三个工具注册、参数与输出 schema、真管道 + 真 token 的 list/send、`hold` → `review accept` 全链路 | 通过（单测 + 包级 e2e 共 108 个用例，107 通过、1 平台跳过） |
| 真运行时 e2e | `dsh --profile session-messaging-e2e headless --json`：目标会话建立 → 发送方 `hold` → 目标 `--session-id` 恢复并 `accept` → 再发一条等过期 → `expired` | **17/17 检查通过**（见 §14.7） |

包级 e2e 补上了 v1 「尚未覆盖」的空白：ESM 产物、跨模块 import、插件入口、真实管道连接、shellEnv 注入。

真运行时 e2e（`scripts/e2e-runtime.mjs`，一次性准备 profile 后 `DEEPSEEK_API_KEY=... node scripts/e2e-runtime.mjs`）：

- 独立 profile `session-messaging-e2e`，`dsh plugin add` 链接本仓库，与日常 GUI 的 profile 隔离；
- 脚本写入 profile 的 `cordis.patch.yml`（`inbound: hold`，先 60s 窗口后切 1.5s 用于过期用例）；
- 每一步的 `--json` 事件流落在 `e2e-workspace/artifacts/`，会话日志用 `zstd -dc` 解多帧后断言。

### 14.7 已知问题与仍未做

- **一次性 headless 进程里冷唤醒有假阴性**：sender 进程唤醒目标后立刻 dispose，目标可能刚被唤醒、消息还在
  next-step inbox 就被拆掉，`messageAccepted` 判 false，返回 `queued`。长驻宿主（GUI）不存在这个问题；账本会
  在目标下次真正运行时重放，所以是「诚实的状态」而不是丢消息。真运行时 e2e 的 accept 用例因此走
  `hold` + 目标自己 `--session-id` 恢复的路径；
- team **任务板**未接，只接了口箱；`notify_when_idle` 未做（`queued` 已覆盖"目标不在时先落盘"）；
- 每会话 socket 变体、camelCase 别名仍未做（理由同 §13.2/§13.4）。


## 15. DDD 分层重构（v2.1）

v2 的逻辑是正确的，但模块按「技术件」平铺（`service.ts` 同时承担用例编排、投递、唤醒、
限额、审批），领域规则与基础设施细节混在一个文件里。v2.1 按 DDD 的分层与依赖倒置重排，
行为不变（108 个用例全绿，真运行时 e2e 17/17），只是让规则可以脱离 Cordis 被理解和测试。

### 15.1 分层与依赖方向

| 层 | 目录 | 职责 | 允许依赖 |
|---|---|---|---|
| 领域层 | `src/domain/` | 会话目标值对象、授权矩阵、通道路由、消息与送达判定、入站三态与容量规则、出站账本模型 | 只依赖 `src/types.ts` 的共享契约；不碰 Cordis、不碰 `node:fs` |
| 应用层 | `src/application/` | 用例编排（list / send / review / recover）、DTO、限流去重、端口接口 | 领域层 + 端口 + `types.ts` 共享契约 + `config.ts` 的类型与纯标准库计算（`node:crypto` / `node:path`）；不认识具体适配器 |
| 基础设施层 | `src/infrastructure/` | JSONL 账本、Cordis 会话目录、投递网关（官方通道 / inbox / 冷唤醒）、路径、冷会话短读 | 领域层 + 应用层端口 + Cordis |
| 接口层 | `src/interfaces/` | 模型工具（schema + 参数校验 + DTO 投影）、本地总线 | 应用层 + Cordis 上下文与 `infrastructure/paths`（仅本地总线传输这一例外） |
| 组合根 | `index.ts` / `composition.ts` | 装配端口实现、注册工具 / 总线 / 恢复钩子 | 所有层 |

依赖方向永远指向领域：`domain ← application ← interfaces`，`infrastructure` 实现
`application/ports.ts` 的接口，`index.ts` 是唯一 new 具体适配器的地方。

### 15.2 关键取舍

1. **领域规则纯化**：`authorize()`、`planDelivery()`、`holdDeadline()` / `capacityOverflow()`、
   `messageAccepted()` 都是纯函数或值对象方法，可以在没有 Cordis 的测试里直接断言；
   v2 的 `decideRoute(ctx, …)` 需要整个 Context，现在只接收「是否自己的子代理 / 团队成员名 /
   通道是否存在」三个事实。
2. **端口倒置**：`OutboxRepository`、`InboundRepository`、`SessionDirectory`、`DeliveryGateway`
   四个端口把「持久化 / 目录 / 投递」隔离在应用层之外；测试可以用假 Context 或假适配器替换，
   不依赖 JSONL 文件或命名管道。
3. **聚合与仓储分工**：挂起队列的容量 / 过期规则留在领域层（`inbound-policy.ts`），
   JSONL 实现只负责追加、折叠、压缩——规则不因存储介质不同而漂移。
4. **Caller 是边界对象**：`Caller = { agent, identity }` 只在应用层以上出现；领域层只认
   `CallerIdentity`。`Agent` 是运行时句柄，不进入领域模型。
5. **中文注释**：`src/`、`tests/`、`scripts/` 的注释与 JSDoc 全部用中文（`@module` /
   `@inheritdoc` 等 JSDoc 标签保留）；面向模型的工具 description 仍为英文——它是给模型看的
   接口文案，不是注释。

### 15.3 与原模块的对应

| v2 模块 | v2.1 位置 |
|---|---|
| `service.ts` | `application/messaging-service.ts`（用例）+ `infrastructure/cordis-delivery-gateway.ts`（投递执行）+ `infrastructure/cordis-session-directory.ts`（目录） |
| `names.ts` | `domain/target.ts`（值对象/归一化/错误）+ `infrastructure/cordis-session-directory.ts`（运行时投影、标题缓存） |
| `auth.ts` | `domain/authorization.ts` |
| `route.ts` | `domain/routing.ts` |
| `message.ts` | `domain/message.ts` |
| `ledger.ts` / `inbound.ts` | `infrastructure/jsonl-outbox-repository.ts` / `jsonl-inbound-repository.ts`（各自实现端口） |
| `persisted.ts` / `paths.ts` | `infrastructure/persisted-session.ts` / `paths.ts` |
| `tools.ts` / `socket.ts` | `interfaces/model-tools.ts` / `interfaces/local-bus.ts` |
| `index.ts` | `index.ts` + `composition.ts` |

### 15.4 验证

重构后 `pnpm test` 仍为 37/37 通过（单测 33 + 包级 e2e 4），`tsc --noEmit` 无错误；
真运行时 e2e 重跑 17/17 通过，说明分层调整没有改变外部契约（工具名、参数、状态码、bus 协议、
账本文件名与 JSONL 记录格式全部保持兼容）。

---

## 16. v3：创建会话（`create_session_agent`，2026-11-02）

v3 新增模型工具 `create_session_agent`：从零创建一个普通（root）会话，并把首条消息投递进去。
**完整的工具文档（契约、状态语义、实现路径、授权、失败排查、已知限制、验证方式）独立维护在
[`docs/create-session-agent.md`](../create-session-agent.md)**；本节只保留设计记录。

设计要点（论证见独立文档 §3–§4）：

1. **创建走 `ctx.sessionController.create()`，不走 `ctx.agents.create()`。** 后者把新会话登记成
   调用方 Fiber 的孩子，插件重载/卸载即被拆掉，并跳过产品层要做的 mkdir、preset 组合、模型选择、
   Workspace 归属与侧栏广播；控制器的生命周期归应用组合，与 GUI「新建会话」同构。
2. **首条消息用 `agent.followup()` 投递**，正文复用本插件的转发构造（`session-message` 来源 +
   `Session message <id> from <name> (<id>):` 来源框架）。不用 `sessionController.prompt()`：那是
   Remote 客户端入口，依赖调用侧 principal 与附件/文件回执服务。
3. **root-only。** 子代理已有 `subagent` / `spawn_teammate`；允许它创建 root 会话会绕开委派深度与
   权限收敛，因此应用层直接拒绝。
4. **cwd 授权复用投递侧策略。** 缺省为调用方 cwd；显式 cwd 必须绝对路径，并过
   `allowCrossWorkspace` / `allowlist`；创建后尽力补 Workspace attach、继承调用方权限预设、写标题。
5. **限额与失败语义。** 参数校验在限额之前，被拒绝的请求不消耗配额；会话已创建但首条消息未投递时
   返回 `failed` + `session_id`（会话真实存在，可用 `send_session_message` 补发）。
6. **首条消息不进入站审批。** 它与人类新建会话后输入第一条消息等价；`inbound: hold` / `refuse` 只约束
   之后别人发给这个会话的跨会话投递。
7. **v4 增补：位置可指定工作区。** `create_session_agent` 接受 `workspace`（工作区 id 或已登记根目录
   路径）与 `ensure_workspace`（目录不存在则创建、未登记则 `workspaceRegistry.create` 登记）。解析与
   登记在基础设施层 `CordisWorkspaceResolver`；`ensure_workspace` 严格「先授权、后副作用」，并受
   `allowCreateWorkspace` 控制。DSH 的 `attachSession` 要求会话 cwd 与工作区根目录完全相等，因此
   子目录会话只能未分组，或先把子目录登记成独立工作区。
8. **v4.1 修复记录（2026-11-03）。** 创建链收口：每分钟限额前移到 `ensure_workspace` 副作用之前（被限额
   拒绝不产生目录/工作区）；`ensure` 返回的实路径（realpath）与授权路径不同时按规范路径重新授权；模型
   可见的 `render` 输出清洗对端可控文本；投递网关 `dispose` 取消在途投递并释放恢复句柄；`workspace`
   传 id 时的拒绝文案统一，避免枚举工作区登记状态。
