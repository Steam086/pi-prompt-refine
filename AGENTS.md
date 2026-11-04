# 项目架构

Pi Prompt Refine 是 TypeScript 编写的 Pi 扩展，入口由 `package.json` 的 `pi.extensions` 指向 `src/extension.ts`。它是后台文本改写器，不是执行任务的 Agent。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/extension.ts` | 注册命令、快捷键和生命周期事件；连接 Pi UI、模型注册表、上下文收集与 controller |
| `src/controller.ts` | 管理冻结上下文 round、未发送输入、并行运行与排队、独立 Apply 目标、接受快照及恢复状态；处理去重、取消、超时、发送归档和过期操作 |
| `src/history.ts`、`history-store.ts`、`task-panel.ts` | 有界日志、每 session 最小白名单 sidecar 与原稿／模型运行两层树；按新旧轮次堆叠，支持详情、比较与接受；恢复记录不含完整背景，禁止原背景重跑，不自动进入模型上下文 |
| `src/context.ts` | 选择可见历史，构造固定协议与编辑策略、JSON 输入，校验模型输出 |
| `src/project-context.ts` | 提取宿主项目规则和技能元数据，收集有界目录列表并标注遗漏 |
| `src/config.ts` | 配置校验、默认值、迁移及持久化 |
| `src/workspace.ts`、`preview.ts`、`prompt-input.ts` | Main / Context / Input 工作区、候选阅读和独立输入 |
| `src/background-status.ts`、`presentation.ts`、`panel-layout.ts`、`key-hints.ts` | 后台状态与已查看提醒、展示格式、布局和按键提示 |
| `src/revision-preferences.ts`、`preference-store.ts`、`preference-panel.ts` | 手动修订要求的快照与确定性组合、按项目／全局隔离的并发安全库、独立选择与管理子页；只有带回后显式提交才进入模型请求 |
| `src/model-picker.ts`、`usage.ts` | 模型选项展示、响应 token 口径归一化与请求时 SDK 参考费用 |

## 数据流与验证

round 首份输入捕获系统模板、历史与项目资源，同 round 多份草稿共用冻结背景；每个运行通过扩展适配器调用 Pi `streamSimple()` 发起一次无工具请求。有效 JSON 输出成为候选，Apply 只切换 Refine 当前结果，接受或明确发送才影响 Pi 编辑器/会话。Pi 用户消息开始后自动归档旧 round，下一份输入才捕获新背景。

`test/` 使用 Vitest 覆盖纯逻辑、模拟 Pi/Provider 的生命周期与交互，以及实际 TUI 组件和渲染器。检查命令：`npm run typecheck`、`npm test`。

当前行为见 [README](README.md) 和 `docs/`；长期设计取舍、待验证问题与演进方向见 [DESIGN](DESIGN.md)。
