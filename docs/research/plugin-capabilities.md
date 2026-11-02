# DSH 插件机制 / 扩展点 / 现有插件生态 调研

> 方向：**插件机制 · 扩展点 · 现有插件生态**
> 权威源码：`C:\Code\deepseek-harness`（master，`@deepseek-ai/dsh-*@0.1.3-alpha.1` 线，只读）
> 工作目录：`C:\Code\session_history`（`dsh-plugin-session-history` 骨架）
> 结论日期：2026-11-01

---

## 0. 结论（TL;DR）

**核心问题：DSH 官方是否已有现成的、可复用的 session 创建 / 通信插件能力？**

**答：没有可直接安装的成品插件，但"服务层"已经齐备，缺的只是一层面向模型的工具。**

分三层看：

| 层 | 现状 | 证据 |
|---|---|---|
| **服务层（可复用，无需自己写）** | ✅ **齐全**。`ctx.sessions`（`create/get/list/fork/flush`）、`ctx.agents`（`create/resume/get/list/roots`）、`ctx.subagents`（`startContinuable/sendMessage/listChildren/listDescendants/interrupt`）、`ctx.agentPresets`（`resolve/mount`）已覆盖"建会话 + 通信"的全部原语 | `packages/core/session/src/index.ts:925`、`packages/core/agent/src/index.ts:195-207,400-419`、`packages/subagent/subagent/src/index.ts:229-554` |
| **工具层（部分现成，语义不等价）** | ⚠️ **有 4 组"部分现成"**，但没有一个叫 `create_session`，也没有一个能"按 session id 给任意会话发消息" | 见 §4 |
| **成品插件包（可直接 `dsh plugin add`）** | ❌ **不存在**。`packages/*/tool-*` 全部是官方内部包，唯一被官方点名的第三方 bundle 示范是 `turtle-ui`（一个 Web 皮肤，不是工具集） | `docs/user/develop/basic/publish.zh.md:163` |

**"部分现成"到底缺什么（一句话）**：

- `send_message` / `interrupt_agent` / `list_agents` **已经在 `dsh-base` 默认装载**（`@deepseek-ai/dsh-tool-subagent-control`），但语义被锁死为 **"直接可继续子 agent ↔ 直接父 agent"** 的相邻关系，**模型无法给任意 session 发消息**。
- **建会话**这件事被分散在 `subagent` / `subagent_fork` / `workflow` / `ralph` / `spawn_teammate` 里，每个都绑定一种"角色"（一次性子任务 / 工作流子级 / 团队成员），**没有中性的 `session_create`**。
- **列会话**完全没有工具（Web 侧列表走 Remote `session/list`，模型够不到）。

**设计结论**：

> 新工具集 **不需要新写服务层**，应该做成一个 **"薄工具层 + bundle 组合层"** 的包：复用 `ctx.agents` + `ctx.subagents` + `ctx.agentPresets`，只新增工具注册、配置、prompt 段、授权与呈现。模板直接抄 `packages/session-query/tool-session-query`（三包分层的工具侧）与 `packages/api/session-controller/src/agent.ts#composeAgent`（建会话的正确姿势）。

**风险最高的三件事**（详见 §7）：

1. **命名冲突**：`send_message` / `interrupt_agent` / `list_agents` 已在 root 层注册，同层重名注册会 **失败**。
2. **组合平面选错**：Web 产品的模型侧工具在 **agent preset**（默认 `standard`）里，不在 bundle 里；但 root 层注册的工具对 preset 会话同样可见——两条路都通，语义不同。
3. **npm 版本线**：官方包已发布，但 `latest` dist-tag 停在 `0.0.1-rc.1`，且 `^0.1.3-alpha.2` **匹配不到** `0.1.5-alpha.1` / `0.2.x`（prerelease 规则）。依赖声明必须显式选线。

---

## 1. 插件开发契约（写这个插件要遵守什么）

### 1.1 插件是什么

一个插件就是一个导出 `apply` 的 TS 模块（函数 / 对象 / 类三种形态）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'
export const inject = ['tools', 'agents']      // 框架保证这些服务就绪后才 apply
export interface Config { /* ... */ }
export const Config: z<Config> = z.object({ /* ... */ })

export function apply(ctx: Context, config: Config): void { /* 通过 ctx 注册能力 */ }
```

- 注册即 effect：`ctx.effect()` / `ctx.on()` / `ctx.tools.register()` 在卸载时自动回收，**不需要手动清理**。
- 改 `cordis.yml` 里某行的 `config` 会触发插件热替换（HMR）。
- 来源：`docs/user/develop/basic/index.zh.md`、`docs/user/develop/basic/config.zh.md`、`docs/user/develop/framework/service.zh.md`。

### 1.2 工具注册 API（核心）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'session_create',
  description: '模型看到的描述',
  parameters: { cwd: { type: 'string', required: true, description: '...' } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `created ${value.sessionId}` }],
  },
  async execute(args, exec) { /* 必须返回 output.schema 声明的规范 JSON 值 */ },
  presentCall: args => ({ card: 'generic', kind: 'read', title: `Create session`, rawInput: args }),
}))
```

