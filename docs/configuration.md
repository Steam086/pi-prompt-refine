# 配置参考

配置文件为 `<agent-dir>/prompt-refine.json`，遵循 Pi 的 agent-dir 设置（如 `PI_CODING_AGENT_DIR`）。完整示例见 [examples/prompt-refine.json](../examples/prompt-refine.json)，默认值与校验见 [src/config.ts](../src/config.ts)。示例模型仅表示格式，请选择自己已授权的模型。

## 模型、策略与快捷键

- `model`：`{ provider, id }`；缺省为未配置，不自动使用主模型或更换 Provider。
- `favorites`：按配置顺序循环，跳过不可用模型。
- `thinkingLevel`：默认优化模型的强度；省略时继承 session；可设 `off/minimal/low/medium/high/xhigh/max`，实际按模型能力调整。
- `modelThinkingLevels`：按 `provider/model` 保存上次确认使用的强度（例如 `{"anthropic/claude-sonnet-4-5": "high"}`），包含仅用于比较的模型。选择器优先恢复该模型的记忆，Shift+Tab 只调整当前选中的模型，Enter 确认后保存；取消不保存临时调整。比较运行不会更改默认模型或 `thinkingLevel`；选择默认模型和循环模型时会恢复对应强度。没有记忆时沿用原有的当前运行／扩展设置／session 回退规则；恢复时仍按模型能力调整。
- `systemPrompt`：可编辑的改写策略，省略时使用内置策略；固定角色、JSON 输出和标题协议始终由程序加入。面板编辑后需确认保存，下一 round 捕获时生效；当前 round 使用冻结模板。
- `shortcuts`：默认仅 `optimize: "ctrl+\\"`；`view/dismiss/selectModel/cycleModel/restore` 为 `null`。`null` 只关闭全局绑定，不影响面板和命令。手工修改后执行 `/reload`。

## 历史保存与隐私

`historyPersistence` 默认 `true`。仅在有 session 文件路径时，将原稿、结果、已提交的修订要求与运行元数据保存到相邻的 `<session-file>.prompt-refine.json`，每 session 最多 100 条 / 2 MiB，权限 `0600`。不保存完整背景、请求载荷、未提交输入或撤销快照。

