# 跨会话消息的 Chat 呈现：从折叠上下文行到用户气泡

> 决策记录（2026-11-14）。运行时依据：DSH 0.2.2-rc.3（Desktop 安装包）。
> 相关实现：`src/client/`；Host 侧消息构造见 `src/domain/message.ts`。

## 0. 问题

插件把消息作为普通 `user/message` 投进目标会话，但 `source.kind` 不是 `'user'`。
DSH 内置的 `input-message` Conversation 定义会把这类消息归为 `context`，Chat 用
**折叠的「上下文注入」行**呈现：标题是「上下文注入 / 跨会话消息 · <发送方> · <摘要>」，
正文要点开才看得到，而且展开后仍带着给模型看的来源框架：

```text
Session message 54ba652e-db08-4ec0-a684-596cedc9819b from 前端联调 (session-...):
接口改完了，麻烦重跑一下 e2e
```

结果就是「看起来像系统噪声、正文被折叠、UUID 占满一行」。目标：让它**和用户主动发送的
消息同形**（右对齐气泡、同样的字号/行高/圆角/宽度上限），**换一种颜色**区分来源，并且
**点击气泡跳到发送方会话**。

## 1. 可选扩展点与取舍

| 扩展点 | 能做什么 | 为什么不够 / 被选 |
|---|---|---|
| `conversation.chat.user.before`（chain） | 在用户气泡**上方**加一条来源装饰 | 气泡仍由内置定义渲染成折叠的 context 行，正文依旧看不到 |
| 替换 `conversation.chat.user.content` Factory | 换掉用户消息的正文栈 | 单例 Factory，拿不到 `source`，会影响所有用户消息 |
| 替换 `conversation.chat.node` 的 `user` 键 | 完全接管用户消息渲染器 | 会覆盖**所有**用户消息（附件、图片、引用、反馈动作都要自己重做），回归面太大 |
| **新增 Conversation 定义并 `exclusive` 认领** | 只接管本插件的消息，生成新 kind + 自己的渲染器 | **采用**：影响面最小，且是 DSH 为「非内置消息来源」预留的正规路径 |

`exclusive` 的语义来自 `ui-conversation` 的 assembler：一次事件的所有 match 先收集、再解析
claim，同一 target 只允许一个 claim；有 claim 时其它 Definition 不再收到该事件。因此不依赖
注册顺序，也不需要改动 Chat 的排序逻辑。

## 2. 决策

1. **在 `user/message` 上按 `source.kind === 'session-message'` 独占认领**，内置
   `input-message` 不再处理这些事件；`session-message/notice`（插件提示）不认领，继续走
   `context` 行。
2. **新渲染器 kind 为 `session-message`**，通过 `conversation.chat.node` 键控插槽注册。
3. **视图模型在客户端重新收敛**：`messageId` / `senderId` / `senderName` / `summary` 全部取自
   durable `source`；正文用 `frameOf()` 精确重建来源框架后剥离。重建失败就原样显示——宁可
   多一行，也不吞正文。
4. **分组位置与内置 notice 一致**：开启 Step 1 的消息放 `groupTree: 'input'`，中途 steer
   进来的消息留空（留在当前 step 流程里），两种情况都不从中间切开折叠区间。
5. **导航用 `ctx.uiWorkspace.openSession(senderId)`**，按可选服务处理：服务缺席时卡片退化为
   只读（不渲染「打开会话」、不显示手型光标），首次触发会 `console.warn` 一次；会话已被归档/
   删除时 `openSession` 未必报错，这属于 DSH 的导航语义，插件不额外猜测。
6. **表现层独立成 `src/client/`**：纯数据整理（`source.ts`）、事件定义（`definition.ts`）、
   React 组件（`SessionMessageView.tsx`）、样式（`styles.ts`）分离；不 import 任何
   `@deepseek-ai/dsh-*` 包，客户端契约在 `contract/` 本地声明（与 Host 侧 `types/` 同策略）。

## 3. 交互

- 点击气泡 → 打开发送方会话。单击延迟 300ms 才导航：双击选词时第二次点击会先取消它；
  选区锚点或焦点落在气泡内时不导航（选区在页面别处不阻止导航）。
- 键盘与读屏用户走来源行右侧的「打开会话」`<button>`；卡片本身不做 `role="button"`，否则
  读屏会把长正文吞成按钮名。窄视口（< 480px）下按钮只留箭头。
- 气泡下方是时间 + 图标式「复制」按钮：24px 热区、hover 底色、三态（复制/已复制/复制失败），
  状态经 `role="status" aria-live="polite"` 播报；剪贴板不可用时显示失败而不是静默。
- 时间格式复用 Chat 的 `clock.md` / `clock.ymd` 模板（中英各一份），非中英界面回退英文。
- 区分线索不只有颜色：左缘 3px 强调色竖条 + 来源行；底色混入 14% 强调色（hover 18%），
  描边用 inset `box-shadow` 而不是 `border`，因此盒尺寸与用户气泡完全一致。
- 强调色取 `--dsw-alias-button-info-fill`（品牌 alias），`color-mix()` 前有静态兜底；
  旧引擎失去底色差时仍有竖条。

## 4. 已知边界

- **pending inbox**：消息在 `agent/inbox/spliced` 但还没成为 durable `user/message` 时，Chat
  用内置的 pending steering 气泡渲染，长相与本卡片不同。这段时间通常只有一个 step 边界。
- **客户端模块清单按 Loader 条目重启重新读取**：改完 `lib/client.js` 后要重启 DSH，或在插件页
  把该组件关一次再开；单纯刷新页面不一定生效。本项目不跑浏览器自动化，`tests/client-bundle.test.ts`
  只保证产物形状与注册项正确，观感仍需人工确认。
- **不能改写入库正文**：来源框架是模型判断「谁发的」的唯一依据；剥离只发生在 UI。
- **语言**：客户端字典只有 `zh` / `en`；其它 UI 语言按 locale 的回退链显示英文。
- **文本选区**：正文带 `data-text-interaction-source`，与用户消息一样可被 DSH 的选区工具条
  （引用等）识别；这是有意与用户气泡对齐的行为。
