# Refine 历史与请求比较：执行计划

## 目标与边界

在 `feat/refine-history-ux` worktree 实施；不修改主工作区已有未提交文档。保持后台无工具改写器定位，查看、Apply、恢复记录均不发送 Pi 消息。

## 分批顺序

- [x] 1. `fix(ui): simplify historical context and align run statuses`
  - 去掉右侧顶部 earlier-context 警告；仅在详情 Record 中显示弱化上下文归属。
  - 左树子项状态靠右，模型名占剩余空间；原稿行不变。覆盖宽字符、ANSI、窄屏及长状态。
- [x] 2. `feat(usage): show per-run input output and reference cost`
  - 摘要保留耗时，显示 ↑总输入（含缓存）/↓输出、参考美元费用。
  - 按 Pi 规范化 usage 统计，缓存与 reasoning 不重复计费；优先保留响应 SDK cost。
  - 详情显示精确数、缓存拆分、命中率与费用来源/缺失解释；订阅标识只使用宿主认证信息，不按 provider 名推断。
  - 未知为 Cost —；零价模型目录可能是占位，不能据此宣称免费；非零小金额不舍入为零。
- [x] 3. `feat(ui): revise results inline without leaving inspection`
  - Inspect 底部输入，保留原内容与位置；焦点归输入组件。
  - Enter 换行，Ctrl+S 明确提交，Ctrl+E 展开/收起；小屏自动展开。
  - Esc 返回且保留按结果身份隔离的草稿（仅当前工作区内存）；目标变化/会话变化不允许误发。
- [ ] 4. `feat(history): persist bounded session-local refinement records`
  - 每 session 一个版本化 sidecar `<session-file>.prompt-refine.json`，原子写、0600、最多 100 条 / 2 MiB，淘汰最旧条目而不截断 prompt/result。
  - 白名单保存原稿、结果、修订要求、模型/thinking、关联 ID、状态/时间/用量/费用；不保存完整 history/systemPrompt/project/preparedInput/sentInput、标题或编辑器撤销快照。编辑中的输入草稿不落盘。
  - 恢复为归档记录，未完成请求标 Interrupted；不恢复队列、当前候选、Accept/Send 动作及编辑器。序号重建不碰撞。
  - 缺少完整上下文的恢复记录禁止原背景重跑/Revise；明确引导 `i` 复制原稿到当前 round。结果可显式接受/编辑/发送。
  - 记录为 session 范围，不随 /tree 回退；fork/new 不继承另一 session 的 sidecar。临时 session 无文件则仅内存。
  - 配置允许关闭持久化；命令删除已保存历史。sidecar 不进模型上下文，但包含用户原稿/结果，文档说明保存范围及手工删除 session 时须同时删除 sidecar。
  - 串行合并写入、防止过期回调跨 session 写入、失败通知、损坏/未知版本安全降级；集成测试重启/resume/隔离/中断/隐私白名单。

## 验证

每批执行相关 Vitest 测试及 `npm run typecheck`，提交前执行全量测试。最终补充 README / usage / context / configuration 与架构说明，检查 worktree 干净、提交范围及主工作区未改变。不调用真实模型、不读取用户会话内容。
