# 维护架构

本文说明行为保持型重构和多入口第一切片落实后的维护结构与依赖边界。新增 application、`/refine-api` 与独立 Web 子包，保留原有 TUI 行为、根配置及 sidecar 格式；不以此进行根依赖升级或发布配置迁移。历史设计取舍见 [DESIGN](../DESIGN.md)，行为说明见 [使用说明](usage.md)。

## 结构原则

- 核心保持一个独立 package，不引入框架、容器、全局事件总线或新的运行时依赖。可选 `packages/pi-web/` 单独构建并锁定开发依赖，核心不依赖该子包或 pi-web。
- 按可独立理解和验证的职责拆分，不为了行数机械分割函数，也不把入口的大闭包原样搬到另一文件。
- 已经内聚的小模块和既有导入路径尽量保留；本次不对所有文件做纯目录迁移。根目录的 controller、工作区和任务面板是稳定协调入口，不是导出所有内部能力的 barrel。
- 模型请求、编辑器副作用、session 生命周期与页面实现有明确所有者。新模块接收受限能力，不传递整个 ExtensionAPI 或无限扩展的可变状态袋。

## 当前结构

已有内聚小模块仍保留在 `src/` 根目录；多入口只迁移首片用例，高级原生流程保留兼容边界。

```text
src/
  extension.ts                 Pi 注册入口，调用应用组装函数
  request-types.ts             请求、结果和身份类型（无运行时依赖）
  controller.ts                轮次、调度、候选与接受/发送状态的唯一协调者
  app/
    api.ts / ports.ts          无宿主依赖的公开 DTO 与受限内部能力
    application.ts            可信 Binding、查询与第一切片用例；不持有第二套任务状态
    queries.ts / events.ts     白名单投影、共享排序、合并 invalidation
    idempotency.ts             有界 lease/操作回执账本；不持久化任务
    model-service.ts           默认优化模型、thinking、配置版本与保存状态
    model-utils.ts             模型身份与 thinking 纯辅助，不依赖 picker
    contracts.ts               应用边界使用的受限能力和状态契约
    runtime.ts                 依赖组装、配置写队列、后台状态与当前宿主 context
    commands.ts                slash command 和快捷键动作路由
    request-flows.ts           原稿捕获、启动/修订流程与背景展示摘要
    completion.ts              一次模型请求的准备、预算、调用和输出处理
    context-jobs.ts             共享目录采集任务、复用与销毁
    model-selection.ts         模型选择、确认校验和 thinking 记忆流程
    editor-actions.ts          接受、编辑、发送、恢复及异步确认守卫
    lifecycle.ts               session 恢复、切换与关闭
    workspace-host.ts          唯一工作台的挂载、刷新、关闭与结果动作分发
    workspace-actions.ts       向工作区提供受限操作和数据快照
  adapters/
    wire.ts                    纯 JSON 白名单校验；浏览器可编译
    session-events.ts          Pi session-local 事件传输与有界临时文本
    json-output.ts             白名单 DTO 的惰性 JSON 编码，按需输出单页
    slash.ts                   /refine-api 解析与非 transcript 输出
    tui-operations.ts          原生同步 UI 到共享用例的受限适配
  ui/
    settings-page.ts           Settings 与数值编辑、保存反馈
    revise-page.ts             修订输入、要求阅读与来源布局
    task-content.ts            原稿、结果/参考和用量正文展示
    task-documents.ts          帮助与保存状态文档
    task-preferences.ts        内联偏好选择的有界布局
  workspace.ts                 页面切换、子页生命周期与输入优先级
  task-panel.ts                任务选择、阅读位置与动作协调
  preview.ts                   兼容结果页与只读来源快照
  config.ts                    既有配置校验与存储
  history.ts / history-store.ts
  context.ts / budget.ts / project-context.ts
  revision-preferences.ts / preference-store.ts
  preference-panel.ts / inline-preferences.ts
  ...                          共享布局、提示、模型展示、用量和文本安全小模块

packages/pi-web/
  src/browser/                 面板、scope 绑定的表单/运行目标与重试客户端
  src/server/                  公开宿主 capability 适配；不持有业务任务
  tsconfig.browser.json        独立浏览器构建，不引入 Node
  tsconfig.server.json         独立服务端构建
  test/                        core wire + browser/server 契约与构建图检查

test/
  support/                     每测试独立的 extension harness、终端设施与异步辅助
  fixtures/                    测试数据，不承担流程
  unit/                        controller、协议、预算、配置、存储和纯逻辑
  integration/                 命令、模型选择、session、编辑器提交、修订和工作区流程
  ui/                          组件输入、焦点、展示及布局
  renderer/                    实际 Pi regular/fullscreen 渲染器捕获
  live/                        显式启用的真实 Provider 实验
  benchmarks/                  显式启用的可选性能实验
```