`ToolDefinition` 的关键字段（`docs/subsystems/tools.zh.md:9-97`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` / `description` / `parameters` | ✅ | 模型可见。`parameters` 是 DSL，`defineTool` 帮你推导 `args` 类型并在 execute 前校验 |
| `output.schema` | ✅ | 规范 JSON 值契约（**必须声明**，注册表会校验） |
| `output.render(args, value)` | ✅ | 纯函数，规范值 → 模型可见 `ContentBlock[]` |
| `output.presentationMeta(args, value)` | ❌ | 可从规范值派生、持久化到 `tool/result` 的可回放 UI 元数据 |
| `execute(args, exec)` | ✅ | `exec` = `{ callId, name, arguments, agent?, token, signal, parent? }`。**必须遵守 `exec.signal`** |
| `timeoutMs` / `isConcurrencySafe` | ❌ | 并发与截止时间 |
| `presentCall` / `presentResult` | ❌ | UI 卡片渲染意图（`generic` / `terminal` / `diff` / `read` / `search` / `web`） |

补充事实：

- `ctx.tools.register()` **也直接接受原始 JSON Schema `ToolDefinition`**（MCP 工具就是这样进场的）——这是**不引入 `@deepseek-ai/dsh-tools` 运行时依赖**的唯一办法。
- **同层重名注册会失败**；scoped 注册会遮蔽 global。原文：*"Scoped tools shadow globals; duplicates within one layer and the reserved `run_code` name fail"*（`docs/subsystems/tools.zh.md:497-500`）。
- 注册的 schema 自动流入系统提示词组装；`schemas()` 只白名单 `name/description/parameters`，`execute`/`output` **绝不泄漏给模型**。

### 1.3 权限 / 策略扩展点（不要内建到工具里）

| 扩展点 | 模式 | 用途 |
|---|---|---|
| `tools/pre-execute` | waterfall（allow / deny / ask） | 部署级许可策略；**权限门禁的标准位置** |
| `ctx.tools.guard(fn)` | 单调 guard | 不可被后续监听器翻盘的最终拒绝 |
| `tools/execute` | 环绕分发 | 截止时间 / 重试 / 指标；**唯一可替换 `exec.signal`** |
| `tools/post-execute` | waterfall | 变换展示内容或返回值 |
| `tools/result` | emit | 观察不可变的权威结果（审计 / 采集） |
| `ctx.tools.restrict({allow, deny})` | 按作用域 | 过滤继承来的 global 工具；不影响自身 scoped 注册 |

来源：`docs/cookbook/adding-a-tool.zh.md`「执行策略与观测」、`docs/cookbook/extension-cookbook.zh.md`、`docs/subsystems/tools.zh.md:153-180`。

### 1.4 系统提示词段

```ts
ctx.systemPrompt.section({
  name: 'tool:session-tools',                              // 必须全局唯一，重复会抛
  order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
  text: '……给模型的使用指引……',
})
```

**⚠️ 第三方插件的硬约束**：`getSectionOrder()` 只接受 `packages/core/system-prompt/src/index.ts:120-139` 那张**封闭常量表**的 key（`TOOL_BASH:1000`、`TOOL_SESSION_QUERY:2300`、`TOOL_SUBAGENT:2800`……）。第三方**无法新增具名槽位**（除非 patch `dsh-system-prompt`）。做法：复用最接近的既有 key，或直接传数字（`PromptSection.order` 只要求 `number`）。

### 1.5 配置契约

- "凡不同部署可能需要不同值的参数，都必须定义为配置字段"（`docs/user/develop/basic/config.zh.md`）。
- 默认值写在 Schemastery schema 里；配置非法要在加载时**响亮失败**。
- 生成的配置目录 `docs/config-catalog.zh.md` 是官方包的"穷尽式真源"——新包应在 JSDoc 上对齐这个习惯。

---

## 2. 组合机制：bundle / profile / preset 三平面（最容易踩坑的地方）

### 2.1 概念对照

| 概念 | 载体 | manifest | 回答的问题 |
|---|---|---|---|
| **组合包 bundle** | npm 包 | `package.json` → `dsh.bundle.patch: "./cordis.patch.yml"` | "这个包贡献哪一层配置？" |
| **profile** | `$DSH_HOME/profiles/<name>/` | `dsh.profile.bundles: [...]` | "这套配置由哪些 bundle 按顺序组成？" |
| **agent preset** | `agent.cordis.yml` | `preset.yml`（name/description/order） | "这个**会话**的模型侧工具/人设/提示词段是什么？" |

> 原文：*"没有东西同时是两者。"*（`docs/user/develop/basic/publish.zh.md:24`）
> **关键补充**：preset 是第三平面，publish.md 没讲，但在 Web 产品里它才是模型侧工具的归属地。

### 2.2 层顺序（后应用者胜，且 patch **整行替换** `config`，不深合并）

1. profile 的 `dsh.profile.bundles` 顺序应用；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`；
4. 每个 `--patch <path>` overlay（按 argv 顺序）。

来源：`docs/user/develop/basic/publish.zh.md`「加载顺序」、`apps/cli/reference/README.zh.md`。

### 2.3 三平面该怎么选（本插件相关）

```
Web 产品实际组合
├─ host 平面  = dsh-base 层 + dsh-web-app 层          → 注册表/服务/persistence/沙箱
└─ agent 平面 = agent preset (packages/preset/agent-presets/presets/standard/agent.cordis.yml)
                                                      → bash/fs/subagent/workflow... 工具行
```

- `dsh-web-app` 挂 roster：`agent-presets`，`default: standard`（`packages/bundle/web-app/cordis.patch.yml:445-449`）。
- preset 里的工具行**在该 preset 的 standing scope 内注册**，只有加入该 preset 的会话可见；**如果一行发布服务，必须包在带 `isolate` realm 的 group 里**，否则会让整个进程冲突。
- **root（bundle 层）注册的工具是 global 层，preset 会话能看见**（ToolRestriction 的语义是"过滤继承来的 global + 祖先作用域"，preset 只是额外叠加）。`packages/bundle/headless/src/index.ts:180-184` 的注释是这个语义的官方表述：*"This bundle composes no preset roster, so the model-facing rows sit in the host plane and the agent reads them from the global layer"*。

