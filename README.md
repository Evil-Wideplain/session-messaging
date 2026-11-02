# dsh-plugin-session-messaging

DSH bundle 插件：让同一个 DSH 进程里的会话可以**互相寻址、互相唤醒、互相发消息**。

提供三个模型可调用工具和一个给 shell 脚本用的本机通道：

| 能力 | 形态 |
|---|---|
| 列出可发送的会话 | 工具 `list_session_agents` |
| 给会话发消息（含冷会话唤醒、官方通道路由） | 工具 `send_session_message` |
| 审批别人发给你的消息（入站 `accept/hold/refuse`） | 工具 `review_session_messages` |
| bash / pwsh 脚本发消息 | 每用户一个本地 bus socket + 每会话 token（`ctx.shellEnv` 注入） |

投递优先走官方通道：同团队成员走 `ctx.agentTeams.sendMessage`（按成员名，优先于 subagent 通道），
自己的 continuable subagent 走 `ctx.subagents.sendMessage`，其余走会话 inbox（`Agent.steer`）。
名册里的 inactive 队友也是可寻址目标，由 team mailbox 冷恢复。

设计与取舍见 [`docs/design/dsh-session-messaging-plugin.md`](docs/design/dsh-session-messaging-plugin.md)；
Claude Code 的机制对照见 [`docs/research/claude-code-session-messaging.md`](docs/research/claude-code-session-messaging.md)。

## 目录结构

代码按 DDD 分层（领域 / 应用 / 基础设施 / 接口），依赖方向永远指向领域：

```text
src/
├─ index.ts                     # 组合根：name / inject / Config / apply + 恢复钩子
├─ composition.ts               # 装配：端口 → 具体适配器
├─ config.ts                    # 扁平配置 + schemastery schema + 默认值
├─ types.ts                     # DSH 服务结构化契约 + Cordis declaration merging
├─ domain/                      # 纯业务规则：无 IO、无 Cordis 依赖
│  ├─ target.ts                 # 会话目标值对象、寻址归一、歧义错误
│  ├─ authorization.ts          # 授权矩阵（workspace / 团队 / 例外清单）
│  ├─ routing.ts                # 通道路由：team / subagent / steer
│  ├─ message.ts                # 消息构造 + messageAccepted 送达判定
│  ├─ inbound-policy.ts         # 入站三态、审批截止、容量淘汰规则
│  ├─ held-message.ts           # 待审批消息实体与过期判定
│  └─ outbox.ts                 # 出站账本模型（queued/held/终态）
├─ application/                 # 用例编排 + 端口接口
│  ├─ messaging-service.ts      # list / send / review / recover
│  ├─ dto.ts                    # 工具与 bus 的返回形状
│  ├─ guards.ts                 # 频率限制、正文去重
│  └─ ports.ts                  # OutboxRepository / InboundRepository / SessionDirectory / DeliveryGateway
├─ infrastructure/              # 端口实现
│  ├─ jsonl-ledger.ts            # 追加式 JSONL 文件原语（换行修复/原子重写/读缓存）
│  ├─ jsonl-outbox-repository.ts
│  ├─ jsonl-inbound-repository.ts
│  ├─ cordis-session-directory.ts  # 在线/冷会话 → SessionTarget，团队名册查询
│  ├─ cordis-delivery-gateway.ts   # 官方通道、inbox、冷唤醒
│  ├─ persisted-session.ts      # 冷会话短读：header / events / title / 模型路由
│  └─ paths.ts                  # DSH_HOME、socket/outbox/inbound 目录
└─ interfaces/                  # 外部入口
   ├─ model-tools.ts            # 三个工具的 JSON Schema 与参数校验
   └─ local-bus.ts              # 每用户 bus server + shellEnv 注入
tests/messaging.test.ts       # 领域 + 服务单测（寻址/授权/投递/重放）
tests/routing-approval.test.ts # 通道路由 + 入站审批单测
tests/e2e-package.test.ts     # 构建产物级 e2e（lib/index.js + 真 socket）
tests/bus.test.ts             # bus 协议与 shellEnv 注入单测
tests/bus-protocol.test.ts    # 总线 UTF-8 分块、参数校验、端点归属
tests/ledger.test.ts          # JSONL 账本残行修复/原子压缩/路径穿越
scripts/e2e-runtime.mjs       # 真运行时 e2e（dsh CLI + 真模型）
cordis.patch.yml              # bundle 层插入插件行
```

分层约定：`domain/` 不 import 任何 Cordis 或 `node:fs`；`application/` 只依赖
`domain/` 与 `application/ports.ts`；基础设施实现端口；接口层只做参数校验与 DTO 投影；
`index.ts` 与 `composition.ts` 是唯一允许 new 具体适配器的地方。代码注释统一用中文。

## 安装

```sh
pnpm install
pnpm run build
dsh plugin --profile demo add .
dsh --profile demo
```

插件通过 `cordis.patch.yml` 插入组合，插件名 `session-messaging`，工具注册在全局层，所有会话可见。

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

### `review_session_messages`

接收方审批工具，配合 `inbound: hold` 使用。

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `list` / `accept` / `refuse`，必填 | 列出、放行、丢弃 |
| `message_id` | string，可选 | 只处理某一条；省略则作用于当前全部待审消息 |

