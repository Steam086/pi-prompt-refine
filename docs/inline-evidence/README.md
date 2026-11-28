# 快速预览实现与验收记录

实验分支 `t3/implement-inline-ui`，起点 `3319719ba320b5f25d400fbdc0281ee72df4c1f3`。输入规范的 SHA-256 为 `b78e33eb42e9c6860538beb7421828d07808f4b9eb04d2e7cde1460032e83956`。环境为锁文件中的 Pi coding-agent / tui 1.6.0、Node 24.18.0、tmux 3.7c、Alacritty 0.17.0。

## 焦点与宿主限制

在实现前，探针给 aboveEditor Widget 和一个底部 Overlay 分别安装了组件本地输入处理器。输入的 `original` 到达 Pi 编辑器。Overlay 收到了 Enter、方向键和 Esc。下一次调用快捷键读回 `original restored`。在 80×24 上，底部锚点上移三行正好盖住编辑器原文。完整屏幕和按键记录保存在 [focus-probe.txt](focus-probe.txt)，可在仓库根目录执行 `bash test/pty/focus-probe.sh` 复测。

Pi 1.6.0 的公开 TUI 提供 `setFocus(component)`、终端行列和 Overlay 所有权管理，缺少读取当前焦点组件及获取 editor/footer 组合边界的接口。多行编辑器、自定义编辑器和其他 Widget 均可改变底部布局。本实现按 §9.2 采用**居中专用预览 Overlay**。收起后使用原有单行 aboveEditor 状态 Widget。紧凑预览、Expanded、Revision、Workspace 和模型选择共用一次 `ctx.ui.custom` 生命周期。Pi 负责把焦点归还之前的组件。终端输入由聚焦组件接收。

同一 PTY 中的两个 Enter 都编码为 `\r`。为避免连续 Enter 在焦点切换时发送草稿，Ready 和 Expanded 使用 **`a Accept`**。Enter 在 Unsent 启动请求，回到 Pi 编辑器后沿用原生提交。紧凑预览使用最多 12 行及屏高 30% 的预算，Expanded 和高级子页使用原有的 75% 高度。居中 Overlay 会遮挡背后的内容，主聊天保留六行及正文与主输入同时完整可见均无宿主几何保证。

## 选择与数据边界

快捷键读取 Pi 展开的编辑器文本。新草稿在当前轮次创建并启动；精确匹配的原文、已接受候选和显式 Unsent 均可重新定位。Preferences 在捕获时冻结。显式 Unsent 及超过提交限制的初始偏好可先调整。重试沿用选定运行的输入和模型，比较与 Revision 使用各自的现有业务入口。Quick 接受调用 controller 的接受事务，覆盖确认同时固定当前记录版本和编辑器原文。确认开启新草稿时，先通过本地 createDraft 接口保住未捕获的文字。会话持久化、优化请求、主 Agent 发送和 RPC 协议沿用原有实现。[快捷键路由](../../src/app/commands.ts) · [事务与子页](../../src/app/quick-session.ts) · [阅读视口](../../src/quick-preview.ts)

## 离线复现

从此 worktree 根目录执行。首次安装可使用已缓存的 `npm ci --offline`。交互体验运行 **`bash test/pty/demo.sh`**，或加 `light` 切换浅色主题。输入 `Long fixture` 得到 60 段固定结果。默认体验使用 Pi 的原生编辑器。脚本创建临时工作目录、HOME 和 agent 目录，以清洁环境启动 Pi，并注册进程内 fixture provider。主 Agent 的显式提交也由该 fixture 回答。

```sh
npm run typecheck
npm test
npm run check:pack
bash test/pty/quick-smoke.sh "$(mktemp -d)" dark
bash test/pty/quick-smoke.sh "$(mktemp -d)" light
```

最后两项在真实 Pi 进程中额外加载委托给 Pi CustomEditor 的测试编辑器，记录事件并驱动宿主 selector、另一扩展的 Overlay、原生提交、窗口 resize 及 bracketed paste。每次运行观测到四次 fixture stream（短稿、主 Agent 的明确提交、长稿、多行粘贴各一次），一次用户 message_start。重复进入同一份多行草稿沿用了第一次捕获。详见 [dark 事件记录](dark/events.txt) 和 [light 事件记录](light/events.txt)。

根目录没有 lint 脚本。TypeScript、Vitest、包内容检查和 `git diff --check` 均已执行。完整套件中 1,433 个测试通过；35 个真实供应商或 benchmark 用例按项目 opt-in 配置跳过。打包检查覆盖 77 个文件，fixture、会话数据及截图均在发布包之外。

## 终端截图

PNG 取自独立虚拟显示器上的实际 Alacritty 客户窗口。客户端通过 UTF-8 tmux 连接隔离 Pi。各 PNG 的同名 txt 是 tmux 屏幕文本。复现场景用上面的 smoke 脚本；如需重新拍摄 PNG，可设置 `REFINE_CAPTURE_HOOK` 为本地截图程序，三个参数依次为 tmux socket、目标 PNG 路径和主题。现有截图用 Alacritty 连接对应 socket 后以 ImageMagick 抓取 Xwayland 客户窗口。

