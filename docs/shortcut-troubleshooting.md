# 快捷键无响应与命令备用入口

## 本次 herdr 排查

检查了本机 herdr 0.9.5、Pi 1.4.0 和 Prompt Refine 的实现与配置：

- `~/.pi/agent/prompt-refine.json` 中 `shortcuts.optimize` 为 `ctrl+\\`，并已配置优化模型；不是快捷键被设为 `null`。
- `~/.config/herdr/config.toml` 仅有 `onboarding = false`，没有自定义按键覆盖。tmux 使用默认 `C-b` 前缀，查询绑定未发现 `C-\\`。这些检查不代表已排除宿主终端、远端客户端或键盘布局拦截。
- Pi 没有用户 `keybindings.json` 覆盖。对当前安装的 `pi-tui` 实测：传统字节 `0x1c` 和 Kitty 序列 `ESC[92;5u` 都能匹配 `ctrl+\\`。
- [herdr 0.9.5 的解析源码](https://github.com/herdrdev/herdr/blob/v0.9.5/src/input/parse.rs) 将字节 28 解析为 Control+反斜杠；不能仅凭“无响应”断言 herdr 不支持该按键。
- 原扩展收到优化快捷键后，会根据状态启动请求或打开面板；没有捕获物理按键的持久日志。缺少刚才那次按键的原始字节和实际 UI 焦点记录，**尚不能确认那次无响应的根因**。

确定存在的备用入口缺陷：旧 `/refine` 将全部参数当成固定操作名，任何待优化文本都会被拒绝。与此同时，Pi 的交互提交路径会先清空编辑器，再执行扩展命令，因此仅提供读取编辑器的 `/refine optimize` 不足以作为可靠的备用入口。

## 现在如何使用

1. 必要时用 `/refine model` 选择优化模型。
2. 输入 `/refine 待优化文本`，或 `/refine optimize 待优化文本`。
3. 用 `/refine view` 查看结果，`a` 接受进编辑器，`s` 明确发送。

快捷键默认绑定仍为 `Ctrl+\`：只有空工作区才自动启动；已有内容时，新草稿只加入未发送列表，选中后 Enter 才 refine，未变草稿只查看；完整规则见 [使用说明](usage.md)。裸子命令仍保留；优化文本恰好为 `model` 等保留字时，用 `/refine optimize model`。

## 如需继续定位物理按键

- 在发生问题的同一 Pi 会话用 `/hotkeys` 核对实际加载的扩展绑定，并确认主编辑器有焦点，而非模型选择器等自定义面板。
- 分别在直接终端与 herdr 中复测；需要原始输入捕获才能区分宿主终端截获、herdr 转发、协议转换和 UI 焦点问题。
- 不要在普通 Shell 提示符中直接测试 Control+反斜杠，它可能触发 SIGQUIT。使用 slash command 无需修改 herdr 或终端配置。
