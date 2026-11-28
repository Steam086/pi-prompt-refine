# Pi Prompt Refine

[English](README.md)

Pi Prompt Refine 是 Pi Coding Agent 的提示词改写扩展。发给主 Agent 前，先用单独选择的模型结合当前对话整理草稿，再检查、修改或挑选合适的结果。

## 主要功能

- **结合上下文改写。** 根据当前对话补清指代、理顺表达，保留原意和约束。
- **单独选择改写模型。** 从 Pi 已配置的模型中挑选，主 Agent 继续使用自己的模型。
- **对比多个模型。** 用同一份草稿和上下文并行试跑，比较改写结果和耗时。
- **继续修订。** 给已有结果补充要求，例如「再短一点，命令原样保留」。
- **复用 Preferences。** 把常用要求存为偏好，下次改写时直接选用。

## 安装

使用 [Pi Coding Agent](https://pi.dev/) 的交互式终端界面，并在 Pi 中配置可用模型。Refine 需要 **Node.js 22.19+**，已在 **Pi 1.6.0** 上验证。

```sh
pi install npm:pi-prompt-refine
```

安装后启动 Pi，或在已打开的 Pi 会话中执行 `/reload`。

## 快速开始

1. 在 Pi 中执行 `/refine model`，选择改写模型。
2. 在 Pi 输入框写下草稿，例如「看看刚才说的错误处理，先给改进建议，别改代码。」
3. 按 `Ctrl+\` 开始改写并打开快速预览。如果当前轮次已有匹配结果，同一快捷键会重新打开该结果。按 `v` 展开全文，按 `w` 进入工作台。
4. 检查已完成的结果，按 `a` 将选中的改写放回 Pi 输入框。你可以继续编辑，准备好后再自行发送。

## 常用命令

| 命令或按键 | 用途 |
| --- | --- |
| `/refine` | 打开 Refine 工作台，无需调用模型。 |
| `/refine optimize <文本>` | 快捷键不可用时，直接请求改写。 |
| Refine 中的 `?` | 查看当前选中项可用的快捷键。 |

## 使用须知

- **费用。** 改写是一次单独的模型请求，可能消耗额度或产生费用。
- **隐私。** 改写服务商会收到草稿、已提交的编辑要求和启用的上下文，默认包含选取的近期对话。[了解数据范围和上下文设置。](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/configuration.md#预算与上下文开关)
- **本地历史。** 如果 Pi 会话有对应文件，Refine 默认会在其旁边保存已提交的草稿、改写结果和编辑要求。[查看保存范围和清理方法。](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/usage.md#记录范围与用量)

## 详细文档

- [使用说明](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/usage.md)
- [配置参考](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/configuration.md)
- [Preferences 选择与保存](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/preference-selection.md)
- [快捷键排查](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/usage.md#快捷键无响应)