**→ 对本插件的推论**：

- 走 **bundle 层注册工具** ＝ `dsh plugin add` 一次到位、对**所有会话**生效、不需要用户碰 preset。**这是最小侵入路径。**
- 走 **preset 行** ＝ 只对某个 preset 生效，适合"给创造模式额外能力"，但用户必须复制 preset 才能装，成本高。

### 2.4 建会话时必须"组进 preset"（否则建出裸 agent）

`packages/api/session-controller/src/agent.ts` 里的 `composeAgent()` 是官方唯一正确的建会话范式：

```ts
async composeAgent(presetId: string | undefined) {
  const presets = this.ctx.get('agentPresets')
  if (presets === undefined) return { setup: (agentCtx) => this.installSelection(agentCtx) }
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => { this.installSelection(agentCtx); await presets.mount(agentCtx, resolvedId) },
  }
}
```

配套的 create 体（同文件 `ensureSession`）：

```ts
const composition = await this.composeAgent(presetId)
return (await this.ctx.agents.create({
  sessionId,                                   // brandString<SessionId>(`session-${randomUUID()}`)
  agentOptions: this.agentOptions(),
  meta: { cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
  setup: composition.setup,
})).agent
```

**如果跳过 `presets.mount()`**：在 Web 部署里新会话拿不到 `standard` 的工具（bash/fs/subagent 全没有），只有一个空壳 agent。这是本次调研中最容易做错的一点。

---

## 3. 运行时动态插件（`packages/extensions/*`）

### 3.1 能力边界

| 项 | 事实 |
|---|---|
| 工具集 | `@deepseek-ai/dsh-tool-cordis` 提供 7 个工具：`cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`、`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine` |
| 依赖服务 | `ctx.dynamicCordisRunner`（由 `@deepseek-ai/dsh-cordis-host-runner` 提供）+ `ctx.cordisInspect`；**缺少 runner 时工具不激活** |
| 模型能做什么 | 在**进程内存**里定义带版本的 Cordis 包（host 半 / 浏览器半 / 两半），run / stop / undefine，并注册**额外的模型可见工具** |
| 存续 | **仅进程内存**。DSH 重启即清空；写不进 `cordis.yml`、不装 npm 包、不改仓库文件 |
| 作用域 | 定义以**会话**为界（Session 拥有），运行中的包可能影响同进程**其他会话** |
| 安全 | vm 沙箱隔离全局变量，**但不是安全边界**——官方明说"对待动态包要像对待 bash 访问"；浏览器半首次激活需人工批准 |
| 默认装载 | **不在任何随产品发布的树里**，需显式 `--patch apps/cli/config/examples/cordis/cordis.yml` 或使用 `cordis` agent preset（创造模式） |

来源：`packages/extensions/README.zh.md`、`packages/extensions/tool-cordis/README.zh.md`、`docs/subsystems/extensions.zh.md`、`docs/user/develop/practice/dynamic-cordis.zh.md`、`docs/tool-catalog.zh.md:27`。

### 3.2 能不能用动态插件交付本工具集？

**不能作为交付形态**，可以作为**演示/原型**：

| 维度 | 动态插件（cordis_define） | bundle 插件（本方案） |
|---|---|---|
| 持久化 | ❌ 重启即失 | ✅ npm 包 + profile 层 |
| 安装 | ❌ 每个会话让模型重写一遍源码 | ✅ `dsh plugin add` 一次 |
| 版本/测试/CI | ❌ 无 | ✅ 正常 npm 生态 |
| 组合进 preset | ❌ 不可（不进 profile） | ✅ 或走 preset |
| 适合场景 | 一次性试验、模型自我扩展 | 产品化能力 |

**但有一个很有价值的产品化先例**：`packages/preset/agent-presets/presets/cordis/agent.cordis.yml`（"创造模式"preset）把 `tool-cordis` 作为**一个 preset 的固定行**，并配了 persona 讲清"两个平面"和配套 skill。**如果本工具集只想给某类会话用，抄这个 preset 形态比抄 bundle 更贴。**

### 3.3 `packages/host/plugin-inventory` 是什么

**只读的 Loader 投影**，不是插件管理器：

- 一个 Host Remote：`pluginInventory/list` → 每行 `{ id, module, enabled, phase }`；配了 roster 时还带**每个 preset 的压平组合行**。
- `phase` ∈ `pending / loading / active / failed / unloading / null`。
- **不能**启用/停用/增删插件，**不**携带失败历史，**不**说明某行来自哪个 bundle。
- 浏览器侧渲染：`packages/client/ui-settings-plugin-inventory`。

来源：`packages/host/plugin-inventory/README.zh.md`。

> 对本插件的意义：**装完之后用户在设置页能看见它是否 `active`**，这就是"可观测性"的落点，不需要自己写 UI。

### 3.4 安装 / 发布路径

| 方式 | 命令 | 注意 |
|---|---|---|
| 从本地 checkout 装进 profile | `dsh plugin --profile <name> add ./my-plugin` | 需要 `dsh.bundle.patch` 才激活配置层，否则只当普通依赖并警告 |
| 从 npm 装 | `dsh plugin --profile <name> add <pkg>` | 包必须**预构建**（`files` 含 `lib/`） |
| 从 git 装 | `dsh plugin ... add github:you/repo#<sha>` | pnpm 不跑 build；需作者提供自包含 `prepare`，用户需在 profile `pnpm-workspace.yaml` 写 `allowBuilds`——**等于允许安装期在本机执行代码** |
| 验证层 | `dsh --profile <name> --dump-config` | 会打印 `# == your-plugin` 层 |
| 移除 | `dsh plugin --profile <name> remove <pkg>` | 同时删依赖和层 |

