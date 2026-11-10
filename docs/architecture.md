# 维护架构

本文确定本次行为保持型重构的目标结构和依赖边界。用户操作、配置格式和持久化格式不变；不涉及发布、CI、依赖升级或其他开源准备。历史设计取舍见 [DESIGN](../DESIGN.md)，行为说明见 [使用说明](usage.md)。

## 结构原则

- 一个 package，不引入框架、容器、全局事件总线或新的运行时依赖。
- 按可独立理解和验证的职责拆分，不为了行数机械分割函数，也不把入口的大闭包原样搬到另一文件。
- 已经内聚的小模块和既有导入路径尽量保留；本次不对所有文件做纯目录迁移。根目录的 controller、工作区和任务面板是稳定协调入口，不是导出所有内部能力的 barrel。
- 模型请求、编辑器副作用、session 生命周期与页面实现有明确所有者。新模块接收受限能力，不传递整个 ExtensionAPI 或无限扩展的可变状态袋。

## 目标结构

以下为本次落实后的结构；已有内聚小模块仍保留在 `src/` 根目录。

```text
src/
  extension.ts                 Pi 注册入口，调用应用组装函数
  request-types.ts             请求、结果和身份类型（无运行时依赖）
  controller.ts                轮次、调度、候选与接受/发送状态的唯一协调者
  app/
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
| 模型最近使用记录 | app model-selection |
| 输入/修订草稿（运行期内存） | app workspace-actions；修订页通过受限 Map 访问 |
| overlay 打开/刷新/关闭和结果阅读位置缓存 | app workspace-host |
| 主页面和 Usage 的选中/滚动位置 | 每 session 的 TaskPanelPosition，由 runtime 保留 |
| 页面内部控件、焦点、正文缓存 | 对应 UI 页面；TaskContent 不拥有选择目标 |

## 修改定位

| 要修改的行为 | 首先查看 |
| --- | --- |
| 命令和快捷键路由 | extension / app commands |
| 请求捕获、启动与修订 | app request-flows |
| 请求结构、预算、输出校验 | app completion、context、budget |
| 并发、取消、轮次、候选身份 | controller、request-types、history |
| 接受、发送、恢复与覆盖确认 | app editor-actions |
| session 恢复和销毁 | app lifecycle |
| Settings 或 Revise | 对应 ui 页面，workspace 只协调 |
| 任务树选中、归档后保留阅读 | task-panel |
| 结果、参考、Usage 正文 | ui task-content |
| Preferences 库与快照 | revision-preferences、preference-store、preference-panel |

验证层次与必须保持的行为见 [测试与重构验收](testing.md)。
