# 上下文与 Prompt 协议

每次优化是独立的 `ctx.modelRegistry.streamSimple()` 调用，不是 Pi Agent session。模型没有跨请求记忆，工具集固定为空；输出通常回到原主会话。实现位于 [context.ts](../src/context.ts)、[project-context.ts](../src/project-context.ts) 与 [extension.ts](../src/extension.ts)。

## 输入来源与选择

| 来源 | 当前处理方式 |
| --- | --- |
| 草稿 | 来自主编辑器、命令正文或 Input 页；完整保留，超过上限拒绝调用 |
| 候选修订 | `operation: revise` 单独传入最初草稿、最新候选与本次修改要求；不把反馈误当新草稿 |
| 会话历史 | `getBranch()` 当前分支中 user/assistant 的可见文本 |
| 项目规则 | Pi 已加载的 context files，保留来源和宿主顺序；默认每次注入 |
| 技能 | 显式启用后提供名称与描述，不读取技能正文 |
| 目录 | 有界名称列表，不读取源码正文；默认 tree 与显式引用分别控制 |

历史不包含 thinking、工具调用块、原始工具结果、图片、其他分支、独立压缩摘要或整套主系统提示。引用普通 `@file` 不代表正文已读取；但用户或助手先前消息中的代码可能随可见历史发送。

### 历史预算

1. 全部可见消息同时满足条数和字符限制时，完整保留。
2. 超限时优先为最新 user 预留约半预算，再保留最新 assistant，其余从新到旧填充；剩余空间回填摘录消息，最后按时间排序。
3. 只有一个名额时选最新可见消息，不能用旧 assistant 替换更新的用户纠正。
4. 长消息仍采用首尾摘录；极小预算可能只保留末尾。这不是语义摘要，不能保证保留所有中段约束。

模型收到逐条 ID、角色及 `complete/excerpted` 状态，还有总条数、入选/省略/摘录计数。整体状态为 `complete/partial/disabled_by_policy`，整条省略也算不完整。完整性仅针对上述可见文本范围。

### 项目规则与技能

命令上下文优先使用 `getSystemPromptOptions()`；普通快捷键从 `getSystemPrompt()` 的 Pi 命名资源区段提取。不兼容或读取失败时告警，不自行扫描全局规则目录，也不发送通用系统规则、认证或技能位置。两种接口的结果不等同于主会话最终 Provider payload。

规则在预算内完整提供，超限时选完整 Markdown 章节并标注来源、行号和不完整状态；不将代码围栏内的标题当章节边界。技能描述整项保留；禁用自动调用的技能只有被原稿以 `/skill:name` 或 `$name` 明确引用时才纳入。技能存在不授权 optimizer 调用它或新增调用要求。

项目规则支持 `First request only`、`Always`、`Off` 三态，默认 `Always`。仅首次以一个优化任务为单位：新草稿的首次优化包含规则，围绕该候选的后续 Revise 省略；主会话是否已有历史不参与判断。规则省略不影响独立启用的技能与目录，也不意味着模型跨请求保留规则。配置映射见 [配置参考](configuration.md)。

### 目录列表

- 默认 tree 只在本次实际选中的可见历史为空时收集。原始草稿中的 `@目录` 独立收集，不依赖历史或 `tree.enabled`，但受项目总开关控制。
- 支持相对 cwd、cwd 内绝对路径和带引号的空格路径，如 `@src/`、`@"docs with spaces"`。按字面解释，不展开变量、glob、`~` 或 shell 转义；邮箱、URL 和转义 `\@` 不作为引用。
- 目录限定在 cwd 内，不接受 `..`，逐级拒绝符号链接与 ignored/excluded 路径。默认最多检查 8 个不同引用，每个最多 32 层；普通文件不读取正文。
- 显式目录优先，归一化去重，父/default tree 不重复展开显式引用子树。所有目录共享字符、条目、扫描和时间预算，不能因引用数量增加而倍增。
- 使用适用的祖先/嵌套 `.gitignore`，不读取 Git 全局 excludes 或 `.git/info/exclude`。默认排除依赖、产物、缓存及 `.env*`，始终排除 `.git`；不执行 shell/Git 命令、不跟随目录符号链接。
- 预算省略、不可访问或不可解析等问题同时进入模型背景与 UI 告警，不触发自动补读。默认深度折叠和正常 ignore 过滤只作列表标注。

宿主资源在触发时捕获，目录在后台请求内异步收集，受同一取消、超时和会话失效边界约束。规则优先于技能及目录；具体默认值见 [配置参考](configuration.md)。

## 请求与输出

系统消息由固定 refiner 协议、默认或自定义编辑策略、输出与标题要求组成。仅一条 user 消息，其内容为 JSON 数据包，例如：

```json
{
  "operation": "refine",
  "delivery_context": "existing_session",
  "project_context": null,
  "conversation": {
    "scope": "current_branch_visible_user_assistant_text",
    "status": "partial",
    "total_message_count": 2,
    "selected_message_count": 1,
    "omitted_message_count": 1,
    "excerpted_message_count": 0,
    "items": [
      { "id": "m2", "role": "user", "status": "complete", "text": "仅讨论，不实施。" }
    ]
  },
  "draft": "继续看这个方案。"
}
```

ID 优先使用宿主消息 ID，缺失时使用分支位置 `branch-N`。项目背景若启用则为带来源、完整性和告警的文本。JSON 可避免原文中的角色标签或 BEGIN/END 标记改变数据结构，但不能独立保证防御提示词注入。

默认编辑策略要求最小有效修改、允许原样返回，保留字面内容、授权范围与不确定性；助手提议不是已批准需求，指代只在依据充分且唯一时消解。模板位于 `context.ts`，不加载 `.pi/prompts/*.md`，也不展开草稿里的 `/模板名`。

响应为 `{"prompt":"…","title":"…"}`，已命名时仅需 `prompt`。非法 JSON、空 prompt、截断和工具调用均拒绝，不回退到原始响应；无效可选标题只跳过命名。系统模板与历史快照参与去重，但目前尚无包含异步 tree 的完整最终 payload 快照。

## 数据与能力边界

所选优化 Provider 会收到草稿和启用的背景，可能不同于主 Agent Provider；不能自动识别文本中的全部秘密。过程不默认持久化到主会话；模型只能返回改写，不能读取文件、联网或执行任务。

候选修订复用来源请求的历史快照，项目资源按触发时的 Context 设置重新捕获；修改要求中的显式目录引用同样受既有目录规则限制。原始草稿和本次修改要求分别受 `maxDraftChars` 限制，上一候选受既有输出字符上限限制；不保存无限修订链。修订失败保留一个来源候选，取消或切换会话/模型仍会清除失效结果。

当前不提供 `need_context` 或渐进式补读。统一 token 预算和语义效果验证也尚未完成，见 [ROADMAP](../ROADMAP.md)。
