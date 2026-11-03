# 项目架构

Pi Prompt Refine 是 TypeScript 编写的 Pi 扩展，入口由 `package.json` 的 `pi.extensions` 指向 `src/extension.ts`。它是后台文本改写器，不是执行任务的 Agent。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/extension.ts` | 注册命令、快捷键和生命周期事件；连接 Pi UI、模型注册表、上下文收集与 controller |
| `src/controller.ts` | 管理单一活动请求、同稿多模型候选选择、冻结输入、已接受快照及恢复状态；处理去重、取消、超时和过期操作 |
| `src/history.ts`、`history-panel.ts` | 有界内存请求日志与只读 History / Usage；记录候选来源及接受、发送事件，不自动进入模型上下文 |
| `src/context.ts` | 选择可见历史，构造固定协议与编辑策略、JSON 输入，校验模型输出 |
| `src/project-context.ts` | 提取宿主项目规则和技能元数据，收集有界目录列表并标注遗漏 |
| `src/config.ts` | 配置校验、默认值、迁移及持久化 |
| `src/workspace.ts`、`preview.ts`、`prompt-input.ts` | Main / Context / Input 工作区、候选阅读和独立输入 |
| `src/presentation.ts`、`panel-layout.ts`、`key-hints.ts` | 被动摘要、布局和按键提示 |
| `src/model-picker.ts`、`usage.ts` | 模型选项展示与响应 token 用量处理 |

## 数据流与验证

触发时捕获草稿、系统模板、历史与项目资源；controller 调用扩展提供的模型适配器，后者通过 Pi `streamSimple()` 发起一次无工具请求。有效 JSON 输出成为候选，只有用户接受或明确发送才影响主编辑器或会话。

`test/` 使用 Vitest 覆盖纯逻辑、模拟 Pi/Provider 的生命周期与交互，以及实际 TUI 组件和渲染器。检查命令：`npm run typecheck`、`npm test`。

当前行为见 [README](README.md) 和 `docs/`；长期设计取舍见 [DESIGN](DESIGN.md)，未实现方向见 [ROADMAP](ROADMAP.md)。
