# session-messaging

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB.svg)](https://github.com/Evil-Wideplain/session-messaging)
[![GitHub stars](https://img.shields.io/github/stars/Evil-Wideplain/session-messaging?style=social)](https://github.com/Evil-Wideplain/session-messaging)

**DSH（DeepSeek Harness）插件：跨会话消息传递（cross-session messaging）。**
让同一个 DSH 进程里的会话**互相寻址、互相唤醒、互相发消息**，也让 bash / pwsh 脚本通过本机总线参与协作。

> **English**: Cross-session messaging for DSH (DeepSeek Harness) agents — lets sessions in the same
> process address, wake and message each other, approve inbound messages, and send messages from
> bash / pwsh scripts. Built for multi-agent collaboration, Agent Teams and session orchestration.

> 状态：v0.1.0（早期版本，接口可能调整）。运行时基线为 DSH 0.2.x、Node.js ≥ 22。

## 目录

- [为什么需要它](#为什么需要它)
- [能力一览](#能力一览)
- [快速开始](#快速开始)
- [工具](#工具)
  - [`list_session_agents`](#list_session_agents)
  - [`send_session_message`](#send_session_message)
  - [`create_session_agent`](#create_session_agent)
  - [`review_session_messages`](#review_session_messages)
- [入站审批](#入站审批)
- [配置](#配置)
- [本地总线](#本地总线)
- [授权矩阵](#授权矩阵)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [开发](#开发)
- [延伸阅读](#延伸阅读)
- [许可证](#许可证)

## 为什么需要它

在一个 DSH 进程里，多个会话并存是常态：GUI 里每个标签页一个会话、Agent Teams 的队友、subagent，
以及 `dsh headless` 拉起的一次性会话。它们各自有历史、有模型、有工具，但**默认彼此不可见**：

- GUI 标签页之间没法互相通知「接口改完了，帮忙重跑一下 e2e」；
- Agent Teams 的消息工具绑在团队身份上，平级会话和脚本进不来；
- subagent 通道只覆盖「直接父 ↔ 直接子」这一层；
- headless / CI 脚本里没有会话身份，想给某个会话递一句话只能人工切换。

这个插件补的就是这一层：给每个会话一个**地址**（显示名或 session id）、一个**信箱**（inbox），
以及一套**授权矩阵**（同 workspace / 团队 / 子代理关系），让「任意有权访问的会话」都能被寻址和投递；
冷会话还能按历史里的模型路由 resume 之后投递。所有写操作先落 JSONL 账本，重启后重放、按 `messageId`
去重，不会重复投递，也不会静默丢失。

## 能力一览

| 能力 | 形态 |
|---|---|
| 列出可发送的会话 | 工具 `list_session_agents` |
| 给会话发消息（含冷会话唤醒、官方通道路由） | 工具 `send_session_message` |
| 审批别人发给你的消息（入站 `accept/hold/refuse`） | 工具 `review_session_messages` |
| 新建一个普通会话并投递第一条消息 | 工具 `create_session_agent` |
| bash / pwsh 脚本发消息 | 每用户一个本地 bus socket + 每会话 token（`ctx.shellEnv` 注入） |

插件页上它拆成两个组件：`session-messaging`（三个会话间工具 + 本地总线）和 `session-creation`
（只注册 `create_session_agent`），两个组件可以分别启停。

投递优先走官方通道：同团队成员走 `ctx.agentTeams.sendMessage`（按成员名，优先于 subagent 通道），
自己的 continuable subagent 走 `ctx.subagents.sendMessage`，其余走会话 inbox（`Agent.steer`）。
名册里的 inactive 队友也是可寻址目标，由 team mailbox 冷恢复。

## 快速开始

前置条件：Node.js ≥ 22、pnpm、可用的 `dsh` CLI（DSH 0.2.x）。Windows / macOS / Linux 都支持，
本地总线在 Windows 上用命名管道、在 POSIX 上用 unix socket，无需额外配置。

```sh
# 1. 克隆并构建
git clone https://github.com/Evil-Wideplain/session-messaging.git
cd session-messaging
pnpm install
pnpm run build

# 2. 装进一个独立 profile，然后启动
dsh plugin --profile demo add "$PWD"
dsh --profile demo
```

自检（贡献代码或排查环境时）：

```sh
pnpm run typecheck
pnpm test          # 202 个用例通过（共 203，1 个平台相关跳过）：单测 + 构建产物级 e2e（会先 build）
```

装好之后，在任意会话里用自然语言就能触发：

```text
列出这个 DSH 进程里其他可见会话，然后给「前端联调」发一条消息：
接口改完了，麻烦重跑一下 e2e
```

模型会先调 `list_session_agents`，再调 `send_session_message`。脚本通道见
[本地总线](#本地总线)。

插件通过 `cordis.patch.yml` 插入组合。包内拆成两个装载行（插件页上是两个独立组件）：

| 组件 / 行 id | 入口 | 提供什么 |
|---|---|---|
| `session-messaging` | `session-messaging` | `list_session_agents` / `send_session_message` / `review_session_messages`、本地总线、`create_session_agent` 依赖的 `sessionMessaging` 服务 |
| `session-creation` | `session-messaging/creation` | 只注册 `create_session_agent`；注入主行提供的 `sessionMessaging` 服务 |

插件页显示的标题和描述由 locale meta 提供：包根 `locale/{en,zh}.json` 同时是「插件（组合包）」
和主行组件 `session-messaging` 的文案（两者模块标识相同，共用一份）；创建行用
`locale/creation/{en,zh}.json`，显示为 `session-creation`。注意创建行在 Loader 里的模块标识仍是
`session-messaging/creation`——同一个包内只能用子路径解析，裸名 `session-creation` 需要独立包或
profile 侧别名才能解析。

两行可以分别启停：关掉 `session-creation` 只少 `create_session_agent` 一个工具；
关掉 `session-messaging` 则主行工具、本地总线与创建行一起停（创建行等依赖）。
工具注册在全局层，所有会话可见。

## 工具

### `list_session_agents`

| 参数 | 类型 | 说明 |
|---|---|---|
| `include_subagents` | boolean，可选 | 是否**额外列出其他会话的** subagent（这些行标 `（不可发送）`，授权矩阵不允许跨会话发给子代理）；自己的 subagent 总是可见。默认 false |
| `limit` | integer，可选 | 最多返回多少行，1–200，默认 50 |

返回 `{ agents, omitted, truncated }`。每行：

```json
{ "name": "前端联调", "id": "<sessionId>", "short_id": "a1b2c3d4",
  "cwd": "/repo/web", "workspace": "same", "state": "idle", "kind": "peer" }
```

- `workspace`: `same` / `different` / `unknown`；
- `state`: `running` / `idle` / `offline`（offline = 已持久化但当前没加载，可冷唤醒）；
- `omitted`: 因为你无权访问、或对方是别人的 subagent 而没列出的数量；
- `truncated`: 仅因为 `limit` 被截断、没有返回的行数。两者分开计数：前者是永久不可见，后者调大 `limit` 就能看到。

### `send_session_message`

| 参数 | 类型 | 说明 |
|---|---|---|
| `to` | string，必填 | 显示名（可带引号）或精确 session id |
| `message` | string，必填 | 正文；目标会把它当作来自你的 user message |
| `summary` | string，可选 | 一行摘要，写进消息 `source` 供目标辨认 |
| `dedupe` | boolean，可选 | 默认 true；传 false 可绕过 `dedupeWindowMs`，强制投递同正文同摘要的消息 |

返回 `{ status, message_id, detail, target?, candidates? }`：

| status | 含义 |
|---|---|
| `accepted` | 已进入目标 inbox（inbox acceptance，不等待目标模型处理）或已由官方通道（team mailbox / subagent）接管，账本已确认 |
| `queued` | 通道失败或冷唤醒被拒（如没有模型路由、唤醒后首轮报错）；消息留在账本，等下次启动或人工重试 |
| `held` | 目标开了入站审批，消息停在其 inbound 账本等待 `review_session_messages`；`expires_at` 是截止时间 |
| `duplicate` | `dedupeWindowMs` 内向同一目标发过相同正文与摘要，本次不重复投递；需要重发时传 `dedupe: false` |
| `refused` | 目标会话已归档（DSH 归档门禁会以 `turn/end blocked` 吞掉唤醒消息）、超限（字节/频率/未确认条数）、入站策略 `refuse`，或非队友目标冷唤醒被禁用 |
| `not_found` | 地址不存在，**或**目标对你不可见。未授权（跨 workspace、别人的 subagent、被归档）与不存在返回完全相同的文案，调用方无法用它枚举会话；拒绝原因只写进插件日志 |
| `ambiguous` | 多个会话同名，`candidates` 列出候选，请改用 id |
| `self` | 发给自己 |

投递语义：

- 先按关系选通道：团队成员 → `ctx.agentTeams.sendMessage`（用成员名，不用 session id）；自己的
  continuable subagent → `ctx.subagents.sendMessage`；其余 → 会话 inbox。**在线**目标的官方通道抛错时回落
  inbox；**离线**目标则保持 `queued`——回落到 inbox 会绕过冷恢复语义（子代理会被当根会话唤醒、队友会丢团队授权）；
- inbox 通道只用 `Agent.steer()`，**绝不**直接 append `user/message`——steer 才会写 inbox splice、唤醒 idle 会话、并保证未 claim 的消息能跨重启恢复；
- 正文带来源框架：转发给目标的 `content[0].text` 形如
  `Session message <messageId> from <senderName> (<senderId>):` + 换行 + 正文；团队邮箱/subagent 通道收到的也是同一段文本。
  框架在领域层与 `source` 一起构造，目标模型据此区分「另一个会话的消息」与「人类的直接指令」，不依赖调用方自己补；
- 归档会话不可投递：列表不显示；按 id 发送返回 `refused` 并说明需先取消归档。归档集合读取失败时同样 `refused`
  并保持 `queued`（fail-closed）——把「读不到」当成「没有归档」会让唤醒被门禁 `blocked` 吞掉。原因见 §“归档门禁”；
- `accepted` 判定：**在线**目标以 `steer` 成功（消息进入 inbox）为准，不要求立刻在事件里看到 splice；
  **冷唤醒**目标额外用 1.2s 窗口捕获首轮 `agent/error` 与 `turn/end blocked`，并检查消息是否真的进入历史：
  有错误且无落账证据 → dispose 恢复实例、保持 `queued`；既无错误也无证据 → 同样保持 `queued`，避免向正在销毁的
  Agent 投递后报成功；
- 落盘账本在 `$DSH_HOME/session-messaging/outbox/<senderId>.jsonl`，先 `queued`/`held` 后 `delivered`/`expired`/`refused`，
  会话启动时由 `agent/created` 触发重放（0.2.x 没有 `agent/session-start` 事件；插件加载时还会对现有 Agent 补跑一次）。
  重放前先按 `messageId` 查目标历史，已送达的直接标记 `delivered`，不会再发一遍（`held` 归接收方 inbound 账本管）；
- 冷会话通过 `ctx.agents.resume` 唤醒，模型路由取目标历史的 `request/header`，缺失时用部署默认模型；
  两者都没有则拒绝唤醒并保持 `queued`——用无路由实例唤醒会在 prompt 组装阶段失败并吞掉消息。
  preset 按历史记录挂载，同一目标并发发送只 resume 一次。

### `create_session_agent`

创建**普通（root）会话**并把第一条消息投递进去；创建后它就是一个平等的会话，可以用
`list_session_agents` 看到、用 `send_session_message` 继续控制。工具在首条消息被接纳后返回，
不等待第一轮结束。

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string，必填 | 新会话收到的第一条消息；按跨会话消息带来源框架 |
| `cwd` | string，可选 | 工作目录（绝对路径）；缺省为调用方自己的工作目录。精确等于某个工作区根目录时会归入该工作区 |
| `workspace` | string，可选 | 目标工作区：工作区 id，或已登记工作区的绝对路径；会话建在其根目录并归入该工作区。与 `cwd` 同时给出时必须指向同一目录 |
| `ensure_workspace` | boolean，可选 | 配合 `cwd` / `workspace` 路径：目录不存在时创建、未登记时登记成工作区后再建会话（等价于 GUI 的「添加文件夹」） |
| `title` | string，可选 | 会话标题，在第一轮开始前写入 |
| `agent_preset` | string，可选 | Agent preset id，由 DSH 解析并挂载 |

返回 `{ status, session_id, short_id, cwd, workspace_id?, title?, agent_preset?, message_id, detail }`，
`status` 为 `accepted` / `refused` / `failed`。完整契约、实现路径、授权与限制见独立文档
[`docs/create-session-agent.md`](docs/create-session-agent.md)。

### `review_session_messages`

接收方审批工具，配合 `inbound: hold` 使用。

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `list` / `accept` / `refuse`，必填 | 列出、放行、丢弃 |
| `message_id` | string，可选 | 只处理某一条；省略则作用于当前全部待审消息 |

返回 `{ held, outcomes }`：`held` 是仍待审批的消息（`sender`、`summary`、`preview`、`expires_at`），
`outcomes` 是本次动作的结果（`accepted` / `refused` / `denied` / `expired` / `failed` / `not_found`；`denied` 表示 accept 时重新授权失败，`not_found` 表示没有匹配的待审消息）。

## 入站审批

入站策略分 `accept` / `hold` / `refuse` 三态，对应 Claude Code 的 `crossSessionInbound` 开关，默认 `accept`：

| 策略 | 行为 |
|---|---|
| `accept` | 直接投递（v1 行为，默认） |
| `hold` | 消息不进会话，先写接收方 inbound 账本；给在线的接收方发一条"有消息待审批"notice（按 `notifyIntervalMs` 节流）；接收方用 `review_session_messages` 决定。超过 `holdExpiryMs` 自动过期，超过 `maxHeldPerTarget` 丢弃最旧的 |
| `refuse` | 一律 `refused` |

实现细节：

- 待审消息落盘在 `$DSH_HOME/session-messaging/inbound/<targetId>.jsonl`（`held` → `accepted`/`refused`/`expired`），
  与发送方 outbox 分账：接收方 accept 时才写发送方的 `delivered`，refuse/过期写 `expired`/`refused`；
- accept 会**重新授权**：发送方会话若已不存在、或跨 workspace 且策略不允许，判 `denied` 而不是放行；
- 过期与容量淘汰在三个时机惰性执行：新的 `hold` 入账前、接收方 `review` 时、接收方会话启动时的 `recover`；
  发送方在线时收到一条 notice，离线则只更新账本；
- 过期若发生在 `recover`（目标还没 `review`），结果会按目标暂存一次，在它下一次 `review` 的 `outcomes` 里
  仍以 `expired` 报告，不会静默丢失；
- **没有用 `ctx.approval`**：DSH 的审批服务要求存在 open turn，且只能由 agent 的 owner 作答；入站消息的审批发生在
  目标会话自己的工具调用里，所以做成目标侧工具 + notice，而不是 harness 审批对话框（设计文档 §14.3）。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `allowCrossWorkspace` | `false` | 允许给不同 `cwd` 的会话发消息 |
| `allowlist` | `[]` | 例外条目：session id，或目录前缀（如 `/repo`、`C:\repo`） |
| `maxMessageBytes` | `65536` | 单条正文上限 |
| `maxPerMinute` | `20` | 每 sender→target 每分钟上限 |
| `dedupeWindowMs` | `10000` | 相同正文去重窗口；0 关闭 |
| `maxPendingPerTarget` | `50` | 同一目标未确认消息上限 |
| `allowColdWake` | `true` | 允许 resume 冷会话后投递 |
| `inbound` | `accept` | 入站策略：`accept` / `hold` / `refuse` |
| `holdExpiryMs` | `300000`（5 分钟） | `hold` 的审批截止时间 |
| `maxHeldPerTarget` | `100` | 每个接收方最多挂起多少条待审消息，满了丢最旧 |
| `notifyIntervalMs` | `60000` | 同一接收方两次"待审批"notice 的最小间隔 |
| `socketEnabled` | `true` | 是否开本地 bus |
| `socketDir` | 系统临时目录 | POSIX socket / Windows 管道名的来源目录；默认 `…/dsh-session-messaging-<uid>` |
| `outboxDir` | `$DSH_HOME/session-messaging/outbox` | 账本目录 |
| — | — | 账本目录、socket 名前缀与 `DSH_SESSION_MESSAGING_*` 环境变量沿用旧名 `session-messaging`：它们是持久化/传输标识，改名会让在途账本和既有脚本失效；插件页显示名、包名、行 id 与 Cordis 服务名已经改为 `session-messaging` |
| `allowCreateSession` | `true` | 允许 `create_session_agent` 创建新的普通会话 |
| `maxCreatesPerMinute` | `4` | 每个调用方每分钟最多创建多少个新会话 |
| `allowCreateWorkspace` | `true` | 允许 `ensure_workspace` 把目录登记成工作区 |

需要覆盖配置时，在 `cordis.patch.yml` 的行内加 `config`：

```yaml
- insert:
    - id: session-messaging
      name: session-messaging
      config:
        allowCrossWorkspace: true
        allowlist: ["/work/shared"]
```

配置属于主行 `session-messaging`；`session-creation` 行没有自己的配置，创建行为随主行配置。

## 本地总线

除了模型工具，bash / pwsh 脚本也能发消息。插件启动后在 `ctx.shellEnv` 里注册两个变量，每次 bash/pwsh
工具调用都会注入：

```text
DSH_SESSION_MESSAGING_SOCKET   # POSIX: /tmp/dsh-session-messaging-<uid>/bus.sock
                               # Windows: \\.\pipe\dsh-session-messaging-<uid>-<sha256(dir)[0:8]>
DSH_SESSION_MESSAGING_TOKEN    # 当前会话的 bearer token（等于身份，别外泄）
```

协议：一次连接 = 一条 JSON 请求 + 一条 JSON 响应（请求以换行或 EOF 结束）。bus 只有 `list` / `send`；
入站审批只能由目标会话自己的模型通过 `review_session_messages` 完成（`send` 会返回 `held`）。

```text
{"token":"<token>","op":"list","include_subagents":false,"limit":20}
{"token":"<token>","op":"send","to":"<name-or-id>","message":"...","summary":"..."}
```

响应：

```json
{"ok":true,"result":{...}}
{"ok":false,"error":{"code":"unauthenticated|bad_request|too_large|timeout|failed","message":"..."}}
```

示例（Node，两边平台通用）：

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
  to: "前端联调",
  message: "接口改完了，麻烦重跑一下 e2e"
}) + "\n")
'
```

POSIX 上也可以直接 `nc -U "$DSH_SESSION_MESSAGING_SOCKET"`。Windows 命名管道不能用 `nc`，Node/PowerShell 的
`net.connect` 都能连。

### 为什么是一个 bus，而不是每会话一个 socket

Claude Code 是每会话一个 inbox socket：脚本拿到的就是自己会话的地址，所以天然只能"投自己"。本插件的需求是
「脚本能给任意有权访问的会话发消息，并且能唤醒冷会话」，而冷会话没有进程、也就没有监听者。因此采用
「每用户一个 bus + 每会话 token」：token 解析出 sender 身份，目标由请求里的 `to` 决定，冷目标由服务端
`resume` 后投递。隔离性来自 token/授权矩阵，而不是地址数量。（2026-11-01 决策）

安全模型与 Claude Code 的 inbox socket 同级：**以本机 OS 用户为信任边界**。目录 0700、token 0600/内存态、
单次连接、30s 超时；token 只能由同用户的 shell 读到，不跨用户、不跨机器。bus 端点目录无法收紧到 0700 时
宁可让总线不启动，账本目录则只记日志、不阻断插件。

## 授权矩阵

| 目标 | 条件 | 结果 |
|---|---|---|
| 自己 | — | `self` |
| 同 workspace peer | `cwd` 相同 | 允许 |
| 别人的 workspace | `allowCrossWorkspace` 或命中 `allowlist` | 允许，否则拒绝（对外表现为 `not_found`） |
| 自己的直接 subagent | `header.parentSession === caller` | 允许 |
| 别人的 subagent | 无（`allowlist` 也不能绕过） | 拒绝（`subagent-of-other`，对外表现为 `not_found`） |
| 团队成员 | `agentTeams.membership` + `listMembers` 命中 | 允许（团队名册本身就是授权关系，可跨 workspace） |
| 冷会话 | `allowColdWake`（队友例外：由 team mailbox 冷恢复） | resume 后投递 |
| 创建会话 | 调用方是 root 会话，且目标目录（`cwd` 或 `workspace` 根）等于调用方 cwd 或命中 `allowCrossWorkspace` / `allowlist` | 允许；子代理调用一律拒绝 |

身份只来自运行时：工具通道是 `exec.agent`，脚本通道是 bus token；消息正文/`source` 里的任何字段都不能冒充发送者。

## 项目结构

代码按 DDD 分层（领域 / 应用 / 基础设施 / 接口），依赖方向永远指向领域：

```text
src/
├─ index.ts                     # 组合包入口（package main）：只转出 entries/messaging
├─ creation.ts                  # ./creation 子路径入口：只转出 entries/creation
├─ entries/
│  ├─ messaging.ts              # 主行 session-messaging：运行时 + 三个工具 + 总线 + 恢复
│  └─ creation.ts               # 创建行 session-creation：只注册 create_session_agent
├─ shared/
│  └─ service.ts                # 跨行服务契约：sessionMessaging（主行 provide）
├─ composition.ts               # 装配：端口 → 具体适配器
├─ config.ts                    # 扁平配置 + schemastery schema + 默认值
├─ types.ts                     # 契约 barrel；类型真身在 types/
├─ types/                       # session / agent / tools / services / context 声明增补
├─ domain/                      # 纯业务规则：无 IO、无 Cordis 依赖
│  ├─ target.ts                 # 会话目标值对象、寻址归一、歧义错误
│  ├─ authorization.ts          # 授权矩阵（workspace / 团队 / 例外清单）
│  ├─ routing.ts                # 通道路由：team / subagent / steer
│  ├─ message.ts                # 消息构造 + messageAccepted 送达判定
│  ├─ inbound-policy.ts         # 入站三态、审批截止、容量淘汰规则
│  ├─ held-message.ts           # 待审批消息实体与过期判定
│  ├─ outbox.ts                 # 出站账本模型（queued/held/终态）
│  └─ util.ts                   # 跨层纯函数：错误文本化、空白归一
├─ application/                 # 用例编排 + 端口接口
│  ├─ messaging-service.ts      # 门面；用例实现在 messaging/
│  ├─ messaging/                # list / send / review / recover / inbound / rows / auth / dedupe / deps
│  ├─ session-creation-service.ts  # create：root-only、cwd 授权、限额、首条消息
│  ├─ session-creation/         # location：位置解析 + workspace 授权
│  ├─ dto.ts                    # 工具与 bus 的返回形状
│  ├─ guards.ts                 # 频率限制、正文去重
│  ├─ ports.ts                  # 消息 / 目录 / 投递 / 创建端口；re-export Workspace 端口
│  └─ ports-workspace.ts        # WorkspaceResolver / WorkspaceTarget（从 ports.ts 拆出）
├─ infrastructure/              # 端口实现
│  ├─ cordis-delivery-gateway.ts   # 门面；投递实现在 delivery/
│  ├─ delivery/                 # channels / inbox / wake / failure-probe / model-route / shared
│  ├─ cordis-session-directory.ts  # 门面；目录实现在 directory/
│  ├─ directory/                # live / cold / team / archive / shared
│  ├─ cordis-session-creator.ts    # sessionController.create + followup + preset/权限/标题/attach
│  ├─ session-finish.ts         # 创建后收尾：权限预设 / 标题 / flush（尽力而为）
│  ├─ jsonl-ledger.ts            # 追加式 JSONL 文件原语（换行修复/原子重写/读缓存）
│  ├─ jsonl-outbox-repository.ts
│  ├─ jsonl-inbound-repository.ts
│  ├─ persisted-session.ts      # 冷会话短读：header / events / title / 模型路由
│  └─ paths.ts                  # DSH_HOME、socket/outbox/inbound 目录
└─ interfaces/                  # 外部入口
   ├─ model-tools.ts            # 工具 barrel；每个工具在 tools/
   ├─ tools/                    # shared / list / send / review / create-session
   ├─ local-bus.ts              # 门面；总线实现在 bus/
   └─ bus/                      # protocol / server / listener / connection / shell-env
tests/
├─ support/                     # 共享夹具（不参与用例收集）
├─ messaging-*.test.ts          # 寻址/发送/路由/入站/恢复/冷唤醒/列表
├─ model-tools-*.test.ts        # 四个工具的 schema / render / execute
├─ create-session-*.test.ts     # 创建会话：服务 / 适配器 / 工具
├─ routing.test.ts、approval.test.ts
├─ e2e-package-*.test.ts        # 构建产物级 e2e（lib/index.js + 真 socket）
└─ bus*.test.ts、ledger.test.ts、paths.test.ts
scripts/
├─ e2e-runtime.mjs              # 真运行时 e2e 流程
└─ e2e/                         # env / profile / headless / checks
cordis.patch.yml                # bundle 层插入插件行
locale/{en,zh}.json             # 插件（组合包）与主行组件的标题/描述
locale/creation/{en,zh}.json    # 子路径组件（session-creation）的标题/描述
```

分层约定：`domain/` 不 import 任何 Cordis 或 `node:fs`；`application/` 只依赖
`domain/`、`application/ports.ts` 与 `types.ts` 的共享契约（外加 `config.ts` 的类型和
`node:crypto` / `node:path` 这类纯标准库计算）；基础设施实现端口；接口层只做参数校验与 DTO 投影，
本地总线传输是唯一例外（直接用 Cordis 上下文与 `infrastructure/paths`）；`index.ts` 与
`composition.ts` 是唯一允许 new 具体适配器的地方。代码注释统一用中文。
单个 TS/JS 文件不超过 200 行：超过时按职责拆子模块，原文件保留为 barrel 或门面。

## 已知限制

- 一次性 `dsh headless` 进程里冷唤醒的目标 turn 可能随宿主退出被中断；消息已进入 inbox/历史就确认，
  未进入则保持 `queued` 等下一次重放（长驻宿主里不存在这个问题）；
- Agent Teams 的**任务板**没有接进来，只接了口箱（发消息）；团队任务仍需用团队工具；
- 未实现 Claude Code 的 `notify_when_idle`（无人时排队、目标回来再投），目前 `queued` 已覆盖"目标不在时先落盘"；
- 名字解析对冷会话需要 `sessionQuery`（缺失时只能按 id/live 名字寻址），冷标题按 30s 缓存、每次最多扫 200 条会话；
- 冷唤醒需要可用的模型路由（历史或部署默认）；都没有时拒绝唤醒并保持 `queued`，不会用残缺 Agent 吞消息；
- `hold` 的 notice 只在接收方**在线**时发；离线目标靠启动时的 `recover` 惰性过期，不会补发 notice（过期结果仍会在其下次 `review` 报告）；
- `create_session_agent` 的已知限制（headless / CLI 组合没有 `sessionController` / `workspaceRegistry`、`custom` 权限不可继承、
  不等待第一轮、不支持 fork / 幂等）见独立文档
  [`docs/create-session-agent.md`](docs/create-session-agent.md#7-已知限制)。

## 开发

```sh
pnpm run typecheck
pnpm test          # 202 个用例通过（共 203，1 个平台相关跳过）：单测 + 构建产物级 e2e（会先 build）
pnpm run build
```

`pnpm test` 覆盖：寻址与歧义、授权矩阵、通道路由（team 优先 / subagent / 回落）、inactive 队友与自己的
冷 subagent 寻址、入站三态、审批 accept/refuse/expire（含 recover 先过期后的报告）/容量/重新授权、账本重放与
按 `messageId` 去重、`agent/created` 恢复钩子、冷唤醒路由（历史/默认/拒绝/首轮回滚）、去重、限额、
创建会话（root-only / cwd 授权 / 限额 / 首条消息构造 / preset 与权限继承 / 部分失败语义）、
参数与渲染契约、真 socket 协议与多实例端点隔离、总线 UTF-8 分块与参数校验、JSONL 残行修复/原子压缩/路径穿越防线，
以及直接加载 `lib/index.js` 的包级 e2e。

### 真运行时 e2e（可选，需要模型凭据）

```sh
# 一次性准备：独立 profile（与日常 GUI 隔离）
dsh plugin --profile session-messaging-e2e add "$PWD"

# 运行：多个 OS 进程，真模型，真工具调用
DEEPSEEK_API_KEY=... node scripts/e2e-runtime.mjs
```

运行前需要 `dsh` CLI 在 `PATH` 里、可用凭据（`DEEPSEEK_API_KEY`，或受管凭据文件
`$DSH_HOME/.credentials.yaml`），以及 `zstd`（会话日志是多帧 zstd，缺了无法校验落盘结果）。
脚本在运行前备份该 profile 的 `cordis.patch.yml`（原始内容同时落到
`e2e-workspace/artifacts/cordis.patch.yml.orig`，进程被强杀时也能手工恢复），结束时还原，
并按阶段切换审批策略：审批阶段写 `inbound: hold` + 60s 截止，过期阶段改成 1.5s 截止。

5 个 headless 阶段：

1. `01-target-create`：用 `dsh headless --json` 建一个目标会话；
2. `02-sender-hold`：起另一个会话，让模型调 `list_session_agents` + `send_session_message`，断言状态是
   `held` 且消息还没进入目标会话；
3. `03-target-accept`：用 `--session-id` 让目标会话恢复自己，调 `review_session_messages` list→accept，
   断言消息进入目标 `user/message` 历史（`source.kind = session-message`）；
4. `04-sender-expiry`：把截止时间改成 1.5s 后再发一条，断言状态仍是 `held`；
5. `05-target-expire`：等过截止时间，断言 `review` 报 `expired` 且消息从未进入目标会话。

脚本共 18 个 `record()` 检查（凭据、隔离 profile、`zstd`、patch 是否生效到组合配置、目标会话建立、
`held` 不入会话、accept 入历史、过期不入会话等）。最近一次实跑是 2026-11-01，17/17 通过；整理仓库时只把
脚本拆到 `scripts/e2e/`（env / profile / headless / checks），本轮没有重跑（`DEEPSEEK_API_KEY` 额度不足）。

### 本地模型 e2e（开发期脚本，不随仓库提交）

本地网关联调用的 `local-flow-e2e.mjs` / `recovery-e2e.mjs` 属于开发期临时脚本，未纳入版本控制
（`e2e-workspace/` 在 `.gitignore` 中），因此上面的仓库不提供这两个入口。需要回归同类场景时，用
`tests/messaging-*.test.ts` 的服务级用例覆盖 `held`/`accept`/`refuse`/`expire`/重放去重，
或用 `node scripts/e2e-runtime.mjs` 跑真模型版本。

产物在 `e2e-workspace/artifacts/`（每次 run 的 `--json` 事件流）。清理：
`rm -rf e2e-workspace "$DSH_HOME/profiles/session-messaging-e2e"`，并按需删除
`$DSH_HOME/sessions/*/session-<e2e id>/`。

## 延伸阅读

- 设计与取舍：[`docs/design/session-messaging-plugin.md`](docs/design/session-messaging-plugin.md)；
  投递/持久化方案：[`docs/design/session-messaging-plan.md`](docs/design/session-messaging-plan.md)、
  [`docs/design/session-bus.md`](docs/design/session-bus.md)
- Claude Code 的机制对照：[`docs/research/claude-code-session-messaging.md`](docs/research/claude-code-session-messaging.md)
- `create_session_agent` 完整文档：[`docs/create-session-agent.md`](docs/create-session-agent.md)
- DSH 能力调研总览：[`docs/research/README.md`](docs/research/README.md)
- Session Query（会话历史检索）设计与实现：[`docs/dsh-session-query-设计与实现.md`](docs/dsh-session-query-设计与实现.md)

## 许可证

[MIT](./LICENSE)。欢迎 issue / PR；使用中遇到投递异常时，附上 `$DSH_HOME/session-messaging/` 下的
outbox / inbound 账本片段会更容易定位。
