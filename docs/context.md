# 上下文与 Prompt 协议

用户可控制的数据披露范围见 [TUI 指南](tui-guide.md#what-the-rewrite-provider-receives)和[配置参考](configuration.md)。诊断实际收到什么时，从[模型调用](../src/app/completion.ts)读到 [输入构造与解析](../src/context.ts)，再对照[请求回归](../test/unit/context.test.ts)。

## Round 快照

round 的首份输入冻结会话历史、系统模板和项目资源。并行比较、重试及 Revise 使用原稿所属背景，使模型差异可比较，也避免后来的配置或主会话回复改变早先请求的含义。各模型仍按自己的容量选择可发送的背景。磁盘恢复只有候选及最小记录，须复制到当前 round 才能用新背景再次运行。

## 背景的来源边界

- 历史限于当前分支中的可见 user／assistant 文本。完整性字段只描述这部分。条数或字符不足时可能保留摘录，依据不足时不能推断中段约束不存在。保留较新的用户纠正比补齐较早的助手文本更重要。选择与计数见 [`selectHistory`](../src/context.ts)。
- 项目规则和技能元数据来自 Pi 已加载的资源。自动生成的规则标签只用项目相对路径或 `external rule`。用户草稿、历史和规则正文中的字面路径保持原样。启用「仅首次」时按优化任务计数，Revise 省略项目规则，已有主会话历史不会让新任务跳过规则。
- 显式目录引用与默认目录树独立。引用可使用工作目录内的路径，如 `@src/` 或 `@"docs with spaces"`。生成的内容是有界名称列表，受工作目录、适用 ignore 规则及符号链接边界约束。普通文件正文不读取。解析、过滤和错误脱敏见[项目背景实现](../src/project-context.ts)，共享采集的取消边界见[目录任务](../src/app/context-jobs.ts)。

## 发送前统一预算

预检使用模型注册表的窗口和输出能力，估算实际序列化输入、系统提示、输出与安全余量。估算会随 Provider 分词偏离实际用量。容量不足时缩减可选背景与输出规划，保留完整原稿和本次明确要求。必须内容放不下时拒绝调用。裁减属于本次运行，不能污染冻结的 round。具体顺序和额度看[预算实现](../src/budget.ts)及[回归](../test/unit/budget.test.ts)。

## 请求与输出

每次运行最多一次独立无工具请求。固定角色和输出约定独立于可编辑策略。模型输入区分当前草稿、补充的会话／项目背景和用户提交的编辑要求。原稿内的代码、TUI、路径和引用按字面保护；额外背景只用于理解任务。JSON 可以界定数据字段，模型可能仍误解指令，需用户审阅。

Revise 把原稿、上一候选和本次修订要求分别传入。历史编辑依据只解释候选中仍保留的改动，不能重放已删除的要求。预算不足时可省略这份依据。[连续修订实验](experiments/revision-semantics-experiment.md)

只有正常结束、没有工具调用且返回有效 JSON 正文的响应才能产生候选。若 Provider 区分输出阶段，优先解析 `final_answer` 文本，跳过 `commentary`。可选标题或附注无效时保留有效正文。附注顺序和名称取自本次选择，仅请求附注的 Revise 会保留上一候选的正文。[响应阶段选择](../src/app/provider-response.ts) · [输出解析](../src/context.ts)

首次改写严重遗失原稿中粘贴的 TUI 参考时，可以回退到原稿并提示用户。触发条件和显式删除参考的例外见[保留规则](../src/reference-preservation.ts)及[回归测试](../test/unit/reference-preservation-guard.test.ts)。通用语义质量通过[样例验收](optimizer-evaluation.md)评估。