来源：`docs/user/develop/basic/publish.zh.md`、`apps/cli/reference/README.zh.md:46-62`。

---

## 4. 现有官方工具目录：session / agent 相关全清单

以 `docs/tool-catalog.zh.md:16-45`（工具包映射表）为准；`packages/*/tool-*` 共 22 个包。

| 工具包 | 模型可见工具 | 是否默认装载 | 与会话创建/通信的关系 |
|---|---|---|---|
| **`@deepseek-ai/dsh-tool-subagent-control`** | `send_message`、`interrupt_agent`（另 `list_agents` 由 `/list-agents` 插件提供） | ✅ **`dsh-base` 默认装载** | ⚠️ **部分现成**：`send_message` 只对"直接可继续子 agent / 直接父 agent"，**不能按任意 session id 发消息** |
| `@deepseek-ai/dsh-tool-subagent` | `subagent`、`subagent_fork`（+`list_subagent_models`） | ✅ `dsh-base`（`toolName` 可配置，`providerName` spawn/fork） | ⚠️ 能**创建子会话**，但语义是"委派一次性/可继续任务"，不是中性 `create_session`；父会话固定为调用者 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | `send_message`、`spawn_teammate`、`list_agents`、`wait_agent`、`team_task_*`（9 个） | ❌ **默认禁用**（`dsh-experimental-agent-team-profile` 才启用，并**禁用**上面那组同名工具） | ⚠️ **最接近"通用会话通信"**：`spawn_teammate` 建会话、`send_message` 跨成员通信、`wait_agent` 等待。但绑定"隐式 Team Lead"身份，且是 experimental |
| `@deepseek-ai/dsh-tool-session-query` | `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read` | ❌ **opt-in，不在任何已发布树中** | 只读历史，**不建会话、不发消息**；但**是本插件的最佳代码模板** |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` | ✅ | 创建子级执行脚本，非通用会话管理 |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` | ✅ | 每轮新建全新子级，非通用 |
| `@deepseek-ai/dsh-tool-goal` | `create_goal`/`get_goal`/`update_goal` | ✅ | 同会话目标，不是新会话 |
| `@deepseek-ai/dsh-schedule` | `schedule_create`/`schedule_list`/`schedule_delete` | opt-in | 定时唤醒**本会话** |
| `@deepseek-ai/dsh-tool-jobs` | `job_list`/`job_output`/`job_kill` | ✅ | 后台任务控制（含 subagent job） |
| `@deepseek-ai/dsh-tool-skill` / `tool-todo` / `tool-ask-user` / `tool-fs*` / `tool-bash*` / `tool-web` / `tool-lsp` / `tool-terminal` / `tool-str-replace-editor` / `tool-cordis` | 各自的工具 | 多数 ✅，`tool-cordis`/`tool-terminal`/`tool-lsp` opt-in | 无关 |

**全库搜索确认（`grep name: 'create_session|list_sessions|new_session|session_create'`）：零命中。**
**`list_sessions` 也不存在**——Web 侧会话列表走 Client Remote `session/list`（`ctx.sessionController`），**模型无法调用**。

### 4.1 "部分现成"的语义差异（这是给用户回答的关键表）

| 你想要的能力 | 现有最接近的工具 | 缺什么 |
|---|---|---|
| `create_session(cwd?, preset?, prompt?)` | `subagent`（spawn）、`spawn_teammate`、`workflow`、`ralph` | **中性命名**、**可建 root 会话**、**可指定 preset**、**可返回 session id 供后续使用**、**不绑定"委派"语义** |
| `list_sessions()` | `list_agents`（只列自己的 subagent） | 列全部/按 workspace 列、带标题与状态、含非自己创建的会话 |
| `send_message(session_id, text)` | `send_message`（只限直接子/父）、`spawn_teammate`+team `send_message` | **任意 session id**、跨 lineage、广播 |
| `wait_session(session_id)` | `wait_agent`（team 内）、`subagent` 的 job + `job_output` | 通用"等到某个会话 idle" |
| 会话生命周期（关闭/恢复） | team 的 `interrupt_agent`、`subagent` 的 dispose | `session_close` / `session_resume` |

---

## 5. 现成模板：`tool-session-query` 拆解（本插件的直接蓝本）

### 5.1 三包分层

| 包 | 角色 | ctx key | 是否默认装载 |
|---|---|---|---|
| `packages/session-query/session-query` | Service **Definition**（后端无关的读/过滤/血缘/搜索） | `ctx.sessionQuery` | ✅（`session-query-sqlite` 行，`openAt: never`） |
| `packages/session-query/session-query-sqlite` | Service **Provider**（FTS5 索引） | 注册进 `ctx.sessionQuery` | ✅ 但索引默认不打开 |
| `packages/session-query/tool-session-query` | **Consumer / 工具层** | 注册进 `ctx.tools` | ❌ **opt-in** |

这正是 `docs/user/develop/practice/index.zh.md` 讲的三角色模式（Definition / Provider / Consumer）。**本插件属于 Consumer 角色**，而且它的 Definition（`ctx.agents` / `ctx.subagents` / `ctx.sessions`）**官方已经提供**，所以**只需写 Consumer**。

