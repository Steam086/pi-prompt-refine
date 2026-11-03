# 配置参考

配置文件为 `<agent-dir>/prompt-refine.json`，遵循 Pi 的 agent-dir 设置（如 `PI_CODING_AGENT_DIR`）。完整示例见 [examples/prompt-refine.json](../examples/prompt-refine.json)，默认值与校验见 [src/config.ts](../src/config.ts)。示例模型仅表示格式，请选择自己已授权的模型。

## 模型、策略与快捷键

- `model`：`{ provider, id }`；缺省为未配置，不自动使用主模型或更换 Provider。
- `favorites`：按配置顺序循环，跳过不可用模型。
- `thinkingLevel`：省略时继承 session；可设 `off/minimal/low/medium/high/xhigh/max`，实际按模型能力调整。
- `systemPrompt`：可编辑的改写策略，省略时使用内置策略；固定角色、JSON 输出和标题协议始终由程序加入。面板编辑后需确认保存，后续请求生效。
- `shortcuts`：默认仅 `optimize: "ctrl+\\"`；`view/dismiss/selectModel/cycleModel/restore` 为 `null`。`null` 只关闭全局绑定，不影响面板和命令。手工修改后执行 `/reload`。

## 预算与上下文开关

下表的项目字段均位于 `projectContext` 内；具体采集边界见 [上下文说明](context.md)。

| 字段 | 默认值 | 范围或用途 |
| --- | --- | --- |
| `timeoutMs` | 60000 ms | 1000–300000 |
| `maxDraftChars` | 16000 | 1–100000；超限拒绝，不截断草稿 |
| `maxOutputTokens` | 2048 | 16–16384，调用时不超过模型输出上限 |
| `context.maxMessages` / `maxChars` | 12 / 16000 | 0–50 / 0–100000；任一为 0 禁用历史 |
| `projectContext.enabled` | true | 项目背景总开关 |
| `instructionsEnabled` / `skillsEnabled` | true / false | 项目规则 / 技能元数据 |
| `instructionsOnFollowUp` | true | 每次独立请求携带规则；false 时有主会话历史即省略 |
| `maxChars` / `instructionsMaxChars` / `skillsMaxChars` | 28000 / 16000 / 6000 | 各为 512–100000 |
| `tree.enabled` | true | 默认 tree；还要求本次选中的可见历史为空 |
| `referencedDirectories.enabled` / `maxReferences` | true / 8 | 显式目录独立开关；引用数 1–32 |
| `tree.maxChars` / `maxDepth` | 4000 / 2 | 128–20000 / 1–6，根深度为 0 |
| `tree.maxEntriesPerDirectory` / `maxEntries` | 20 / 120 | 1–100 / 1–1000 |
| `tree.maxScannedEntries` / `timeoutMs` | 2000 / 200 ms | 1–20000 / 10–2000 ms |
| `tree.exclude` | 依赖、产物、缓存等目录名 | 最多 100 个名称，无路径分隔符；替换默认列表 |

字符限制使用 JavaScript UTF-16 字符单元，不是 token 计数。历史预算按角色标签加正文计算，不含 JSON 转义和元数据；项目总预算含其标题与告警。当前没有完整输入加输出的统一模型窗口校验。

关闭 `projectContext.enabled` 可只保留草稿与历史。关闭所有目录扫描需同时关闭 `tree.enabled` 和 `referencedDirectories.enabled`；单独关闭默认 tree 不影响显式 `@目录`。

## 兼容旧配置与持久化

- 已保存的 `instructionsOnFollowUp: false` 不自动改为 true；删除字段或改为 true 才采用每次注入策略。
- 自定义 `systemPrompt` 原样保留为编辑策略，不会自动换成新默认模板。旧 BEGIN/END 分区假设需适配 JSON 输入；删除字段可恢复内置策略。
- 完整的旧默认 F2–F7 或 Alt+Shift 六键映射会在加载时迁移为单入口默认值；部分配置和自定义映射保留。加载本身不改写配置文件。
- 无效配置回退并告警，有告警时不自动覆盖原文件。有效配置通过临时文件原子替换，权限 `0600`；写入失败时提示仅内存生效。Provider 认证仍由 Pi 管理，不在本文件保存 API Key。
