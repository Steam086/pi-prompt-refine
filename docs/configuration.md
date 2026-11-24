# 配置参考

配置位于 Pi agent 目录的 `prompt-refine.json`，受 `PI_CODING_AGENT_DIR` 影响。编辑前参见[可复制的配置示例](../examples/prompt-refine.json)。字段范围、默认值和迁移见[配置实现](../src/config.ts)。手工保存后在 Pi 运行 `/reload`。

## Settings 面板

Tab 切换 **Context**、**Optimizer**，方向键选择设置，必要时用 PgUp／PgDn 阅读详情。Enter／Space 切换开关。数值项按 Enter 打开编辑页，可直接输入或用 Tab 切换档位。再次按 Enter 暂存，返回 Settings 后按 Ctrl+S 保存。Esc 可取消本次暂存。

上下文和编辑策略从下一 round 生效。输出和超时设置用于之后实际启动的请求，包括届时启动的排队项。原稿长度限制用于新的输入及编辑校验，已有记录仍可阅读。保存失败时检查 `Not persisted`，已应用的设置可能只在当前进程有效。

## 模型、策略与快捷键

- 用 `/refine model` 选择默认优化模型。Pi 管理 Provider 认证，主模型保持独立。模型、thinking 和策略各有保存确认。
- **Optimizer → Optimization prompt** 按 Enter 编辑，Ctrl+S 后按 `y` 确认。删除文件中的 `systemPrompt` 字段可恢复内置策略。自定义策略保留，固定角色、字面保护和输出协议由程序提供。
- 默认优化快捷键是 `Ctrl+\`，Preferences 的 `preferencesKey` 默认是 Alt+P。可在配置中用 `null` 关闭对应绑定。面板命令和页内入口见[使用说明](usage.md)及[偏好指南](preference-selection.md)。原生快捷键避免功能键，旧绑定的兼容行为见[配置测试](../test/unit/config.test.ts)。

## 历史保存与隐私

`historyPersistence: false` 加 `/reload` 可停止历史读写。已有文件可在对应 Pi 会话的原生 TUI 中用 `/refine history clear` 清理。保存数据和清除边界见[本地历史与清理](tui-guide.md#local-history-and-cleanup)，旧结果的重用见[历史恢复](usage.md#resume--reload-后的历史)。

## 预算与上下文开关

- **History messages** 或 **History characters** 任一设为 `0` 即排除会话历史正文。历史计数仍可存在。**Project context** 独立控制规则、技能和目录列表，关闭时保留子设置。
- **Directory references** 控制显式 `@目录` 列表，**Directory tree** 控制没有历史正文时可附带的默认树。**Project instructions** 的 `First request only` 指每个新优化任务的首次请求，`Always` 包含 Revise，`Off` 关闭规则发送。
- 关闭 **Project context** 只排除项目背景。仍会发送草稿、改写策略、已提交的偏好或编辑要求。Revise 还会发送上一候选，可能附带历史编辑依据。有关绝对路径、文件内容和会话历史的范围，见[Provider 收到的数据](tui-guide.md#what-the-rewrite-provider-receives)。
- 字符限额按 UTF-16 计算。**Output token limit** 约束模型输出预算，推理模型可能与正文共享额度。容量告警见运行详情。长输出截断时可考虑提高允许的输出量或降低 thinking。[预算预检](context.md#发送前统一预算)