### 5.2 工具层六个文件的职责（可直接照抄结构）

| 文件 | 职责 | 本插件对应物 |
|---|---|---|
| `src/index.ts` | `name` / `inject` / `Config` + JSDoc / `ctx.systemPrompt.section()` / 5 个 `ctx.tools.register()` | ⭐ 核心 |
| `src/input.ts` | 纯 JSON Schema + 参数归一化 | ⭐ 需要 |
| `src/operations.ts` | 每个工具一个 `executeXxx(ctx, args, exec, …)` 编排 | ⭐ 需要 |
| `src/workspace-access.ts` | **调用者身份 + 工作区授权** + 共享投影 | ⭐ 需要（授权模型照抄） |
| `src/service-boundary.ts` | 服务调用集中 + **错误脱敏**（白名单错误码） | ⭐ 需要 |
| `src/presentation.ts` | 纯文本格式化 + `presentCall` 卡片 | ⭐ 需要 |

关键代码形态（`src/index.ts`，实测）：

```ts
export const name = 'tool-session-query'
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'sessionProjections']

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({ name: 'tool:session-query', order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'), text: PROMPT_TEXT })
  ctx.tools.register(defineTool({ name: 'session_search', /* ... */ }))
  // ×5
}
```

### 5.3 工作区授权模型（**建议直接复用**）

`src/workspace-access.ts` 的核心规则只有一句：**授权来自调用方身份，绝不由模型提供**。

```ts
// 调用者：来自 ToolRunContext.exec.agent，不是参数
const caller = { id: agent.session.id, header: agent.session.header, ... }

// 跨会话访问要求 cwd 字符串严格相等
function headerAuthorized(header, caller) {
  if (header.id === caller.id) return header.cwd === caller.header.cwd
  return caller.header.cwd !== undefined && header.cwd === caller.header.cwd
}

// 未授权与"不存在"行为完全相同（防猜测）
throw new HarnessError('session target is outside the caller workspace', 'SESSION_QUERY_TOOL_UNAUTHORIZED')
```

`src/service-boundary.ts` 的价值：把所有 `ctx.sessionQuery.*` 调用包进 `call(ctx, signal, operation, fn)`，异常一律经 `sanitizeError` 映射到**固定白名单码**，内部诊断只进 `ctx.logger.warn`。**任何会跨会话读写的工具都应该有这一层。**

### 5.4 与工作目录骨架的差距（`C:\Code\session_history`）

| 项 | 官方 `tool-session-query` | 现状骨架 | 需要补 |
|---|---|---|---|
| 插件导出 | `name`/`inject`/`Config`/`apply` | ✅ `name`/`Config`/`apply` | 补 `inject` |
| 工具注册 | 5 个 `defineTool` | ❌ 只有 `ctx.logger.info` | ⭐ 核心工作量 |
| 依赖 | peer: `dsh-tools`/`dsh-agent`/`dsh-session`/`dsh-system-prompt`/`dsh-timeout`… | 仅 `@deepseek-ai/cordis ^4.0.5` + `schemastery ^3.18.5` | 加 peer/dev 依赖；或**改用原始 ToolDefinition 不引 dsh-tools** |
| `Config` | 字段带默认值 + JSDoc + 二次校验 `resolveConfig()` | `{ enabled?: boolean }` | 按 §6.2 设计 |
| prompt 段 | 有 | ❌ | 加（注意 §1.4 的封闭表） |
| 授权 | `workspace-access.ts` | ❌ | 抄 |
| 错误边界 | `service-boundary.ts` | ❌ | 抄 |
| 呈现 | `presentation.ts` + `presentCall` | ❌ | 抄 |
| 多入口 | `exports: { ".", "./src/*" }` | 只有 `.` | 若拆 service/tool 两入口需加 `./tool`、`./service` |
| 测试 | e2e 组装覆盖 | `tests/index.test.ts` 单测 | 至少加"装入组合 + 模型可见 schema"级测试 |
| bundle 层 | 三包各有自己的层（用户自行 patch） | ✅ 已有 `cordis.patch.yml`（`- insert: - id: session-history, name: dsh-plugin-session-history`） | 行数按实际入口调整 |

**三个额外可抄的模板**：

1. `packages/subagent/tool-subagent-control/src/index.ts` —— **最薄的工具层**（60 行一个工具：`defineTool` + `ctx.subagents.sendMessage` + 固定文本 render）。本插件通信工具直接照这个写。
2. `packages/experimental/agent-team-profile/{package.json,cordis.patch.yml}` —— **bundle + 顶层 patch 覆盖既有行**的完整示范（它 patch 掉了 `tool-subagent-control` 的三行，为同名工具腾位置）。
3. `packages/api/session-controller/src/agent.ts#composeAgent/ensureSession` —— **建会话**的正确实现。

---

## 6. 最小侵入的插件设计建议

### 6.1 分层建议（推荐"两层半"，不要照搬 session-query 的三包）

```
┌─────────────────────────────────────────────────────────┐
│ L3 可选：Web UI（client plugin + Remote）                │  ← 不建议第一版做
├─────────────────────────────────────────────────────────┤
│ L2 工具层  dsh-tool-session-*  （本插件唯一的真实工作量） │  ← 必做
│    defineTool × N + systemPrompt.section + 授权 + 错误边界│
├─────────────────────────────────────────────────────────┤
│ L1 可选：服务层  ctx.sessionBus                          │  ← 只有"多插件复用/Web UI 直连"才需要
│    封装 agents+subagents+agentPresets，带 handle 注册表   │
├─────────────────────────────────────────────────────────┤
│ L0 复用（不写代码）  ctx.sessions / ctx.agents /         │
│    ctx.subagents / ctx.agentPresets / ctx.workspaceRegistry│
└─────────────────────────────────────────────────────────┘
```

