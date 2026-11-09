# gpt-6-luna：本 session 的 Refine 追踪记录

记录时间：2026-11-09。来源：当前 Pi session 相邻的 `.prompt-refine.json` sidecar；session ID 为 `01a1bf2d-3513-728e-bd21-e3d86059d2a9`。该文件只保存原稿、结果、部分运行元数据与已提交的编辑要求，**不保存冻结背景、系统提示或完整请求载荷**；以下仅是输出观察与后续排查线索，不据此断言模型或策略的根因。原始请求未能完整重跑；文末另记 xhigh 近似回放。

## Round 1：截图 + 讨论问题（同一原稿，两次 luna 运行）

原稿（Task 1 / Task 2 相同）：

```text
 Preferences
  Focus: Library · 0 frozen snapshots
  Search:
    n Add                           e Edit                          d Delete
  Library 3/17 · 0 selected · s Selected    │ Preview · Enter reads full text
  Prompt rewriting                          │ Prompt Bullet Structure
    [ ] Clarify Prompt Intent       Project │ global · 8d656e43-33ed-4443-b415-d5e45419c87d
    [ ] Neutral Prompt Tone          Global │ Library entry
  › [ ] Prompt Bullet Structure      Global │ Prompt rewriting · manual
    [ ] Prompt Step Structure        Global │ 将需要整理的独立并列要求改为列表；不改变回答格式。
    [ ] Clarify Prompt Intent        Global │
    [ ] Translate Prompt to English  Global │ Prefer a list-based structure when separating
  Task requirements                         │ distinct requirements, questions, constraints, or
    [ ] Answer in Bullet Points     Project │ other points would improve clarity and readability.
  ────────────────────────────────────────────────────────────────────────────────────────────────
  s Selected only · Enter Read
  Esc Back        · Tab / Shift+Tab Focus · / Search 右侧的正文部分是不是太靠下了，讨论能否删掉一部分
```

- **Run #1 / Task 1 / Round 1**：`openai-codex/gpt-6-luna`，2026-11-09 07:20:09.890 UTC；15 秒，生成后接受。结果：`右侧的正文部分是不是太靠下了？讨论一下能否删掉一部分。`
  - 提交的编辑要求为两个“最小有效修改”偏好：只在有明确依据时澄清指代、避免附加成功标准或重述背景；仅改妨碍理解的口语／含糊／重复表达，保留用户语气。
- **Run #2 / Task 2 / Round 1**：`openai-codex/gpt-6-luna`，2026-11-09 07:22:02.347 UTC；8 秒，生成、未接受（界面显示 Earlier / Restored history）。结果：`右侧的正文部分是不是位置太靠下了？讨论一下能否删掉一部分内容。` 无已提交编辑要求。
- **观察／待排查**：两次结果均删掉了整段界面截图，只保留讨论问句；“右侧”“删掉一部分”的指代因此失去可供下一位助手参考的具体内容。这不是用户明确授权删去截图。对照同一 Task 2 的 Run #3（`gpt-6.1-terra`）结果逐字保留原稿，仅作对照，不属于 luna 记录。
- **后续验证方向**：用含多行 TUI／日志／代码块的原稿测试模型是否把参考材料误当作可删冗余；区分带偏好与不带偏好；检查候选是否保留用户提供的字面参考内容。不要只测问句语义或引入“必须润色”的目标。

## Round 2：依赖上文建议的简短确认

- **Run #4 / Task 3 / Round 2**：`openai-codex/gpt-6-luna`，2026-11-09 07:24:32.448 UTC；15 秒，生成后接受；无已提交编辑要求。
- 原稿：`好的，删掉吧，然后提交`
- 结果：`请按刚才的建议修改右侧预览：删掉 UUID、\`Library entry\` 和 \`· manual\`，保留名称、说明、简短的类型行和正文；条目已删除、来源变化或快照不同的警告仍应保留。修改后提交。`
- **观察／待排查**：这次补足了上文建议的具体范围，后续可作为“有充分且唯一的上文依据时允许消解指代”的正例；仅凭 sidecar 不能复原模型当时实际看到的冻结上下文，不能据此断定实现细节。

## xhigh 近似回放（2026-11-09）

使用本地配置的 `openai-codex/gpt-6-luna`，`reasoning: "xhigh"`、`maxTokens: 8192`、无工具；两次各调用一次，不进行失败重试。用 sidecar 中 Run #1 / #2 的**原稿**和各自已提交的编辑要求重新构建 Refine JSON 输入；使用**当前工作树**的 `buildRefineSystemPrompt(false)` / `buildRefineInput()`，空可见历史、空项目文本。原始 round 的冻结背景／实际请求载荷未保存，当前策略文件也可能已变更，因此不是原请求的精确复现。以下“截图完整”指结果包含原稿中讨论问句之前的截图文本，逐字且连续。

| 回放依据 | 已提交编辑要求 | stop / JSON | 输出中的原截图 | 结果 |
| --- | --- | --- | --- | --- |
| Run #1 | 两条最小编辑偏好 | stop / 有效 | **完整保留** | 结果与原稿逐字相同，含截图和讨论问句。 |
| Run #2 | 无 | stop / 有效 | **全部丢失** | `右侧的正文区域是不是显得太靠下？请结合当前界面讨论是否可以删减其中一部分内容。` |

结论仅限两次样本：**xhigh 不保证保留截图**；有编辑要求的 #1 回放保留，无编辑要求的 #2 回放仍删除。不能只凭这一组观察把差异归因于思考等级或偏好。回放原始 JSONL 暂存于本机 `/tmp/luna-xhigh-refine-replay-20261109.jsonl`（未纳入仓库）。

追踪标识：当前 session ID + Run #1／#2／#4；不要把恢复记录当作旧背景已保存的精确回放。
