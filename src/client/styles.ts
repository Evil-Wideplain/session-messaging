/**
 * 跨会话消息卡片的样式表。
 *
 * 形状、字号、行高与 Chat 的用户气泡一致（同一套 `--dsh-content-font-*`、
 * `--dsw-specific-bubble`、`--dsw-radius-xl`），用两个不依赖颜色感知的线索区分
 * 来源：气泡左缘 3px 强调色竖条 + 顶部来源行；底色再淡淡混入强调色。
 *
 * 颜色全部走主题 token，明暗主题自动跟随。`color-mix()` 需要较新的 Chromium，
 * 因此每条用它的声明前面都有一条静态兜底（旧引擎下竖条仍然在，只是底色不变）。
 * 不用 `border` 画描边：用 inset `box-shadow` 保持与用户气泡完全相同的盒尺寸。
 *
 * 样式通过 `apply` 里的一个 `<style>` 元素安装并由 `ctx.effect` 卸载，不往组件
 * 树里塞重复样式，也不读宿主的 CSS Module 类名。
 *
 * @module session-messaging/client/styles
 */

/** 行布局：与 Chat 用户消息的 `userRow` + `userStack` 同一套几何。 */
const LAYOUT = `
.dsm-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.dsm-stack{--dsm-accent:var(--dsw-alias-button-info-fill,var(--dsw-static-blue-500,#3b82f6));display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%)}
`

/** 气泡本体；几何值对齐用户气泡，描边用 inset shadow 不改变盒尺寸。 */
const BUBBLE = `
.dsm-card{box-sizing:border-box;max-width:100%;padding:10px 16px;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word;text-align:left;transition:background 120ms ease,box-shadow 120ms ease}
.dsm-card[data-dsm-clickable]{cursor:pointer;background:var(--dsw-specific-bubble-highlight,var(--dsw-specific-bubble,transparent));background:color-mix(in srgb,var(--dsm-accent) 14%,var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2,transparent)));box-shadow:inset 3px 0 0 var(--dsm-accent),inset 0 0 0 1px var(--dsw-specific-bubble-highlight,transparent);box-shadow:inset 3px 0 0 var(--dsm-accent),inset 0 0 0 1px color-mix(in srgb,var(--dsm-accent) 45%,transparent)}
.dsm-card[data-dsm-clickable]:hover{background:color-mix(in srgb,var(--dsm-accent) 18%,var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2,transparent)));box-shadow:inset 3px 0 0 var(--dsm-accent),inset 0 0 0 1px color-mix(in srgb,var(--dsm-accent) 65%,transparent)}
`

/** 卡片内部的来源行、摘要与正文。 */
const CONTENT = `
.dsm-head{display:flex;align-items:center;gap:6px;min-width:0;min-height:calc(24px + var(--dsh-content-font-delta-secondary,0px));margin-bottom:2px;white-space:normal;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-secondary)}
.dsm-glyph{display:inline-flex;flex:none;color:var(--dsm-accent)}
.dsm-sender{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsm-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsm-open{display:inline-flex;flex:none;align-items:center;justify-content:center;gap:2px;margin-left:auto;appearance:none;border:0;background:none;padding:2px 4px;min-height:calc(24px + var(--dsh-content-font-delta-secondary,0px));min-width:calc(24px + var(--dsh-content-font-delta-secondary,0px));font:inherit;color:var(--dsm-accent);cursor:pointer;border-radius:var(--dsw-radius-xs,4px)}
@media (hover:hover){.dsm-open:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}}
.dsm-open:focus-visible{outline:2px solid var(--dsm-accent);outline-offset:1px}
@media (max-width: 480px){.dsm-open-text{display:none}}
.dsm-summary{margin:0 0 4px;white-space:normal;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary)}
.dsm-body{min-width:0}
`

/** 气泡下方的时间与操作行：与用户消息的时间行同位、同色，热区不小于 24px。 */
const ACTIONS = `
.dsm-actions{display:flex;align-items:center;gap:2px;min-height:calc(24px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary)}
.dsm-time{padding:0 2px}
.dsm-action{display:inline-flex;align-items:center;justify-content:center;width:calc(24px + var(--dsh-content-font-delta,0px));height:calc(24px + var(--dsh-content-font-delta,0px));appearance:none;border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer;border-radius:var(--dsw-radius-xs,4px)}
.dsm-action[data-state="copied"]{color:var(--dsw-alias-state-success-primary,currentColor)}
.dsm-action[data-state="failed"]{color:var(--dsw-alias-state-error-primary,currentColor)}
@media (hover:hover){.dsm-action:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-secondary)}}
.dsm-action:focus-visible{outline:2px solid var(--dsm-accent,var(--dsw-static-blue-500,#3b82f6));outline-offset:1px}
.dsm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`

/** 完整样式表。 */
export const STYLE_TEXT = [LAYOUT, BUBBLE, CONTENT, ACTIONS].join('')