**理由**：session-query 之所以是三包，是因为它要"可替换的后端（SQLite FTS5）"。本工具集**没有可替换后端**——`ctx.agents` 就是唯一实现。硬拆三层只会多出两个包和一次 `ctx.get()`。**建议单包 + 两个 subpath 入口**（`"./tool"` 必须，`"./service"` 仅在真的抽了 L1 时才加），L1 服务用 `ctx.effect()` 管 handle 生命周期。

### 6.2 工具集命名建议

**必须避开 root 层已占用的名字**：`send_message`、`interrupt_agent`、`list_agents`（`dsh-base` 行 `tool-subagent-control` / `tool-subagent-list-agents`）。

| 能力 | 建议工具名 | 理由 |
|---|---|---|
| 建会话 | `session_create` | 中性、与 `subagent`/`spawn_teammate` 区分；`create_session` 亦可，但 `session_*` 前缀与官方 `session_search`/`session_trace` 一族一致 |
| 列会话 | `session_list` | 避开 `list_agents` |
| 发消息 | `session_send` | **避开 `send_message`**（同层重名会注册失败）。若要复用 `send_message` 语义，必须像 `agent-team-profile` 那样先 `disabled: true` 掉 base 行——**不推荐**（会影响 subagent 工具链） |
| 等待 | `session_wait` | 对齐 team 的 `wait_agent` 语义但不同名 |
| 检查 | `session_inspect` / `session_trace`(已占) | 用 `session_inspect` |

> 备选：把工具名做成 `Config` 字段（官方 `tool-subagent` 的 `toolName` 就是先例），部署可自行改名避冲突。**建议默认值固定 + 提供 `toolNamePrefix` 配置。**

### 6.3 配置建议（`Config` 字段草案）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabledTools` | `['session_create','session_list','session_send','session_wait','session_inspect']` | 让部署能裁剪（官方 `tool-session-query` 用 `maxSearchResults` 这类"参数配置"而非开关，参考其风格） |
| `defaultPreset` | `undefined` = 用 `ctx.agentPresets.defaultId` | 新建会话的 preset；**没有 roster 时自动退化为 global 平面** |
| `allowRootSessionCreation` | `false` | 是否允许建**顶层**会话（否则只允许建自己的子会话） |
| `inheritCwdOnly` | `true` | 新会话 cwd 强制等于调用方 `header.cwd`，不接受模型传 cwd |
| `maxChildSessions` | `8` | 防失控（对齐 team 的 `maxMembers: 8`） |
| `maxSendBytes` | `65536` | 对齐 team 的 `maxMessageBytes` |
| `waitTimeoutMs` | `30000` | 对齐 `tool-session-query` 的 `searchTimeoutMs` |
| `authorizeByWorkspace` | `true` | 跨会话操作要求 `cwd` 严格相等（复用 §5.3 规则） |

### 6.4 权限建议

1. **身份只从 `exec.agent` 取**，`cwd`/`session_id`/`preset` 一律由调用方会话派生，**永不让模型自由指定 cwd**（除非 `allowRootSessionCreation` 显式打开）。
2. **建会话**：`sessionId = brandString<SessionId>('session-' + randomUUID())`；`meta: { cwd: caller.header.cwd, agentPreset }`；`setup: (agentCtx) => presets.mount(agentCtx, presetId)`。
3. **发消息**：先做授权（`headerAuthorized`），再走 `ctx.subagents.sendMessage(...)` **或** `agent.steer()/followup()`。注意 `ctx.subagents.sendMessage` 会**自己**校验 sender/target 是否相邻——若目标不是自己的 continuable child，它会抛 `UNAUTHORIZED`。**因此"任意会话通信"不能只靠 `ctx.subagents`，必须自己实现**（用 `ctx.agents.get(id)?.followup(...)`），并自己承担授权与去重。
4. **破坏性操作**（关闭/中断别人）建议走 `tools/pre-execute` 的 `ask` 决策，而不是在工具里硬编码。
5. **持有可能泄漏的东西必须登记**：`ctx.agents.create()` 返回的 `AgentHandle` 只有持有者能 dispose。用一个 `Map<SessionId, AgentHandle>` + `ctx.effect(() => () => disposeAll())` 收尾，否则插件卸载后 agent 会泄漏到进程结束。

### 6.5 组合与安装建议

`cordis.patch.yml`（保持骨架现状，按需扩行）：

```yaml
- insert:
    - id: session-tools
      name: 'dsh-plugin-session-history'            # 单入口
      config:
        defaultPreset: standard
        allowRootSessionCreation: true
```

- **不要**在 patch 里 `disabled: true` 掉 `tool-subagent-control`（会破坏 subagent 工具链），改用 `session_*` 前缀避让。
- `package.json` 必须有 `dsh.bundle.patch`（已有）+ `files` 含 `lib/index.js`、`cordis.patch.yml`。
- 若要有 Web 卡片/面板：client plugin 放 `./client` 入口，Host 侧加 Remote；**第一版不建议做**——`pluginInventory` 已能给"已加载/active"的可观测性。

### 6.6 依赖与版本策略（实测，容易翻车）

