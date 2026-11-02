# Claude Code 的 Session 间通信：原理与实现方法

> 调研对象：Claude Code v2.1.224+（cross-session messaging）与实验性 Agent Teams（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）。
> 主要来源：[官方文档 cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)、
> [官方文档 agent teams](https://code.claude.com/docs/en/agent-teams)、
> [工具参考](https://code.claude.com/docs/en/tools-reference)、
> 社区逆向分析文章 [《Claude Code Agent Teams 逆向工程：文件系统就是消息队列》](https://github.com/Quriosity-agent/articles/blob/main/2026-02-28/claude-code-agent-teams-reverse-engineering.md)。
> 本文只记录机制与原理；版本号与行为以官方文档为准（Claude Code 迭代很快，社区文章可能落后于最新版本）。

---

## 0. 摘要

Claude Code 有两套**互相独立**的会话间通信机制：

| | **Cross-session messaging** | **Agent Teams** |
|---|---|---|
| 定位 | 稳定能力，默认开启（满足版本/平台条件） | 实验性，默认关闭，需环境变量开启 |
| 拓扑 | 你机器上**任意两个会话**（同名不同 cwd 可消歧），加跨机/云会话 | **一个 Lead + 若干 teammate**（一个会话只能有一个 team） |
| 传输 | **每个会话一个 socket**（Unix domain socket / Windows named pipe）；跨机经 Anthropic 服务器 | **每个 agent 一个 JSON 邮箱文件**：`~/.claude/teams/{team}/inboxes/{agent}.json` |
| 寻址 | 会话名（`/rename`、`--name`、自动名），`ListAgents` 发现，`@mention` 指定 | teammate 名（Lead 创建时指定） |
| 投递语义 | 消息作为**普通文本 user message** 注入；运行中在 tool call 之间读取，idle 时开新 turn | 同样注入为 user message；文件写入成功即"已发送" |
| 持久性 | 尽力而为（socket 传输，无持久队列） | 文件即队列；**写文件成功 = 发送成功**，不代表已读 |
| 权限 | 消息 ≠ 同意：不能批准权限、不能改配置、命令不执行；入站三态 + 审批对话框 | 继承 Lead 权限模式；prompt 冒泡给 Lead；消息不能代替同意 |

**核心设计思想只有一句**：**会话是一等公民，消息是"另一个 Claude 写给你的一段文本"，不是共享上下文、不是远程调用、不是用户授权。**

---

## 1. 为什么不做"共享上下文"

Claude Code 明确把三件事分开：

- **消息**：一段纯文本（cross-session 限制"plain text only"，同机单条上限约 100 万字符）；
- **上下文迁移**：要搬对话历史就 `resume` 那个会话，而不是发消息；
- **权限与同意**：任何来自其他会话的文本都**不构成用户同意**。

这样做的直接收益：

1. **安全边界简单**：接收方仍然按自己的权限规则逐条审批，发送方无法借消息提权。
2. **上下文不污染**：每个会话有自己的 context window，消息只是其中一条 user message。
3. **失败模式清晰**：发送失败（超限/burst/拒收）在发送方就报错；接收方 hold/refuse 单独可控。

---

## 2. Cross-session messaging：原理

### 2.1 会话身份与发现

- 每个会话可以有一个**名字**：`/rename`、启动参数 `--name`，或自动生成；重名时结合工作目录区分，跨机会话加 `Remote Control` 标签。
- `ListAgents` 工具负责发现可发消息的对象：本会话的 subagent、team 的 teammate、**本机其他 Claude Code 会话**、以及（连了 Remote Control 时）云会话与其他机器上的会话。它也是 `/list-agents` 命令的后端。
- `SendMessage` 负责发送；用户在 prompt 里用 `@name` 可以让 Claude 直接寻址，省掉一次列表。

### 2.2 传输：每个会话一个 inbox socket

这是最值得注意的实现细节：

| 平台 | 介质 | 安全 |
|---|---|---|
| macOS / Linux（含 WSL2 内） | **Unix domain socket** | 文件系统权限限制为当前 OS 用户；拒绝在不接受的目录建 socket，必要时退到 `/tmp/cc-socks-<uid>` |
| 原生 Windows | **Named pipe** | 连接首行必须发送 `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}`，token 只有当前用户可读 |

- socket 路径可在 `/status` 的 `Peer address` 行看到（前缀 `uds:`）；建立失败会显示 `unavailable` 与原因。
- 会话通过环境变量导出 `CLAUDE_CODE_MESSAGING_TOKEN`，**脚本/hook 也能往自己会话的 socket 投消息**（按平台决定是否必须带 auth 行）。
- 连接 30 秒内必须发完整一行，否则关闭——所以"先跑完慢命令再连接发送"。
- 同机消息**从不经过 Anthropic 服务器**；跨机/云会话经 Anthropic 服务器中转（Remote Control 通道），对方离线时消息排队，重连后到达。
- 隔离边界：容器内外的会话互不可达；WSL2 与原生 Windows 会话也互不可达；bare mode 不绑定 socket。

### 2.3 投递语义：消息是 user message，注入时机在 tool call 之间

- 接收方**运行中**：在两次 tool call 之间读取消息，**不会打断正在执行的工具**。
- 接收方 **idle**：用这条消息**开一个新的 turn**。
- 消息到达时在对话里显示为一行暗色预览（`› Message from @api-worker: ...`），完整内容在 transcript 里；忙碌未送达时显示 `Waiting to be delivered`。
- 消息带**发送方名字与回复地址**（跨机单向消息除外）；如果消息里写了 `@path`，接收方看到的是字面文本，Claude Code 不会替你附加文件。

### 2.4 安全模型：消息不等于同意

官方明确的四条限制：

1. **不能批准任何东西**：消息永远不算用户对本会话权限提示的授权。
2. **不能改配置**：不允许因为别的会话的要求去改权限设置、`CLAUDE.md` 等。
3. **命令不执行**：文本里的 `/compact` 之类只是文本。
4. **权限提示照常触发**：消息要求做的事，仍按接收方自己的权限规则走。

另有：
- 权限边界**按会话隔离**：一个会话被拒绝的操作，不能转手让另一个会话去做；
- auto mode 的 classifier 会检查消息，转述的"批准声明"视为不可信输入；
- 拒绝规则禁用 `SendMessage`/`ListAgents` 时，**subagent 与 teammate 的消息也一起失效**（同一个工具）。

### 2.5 入站控制：accept / hold / refuse

`crossSessionInbound` 三个值：`accept`（投递）、`hold`（先扣着，等批准或后续设置变化再放行）、`refuse`（丢弃）。

- 未显式设置时，按**双方权限模式分类**决定：接收方是"提示权限"类 → 默认投递（但发送方自称 bypass 时 hold）；接收方是"bypass"类 → 默认 hold（只有发送方也 bypass 才投递）。
- hold 时在交互终端弹审批框：Approve 放行一条、Deny/关闭丢弃、超时（`dialogExpiry` 默认 5 分钟）丢弃；**最多 hold 100 条**，超出丢最旧的。
- `claude -p`（headless）不能弹框：hold 到期即丢，并在可达时把"已过期"告诉发送方；要无人值守接收，用 `--settings` 显式 `crossSessionInbound=accept`。
- 跨机消息可用 `isolatePeerMachines=true` 强制"离开本机前必须人工批准"。

### 2.6 限额与防循环

- **体积**：本机单条超过约 100 万字符，发送方直接拒绝（报错里给两个尺寸）。
- **突发**：向同一会话的快速连续发送达到其 inbox 可接受量后，发送方被拒绝，提示合并成一条或稍后再发。
- **防循环**：接收方按 sender 限流、**短窗口内相同内容去重**、**最多排 50 条已接受消息**；两个会话互发形成的 loop 会自行停下。

### 2.7 订阅式通知：`notify_when_idle`

`SendMessage` 有一个 `notify_when_idle` 输入：请求目标会话在**下一次 idle 或退出**时回一条通知（12 小时内有效）。

- 可单独订阅（不启动目标 turn、不花 token；目标已 idle 则立即通知），也可附着在一条消息上（先投消息，后发通知）。
- 只有主会话能订阅，且只能订阅**本机**会话。
- 通知同样受入站三态约束（refuse 则不到；hold 则只显示不进 Claude 上下文）。

> 这相当于把"等待"做成了**推送**，而不是让模型轮询。

---

## 3. Agent Teams：原理

实验性能力，开启后"团队"由四部分组成：

| 组件 | 角色 |
|---|---|
| **Team lead** | 主会话，创建 teammate、分配任务、汇总结果 |
| **Teammates** | 各自独立的 Claude Code 实例（in-process 或 tmux/iTerm2 分屏），各有自己的 context window |
| **Task list** | 共享任务板：pending / in progress / completed，支持依赖与 file locking 抢占 |
| **Mailbox** | 每个 agent 一个 JSON 文件：`~/.claude/teams/{team-name}/inboxes/{agent-name}.json` |

### 3.1 团队是怎么开始的

- 启用后，Claude 调 `Agent` 工具且**带 `name`** 时就会启动一个 teammate（fork 调用或带 `isolation` 的调用除外）；不需要用户确认。
- Claude 也会给普通 subagent 起名以便之后发消息；**带名字的 subagent 在启用团队后直接变成 teammate**。
- `-p` / Agent SDK 会话不 spawn teammate（非交互）。
- 团队名是 `session-` + 会话 ID 前 8 位；`~/.claude/teams/{name}/config.json` 存成员与运行时状态（session ID、tmux pane ID），**会话结束即删除**；任务目录 `~/.claude/tasks/{name}/` **保留**（受 `cleanupPeriodDays` 控制）。

### 3.2 Mailbox：文件系统就是消息队列

- 每个 agent 一个 JSON 数组文件，消息追加到末尾；`inbox` 文件按需创建（没人发过就不存在）。
- **发送成功的定义**：写入收件人 mailbox 文件成功。写失败（磁盘满、目录不可写）→ 发送方收到错误、什么都没发出。
- 读取时**逐条校验**：格式不符的条目报错并**从文件中移除**，合法消息照常投递。
- 普通消息的 `text` 是纯文本；**协议消息是 JSON 序列化成字符串塞进 `text`**：`idle_notification`、`shutdown_request` / `shutdown_approved`、计划批准等。
- 消息字段（社区逆向的样例）：`from`、`text`、`summary`、`timestamp`、`color`、`read`。

社区逆向文章补充了两个实现细节（版本可能已变化）：

- 二进制里能找到 `injectUserMessageToTeammate`——**teammate 的消息最终被注入成 user message**；
- 早期版本的 inbox 检查发生在 **turn 之间**（长 turn 中收不到），这后来演化为官方文档写的"在 tool call 之间读取"。

### 3.3 投递与生命周期

- **自动投递**：teammate 之间、teammate 与 lead 之间直接按名字发消息，Lead 不需要轮询。
- **idle 通知**：teammate 结束一轮后自动通知 Lead，并**附带最终答案**；API 错误则通知失败原因。
- **关闭协商**：Lead 发 shutdown 请求，teammate 批准（优雅退出）或拒绝并说明理由。
- **复活**：Lead 给"已不在运行"的 in-process teammate 发消息时，会把它在同一会话内唤醒、恢复已保存的对话，并把消息作为下一个 prompt（但 `/resume` 之后的会话不行，见限制）。
- **质量门 hook**：`TeammateIdle`（code 2 = 打回，让它继续干）、`TaskCreated`、`TaskCompleted`（code 2 = 阻止并反馈）。

### 3.4 任务板

- 三态：pending / in progress / completed；支持 `blockedBy` 依赖；**claim 用文件锁**防并发抢占。
- Lead 可显式分配，teammate 也可在完成当前任务后自领下一个未阻塞任务。
- 完成的任务会自动解锁依赖它的任务。

### 3.5 权限

- teammate **继承 Lead 的权限模式**（`dontAsk` 除外；`--dangerously-skip-permissions` 会传导）；spawn 后可以单独改某个 teammate 的模式，但 spawn 时不能逐个指定。
- teammate 的权限提示**冒泡到 Lead 会话**，由用户在那里批准。
- 消息同样不能代替同意，也不能把"自己被拒的操作"转交给别的 teammate 绕过检查。

### 3.6 已知限制（官方列出的）

- in-process teammate 不支持 `/resume` / `/rewind` 恢复（恢复后 Lead 可能对着不存在的 teammate 发消息）；
- 任务状态可能滞后，导致依赖任务卡住；
- **不能嵌套团队**：teammate 不能再创建 teammate；
- in-process teammate 自己的 subagent 只能前台运行（后台工作不能比 Lead 进程活得更久）；
- 权限模式只能在 spawn 时继承、不能分别指定；
- 分屏模式需要 tmux 或 iTerm2（VS Code 终端、Windows Terminal、Ghostty 不支持）。

---

## 4. 从实现里能提炼出的方法（可直接照搬的清单）

| # | 方法 | Claude Code 的做法 | 说明 |
|---|---|---|---|
| 1 | **会话即 peer** | 名字 + 地址（socket 路径 / mailbox 文件路径） | 地址是能力，不只是 id |
| 2 | **消息注入为 user message** | 不共享上下文，不远程执行 | 接收方用自己的权限规则处理 |
| 3 | **传输分介质** | 本机 socket / 本机文件 / 跨机服务器中转 | 延迟、可靠性、安全模型各不相同 |
| 4 | **发送 ≠ 送达 ≠ 处理** | teams：写文件成功=已发送；cross-session：socket 送达；是否被 Claude 读到另行呈现（`Waiting to be delivered`） | 别把"写成功"说成"对方已完成" |
| 5 | **同意与消息分离** | 四条硬限制 + auto classifier | 这是多 agent 安全的核心 |
| 6 | **入站三态 + 超时 + 容量** | accept / hold / refuse，dialogExpiry 5 分钟，最多 100 条 | 比"允许/拒绝"二元更贴合人机协作 |
| 7 | **防循环三件套** | 限流 + 短窗口相同内容去重 + 队列上限 50 | 否则两个 agent 会互相刷屏烧 token |
| 8 | **订阅式等待** | `notify_when_idle`（12 小时、推送而非轮询） | 比 `wait` 工具更省 token |
| 9 | **可观察性** | `/status` 的 Peer address、inbox 明文 JSON、`/list-agents` | 文件系统即调试工具 |
| 10 | **失败显式化** | `Not sent` / `offline` / `can't receive` / `Waiting to be delivered` | 让模型知道该重试、等待还是放弃 |
| 11 | **生命周期协商** | shutdown request/approve/reject；idle 通知带结果 | 团队不是"启停进程"，是协商 |
| 12 | **质量门** | TeammateIdle / TaskCreated / TaskCompleted hooks | 在关键状态转换点插策略 |

---

## 5. 与 DSH Agent Teams 的对照

| 维度 | Claude Code | DSH（0.1.3-alpha.1） |
|---|---|---|
| 通信介质 | 本机 socket / 跨机服务器；团队用 JSON 文件 | **会话日志事件**（Lead 日志里的 `team/message/queued`/`delivered`） |
| 账本归属 | 收件人 mailbox 文件 | **Lead 会话日志**（事务 owner） |
| 寻址 | 会话名 / teammate 名 | teammate 名（`SessionId` 隐含） |
| 投递 | 注入 user message；运行中 tool call 之间 | 注入 user message；`steer` 固定调度 |
| ack | 写文件成功 = 已发送；无 durable ack | **target 日志出现该消息才算 delivered**（更严格） |
| 持久性 | mailbox 文件；任务目录 | 会话日志可回放；事件有版本与运行时校验 |
| 并发 | 文件锁（任务 claim）、无严格写互斥 | 每 Lead 串行事务；任务板 CAS revision |
| 跨进程/跨机 | ✅ 本机跨进程；跨机经 Remote Control | ❌ 进程内；跨机需另做（API/SDK） |
| 默认开关 | cross-session 默认开；teams 实验性关闭 | 两个 Team 包均实验性、默认不装 |
| 成熟度 | 已迭代到 v2.1.2xx，有大量版本化行为 | 0.1.3-alpha，实验包 `private: true` |

一句话：**Claude Code 把"通信"做成 OS 级原语（socket + 文件），DSH 把"通信"做成日志级原语（session event + 事务）。** 前者跨进程容易、可观察性强；后者可回放、可校验、可恢复，但天然只在单进程内。

---

## 6. 对"DSH session 间主动通信"方案的启示

1. **寻址**：`SessionId` 做主键、名字做 label（DSH 已有 SessionId，补一个可读名即可）。
2. **投递**：固定 steer（running 在最近 step 边界读、idle 起 turn），与 Claude 的"tool call 之间 / idle 起 turn"语义一致。
3. **可靠性分级**：Claude 的 cross-session 只做"socket 尽力而为"，teams 只做"写文件成功"。我们的 sender-owned outbox + target 侧 ack 比两者都强，但要接受成本（每条消息两个事件）。
4. **入站控制补 hold**：我们方案目前只有 allow/deny；建议加 `accept / hold / refuse` 三态，hold 进审批流（DSH 有 `tools/pre-execute` 的 ask 能力，正好对应 Claude 的审批框）。
5. **防循环**：照抄"限流 + 相同内容短窗口去重 + 队列上限"，而不是只限体积。
6. **订阅等待**：`notify_when_idle` 值得抄——DSH 可以用 `agent/status` 事件 + 一次注入实现，比 `session_wait` 轮询省 token。
7. **失败文案**：区分"未发送 / 已排队 / 已送达 / 已过期 / 对方拒收"，并让工具返回值直接体现（我们目前的 `accepted|queued` 可以再补 `held/refused`）。
8. **可观察性**：在 Web 侧暴露"本会话的通信地址 + 入站策略 + 最近投递状态"，对应 Claude 的 `/status` Peer address 行。

---

## 7. 参考

- [Message your other Claude Code sessions（cross-session messaging）](https://code.claude.com/docs/en/cross-session-messaging)
- [Orchestrate teams of Claude Code sessions（agent teams）](https://code.claude.com/docs/en/agent-teams)
- [Tools reference（`ListAgents` / `SendMessage`）](https://code.claude.com/docs/en/tools-reference)
- [Work with sessions（Agent SDK：resume / fork）](https://code.claude.com/docs/en/agent-sdk/sessions)
- [《Claude Code Agent Teams 逆向工程：文件系统就是消息队列》（社区，2026-02-28）](https://github.com/Quriosity-agent/articles/blob/main/2026-02-28/claude-code-agent-teams-reverse-engineering.md)