返回 `{ held, outcomes }`：`held` 是仍待审批的消息（`sender`、`summary`、`preview`、`expires_at`），
`outcomes` 是本次动作的结果（`accepted` / `refused` / `denied` / `expired` / `failed` / `not_found`；`denied` 表示 accept 时重新授权失败，`not_found` 表示没有匹配的待审消息）。

## 入站审批（accept / hold / refuse）

对应 Claude Code 的 `crossSessionInbound` 三态开关，默认 `accept`：

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

需要覆盖配置时，在 `cordis.patch.yml` 的行内加 `config`：

```yaml
- insert:
    - id: session-messaging
      name: dsh-plugin-session-messaging
      config:
        allowCrossWorkspace: true
        allowlist: ["/work/shared"]
```

## bash / pwsh 通道

插件启动后在 `ctx.shellEnv` 里注册两个变量，每次 bash/pwsh 工具调用都会注入：

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
单次连接、30s 超时；token 只能由同用户的 shell 读到，不跨用户、不跨机器。

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

身份只来自运行时：工具通道是 `exec.agent`，脚本通道是 bus token；消息正文/`source` 里的任何字段都不能冒充发送者。

## 已知限制

- 一次性 `dsh headless` 进程里冷唤醒的目标 turn 可能随宿主退出被中断；消息已进入 inbox/历史就确认，
  未进入则保持 `queued` 等下一次重放（长驻宿主里不存在这个问题）；
- Agent Teams 的**任务板**没有接进来，只接了口箱（发消息）；团队任务仍需用团队工具；
- 未实现 Claude Code 的 `notify_when_idle`（无人时排队、目标回来再投），目前 `queued` 已覆盖"目标不在时先落盘"；
- 名字解析对冷会话需要 `sessionQuery`（缺失时只能按 id/live 名字寻址），冷标题按 30s 缓存、每次最多扫 200 条会话；
- 冷唤醒需要可用的模型路由（历史或部署默认）；都没有时拒绝唤醒并保持 `queued`，不会用残缺 Agent 吞消息；
- `hold` 的 notice 只在接收方**在线**时发；离线目标靠启动时的 `recover` 惰性过期，不会补发 notice（过期结果仍会在其下次 `review` 报告）。

## 开发

```sh
pnpm run typecheck
pnpm test          # 108 个用例，其中 1 个平台相关跳过：单测 + 构建产物级 e2e（会先 build）
pnpm run build
```

`pnpm test` 覆盖：寻址与歧义、授权矩阵、通道路由（team 优先 / subagent / 回落）、inactive 队友与自己的
冷 subagent 寻址、入站三态、审批 accept/refuse/expire（含 recover 先过期后的报告）/容量/重新授权、账本重放与
按 `messageId` 去重、`agent/created` 恢复钩子、冷唤醒路由（历史/默认/拒绝/首轮回滚）、去重、限额、
参数与渲染契约、真 socket 协议与多实例端点隔离、总线 UTF-8 分块与参数校验、JSONL 残行修复/原子压缩/路径穿越防线，
以及直接加载 `lib/index.js` 的包级 e2e。

### 真运行时 e2e（可选，需要模型凭据）

```sh
# 一次性准备：独立 profile（与日常 GUI 隔离）
dsh plugin --profile session-messaging-e2e add "$PWD"

# 运行：两个 OS 进程，真模型，真工具调用
DEEPSEEK_API_KEY=... node scripts/e2e-runtime.mjs
```

脚本会写入该 profile 的 `cordis.patch.yml`（`inbound: hold` + 1.5s 截止），然后：

1. 用 `dsh headless --json` 建一个目标会话；
2. 起另一个会话，让模型调 `list_session_agents` + `send_session_message`，断言状态是 `held`；
3. 用 `--session-id` 让目标会话恢复自己，调 `review_session_messages` list→accept，断言消息进入目标
   `user/message` 历史（`source.kind = session-message`）；
4. 再发一条、等过截止时间，断言 `review` 报 `expired` 且消息从未进入目标会话。

本机结果（2026-11-01，修复前基线）：**17/17 检查通过**——目标会话建立、`held` 不入会话、目标
`--session-id` 恢复后 `accept` 并进入 `user/message` 历史（`source.kind = session-message`）、第二次发送
等过截止后 `review` 报 `expired` 且消息从未进入会话。本次修复没有重跑官方脚本（`DEEPSEEK_API_KEY` 额度不足），
改用本地模型脚本回归；脚本会在运行前备份该 profile 的 `cordis.patch.yml` 并在结束时还原（进程被强杀时备份仍在
`e2e-workspace/artifacts/cordis.patch.yml.orig`）。

### 本地模型 e2e（开发期脚本，不随仓库提交）

本地网关联调用的 `local-flow-e2e.mjs` / `recovery-e2e.mjs` 属于开发期临时脚本，未纳入版本控制
（`e2e-workspace/` 在 `.gitignore` 中），因此上面的仓库不提供这两个入口。需要回归同类场景时，用
`tests/messaging.test.ts` 的服务级用例覆盖 `held`/`accept`/`refuse`/`expire`/重放去重，
或用 `node scripts/e2e-runtime.mjs` 跑真模型版本。

产物在 `e2e-workspace/artifacts/`（每次 run 的 `--json` 事件流）。清理：
`rm -rf e2e-workspace "$DSH_HOME/profiles/session-messaging-e2e"`，并按需删除
`$DSH_HOME/sessions/*/session-<e2e id>/`。