| 事实 | 影响 |
|---|---|
| 官方包**已发布** npm，但 `latest` dist-tag 停在 **`0.0.1-rc.1`**（`next: 0.2.1-rc.5`，`alpha: 0.2.2-alpha.2`） | 永远不要写裸 `npm i @deepseek-ai/dsh-tools` |
| 本地 checkout 是 `0.1.3-alpha.1`，**该版本未发布**（npm 上是 `0.1.3-alpha.2` 起） | 不能 `pnpm add @deepseek-ai/dsh-tools@0.1.3-alpha.1` |
| 官方包互相用 `peerDependencies: ^0.1.3-alpha.2` | 抄这个范围最安全 |
| **prerelease 语义坑**：`^0.1.3-alpha.2` 匹配 `0.1.3-alpha.x` / `0.1.3` / `0.1.4`，**不匹配** `0.1.5-alpha.1`、`0.2.0-rc.1`、`0.2.2-alpha.2` | 若目标部署可能是 0.1.5+/0.2.x，peer 范围要写 union：`>=0.1.3-alpha.2 <0.1.4 \|\| >=0.1.5-alpha.1 <0.2.0-0 \|\| ...`，或者只把 `dsh-tools` 等放 `devDependencies`（**只用 `import type`**） |
| **不引任何官方运行时依赖的可行路径**：`ctx.tools.register(<原始 JSON Schema ToolDefinition>)` | 官方文档明说支持；`import type` 在编译期擦除 → 装到任何 0.1.x/0.2.x 都不容易炸。**建议本插件走这条路**，把 `@deepseek-ai/dsh-tools` 只作为 devDependency 取类型 |

> ⚠️ 待确认：本机实际运行的 DSH（`.../app.asar/dsh/`）内部版本号未能读取（asar 未解包），**发布前需要核对运行时版本线与 peer 范围是否匹配**。见 §8。

### 6.7 验收 / 测试建议

1. **组装测试**：把插件挂进一个最小 cordis 组合（`session` + `agent` + `agent-loop` + `tools` + `system-prompt`），断言 `ctx.tools.schemas()` 里出现全部工具名。
2. **授权测试**：调用方 `cwd` 为 A，目标会话 `cwd` 为 B → 必须 `UNAUTHORIZED`，且错误文本不泄漏目标存在性。
3. **建会话测试**：无 roster / 有 roster 两条路径；有 roster 时断言新 agent 的 `agentPreset` 投影正确、且 `standard` 的工具对其可见。
4. **泄漏测试**：卸载插件后 `ctx.agents.list()` 不应残留本插件创建的 agent（或按设计保留但要写明）。
5. **重名测试**：与 `dsh-base` 同时装载，断言根层注册不冲突。

---

## 7. 关键风险与坑（按严重度排序）

| # | 风险 | 事实依据 | 规避 |
|---|---|---|---|
| 1 | **工具重名注册直接失败** | `ctx.tools.register` JSDoc：同层重复名 fail | 用 `session_*` 前缀，不碰 `send_message`/`interrupt_agent`/`list_agents` |
| 2 | **建出"裸 agent"**：在 Web 部署里新会话没有 bash/fs/subagent | `agent-presets` 是第三平面，模型侧工具在 preset 里 | `setup` 里 `presets.mount(agentCtx, id)`；抄 `composeAgent()` |
| 3 | **新会话不出现在 Web 侧栏** | api 层 create 还会 `workspace.attachSession(sessionId)` | 若走 `ctx.agents.create` 直建，需额外 attach workspace（或验证侧栏是否按 cwd 索引）——**待实测** |
| 4 | **peer 版本范围匹配不到 alpha 线** | §6.6 实测 | 只用 `import type` + devDependency；或写 union 范围 |
| 5 | **prompt 段没有官方槽位** | `SECTION_ORDERS` 是封闭 `as const` 表 | 复用 `TOOL_SUBAGENT` 等既有 key；`name` 保持全局唯一 |
| 6 | **`ctx.agents.create` 需要 agent factory** | 未装 `dsh-agent-loop` 时抛 `no agent factory registered (load an agent-loop plugin)` | `inject: ['agents']` 不保证 factory 存在；捕获并映射成模型可行动的错误 |
| 7 | **`ctx.subagents.sendMessage` 自带相邻性校验** | 源码 `UNAUTHORIZED`（`packages/subagent/subagent/src/continuation.ts:583-595`） | 通用通信自理：`ctx.agents.get(id)` + `followup/steer` + 自己的授权 |
| 8 | **AgentHandle 泄漏** | handle 是"只有持有者能拆"的 capability | `Map` + `ctx.effect` 统一 dispose |
| 9 | **工具目录变化影响 KV cache** | 官方多处强调"tool catalog 稳定" | 目录注册一次、不做按调用动态增删；变化时依赖 `tools/change` |
| 10 | **同名工具三套语义**（`send_message` 在 base 与 team 里同名不同实现） | `agent-team-profile` 用 `disabled: true` 硬替换 | 我们**不**学这套，用独立命名 |

---

## 8. 未决问题（需要 Lead / 用户拍板）

1. **运行时版本对齐**：本机 GUI 的实际 `@deepseek-ai/dsh-*` 内部版本未能读取（`app.asar` 未解包）。是否需要在发布前解包核对？这直接决定 §6.6 的 peer 范围。
2. **是否要做"跨 lineage 任意会话通信"**：这是唯一必须**绕开** `ctx.subagents` 自己实现的部分（授权 + 唤醒语义 + 去重都要自建）。若只做"父子会话"，可以直接薄封装 `ctx.subagents.sendMessage`，工作量差一个数量级。
3. **是否需要 Web UI**：建议第一版不做（`pluginInventory` 已提供可观测性），第二版再考虑侧栏/面板。
4. **是否复用 team 语义**（Lead/teammate/mailbox/task）还是重造一套中性的 session bus。团队域已有持久 mailbox 与 `wait_agent`，重造会重复实现去重与恢复语义。

