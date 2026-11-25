# 配置参考

配置位于 Pi agent 目录的 `prompt-refine.json`，受 `PI_CODING_AGENT_DIR` 影响。编辑前参见[可复制的配置示例](../examples/prompt-refine.json)。字段范围、默认值和迁移见[配置实现](../src/config.ts)。手工保存后在 Pi 运行 `/reload`。

## Settings 面板

Tab 切换 **Context**、**Optimizer**，方向键选择设置，必要时用 PgUp／PgDn 阅读详情。Enter／Space 切换开关。数值项按 Enter 打开编辑页，可直接输入或用 Tab 切换档位。再次按 Enter 暂存，返回 Settings 后按 Ctrl+S 保存。在数值编辑页按 Esc 取消本次编辑；在 Settings 顶层按 Esc 关闭工作台，未保存的暂存修改会被放弃。

上下文和编辑策略从下一 round 生效。输出和超时设置用于之后实际启动的请求，包括届时启动的排队项。原稿长度限制用于新的输入及编辑校验，已有记录仍可阅读。保存失败时检查 `Not persisted`，已应用的设置可能只在当前进程有效。

## 模型、策略与快捷键

- 用 `/refine model` 选择默认优化模型。Pi 管理 Provider 认证，主模型保持独立。模型、thinking 和策略各有保存确认。
- **Optimizer → Optimization prompt** 按 Enter 编辑，Ctrl+S 后按 `y` 确认。删除文件中的 `systemPrompt` 字段可恢复内置策略。自定义策略保留，固定角色、字面保护和输出协议由程序提供。
- 默认优化快捷键是 `Ctrl+\`，Preferences 的 `preferencesKey` 默认是 Alt+P。可在配置中用 `null` 关闭对应绑定。即使禁用 Alt+P，仍可在 Preview／Usage 按 `p`，或在 Revise 用 Tab 聚焦 Preferences 后按 Enter。完整流程见[使用说明](usage.md)及[偏好指南](preference-selection.md)。原生快捷键避免功能键，旧绑定的兼容行为见[配置测试](../test/unit/config.test.ts)。

## 历史保存与隐私

Pi 会话有对应文件时，Refine 默认将已提交的原稿、候选正文、编辑要求和运行信息以明文保存在同目录的 `<会话文件>.prompt-refine.json`。Unsent 草稿、完整背景和结果附注仅供当前运行时使用。每个会话最多保存 100 次运行、共 2 MiB。超限的记录整条略过，正文保持完整。在 **Usage** 按 `b` 可查看路径和保存状态。[恢复后使用旧结果](usage.md#resume--reload-后的历史)

将配置中的 `historyPersistence` 设为 `false` 并执行 `/reload`，即可停止自动读写。要删除已有文件，在对应会话的原生 TUI 执行 `/refine history clear` 并确认。本次清理只删除该会话的 Refine 历史文件，并暂停保存至下次重载。仍可查看内存中的记录和 Pi 对话。卸载扩展会保留本地历史、配置与偏好库。[偏好库路径](preference-selection.md#库文件与旧版兼容)

## 预算与上下文开关

- **History messages** 或 **History characters** 任一设为 `0` 即排除会话历史正文。历史计数仍可存在。**Project context** 独立控制规则、技能和目录列表，关闭时保留子设置。
- **Directory references** 控制显式 `@目录` 列表，**Directory tree** 控制没有历史正文时可附带的默认树。**Project instructions** 的 `First request only` 指每个新优化任务的首次请求，`Always` 包含 Revise，`Off` 关闭规则发送。
- 默认最多取当前分支 12 条可见的用户或助手消息，合计 16,000 个字符。启用目录引用时只列出目录内的名称。`@文件` 不会附带文件正文。扩展也不会主动附上工作目录的绝对路径，草稿、历史或规则正文中本来就有的路径则会保留。
- 关闭 **Project context** 后，仍会发送草稿、改写策略、已提交的偏好或编辑要求，以及历史设置允许的会话文本。Revise 还会发送上一候选，可能附带先前的编辑要求。[请求协议](context.md)
- 字符限额按 UTF-16 计算。**Output token limit** 约束模型输出预算，推理模型可能与正文共享额度。容量告警见运行详情。长输出截断时可考虑提高允许的输出量或降低 thinking。[预算预检](context.md#发送前统一预算)
