# 项目架构

Pi Prompt Refine 是 TypeScript 编写的 Pi 扩展，入口由 `package.json` 的 `pi.extensions` 指向 `src/extension.ts`。它是后台文本改写器，不是执行任务的 Agent。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/extension.ts` | 注册命令、快捷键和生命周期事件；连接 Pi UI、模型注册表、上下文收集与 controller |
| `src/controller.ts` | 管理冻结上下文 round、未发送输入、并行运行与排队、独立 Apply 目标、接受快照及恢复状态；处理去重、取消、超时、发送归档和过期操作 |
| `src/history.ts`、`history-store.ts`、`task-panel.ts` | 有界日志、每 session 最小白名单 sidecar 与原稿／模型运行两层树；Preview 默认仅当前轮次，Usage 按新旧轮次堆叠全部记录，已打开目标归档后保留阅读直至显式返回；支持详情、比较与接受；恢复记录不含完整背景，禁止原背景重跑，不自动进入模型上下文 |
| `src/context.ts` | 选择可见历史，构造固定协议与编辑策略、JSON 输入，校验模型输出 |
| `src/project-context.ts` | 提取宿主项目规则和技能元数据，收集有界目录列表并标注遗漏 |
| `src/config.ts` | 配置校验、默认值、迁移及持久化 |
| `src/workspace.ts`、`preview.ts`、`prompt-input.ts` | Main / Context / Input 工作区、候选阅读和独立输入 |
| `src/background-status.ts`、`presentation.ts`、`panel-layout.ts`、`key-hints.ts` | 后台状态与已查看提醒、展示格式、布局和按键提示 |
| `src/revision-preferences.ts`、`preference-store.ts`、`preference-panel.ts`、`inline-preferences.ts` | 手动要求的快照与确定性组合、并发安全库、独立选择与管理子页，以及 Preview 的 Unsent 内联勾选；内联 Space 直接更新当前原稿、Enter 显式开始优化，子页仍需显式带回；勾选／阅读／管理不请求模型，Unsent 原稿或内联选择状态的 Enter／Revise 的 Ctrl+S 才提交 |
| `src/model-picker.ts`、`usage.ts` | 模型选项展示、响应 token 口径归一化与请求时 SDK 参考费用 |

## 数据流与验证

round 首份输入捕获系统模板、历史与项目资源，同 round 多份草稿共用冻结背景；每个运行通过扩展适配器调用 Pi `streamSimple()` 发起一次无工具请求。有效 JSON 输出成为候选，Apply 只切换 Refine 当前结果，接受或明确发送才影响 Pi 编辑器/会话。Pi 用户消息开始后自动归档旧 round，下一份输入才捕获新背景。

`test/` 使用 Vitest 覆盖纯逻辑、模拟 Pi/Provider 的生命周期与交互，以及实际 TUI 组件和渲染器。检查命令：`npm run typecheck`、`npm test`。

当前行为见 [README](README.md) 和 `docs/`；长期设计取舍、待验证问题与演进方向见 [DESIGN](DESIGN.md)。

## TUI and interface conventions

- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Reuse `panelLayout` / `panelFrame`, the shared workspace tabs, and the single native overlay shell in `workspace-overlay.ts`. The workspace uses terminal-sized stable geometry (98% width / 96% height), not initial-content measurement or reading expansion. Keep child pages in the same shell and bounded centered canvas; scroll content rather than growing or stacking panels.
- Use `src/key-hints.ts` for keyboard hints: keys use neutral `text` color and bold weight; descriptions use regular `muted` text. Use ANSI-aware aligned/fitting helpers, omit whole secondary hints when space is limited, and preserve the same styling in compact and single-line footers. Prioritize Back/Cancel and the relevant primary action.
- Do not use function-key shortcuts (F1, F2, F3, etc.), including modified variants. Use ordinary keys outside text inputs or non-function modified keys, and check conflicts with Pi bindings. Keep text-entry keys isolated from navigation and management actions.
- Keep Preferences management limited to three visible actions: Add, Edit, and Delete. Tab switches between Search, Library, and Actions, not between hidden menu items. Preserve explicit selection/bring-back and save/confirmation boundaries; cache filtering and long-document wrapping so focus changes do not repeat library I/O or expensive layout.
- Use semantic theme tokens, not hard-coded colors. Headings use neutral `text` plus bold; secondary metadata uses `muted`; status and warning colors retain their semantic meaning. Support both light and dark themes.
- In Prompt details, emphasize page/section headings, the selected run identity, the active tab, and operation keys with neutral `text` plus bold. Keep auxiliary labels, navigation descriptions, inactive tabs, run metadata (including duration), revision provenance, and separators regular-weight `muted`. Keep result, original prompt, and revision-instruction bodies regular-weight `text`, including literal Markdown; reference content must remain readable rather than being dimmed wholesale. Do not repeat the selected identity's emphasis in the compact model summary, or give Accept/Send special emphasis over other actions. Preserve semantic colors for status/warning markers; “muted” always means the theme token, never a hard-coded light gray.
- In Revise, distinguish the action heading from source run/model metadata: use neutral `text` plus bold for the heading and regular-weight `muted` for appended source metadata; do not bold the entire concatenated header. Keep explanatory copy regular-weight `muted` and literal requirements regular-weight `text`. Focused controls may use neutral bold text and a selected background to indicate focus, not extra action importance.
- Give load/save/validation failures and over-limit states an appropriate semantic warning/error treatment, distinct from routine notices. Style warning/error markers independently of adjacent success or progress text so they cannot inherit a misleading color. Keep actionable failure feedback visible in short/narrow layouts rather than silently losing it when header rows are reduced.
- Measure terminal columns with Pi TUI helpers (`visibleWidth`, `truncateToWidth`, and ANSI-aware wrapping), not string length. Sanitize external text before styling; never sanitize already-styled UI chrome, which would remove or corrupt its ANSI formatting.
- Each view has one horizontal split owner. The task browser already splits the tree and summary; do not split that summary again. Only the result details opened with Enter use the approximately 65/35 result/reference layout. Compare owns its separate two-result layout. Narrow details switch between result and reference with `o`; keep reading positions separate and never change the selected action target when switching reading focus.
- Keep result Preview focused on the result and its references. Do not embed persistent Usage, Settings, or full Preferences management panels. Only editable Unsent originals expose a lightweight preference checklist below the original when inactive. While choosing on wide screens, temporarily reuse the task-tree column for preferences and keep a bounded original preview, the highlighted preference description and literal instructions, plus bounded selected-name feedback on the right; the feedback adds no focus. Narrow screens prioritize a full-width checklist, and o reads the full preference across the content area. Direct Space updates are per-original and never submit; Tab enters preference selection directly, Esc/Tab (including Shift+Tab) return to tasks without changing selections, and Enter explicitly starts optimization. Keep Back and Optimize key hints prominent, concise and visible in short layouts. Search/full-text views consume Enter and Tab without submitting or leaving their state; the full child panel retains explicit bring-back/cancel boundaries. Retain explicit navigation to those views and the existing compact run summary.
- Hints must describe the action at the current focus. Retained source-view hints must not advertise actions suspended by the Revise editor; Revise's Editor only / Show source hints must reflect the available internal layout transition, never advertise outer-window expansion. Browsing, selecting, bringing back preferences, and saving library entries never submit a revision; only Ctrl+S back in Revise does. Preserve editor focus, candidate/session guards, explicit save/confirm boundaries, and input-event consumption across child pages.
- Test changed views in both themes, at narrow/short and wide sizes, with ANSI and wide Unicode text, resize, focus changes, scrolling, and confirmation flows. Assert actual styled output as well as visible text and bounds. Keep regular/fullscreen renderer coverage; automated terminal capture is not a substitute for human visual or IME validation.
