# 项目定位

Pi Prompt Refine 是 TypeScript 编写的 Pi 扩展，入口由根 `package.json` 的 `pi.extensions` 指向 `src/extension.ts`。它是后台文本改写器，不是执行任务的 Agent。原生 TUI、`/refine-api` 和可选 Web 子包复用同一应用用例；只有同一 hosted session runtime 的客户端共享状态，不跨进程或原生终端共享 controller。

## 按修改范围必读

下列文档中的维护规则仍是项目约束；移出本文件不意味着可忽略。修改相关模块前阅读对应文档：

| 范围 | 文档 |
| --- | --- |
| 模块职责、状态所有者、依赖与修改定位 | [维护架构](docs/architecture.md) |
| application、适配器、DTO、Binding、重试与传输 | [多入口应用接口](docs/application-api.md) |
| 原生 TUI、布局、样式、按键、Preferences/Revise | [界面维护约束](docs/ui-conventions.md) |
| 测试设施、回归不变量与验收 | [测试与重构验收](docs/testing.md) |
| Web 构建、安装、宿主能力与重启边界 | [Web 子包说明](packages/pi-web/README.md) |

当前操作见 [README](README.md) / [使用说明](docs/usage.md)，长期设计见 [DESIGN](DESIGN.md)。多入口实施进度与实测证据见 [进度记录](docs/multi-surface-progress.md) / [隔离验收记录](docs/multi-surface-acceptance.md)；历史设计或离线通过不能代替当前部署、人工 IME、认证或真实 Provider 验收。

## 架构核心

| 模块 | 边界 |
| --- | --- |
| `src/extension.ts`、`src/app/runtime.ts` | 注册与组装；现有 commands、request-flows、completion、lifecycle、editor-actions 等保留受限能力和局部状态，不把入口闭包整体搬家 |
| `src/controller.ts`、`history.ts`、`request-types.ts` | controller 是 round、调度、候选及接受/恢复事务的唯一协调者；history 持有领域版本，请求类型独立于实现，history/UI 不反向依赖 controller 类型 |
| `src/app/api.ts`、`ports.ts`、`application.ts` 等 | DTO/受限端口、共享用例、Binding 与领域守卫、查询投影、通知、幂等回执和模型配置；不建立第二套任务状态、队列或持久化层 |
| `src/adapters/` | TUI 本地操作、独立 `/refine-api` 命令、纯 JSON wire 校验和 session-local 事件传输；core 持有有界输入暂存及按需输出分页 |
| `src/workspace.ts`、`src/ui/`、`task-panel.ts` 等 | 页面、焦点、阅读位置和唯一原生 overlay；UI 不直接调用模型或写 Pi |
| `src/context.ts`、`project-context.ts`、`config.ts`、偏好/历史存储 | 协议与输出校验、宿主背景采集、配置和白名单持久化；保留原有格式与所有权 |
| `packages/pi-web/` | 独立 browser/server 构建与依赖；server 仅经公开 `pi-web.host / pi-session-events / v1` 连接宿主，不读 sidecar、不调用模型、不导入业务 runtime；核心不依赖 pi-web |

## 不可破坏的不变量

- round 首份输入冻结系统模板、历史及项目资源，同 round 草稿共用背景。每个运行通过 Pi `streamSimple()` 发起一次无工具改写；不继承主 Agent 工具，不执行原稿中的任务。只有 Pi 用户消息 `message_start` 才自动归档旧 round。
- 保留去重、最大并发、FIFO 排队、启动后超时、独立取消、晚到用量和过期操作守卫。关闭视图/断线不取消运行；后台完成不抢焦点、不改变阅读或操作目标。
- 保存、勾选偏好、阅读、配置和连接本身不提交模型请求。只有原生 Unsent 的 Enter、Revise 的 Ctrl+S 等已有明确优化动作，以及 API 的显式运行才提交。Apply 仅切换 Refine 当前结果；接受/发送/恢复仍须明确动作及 session/candidate/编辑器确认守卫。Web 当前不提供 accept/send/restore。
- Binding 为 `{ runtimeId, sessionId, lifecycleEpoch }`，任务/运行 ID 必须与其一起使用。生命周期失效、领域版本冲突、未知/过期重试不得静默迁移或重新执行；丢失回执先查原 lease/operation，不能换 nonce 盲目重试。本地 TUI 复用用例和守卫，不强行套远端账本；高级原生流程保留兼容边界。
- 原生展示同步更新，远端 invalidation 合并通知；时钟读取不增加领域版本。浏览器表单、回执和运行目标绑定原 scope，不覆盖后续本地编辑，不因下拉选项迟到而丢失目标。
- 对外只暴露脱离内部记录的白名单 DTO，不泄露完整背景、prepared input、凭据、原始 Provider 响应或内部路径。sidecar 仍是最小白名单；恢复记录没有可重跑的旧背景，只能显式复制到当前 round。读取与传输必须有界，超额明确拒绝，不截断为假成功。
- 保留旧 `/refine` 和快捷键；`/refine-api` 不求值 shell、不写模型 transcript，错误或命名冲突不能退化为 Agent 请求。Web 只按宿主权威 workspace/session 路由，不接受客户端文件路径；事件总线和 Host/Origin 检查都不是身份认证。
- 原生 TUI 保持唯一稳定 overlay、每个视图唯一水平分割所有者，阅读焦点与动作目标分离。复用主题 token、`key-hints.ts` 和 ANSI-aware 列宽工具；正文可读、错误可见、输入不泄漏到外层动作。详细样式及子页规则见必读界面文档。

## 修改与验证

- 保持既有行为与导入兼容；不升级依赖、不改发布配置、不引入框架。不要为行数压缩代码、删除回归测试，或把整个可变应用状态传给所有新模块。
- 根检查：`npm run typecheck`、`npm test`。`test/` 按 unit/integration/ui/renderer/live/benchmarks 分层，support 每测试独立且可销毁，fixtures 只存数据；保持原用例身份和默认跳过策略。
- Web 修改另在 `packages/pi-web/` 执行 `npm run typecheck`、`npm test`（先安装该子包依赖）；根检查不覆盖它，也不得依赖它才能运行。保持 browser/server 构建图隔离，不把 Node 或业务 runtime 引入浏览器。
- 修改视图需覆盖明暗、窄/短与宽屏、Unicode/ANSI、resize、焦点、滚动和确认；原生保留 regular/fullscreen 渲染覆盖。自动截图不替代人工视觉或 IME。
- 真实 Provider 调用和宿主部署/重启分别需要明确授权；live/benchmark 保持显式环境变量启用策略，不因普通测试或构建擅自启用。隔离实例使用独立 data/socket/port/agent profile，不复制凭据、不继承当前宿主的 live state；重启 session daemon 会中断活动会话和终端，须先告知。
