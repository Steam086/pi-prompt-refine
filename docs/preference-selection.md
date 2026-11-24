# Preferences：检查选择与保存新条目

在 Preview／Usage 按 `p` 打开完整面板，可浏览及管理库。选择只对可编辑 Unsent 和显式 Revise 开放。保存库、浏览和勾选均不会请求模型或写 Pi 编辑器。

## 项目默认与单次选择

在 Library 高亮条目后按 `g` 切换项目默认，`*` 标记已开启。两种库的条目都能加入当前目录的默认组。更改立即保存，从之后的新建或复制原稿生效。已有草稿、重试和 Revise 保持自己的选择。

Space 逐项取消，`c` 清空本次选择（包括被筛选隐藏的项）。完整面板需带回后生效。项目默认正文会随提交发送，可在运行前移除。选择使用快照，后续库写入不会改变已提交要求。

## 任务要求如何融入 prompt

`rewrite` 调整改写方式，例如翻译草稿。 `task` 补充主 Agent 的回答或行为要求，例如要求英文回答。Refine 会把适用且兼容的任务要求融入完整草稿，保留原任务与授权边界。当前明确的用户要求优先于冲突的复用项。[改写协议](context.md#请求与输出)

## Preview 内联选择（Unsent）

1. 选中有完整背景的 Unsent 原稿，按 Tab 聚焦偏好，Space 即时更新该原稿的选择。
2. 用 `/` 搜索、`o` 阅读高亮项全文。搜索和全文中的 Enter 不提交。Esc 从全文回到选择。
3. 在选择列表按 Enter 启动优化，或按 Esc／Tab 返回原稿列表，保留已选项。Usage 的 Unsent 可通过完整面板选择。

## 完整面板：All 与 Selected only

在 Revise 按 Alt+P，或 Tab 到 Preferences 再按 Enter。Space 暂存选择，Alt+Enter 带回，Esc 放弃暂存选择。已经完成的库写入会保留。返回原稿按 Enter 或返回 Revise 按 Ctrl+S 才提交模型请求。在 Revise 可先打开 **Review full requirements** 检查组合要求。

在 Library 或 Actions 按 `s` 切换 **All**／**Selected only**。后者从空搜索开始，按提交顺序展示已选快照，方便发现被筛选隐藏的项目。搜索匹配名称、描述和正文。Enter 可核对 **Selected snapshot** 和 **Current library entry**，库发生变更时要先取消再勾选才能采用新版。[搜索与排序回归](../test/unit/revision-preferences.test.ts) · [快照回归](../test/ui/preference-panel-audit.test.ts)

## 新条目保存后定位

用 **Add** 创建、**Edit** 修改、**Delete** 删除。Add 可以带入本次自由输入，保存后面板会尽量定位新条目，需显式勾选才使用。保存失败可修正表单后再试；外部写入冲突时刷新后重试。跨作用域复用可复制正文，再到目标作用域 Add。

## 库文件与旧版兼容

全局库位于 Pi agent 目录的 `prompt-refine-preferences.json`，项目库位于当前工作目录的 `.pi/prompt-refine-preferences.json`。项目默认列表单独保存在 `.pi/prompt-refine-preference-defaults.json`，可引用任一库。库与会话历史独立。

首次加载 TUI 时，没有全局库文件才会从[随包示例](../examples/prompt-refine-preferences.json)初始化。示例只翻译草稿，需手动选用。删除单个示例或保存空库后不会补回。旧版带自动匹配的有效条目按手动项读取，只有对库的显式写入才保存归一化格式。[库实现](../src/preference-store.ts) · [迁移回归](../test/unit/preference-store.test.ts)