设为 `false` 后执行 `/reload`，停止加载和保存历史，但不删除旧文件。执行 `/refine history clear` 并确认，可删除当前 session 的 sidecar，同时暂停保存直到 reload；内存中的记录仍可查看。原稿与结果仍可能含敏感文本，清理或移动 session 时应同步处理 sidecar。恢复记录不能按旧背景重跑，详情见[历史恢复说明](usage.md#resume--reload-后的历史)。

## 预算与上下文开关

下表的项目字段均位于 `projectContext` 内；具体采集边界见 [上下文说明](context.md)。上下文配置在 round 第一份输入捕获时冻结，Settings 的更改用于下一 round。并行上限目前固定为 4，超出排队；`timeoutMs` 从每条请求实际启动后计算，不包含排队时间。

| 字段 | 默认值 | 范围或用途 |
| --- | --- | --- |
| `timeoutMs` | 60000 ms | 1000–300000 |
| `maxDraftChars` | 16000 | 1–100000；超限拒绝，不截断草稿 |
| `maxOutputTokens` | 8192 | 16–65536；请求输出总预留上限（含 reasoning 余量），同时受模型输出能力和上下文窗口限制 |
| `context.maxMessages` / `maxChars` | 12 / 16000 | 0–50 / 0–100000；任一为 0 禁用历史 |
| `projectContext.enabled` | true | 项目背景总开关 |
| `instructionsEnabled` / `skillsEnabled` | false / false | 项目规则（如 AGENTS.md）/ 技能元数据，按需开启 |
| `instructionsOnFollowUp` | true | 启用规则时，true 为首次优化及每次 Revise 都包含；false 为每个新优化任务首次包含、Revise 省略，与主会话历史无关 |
| `maxChars` / `instructionsMaxChars` / `skillsMaxChars` | 28000 / 16000 / 6000 | 各为 512–100000 |
| `tree.enabled` | false | 按需开启默认 tree；还要求本次选中的可见历史为空 |
| `referencedDirectories.enabled` / `maxReferences` | true / 8 | 显式目录独立开关；引用数 1–32 |
| `tree.maxChars` / `maxDepth` | 4000 / 2 | 128–20000 / 1–6，根深度为 0 |
| `tree.maxEntriesPerDirectory` / `maxEntries` | 20 / 120 | 1–100 / 1–1000 |
| `tree.maxScannedEntries` / `timeoutMs` | 2000 / 200 ms | 1–20000 / 10–2000 ms |
| `tree.exclude` | 依赖、产物、缓存等目录名 | 最多 100 个名称，无路径分隔符；替换默认列表 |

字符限制使用 JavaScript UTF-16 字符单元，不是 token 计数。历史采集预算按角色标签加正文计算；项目采集预算含其标题与告警。发送前另有统一容量预检：完整系统提示词与实际 JSON 输入（含转义、元数据、修订字段）的 token 估算 + 输出预留 + 安全余量不得超过模型窗口。

Pi 没有跨 Provider 的精确 tokenizer 接口，因此本扩展按 UTF-8 字节数 ÷ 3（向上取整）近似估算文本，不再将每个中文字按三个 tokens 计算。安全余量仍为 4096 + 模型窗口的 1%（向上取整），兼顾宿主适配器的预留。这不是 Provider 实测 token 数，也不是严格上界；模型容量依赖注册表信息正确，实际仍可能遇到 Provider 容量限制。

完整草稿／上一候选 JSON 估算长度的 125% + 256 tokens 仅作为期望输出空间，不再因其超过输出上限直接拒绝。优先缩减多余输出空间，再裁减可选背景；仍不足时可进一步降低期望输出，最低保留 256 tokens（配置／模型输出上限更小时遵循该上限）。启用 reasoning 时答案最低空间为 1024 tokens（与宿主适配器一致），另外保留有界 thinking 空间：Anthropic／Bedrock 的追加型适配器先扣除这部分再传入 `maxTokens`，其他适配器直接共享总上限，不重复预留两份 thinking。旧配置 2048 配合 thinking 也可发送小请求。

完整输入加最低输出空间仍超窗口、模型容量无效，或输出上限不足以容纳 thinking 时才拒绝；不会截断草稿或突破配置上限。估算不保证完整输出，长草稿仍可能需要提高 `maxOutputTokens`；模型输出被截断时不接受残缺候选。

预算裁减和拒绝请求在摘要及运行条目上显示 `⚠`，详情显示估算输入、输出、安全余量和窗口。新默认值不覆盖已保存的有效 `maxOutputTokens`；旧的 2048 仍然生效，可自行调整。

默认树与显式目录同时启用、且没有选中历史时，为保证 round 默认树可复用，两者各预留一半目录字符、条目和扫描预算；只启用一个范围时使用完整预算。

关闭 `projectContext.enabled` 可只保留草稿与历史。关闭所有目录扫描需同时关闭 `tree.enabled` 和 `referencedDirectories.enabled`；单独关闭默认 tree 不影响显式 `@目录`。

Settings 中的 `Project instructions` 使用三个模式，Enter / Space 循环切换，`Ctrl+S` 保存后持续生效：

| 模式 | `instructionsEnabled` | `instructionsOnFollowUp` |
| --- | --- | --- |
| `First request only` | true | false |
| `Always` | true | true |
| `Off`（默认） | false | 保留原值，关闭时不生效 |

“首次”指每个新优化任务的首次请求。通过主草稿、命令正文、Input 或 `r` 开始新任务时重新包含规则；对当前候选按 `f` 发起的 Revise（包括重试）属于后续请求。每次模型调用仍然独立，选择仅首次不会使模型自动记住被省略的规则。

## 兼容旧配置与持久化

- 新默认值关闭项目规则和默认目录树；已保存的显式 `true` 不自动覆盖。已有配置可在 Settings → Context 将 `Project instructions` / `Directory tree` 设为 Off 并保存；下一 round 生效。显式 `@目录` 仍独立启用。

- 已保存的 `instructionsOnFollowUp: false` 保留，界面显示 `First request only`（规则启用时）。其生效范围从旧版“有主会话历史即省略”改为“仅 Revise 省略”，因此有主会话历史的新优化任务现在也会包含规则。加载本身不改写配置。
- 自定义 `systemPrompt` 原样保留为编辑策略，不会自动换成新默认模板。旧 BEGIN/END 分区假设需适配 JSON 输入；删除字段可恢复内置策略。
- 完整的旧默认 F2–F7 或 Alt+Shift 六键映射会在加载时迁移为单入口默认值；其他有效的非功能键自定义映射保留。F1–F12 及其修饰组合不再允许，自定义功能键条目会告警并回退对应默认值。加载本身不改写配置文件。
- Preferences 的 `preferencesKey` 默认 `"alt+p"`，在 Unsent 原稿和 Revise 内生效，可设为非功能修饰键或 `null`；旧默认 `"f2"` 自动迁移到 Alt+P，不产生阻止后续保存的配置告警；其他功能键值会告警并回退。禁用或冲突时，Unsent 仍可按 `p` 选择首次 refine 的偏好，Revise 内仍可用 Tab 聚焦 Preferences、Enter 打开；结果详情不提供直接 `p` 入口。带回不请求模型：Unsent 返回后 Enter 启动，Revise 返回后 Ctrl+S 修订。
- 无效配置回退并告警，有告警时不自动覆盖原文件。有效配置通过临时文件原子替换，权限 `0600`；写入失败时提示仅内存生效。Provider 认证仍由 Pi 管理，不在本文件保存 API Key。
