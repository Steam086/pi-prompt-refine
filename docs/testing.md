# 测试与重构验收

在仓库根运行：

```sh
npm run typecheck
npm test
```

默认套件以离线方式运行。真实 Provider 与性能实验各有显式环境开关，普通验收保持关闭。根检查独立于 Web 子包。修改 Web 时按[子包说明](../packages/pi-web/README.md)单独运行类型检查和测试。发包再执行[打包检查与实际 tarball 试装](release.md#2-verify-without-a-model-account)。

## 按变更定位

| 要验证的边界 | 起点 |
| --- | --- |
| 冻结背景、排队、取消、会话切换 | [controller 生命周期](../test/unit/controller-lifecycle.test.ts)、[扩展 round](../test/integration/extension-rounds.test.ts) |
| 编辑器写入、发送和异步确认 | [编辑器事务](../test/integration/extension-editor-actions.test.ts) |
| Binding、对象版本、回执丢失和作用域 | [应用契约](../test/integration/application-contract.test.ts)、[幂等账本](../test/unit/application-idempotency.test.ts) |
| RPC 结果预览、纯查询和完整文本 | [RPC slash 集成](../test/integration/rpc-slash.test.ts)、[人工宿主复验](rpc-slash-v1.md) |
| 传输完整性、配额和断线恢复 | [分页](../test/unit/output-paging.test.ts)、[桥接测试](../packages/pi-web/test/bridge.test.mjs) |
| 原生主题、布局、输入隔离和焦点 | [界面维护约束](ui-conventions.md)、[跨页渲染](../test/renderer/workspace-consistency.test.ts)、[浮窗](../test/integration/extension-overlay.test.ts) |
| 偏好选择与库管理 | [交互回归](../test/integration/extension-preferences.test.ts)：Space 即时更新当前草稿，Esc 保留选择；库操作不改已选快照，两者都不提交请求。 |
| 实际改写是否保留意图和授权 | [语义验收](optimizer-evaluation.md) |

可用 `npm test -- <测试文件或目录>` 跑相关层。改共享布局时查看实际 regular／fullscreen 输出和 ANSI 断言。预期视觉变化才更新[文本快照](../test/renderer/__snapshots__/workspace-consistency.test.ts.snap)，并审阅 diff。

## 测试设施约束

- 每个 harness 独立拥有临时目录、事件处理器、终端、provider 和清理流程。销毁 session、renderer 和定时器，恢复环境变量。共享 agent-dir 的用例勿并发。
- fixtures 只存数据。复用构造和观测辅助，保留各用例的明确动作；等待可观察的完成信号，避免靠增加定时等待消除竞态。
- Pi 内部测试 API 仅从兼容辅助模块引入。参数化减少重复设置，保留用例名称和失败时的可诊断性。
- 重构前后核对用例身份、状态和覆盖的副作用，不用通过数量替代覆盖检查。保留既有导入和[项目不变量](../AGENTS.md#guardrails-and-checks)。

## 验收方式

自动化覆盖已断言的协议、行为与渲染。实体终端、中文 IME、真实 Provider 和生产认证需要专门验收。 [macOS 检查](macos-smoke-test.md) · [Web 隔离证据](multi-surface-acceptance.md) · [历史验收](history.md)