| 状态 | Dark | Light |
| --- | --- | --- |
| 无任务、编辑器焦点 | [PNG](dark/hidden.png) | [PNG](light/hidden.png) |
| 后台运行 | [PNG](dark/background.png) | [PNG](light/background.png) |
| Ready、Refine 焦点 | [PNG](dark/short.png) | [PNG](light/short.png) |
| 接受后、编辑器焦点 | [PNG](dark/accepted.png) | [PNG](light/accepted.png) |
| 长结果 / 翻页 | [初始](dark/long.png) · [翻页](dark/scrolled.png) | [初始](light/long.png) · [翻页](light/scrolled.png) |
| Expanded / Revision | [展开](dark/expanded.png) · [修订](dark/revision.png) | [展开](light/expanded.png) · [修订](light/revision.png) |
| 80×24 / 160×50 / 240×60 | [80](dark/ready-80x24.png) · [160](dark/ready-160x50.png) · [240](dark/ready-240x60.png) | [80](light/ready-80x24.png) · [160](light/ready-160x50.png) · [240](light/ready-240x60.png) |
| 48×18 / 40×12 | [48](dark/ready-48x18.png) · [40](dark/ready-40x12.png) | [48](light/ready-48x18.png) · [40](light/ready-40x12.png) |

初始尺寸为 120×40。启用 Pi 硬件光标后，编辑器和 Revision 的 tmux cursor flag 为 1，阅读态为 0。Pi 自己仍会在失焦 editor 上绘制反显字符格，截图可以看到。焦点身份以当前标题、边框、操作栏和实际输入路由辨别。[Dark 几何与光标](dark/geometry.txt) · [Light 几何与光标](light/geometry.txt)

## §10 验收对照

下表中的“自动化”使用 controller、真实应用入口或 renderer 加固定数据。“PTY”代表独立 Pi 进程。“人工”列出此实验仍需用户在其终端上判断的部分。

| 编号 | 已执行与证据 |
| --- | --- |
| K01 | 自动化、PTY。空白编辑器显示指定提示，调用数不变。 |
| K02–K04 | 自动化、PTY。新草稿保留原文，Running 收起重开只发一次请求，后台与可见完成场景分别追踪。 |
| K05–K06 | 自动化。A 完成时保持 B 和所选对象；A 在运行中仍可启动 B。PTY 验证退出运行视图后继续编辑。 |
| K07–K09 | 自动化、部分 PTY。核对原文、接受文本、编辑后文本的调用次数；展开的多行粘贴按包含首尾空白的完整文本重新命中。 |
| K10–K11 | PTY。连续 Enter 留在 Ready；a 接受，随后编辑器 Enter 才产生一次用户消息。 |
| K12–K13 | 自动化。默认保留、确认后恢复、确认期间原文变更、轮次结束和会话切换均有覆盖。 |
| K14–K16 | 自动化、部分 PTY。Esc 保留运行，x 只取消选定运行，晚到结果无效；r 重试原请求包，重复 r 不再启动。 |
| K17 | 自动化。仅在当前轮恢复有效目标，已接受并主动清空的单一任务保留在 Workspace。 |
| K18–K19 | 自动化。可恢复 Unsent 直接清空，未保存 B 默认保留；明确同意后先创建内存草稿，超限时保留 B。 |
| K20–K21 | PTY。字母输入、selector 的快捷键、Ready 连续 Enter、显式二次提交及编辑器归还；真实硬件长按与不同终端输入协议仍待人工核验。 |
| K22 | 自动化。tree、switch、fork 转场和 shutdown 释放视图并拒绝晚到结果；reload 通过既有生命周期套件。真实多终端转场仍待人工。 |
| K23 | PTY。自定义编辑器、宿主 selector 和从外部覆盖 Quick 的聚焦 Overlay。后者独占 Ctrl+反斜线、a、Enter 与 Esc，关闭后回到 Quick。 |
| K24 | 自动化。只显示前几行时接受完整的 100 行 Unicode 候选。Expanded 的结果备注为独立阅读内容。 |
| K25–K26 | 自动化、部分 PTY。验证 Revision 跨 Preferences、Esc、整体收起、再次打开及重复 Ctrl+S 的来源、草稿和请求数。PTY 捕获真实 Revision 焦点。 |
| K27–K28 | 自动化、部分 PTY。长文翻页、展开、缩放；Expanded 进入 Workspace 后回到原候选，单独 /refine 回编辑器。 |
| K29–K30 | 自动化、部分 PTY。message_start 归档后相同文本可新建；提交、历史、冻结上下文、application 和 RPC 走原有回归套件。 |
| V01–V03 | PTY。无任务零行、后台一行、Overlay 单焦点及真实光标。V02 采用 §9.2 最后一级降级，未实现 in-flow。 |
| V04–V06 | 自动化、PTY。逐尺寸校验高度、短结果锁高、换候选、独立滚动锚点、分页／首尾及主动展开。 |
| V07–V09 | 自动化、PTY。两套主题、六组尺寸；renderer 额外覆盖控制字符、Tab、长 URL、组合字符、Emoji 和宽字符。Expanded 只有当前阅读内容。字体替换、字形、IME 及主观对比度待人工。 |
| V10–V12 | 自动化、PTY。单行中性快捷键说明、后台就绪、单个 Refine 区域和其他扩展抢占。宿主有显式 view 快捷键时继续显示该 view 提示。 |

[快速事务回归](../../test/integration/quick-preview.test.ts) · [选择与几何回归](../../test/renderer/quick-preview.test.ts) · [编辑器动作](../../test/integration/extension-editor-actions.test.ts) · [轮次](../../test/integration/extension-rounds.test.ts) · [应用及 RPC 检查](../testing.md)

最终视觉验收留给用户。未在物理键盘、IME、真实鼠标和所有自定义补全扩展组合上逐项实测。Quick 阅读由键盘滚动，宿主负责其他区域的鼠标和原生补全。长输入仍可能在居中 Overlay 后方；窄屏会省略次要元数据及部分操作提示，完整按键可通过 `?` 查看。
