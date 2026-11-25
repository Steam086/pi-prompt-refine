# Preferences：检查选择与保存新条目

在 Preview／Usage 的可编辑 Unsent 原稿上按 `p` 打开选择器；在空工作区或其他原稿、运行上按 `p` 直接打开库管理，不能更改本次选择。保存库、浏览和勾选均不会请求模型或写 Pi 编辑器。

## 项目默认与单次选择

在库管理中高亮条目后按 `g` 切换项目默认，`*` 标记已开启。Project、Global 和 Built-in 条目都可设为当前目录的默认项。更改立即保存，从之后的新建或复制原稿生效。已有草稿、重试和 Revise 保持自己的选择。

Space 逐项取消，`c` 清空本次选择（包括被筛选隐藏的项）。更改立即生效，不修改项目默认。项目默认正文会随提交发送，可在运行前移除。选择使用快照，后续库写入不会改变已提交要求。

## 任务要求如何融入 prompt

`rewrite` 调整改写方式，例如翻译草稿。 `task` 补充主 Agent 的回答或行为要求，例如要求英文回答。Refine 会把适用且兼容的任务要求融入完整草稿，保留原任务与授权边界。当前明确的用户要求优先于冲突的复用项。[改写协议](context.md#请求与输出)

## Result notes

`result` 为本次运行生成只读附注。可选择内置的 **In Your Own Words**，查看模型如何理解原稿，也可用 **Add** 创建自定义 **Result notes**。对内置项使用 **Edit** 会预填可保存到项目或全局库的副本。

附注与改写共用一次模型调用和输出预算。附注按选择顺序显示在正文下方，标题来自所选快照。每项最多 2000 个 UTF-16 代码单元，遗漏、重复或无效的附注显示为不可用。接受、发送和手工编辑只取正文。在 Revise 中只请求附注时，保留来源正文。附注可在当前运行详情中查看。

## Preview 内联选择（Unsent）

1. 选中有完整背景的 Unsent 原稿，按 Tab 聚焦偏好，Space 即时更新该原稿的选择。
2. 用 `/` 搜索、`o` 阅读高亮项全文。搜索和全文中的 Enter 不提交。Esc 从全文回到选择。
3. 在选择列表按 Enter 启动优化，或按 Esc／Tab 返回原稿列表，保留已选项。Usage 的 Unsent 可通过完整面板选择。

来源显示为 Project、Global 或 Built-in，窄屏简写为 P、G 或 B。

## 完整面板：All 与 Selected only

在 Revise 按 Alt+P，或 Tab 到 Preferences 再按 Enter。在选择器中，Space 立即更新当前草稿，Enter 阅读全文，Esc 返回并保留选择。Tab 在搜索和列表间切换。按 `l` 进入库管理，Esc 回到选择器；库管理不改变已选快照。返回原稿按 Enter 或返回 Revise 按 Ctrl+S 才提交模型请求。在 Revise 可先打开 **Review full requirements** 检查组合要求。

在 Library 或 Actions 按 `s` 切换 **All**／**Selected only**。后者从空搜索开始，按提交顺序展示已选快照，方便发现被筛选隐藏的项目。搜索匹配名称、描述和正文。Enter 可核对 **Selected snapshot** 和 **Current library entry**，库发生变更时要先取消再勾选才能采用新版。[搜索与排序回归](../test/unit/revision-preferences.test.ts) · [快照回归](../test/ui/preference-panel-audit.test.ts)

## 新条目保存后定位

在库管理中用 `n` **Add** 创建、`e` **Edit** 修改、`d` **Delete** 删除。Add 可以带入本次自由输入，保存后面板会尽量定位新条目，需显式勾选才使用。保存失败可修正表单后再试；外部写入冲突时刷新后重试。跨作用域复用可复制正文，再到目标作用域 Add。

## 库文件与旧版兼容

全局库位于 Pi agent 目录的 `prompt-refine-preferences.json`，项目库位于当前工作目录的 `.pi/prompt-refine-preferences.json`。项目默认列表单独保存在 `.pi/prompt-refine-preference-defaults.json`，可引用项目、全局或内置条目。库与会话历史独立。

首次加载 TUI 时，没有全局库文件才会从[随包示例](../examples/prompt-refine-preferences.json)初始化。示例只翻译草稿，需手动选用。删除单个示例或保存空库后不会补回。旧版带自动匹配的有效条目按手动项读取，只有对库的显式写入才保存归一化格式。[库实现](../src/preference-store.ts) · [迁移回归](../test/unit/preference-store.test.ts)