---

## 9. 关键路径索引

### 文档

| 主题 | 路径 |
|---|---|
| 第一个插件 / 插件三形态 / `inject` / `ctx.effect` | `docs/user/develop/basic/index.zh.md` |
| 开发一个工具（`defineTool` 最小例） | `docs/user/develop/basic/tool.zh.md` |
| 插件配置（Schemastery / 设计原则） | `docs/user/develop/basic/config.zh.md` |
| 打包安装（bundle / profile / 层顺序 / git 安装坑） | `docs/user/develop/basic/publish.zh.md` |
| 服务与依赖 | `docs/user/develop/framework/service.zh.md` |
| 事件模式（emit/bail/serial/waterfall） | `docs/user/develop/framework/events.zh.md` |
| 三角色能力分层（Definition/Provider/Consumer） | `docs/user/develop/practice/index.zh.md` |
| 工具编写参考（execute 契约 / 策略 / UI 卡片） | `docs/cookbook/adding-a-tool.zh.md` |
| 扩展模式总览 + 功能→机制映射表 | `docs/cookbook/extension-cookbook.zh.md` |
| 动态 Cordis 实战 | `docs/user/develop/practice/dynamic-cordis.zh.md` |
| 全部工具 schema（权威） | `docs/tool-catalog.zh.md`（包映射表在 `:16-45`） |
| 能力 seams 与服务归属图 | `docs/capability-seams.zh.md` |
| 动态插件子系统 API | `docs/subsystems/extensions.zh.md` |
| `ctx.tools` 完整 API | `docs/subsystems/tools.zh.md:480-578` |
| `ctx.agents` API | `docs/subsystems/core.zh.md`（`ctxagents--agentregistry` 生成块） |
| `ctx.agentPresets` API（`list/resolve/mount/compositionInventory`） | `docs/subsystems/core.zh.md:439`（`ctxagentpresets--agentpresets`） |
| 配置字段真源 | `docs/config-catalog.zh.md` |
| CLI / profile / `dsh plugin` | `apps/cli/reference/README.zh.md` |

### 源码

| 主题 | 路径 |
|---|---|
| 工具层模板（6 文件） | `packages/session-query/tool-session-query/src/{index,input,operations,workspace-access,service-boundary,presentation}.ts` |
| 最薄工具层范例 | `packages/subagent/tool-subagent-control/src/index.ts` |
| 建会话正确实现 | `packages/api/session-controller/src/agent.ts`（`composeAgent` / `ensureSession`） |
| 会话命令层（含 `session-${randomUUID()}` 与 workspace attach） | `packages/api/session-controller/src/commands.ts:82-116` |
| `ctx.sessions`（create/fork/flush） | `packages/core/session/src/index.ts:925` |
| `ctx.agents`（create/resume/get/list） | `packages/core/agent/src/index.ts:195-207,400-419,578-608` |
| `ctx.subagents`（startContinuable/sendMessage/list/interrupt） | `packages/subagent/subagent/src/index.ts:229-554` |
| 子 agent 创建（in-process spawn） | `packages/subagent/subagent-spawn-in-process/src/index.ts` + `subagent-in-process-driver` |
| 动态插件工具集 | `packages/extensions/tool-cordis/src/` + `cordis-host-runner/src/` |
| 只读 Loader 投影 | `packages/host/plugin-inventory/src/index.ts` |
| bundle 层定义（默认装载清单） | `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml` |
| agent preset 组合 | `packages/preset/agent-presets/presets/{standard,cordis,minimal,ptc}/agent.cordis.yml` |
| bundle + 覆盖既有行的范例 | `packages/experimental/agent-team-profile/{package.json,cordis.patch.yml}` |
| prompt 段封闭顺序表 | `packages/core/system-prompt/src/index.ts:120-139` |
| 工作目录骨架 | `C:\Code\session_history\{package.json,cordis.patch.yml,src/index.ts}` |

---

## 10. 一页纸回答用户

> **"DSH 官方有没有现成的、可复用的 session 创建/通信插件能力？"**
>
> **框架有、底座有、成品没有。**
>
> - **底座（服务层）官方已经做完**，而且做得很好：建会话 `ctx.agents.create` + preset 组装 `ctx.agentPresets.mount`，发消息 `ctx.subagents.sendMessage`，列子会话 `ctx.subagents.listChildren/listDescendants`，中断 `ctx.subagents.interrupt`。**这些都不用我们写，也别重写。**
> - **工具层只有"专用版"，没有"通用版"**：`subagent` 只会建"委派子任务"、`spawn_teammate` 只会建"团队成员"、`send_message` 只会发给"直接父子"。官方**没有任何工具叫 `create_session` / `list_sessions`**，也没有"按 session id 给任意会话发消息"的工具。
> - **所以必须自己写，但工作量很小**：一个 bundle 插件包，`cordis.patch.yml` 插一行，`apply()` 里注册 3~5 个 `defineTool` + 一个 prompt 段，授权抄 `tool-session-query/workspace-access.ts`，建会话抄 `session-controller/agent.ts#composeAgent`。**不改 DSH 源码、不碰用户 preset、`dsh plugin add` 一次装好。**
> - **唯一真需要新写的逻辑**是"任意会话通信"的授权与唤醒（因为 `ctx.subagents.sendMessage` 自带父子相邻性校验），以及"新会话挂上 preset/workspace"的组合细节。