`commands.ts` 和 `request-flows.ts` 是实施时进一步明确的两个流程边界，避免 runtime 再次承担原入口的实现。没有引入占位模块或全仓路径兼容转发层；controller 仅保留原有类型导出的兼容性，内部消费者使用 request-types。通常一个文件数百行即可；超过约 600 行或单个处理函数超过约 100 行时应检查职责，但不作为压缩代码或移除测试的理由。

## 状态与依赖

1. `extension.ts` 注册 Pi 命令、快捷键和事件，交给应用模块；入口不实现模型选择器、编辑器确认或完整工作台。
2. 应用模块以 `Pick<RefineController, ...>` 声明实际所需能力，配置也按字段受限；UI 不直接调用模型、写 Pi 编辑器或发送消息。
3. controller 保持现有身份、轮次、排队和接受事务语义。其他模块不维护第二套候选、运行队列或 round 真相。
4. 请求类型独立于 controller 实现。history、展示和存储可以引用类型，不通过类型反向依赖 controller。
5. 模型调用适配器只持有请求和必要的宿主能力；通过显式回调报告 prepared input、budget、诊断，不操作选中项。
6. 目录采集共享缓存与单次模型取消相互独立；生命周期销毁清理共享任务。
7. 工作区拥有唯一原生 overlay 与稳定尺寸；页面仅在分配的画布内渲染。任务浏览、结果详情和 Compare 各自保持唯一水平分割所有者。
8. 输入按子页/确认、编辑器、当前页面、外层动作的优先级消费，阅读焦点与操作目标分离。
9. 历史磁盘 DTO 继续采用最小白名单；不得序列化整个请求或应用对象。恢复记录没有可执行的旧背景。

## 状态所有者

| 状态 | 唯一所有者 |
| --- | --- |
| round、活动请求、队列、候选、接受/恢复快照 | controller |
| 当前 UI/请求宿主 context、配置写队列、后台计时器 | app runtime |
| 共享目录采集任务及 AbortController | app context-jobs |
| sidecar writer、恢复 epoch、已命名 session | app lifecycle |
| runtime Binding/lifecycleEpoch、应用 revision、lease/回执 | app application / events / idempotency |
| task/run 领域版本 | history；不写入 sidecar |
| optimizer 版本与持久化状态 | app model-service |
| 输入分块、输出 DTO/惰性编码器、订阅与传输配额 | core adapters/session-events；按 Binding/connection 清理 |
| Web 本地表单、选中 run、连接与待恢复操作 | Web browser；始终保留原作用域，不拥有业务运行队列 |
| 宿主 capability 连接、请求截止与 in-flight frame | Web server；不缓存整份编码输出、不按客户端路径路由 |
| 模型最近使用记录 | app model-selection |
| 输入/修订草稿（运行期内存） | app workspace-actions；修订页通过受限 Map 访问 |
| overlay 打开/刷新/关闭和结果阅读位置缓存 | app workspace-host |
| 主页面和 Usage 的选中/滚动位置 | 每 session 的 TaskPanelPosition，由 runtime 保留 |
| 页面内部控件、焦点、正文缓存 | 对应 UI 页面；TaskContent 不拥有选择目标 |

## 修改定位

| 要修改的行为 | 首先查看 |
| --- | --- |
| 旧 `/refine` 和快捷键路由 | extension / app commands |
| `/refine-api` 解析、命名冲突与输出 | extension / adapters slash |
| 共享用例、Binding、版本与重试 | app application、history、idempotency、model-service |
| 查询 DTO、排序与通知 | app queries / events；原生同步、远端合并 |
| 临时输入、长结果分页与配额 | adapters wire / session-events / json-output |
| Web 表单/连接/选中目标或宿主桥接 | packages/pi-web 的 browser 或 server |
| 请求捕获、启动与修订 | app request-flows |
| 请求结构、预算、输出校验 | app completion、context、budget |
| 并发、取消、轮次、候选身份 | controller、request-types、history |
| 接受、发送、恢复与覆盖确认 | app editor-actions |
| session 恢复和销毁 | app lifecycle |
| Settings 或 Revise | 对应 ui 页面，workspace 只协调 |
| 任务树选中、归档后保留阅读 | task-panel |
| 结果、参考、Usage 正文 | ui task-content |
| Preferences 库、项目默认与快照 | revision-preferences、preference-store、project-preference-defaults、preference-panel |

验证层次与必须保持的行为见 [测试与重构验收](testing.md)，详细界面规则见 [界面维护约束](ui-conventions.md)。应用契约与 TUI 兼容迁移边界见 [多入口应用接口](application-api.md)；已完成的隔离宿主检查及未验收项见 [隔离验收记录](multi-surface-acceptance.md)，不要把历史验证状态视为当前生产部署状态。
