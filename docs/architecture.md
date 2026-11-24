# 维护架构

Refine 是由 Pi 加载的 TypeScript 扩展。它根据当前对话改写草稿，用户检查候选后决定是否采用。发布时保留宿主 peer 依赖和全局偏好库初始化所需的 starter JSON，见[发布清单](release.md)。维护入口见[文档索引](index.md)。

## 所有权与依赖

- [controller](../src/controller.ts) 协调 round、调度、候选和接受／恢复事务。领域记录与版本由 [history](../src/history.ts) 持有。请求类型放在 [request-types](../src/request-types.ts)，使存储和展示无需依赖 controller 实现。
- [extension](../src/extension.ts) 注册宿主入口，[runtime](../src/app/runtime.ts) 组装受限端口并管理资源生命周期。模型请求、编辑器写入和持久化各有负责模块。新增流程时让调用方只接收所需能力，避免跨模块共享整个可变状态。
- TUI、slash 和实验 Web 复用[共享应用用例](application-api.md)。同一 hosted session 的客户端可共享 controller。Web server 通过公开宿主能力连接；浏览器拥有表单和阅读状态。两者都不复制任务状态、队列或持久化。目录采集的共享任务与单次模型取消独立。
- [原生工作台](ui-conventions.md) 协调页面、焦点和唯一 overlay。模型请求及编辑器副作用由应用层处理。启用历史时，旁车文件只保存[公开说明列出的数据](tui-guide.md#local-history-and-cleanup)，生命周期失效时清理旧作用域。

## 从行为找到入口

| 要修改的行为 | 先读 |
| --- | --- |
| 命令、快捷键与宿主路由 | [注册入口](../src/extension.ts)、[命令路由](../src/app/commands.ts) |
| 用例、作用域与重试 | [应用契约](application-api.md)、[应用实现](../src/app/application.ts) |
| 请求采集、预算和模型响应 | [请求流程](../src/app/request-flows.ts)、[上下文与协议](context.md) |
| 接受、发送、恢复和过期确认 | [编辑器事务](../src/app/editor-actions.ts)、[事务回归](../test/integration/extension-editor-actions.test.ts) |
| 会话恢复、切换与历史 | [生命周期](../src/app/lifecycle.ts)、[历史存储](../src/history-store.ts) |
| 工作台输入、页面和布局 | [界面约束](ui-conventions.md)、[工作台](../src/workspace.ts) |
| Web 构建、连接和部署边界 | [Web 子包说明](../packages/pi-web/README.md) |

跨模块重构按职责和所有权拆分，保留已有入口的兼容性。验证方法见[测试与重构验收](testing.md)。
