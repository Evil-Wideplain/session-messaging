# `create_session_agent`：创建普通会话并投递首条消息

> 所属插件：[`session-messaging`](../README.md) · 工具版本：v4（2026-11-02）·
> 实现：[`application/session-creation-service.ts`](../src/application/session-creation-service.ts) +
> [`application/session-creation/location.ts`](../src/application/session-creation/location.ts) +
> [`infrastructure/cordis-session-creator.ts`](../src/infrastructure/cordis-session-creator.ts) +
> [`infrastructure/cordis-workspace-resolver.ts`](../src/infrastructure/cordis-workspace-resolver.ts)

## 1. 它做什么

`create_session_agent` 让一个**主（root）会话**从零创建一个新的普通会话，并把第一条消息投递进去：

- 新会话是 **root 会话**，不是子代理：它有自己的侧栏条目、自己的 `session_id`，此后与调用方是平等
  会话，可以用 [`list_session_agents`](../README.md#list_session_agents) 看到、用
  [`send_session_message`](../README.md#send_session_message) 继续投递。
- 创建动作等价于 GUI 的「新建会话」：DSH 负责 mkdir、Agent preset 挂载、模型选择、Workspace
  归属和侧栏广播；
- 位置可以指定到**已登记工作区**（id 或根目录路径）；未登记的目录用 `ensure_workspace` 先登记
  再创建（等价于 GUI 的「添加文件夹」）。
- 首条消息立即进入新会话的 inbox，新会话**自行开始第一轮**；工具在消息被接纳后即返回，**不等待
  第一轮结束**。需要结果时用 `send_session_message` 追问，或由新会话回发。

它**不**用于委派一次性子任务——那应该用官方 `subagent` / `spawn_teammate`；也**不**做 fork、
不复制会话历史。

## 2. 契约

### 2.1 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 新会话收到的第一条消息。会按跨会话消息带来源框架（见 §3.4）；空/纯空白或超过 `maxMessageBytes` 返回 `refused`，不是参数错误 |
| `cwd` | string | 否 | 新会话的工作目录，必须是**绝对路径**；缺省为调用方自己的工作目录。精确等于某个已登记工作区根目录时会归入该工作区，否则会话显示为「未分组」（见 §4.2） |
| `workspace` | string | 否 | 目标工作区：工作区 id（GUI 侧栏项）或已登记工作区的绝对路径。给出时会话建在该工作区根目录并归入其中；与 `cwd` 同时给出时必须指向同一目录（`workspace` 传 id 时按解析出的根目录比较） |
| `ensure_workspace` | boolean | 否 | 配合 `cwd` 或 `workspace` 路径：目录不存在时递归创建、未登记时登记成工作区，再在该工作区里建会话。受 `allowCreateWorkspace` 控制；顺序是位置授权 → 每分钟限额 → mkdir/登记，被拒绝的请求不产生目录或工作区 |
| `title` | string | 否 | 会话标题，在第一轮开始前写入；写入失败不影响创建结果 |
| `agent_preset` | string | 否 | Agent preset id，由 DSH 解析并挂载；非法 preset 会让创建失败（`failed`） |

未知参数会被拒绝（工具 schema `additionalProperties: false`）。

### 2.2 返回

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `accepted` / `refused` / `failed` | 见下表 |
| `session_id` | string | 新会话 id；`refused` 或「DSH 未建出会话」时为空串 |
| `short_id` | string | `session-` 前缀后 8 个字符，便于模型引用；`session_id` 为空时为空串 |
| `cwd` | string | 新会话（或被请求的）工作目录 |
| `workspace_id` | string | 可选；会话实际归入的 Workspace id（未归入任何工作区时缺省） |
| `title` | string | 可选；只在显式传了 `title` 且写入成功时返回 |
| `agent_preset` | string | 可选；DSH 解析出的实际 preset |
| `message_id` | string | 首条消息的投递 id，可用于对账/补发 |
| `detail` | string | 人可读的补充说明（失败原因、部分失败原因等） |

### 2.3 状态语义

| status | 何时出现 | 调用方应该做什么 |
|---|---|---|
| `accepted` | 会话已创建，首条消息已进入新会话 inbox | 结束本步；后续用 `session_id` 继续控制 |
| `refused` | 策略拒绝：`allowCreateSession=false`、调用方是子代理、`cwd` 非绝对路径或未授权、`workspace` 不存在或未获授权 / 与 `cwd` 指向不同目录、`ensure_workspace` 被关闭或登记失败、调用方没有 cwd 且未显式传、触发每分钟限额、`prompt` 为空/纯空白或超限 | 修正参数或改用其他方式，一般无需重试 |
| `failed` 且 `session_id` 为空 | DSH 拒绝创建（如 preset 不存在、目录不可用） | 检查 `detail`；不会留下半成品会话 |
| `failed` 且 `session_id` 非空 | **会话已创建**，但首条消息未能投递（inbox 已关闭/agent 已销毁等） | 用 `send_session_message` 向该 `session_id` 补发；会话是空白状态，补发即可 |

> 注意：`status=failed` 不代表「什么都没发生」。`session_id` 非空时，会话真实存在，只是还没有第一条
> 消息；这种会话在侧栏里可能暂时不可见，补发一条消息后就会出现。

### 2.4 调用示例

```json
{
  "prompt": "把 web 端的侧栏重构成可折叠分组，先给我一个改动计划。",
  "cwd": "/repo/frontend",
  "title": "侧栏重构",
  "agent_preset": "coding"
}
```

返回（渲染给模型前是 JSON，`render` 之后是紧凑文本）：

```json
{
  "status": "accepted",
  "session_id": "session-0f1e2d3c4b5a",
  "short_id": "0f1e2d3c",
  "cwd": "/repo/frontend",
  "title": "侧栏重构",
  "agent_preset": "coding",
  "message_id": "7c1f…",
  "detail": "已创建普通会话，首条消息已进入其 inbox；会话会自行开始第一轮"
}
```

## 3. 实现路径

### 3.1 分层

```text
create_session_agent                      接口层：schema / 参数校验 / DTO 投影
  └─ SessionCreationService               应用层：root-only、位置授权、限额、首条消息构造
       ├─ resolveLocation（应用层）        workspace / cwd / ensure_workspace → 目录 + Workspace
       ├─ CordisWorkspaceResolver         基础设施：workspaceRegistry 解析/登记（含 mkdir）
       └─ CordisSessionCreator            基础设施：controller.create + followup + 收尾
            └─ DSH Host                   应用组合：mkdir / preset / 模型 / Workspace / 侧栏广播
```

应用层不 import Cordis；创建端口是 [`application/ports.ts`](../src/application/ports.ts) 里的
`SessionCreator` 接口，测试用假实现替换。基础设施层是唯一碰 `ctx.sessionController` /
`ctx.agents` / `ctx.sessions` 的地方。

### 3.2 创建顺序

```text
1. 解析位置并授权（resolveLocation）：workspace / cwd → 目录 + 可选 Workspace
2. 每分钟限额（maxCreatesPerMinute，按调用方计数）
3. 授权通过且 ensure_workspace 时 mkdir + 登记工作区；返回的 realpath 与授权路径不同则按规范路径再授权
4. controller.create({ workspaceId | cwd, agentPreset? })
5. agents.get(sessionId)                  → 拿在线 Agent
6. workspace attach（仅创建前未归属 Workspace 时，尽力而为）
7. permissionPresets 继承调用方有效预设（尽力而为）
8. controller.rename({ sessionId, title })（尽力而为，先于首轮）
9. agent.followup(message)                → 首条消息进 next-turn inbox 并唤醒
10. sessions.flush(agent.session)         → 让首条消息尽快落盘（尽力而为）
```

任一步「尽力而为」失败只记日志，不影响 `accepted`；第 5 步拿不到 Agent 或第 9 步失败时，
返回 `failed` 但保留 `session_id`（见 §2.3）。第 2 步的限额在位置解析与授权之后、`ensure_workspace`
的副作用之前：被限额拒绝的请求不会创建目录或登记工作区。

### 3.3 为什么走 `sessionController.create()` 而不是 `ctx.agents.create()`

`ctx.agents.create()` 建立的新会话归**调用方 Context 的 owner**。从插件上下文直接调用，新会话会
被登记成插件 Fiber 的孩子：插件重载/卸载时会被一起拆掉，而且跳过了产品层要做的 mkdir、preset
组合、模型选择、Workspace 归属与侧栏广播。

`ctx.sessionController.create()` 是 GUI「新建会话」的同构入口，生命周期归应用组合所有——插件
卸载不影响已创建的会话。它只接受 `workspaceId` / `cwd` / `agentPreset` 等产品级参数，不需要
Remote 调用侧的 principal。

### 3.4 为什么首条消息用 `agent.followup()`

- `followup()` 与内置 `dsh -p` 的驱动方式一致：消息排入 `next-turn` inbox 并唤醒会话；
- 消息本体复用本插件的转发构造，带 `source.kind = 'session-message'` 与来源框架：

  ```text
  Session message <messageId> from <senderName> (<senderId>):
  <prompt>
  ```

  新会话的模型因此能分辨「另一个会话发来的话」，而不是把它当成人类输入。

刻意不用 `sessionController.prompt()`：那是 Remote 层给客户端用的入口，要求调用侧 principal，
并依赖附件上传、文件回执等服务；把跨会话消息伪装成人类 prompt 也违背插件的来源约定。

### 3.5 首条消息与入站审批

首条消息**不经过** `inbound: hold` / `refuse`：它是创建动作的一部分，与人类新建会话后输入第一条
消息等价。入站策略只约束之后别人发给这个会话的跨会话投递。

## 4. 授权与安全

身份只来自运行时：`exec.agent`。参数里的任何字段都不能冒充调用方。

### 4.1 只有 root 会话能创建

调用方的 `session.header` 带 `origin = 'subagent'`，或 `delegationDepth > 0` 时直接 `refused`。理由：子代理已有
`subagent` / `spawn_teammate` 通道；允许它创建 root 会话会绕开委派深度与权限收敛。

### 4.2 位置与授权

位置有三种写法，最终都收敛成「一个绝对目录 + 可选 Workspace」：

- `workspace`（工作区 id 或绝对路径）：解析到已登记工作区后，会话建在其根目录并归入该工作区；
- `cwd`：必须是绝对路径。精确等于某个已登记工作区根目录时会归入该工作区，否则会话显示为「未分组」；
  注意 DSH 的 `attachSession` 要求会话 cwd 与工作区根目录**完全相等**，所以工作区子目录里的会话
  无法归入父工作区——要归属就先把子目录登记成独立工作区（`ensure_workspace`），或接受未分组；
- 都不传：调用方自己的工作目录（`agent.session.header.cwd`）。

`workspace` 与 `cwd` 可以同时给出，但必须指向同一目录（`workspace` 传 id 时按解析出的根目录比较）；
也可以只传 `workspace`。

授权复用投递侧的 workspace 策略：目标目录等于调用方 cwd，或命中 `allowCrossWorkspace: true`，
或命中 `allowlist` 的目录前缀；否则 `refused`。创建会话会让新 Agent 在新目录里拥有写权限，不能比
「给现有会话发消息」更宽松。

为了避免用文案差异枚举「某个工作区 id 是否存在」，`workspace` 传 id 时「未登记」与「已登记但未获授权」
返回同一段 `detail`（且不回显 cwd）；只有绝对路径写法会给出「工作区不存在」这类可操作提示。

`ensure_workspace` 的顺序是**位置授权 → 每分钟限额 → mkdir/登记**：先解析位置并授权，再占用创建限额，
两者都通过后才 mkdir + `workspaceRegistry.create` 登记工作区（幂等）；被授权或限额拒绝都不会产生目录或
工作区。登记还会受 `allowCreateWorkspace` 控制。登记返回的是 DSH 规范化（realpath）后的路径，可能与授权
时的路径不同（符号链接、大小写/尾斜杠归一化）：不同时会按规范路径再授权一次，只有通过才用它创建会话，
否则 `refused`（此时目录/工作区已经登记，但不会创建会话）。

### 4.3 限额

- 按调用方每分钟限额 `maxCreatesPerMinute`（默认 4）；参数校验在限额之前，被拒绝的请求不消耗配额；
- 限额是进程内计数，重启宿主后重置；多宿主（如 GUI + CLI）不共享计数。

### 4.4 权限继承

创建后尝试把调用方的**有效权限预设**复制给新会话（`permissionPresets.current/set`）。DSH 给全新
会话套的是用户默认权限，可能比调用方当前权限更宽。

- 调用方是具名 preset（如 `read-only`）→ 新会话设为同一 preset；
- 调用方是 `custom` 组合（没有预设名）→ 跳过并记日志，新会话按默认权限运行（已知限制，见 §7）。

## 5. 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `allowCreateSession` | `true` | 设为 `false` 时工具一律 `refused` |
| `maxCreatesPerMinute` | `4` | 每调用方每分钟最多创建多少个新会话 |
| `allowCreateWorkspace` | `true` | 设为 `false` 时 `ensure_workspace` 一律 `refused`（不会登记新工作区） |
| `maxMessageBytes` | `65536` | 首条消息正文上限（与普通投递共用） |

配置示例（`cordis.patch.yml`）：

```yaml
- id: session-messaging
  config:
    allowCreateSession: false
    maxCreatesPerMinute: 2
    allowCreateWorkspace: false
```

## 6. 失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `failed` + `detail` 含「没有 sessionController 服务」 | 宿主是 headless / CLI 组合，不装配该服务 | 换 GUI / Web 宿主；这是刻意不降级的设计（见 §3.3） |
| `failed` + `detail` 含「DSH 拒绝创建会话」 | preset 不存在、目录不可用、DSH 内部校验失败 | 按 `detail` 修正 `agent_preset` / `cwd` 后重试 |
| `failed` 且 `session_id` 非空 | 会话已建但首条消息未投递 | 用 `send_session_message` 向 `session_id` 补发 |
| `refused` +「cwd 必须是绝对路径」 | 传了相对路径 | 传绝对路径 |
| `refused` +「不允许在该目录创建会话」 | `cwd`（或 `workspace` 绝对路径）跨 workspace 且未放行 | 改到调用方 cwd，或配置 `allowCrossWorkspace` / `allowlist` |
| `refused` +「工作区不存在」 | `workspace` 传了未登记的绝对路径 | 传已登记工作区的根目录路径；或加 `ensure_workspace: true` 先登记 |
| `refused` +「工作区不可用或未获授权」 | `workspace` 传的是 id：未登记，或登记了但未放行（两者同文案、不回显路径） | 核对 id；或配置 `allowCrossWorkspace` / `allowlist`；或改用绝对路径 + `ensure_workspace` |
| `refused` +「必须指向同一个目录」 | `workspace` 解析出的目录与 `cwd` 不同（传 id 时也适用） | 只传其一，或让两者指向同一目录 |
| `refused` +「创建工作区已关闭」 | `allowCreateWorkspace=false` | 换已登记工作区，或放开配置 |
| `refused` +「登记工作区失败」 | 目录/权限/注册表问题 | 按 `detail` 修正目录或权限后重试 |
| `refused` +「子代理不能创建普通会话」 | 调用方是子代理 | 由主会话创建，或让子代理用 `subagent` |
| `refused` +「触发创建频率限制」 | 超过 `maxCreatesPerMinute` | 稍后重试或调高配置 |

## 7. 已知限制

- **依赖 `sessionController`**：只有 GUI / Web 应用组合装配它；headless / CLI 组合调用会得到
  `failed`。刻意不做 `ctx.agents.create()` 降级（理由见 §3.3）。
- **工作区归属要求根目录精确匹配**：子目录里的会话不能归入父工作区（DSH attach 的约束），
  需要归属时用 `ensure_workspace` 把子目录登记成独立工作区。
- **`ensure_workspace` 依赖 `workspaceRegistry`**：headless / CLI 组合没有该服务，会 `refused`。
- **`custom` 权限无法继承**：调用方是自定义权限组合时没有可复制的预设名，新会话回到用户默认
  权限。需要严格收敛时，应给调用方配置具名 permission preset。
- **不等待第一轮**：调用返回后新会话可能还在跑；工具不返回首轮结果，也没有完成通知。
- **不支持 fork / 指定 session id / 幂等复用**：重试会创建一个新会话。
- **空白会话可能暂不可见**：会话已建但首条消息未投递时，侧栏可能暂时不显示；补发消息即可。
- **限额是进程内计数**：重启宿主或多宿主并行时无法精确约束。

## 8. 验证

| 层 | 内容 | 结果 |
|---|---|---|
| 单元测试 | [`tests/create-session-service.test.ts`](../tests/create-session-service.test.ts)（root-only / cwd 授权 / 限额 / 首条消息构造 / 部分失败）、[`tests/create-session-creator.test.ts`](../tests/create-session-creator.test.ts)（workspaceId vs cwd / attach / preset 继承 / 标题 / followup 失败 / 缺服务）、[`tests/create-session-tool.test.ts`](../tests/create-session-tool.test.ts)（参数校验 / DTO / render） | 38 个用例通过（§9 列出的全部 create-session 用例共 72 个） |
| 全量测试 | `npm test`（构建 + vitest） | 198 通过 / 1 平台跳过（共 199） |
| 真运行时冒烟 | headless + 本地模型：模型实际调用 `create_session_agent`，参数原样透传，缺 `sessionController` 时返回 `failed` | 本轮未重跑（2026-11-01 记录 5/5） |
| GUI 手动验证 | 重启 DeepSeek Harness → 新会话中调用工具 → 工具返回 `accepted`，侧栏出现新会话并开始第一轮 | 发布前执行 |

插件是宿主级加载，**没有 HMR**：修改 `lib/` 后需要重启宿主（DeepSeek Harness / `dsh` 进程），
新工具才会出现在模型工具列表里。

## 9. 相关文件

| 文件 | 职责 |
|---|---|
| [`src/interfaces/tools/create-session.ts`](../src/interfaces/tools/create-session.ts) | 本工具的 schema、参数校验、DTO 投影与 render |
| [`src/interfaces/model-tools.ts`](../src/interfaces/model-tools.ts) | 工具 barrel（四个工具统一从 `tools/` 组装） |
| [`src/application/session-creation-service.ts`](../src/application/session-creation-service.ts) | 用例编排：root-only、cwd 授权、限额、首条消息构造 |
| [`src/application/ports.ts`](../src/application/ports.ts) | `SessionCreator` 端口与请求/结果类型（Workspace 端口在 [`ports-workspace.ts`](../src/application/ports-workspace.ts)） |
| [`src/application/dto.ts`](../src/application/dto.ts) | `CreateSessionInput` / `CreateSessionResult` |
| [`src/infrastructure/cordis-session-creator.ts`](../src/infrastructure/cordis-session-creator.ts) | `sessionController.create` + attach / 权限 / 标题 / followup / flush |
| [`src/infrastructure/session-finish.ts`](../src/infrastructure/session-finish.ts) | 创建后收尾：权限预设继承 / 标题 / flush（失败只记日志） |
| [`src/config.ts`](../src/config.ts) | `allowCreateSession` / `maxCreatesPerMinute` |
| [`tests/create-session-service.test.ts`](../tests/create-session-service.test.ts) | 应用服务单测 |
| [`tests/create-session-workspace.test.ts`](../tests/create-session-workspace.test.ts) | workspace / ensure_workspace 位置解析与授权顺序 |
| [`tests/create-session-workspace-adapter.test.ts`](../tests/create-session-workspace-adapter.test.ts) | Workspace 解析/登记适配器 |
| [`tests/create-session-creator-workspace.test.ts`](../tests/create-session-creator-workspace.test.ts) | 创建适配器的 workspace 归属投影 |
| [`tests/create-session-creator-lifecycle.test.ts`](../tests/create-session-creator-lifecycle.test.ts) | 创建后收尾与取消：flush 失败、创建期间取消、缺服务、preset 继承 |
| [`tests/create-session-creator.test.ts`](../tests/create-session-creator.test.ts) | 基础设施适配器单测 |
| [`tests/create-session-tool.test.ts`](../tests/create-session-tool.test.ts) | 工具契约单测 |
| [`tests/support/create-session-fixtures.ts`](../tests/support/create-session-fixtures.ts) | 6 个 create-session 相关文件共享的夹具 |
| [`docs/design/session-messaging-plugin.md`](design/session-messaging-plugin.md) | 插件整体设计与 v3 决策记录（§16） |
