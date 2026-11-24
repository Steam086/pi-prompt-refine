# 快捷键无响应与命令备用入口

## 现在如何使用

在原生 Pi 中，用 `/refine` 打开工作台，或输入 `/refine optimize <文本>` 明确发起改写。命令可携带与保留字同名的原稿，例如 `/refine optimize model`。模型设置及结果操作见[使用说明](usage.md#命令备用入口)。

## 定位按键

1. 在发生问题的 Pi 会话运行 `/hotkeys`，确认绑定已加载、配置未禁用该键，且主编辑器有焦点。
2. 在直接终端和终端复用器中分别复测。若只有一条路径失败，比较实际按键序列和焦点状态，区分截获、协议转换和组件消费。
3. 在 Pi 中测试 Control+反斜杠。普通 shell 提示符可能将它解释为 SIGQUIT。

一次历史排查中，Pi TUI 1.4.0 同时接受传统字节 `0x1c` 和 Kitty 序列 `ESC[92;5u`。herdr 0.9.5 的解析也支持字节 28。由于当时缺少原始事件和焦点记录，未确定故障原因。 [herdr 解析源码](https://github.com/herdrdev/herdr/blob/v0.9.5/src/input/parse.rs)
