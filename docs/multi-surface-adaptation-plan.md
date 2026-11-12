# TUI / Web UI / Slash 三端对齐实施计划

状态：待实施。本文只规划重构、接入与验证，不表示功能已实现，也不授权宿主改造、依赖升级、发布配置修改或服务重启。

首个 Web 宿主已明确为当前机器正在运行的 [jmfederico/pi-web](https://github.com/jmfederico/pi-web)。核心 Application API 保持宿主无关；首个 Web 桥接与实际端到端验收针对该运行实例。上游仓库用于参考，不能代替核对本机安装版本及其实际能力。

## 1. 目标与实施原则

目标是同一个 Refine 应用核心服务三个入口，而不是复制三套业务逻辑：

```text
TUI adapter ───────────────┐
Slash parser + presenter ──┼── Application API ── controller / use cases
Web UI + transport ────────┘                           │
                                          Pi host ports / repositories
```

Slash 是输入方式，也可能出现在 TUI 或 Web 中；它不是独立运行环境。Application API 首先是进程内 TypeScript 契约，不等于 HTTP API。Web 的实际传输由宿主能力决定。

实施单位是业务纵向切片：补齐基线 → 抽出业务操作 → 原 TUI 接入 → slash 接入 → Web 接入 → 跨端验证。每一步都验证，不等三个端全部完成才补测试。不先进行全仓目录搬迁，也不先重写 TUI。

对齐意味着相同输入、身份、配置和业务状态下具有相同操作语义、结果及副作用；不要求三端拥有相同布局、快捷键或确认组件。滚动、搜索焦点、比较布局属于端内交互，不要求设计等价 slash 指令。

## 2. 当前代码事实与约束

本计划依据当前 `src/` 入口、应用组装和业务流程，以及 [架构](architecture.md)、[使用说明](usage.md)、[测试约束](testing.md)、[设计原则](../DESIGN.md) 和现有测试目录制定。实施时仍需逐切片阅读对应实现和展开用例，不能把本计划当作逐行审计完成证明。

| 当前模块 | 可保留的职责 | 需要调整的边界 |
| --- | --- | --- |
| `extension.ts`、`app/commands.ts` | Pi 注册、兼容命令入口 | 将语法解析、业务执行、UI 打开/输出分开 |
| `controller.ts`、`request-types.ts` | round、任务/运行、队列、取消、候选、接受/恢复/发送状态 | 显式目标操作，避免多端借助全局 applied candidate 争抢目标；不另建业务状态副本 |
| `app/runtime.ts` | 依赖组装、配置写队列 | 当前 `currentUiContext` / `completionContext`、状态更新、TUI 定时刷新需拆开所有权 |
| `app/request-flows.ts` | 捕获、启动、修订、冻结输入 | `triggerOptimize()` 混有 TUI 模式检查、编辑器读写、通知和打开预览 |
| `app/completion.ts`、`context-jobs.ts` | 无工具模型调用、预算、目录共享准备 | completion 也有 `ctx.mode !== "tui"` 限制，不能只移除入口限制；宿主执行能力需独立绑定 |
| `app/workspace-actions.ts` | 已集中多数工作台操作 | API 类型来自 `RefineWorkspace` 构造参数；业务与 mount、位置、关闭标记、UI 回调耦合 |
| `app/model-selection.ts` | 模型查询、thinking 规范化、记忆及默认设置 | picker、模型服务、任务追加运行、TUI 定位需分离 |
| `app/editor-actions.ts` | 接受、编辑、发送、恢复及过期守卫 | `ctx.ui.editor/confirm/getEditorText/setEditorText` 与事务混合；当前发送本身是显式动作，不应擅自新增统一弹窗 |
| `app/lifecycle.ts` | sidecar、恢复 epoch、session 命名、切换及关闭 | 历史清理确认依赖 UI；存储更新直接 refreshPreview；命名依赖当前 UI context |
| `workspace.ts`、`task-panel.ts`、`preview.ts`、`ui/` | TUI 页面、布局、焦点、阅读与键位 | 保留为 TUI；不成为 Web 的领域数据来源 |
| `preference-store.ts`、`project-preference-defaults.ts`、`revision-preferences.ts` | 并发安全库、默认项、快照与组合 | 向应用层提供受限服务，不向浏览器暴露文件仓库/路径访问能力 |
| `config.ts`、`settings.ts` | 配置校验与持久化、设置语义 | 区分业务配置与仅 TUI 键位；表单暂存与已应用配置分开 |
| `history.ts`、`history-store.ts`、`usage.ts` | 有界日志、最小 sidecar、用量归一化 | 增加面向客户端的白名单查询投影，不直接序列化内部 request |
| `background-status.ts`、`presentation.ts` 等 | 展示格式、已查看提醒 | 共享纯数据推导，ANSI、主题、阅读确认归各端 |

当前仓库是 Pi TypeScript 扩展，没有已经确认可复用的浏览器入口、Web 路由或编辑器桥接契约。不能假定 `ctx.ui.custom()` 可以在 Web 中运行，也不能假定已有 HTTP/WebSocket 接口。`package.json` 当前无 Web 框架；本计划不预设新增框架。

文档若存在旧描述，以当前实现、回归测试及最新使用说明交叉确认，例如快捷键捕获只入 Unsent，不能照搬旧的自动启动叙述。

## 3. 全程不变量

1. 一个 session runtime 中只有一个 controller 和 sidecar writer；多个界面连接不创建多个优化器实例。首版不支持多个进程同时写同一 session sidecar。
2. 一次运行仍是一次无工具改写，不执行原稿任务，不引入额外模型调用、自动重试或 Provider 回退。
3. round 首次捕获冻结背景；多草稿共享 round 背景；追加模型从共同原稿开始；修订沿用来源背景；配置不偷偷刷新旧任务。
4. 并发上限 4、FIFO 排队、实际启动后计时、独立取消、晚到用量记账但结果不复活保持不变。
5. 只有 Pi 用户消息 `message_start` 归档 round；预检、投递返回、排队、断线均不等于消息开始。普通发送归档不取消旧运行；session/branch 生命周期失效保持现有行为。
6. 浏览不写编辑器、不发送、不请求模型；接受不等于发送；发送保留编辑器，忙时 followUp；恢复只恢复一次实际替换前的草稿。
7. 当前 Unsent 可修改；已运行/旧轮次编辑创建当前轮次副本；已提交要求快照不可被库更新改写。
8. 历史恢复不带完整背景，不允许原背景重跑/修订；只能显式复制到当前 round。内存中的旧 round 与磁盘恢复记录不能混为一谈。
9. 历史维持最小白名单、容量、权限、原子写、保存暂停；不新增背景、payload、未提交修订或界面状态落盘。
10. TUI 单 overlay、稳定几何、主题、输入消费、显式提交、未提交修订保留和已有兼容入口不退化。
11. UI 断开/关闭不取消运行；完整宿主 shutdown 仍清理执行资源。通知或传输失败不能撤销已经成功的业务提交。

## 4. 目标契约与状态所有权

建议按实际切片逐步增加 `app/api.ts`、`app/ports.ts`、`app/queries.ts` 及有界通知契约；操作变多后按 drafts/runs/results/settings/preferences 分模块。禁止形成转发所有内部方法的巨大 facade 或把整个 ExtensionAPI 传入核心。

### 4.1 操作、查询、订阅

- 操作：类型化输入、明确业务目标、结构化结果；不能返回只能在同一个 UI mount 中调用的保存闭包。
- 查询：summary/detail 分离，返回不可变 DTO 和动作可用性/禁用原因。
- 订阅：实例内有界的状态失效通知，不引入全局事件总线。先采用 snapshot + revision + invalidation，不急于实现复杂 patch 或完整 token 流。
- 输出：`ok / confirmation-required / conflict / unsupported / error` 等稳定判别类型；保留 started、queued、duplicate、capacity 等业务差异和机器可读原因。
- 可用性是展示提示，不是授权；执行时重新校验。

### 4.2 身份与版本

- 请求明确绑定宿主 runtime epoch、session、必要时 branch、task/run/result 身份；不能仅用一个局部数字跨 session 操作。
- 分开领域对象版本、订阅 revision、生命周期 epoch、编辑器 revision。耗时刷新或其他运行完成不应让无关编辑失效。
- 核查现有 `CandidateToken.generation` 的用途，保留生命周期和结果过期保护，但不能把 UI 切换 applied candidate 作为跨端操作的必要步骤。
- 不通过读取客户端传来的 sessionId 自动切换宿主 session；不匹配时拒绝。

### 4.3 状态所有者

| 状态 | 所有者 |
| --- | --- |
| round、任务、运行、结果、调度、发送状态 | controller |
| 配置与保存队列、业务诊断、模型服务 | 应用服务 |
| 宿主 session/branch 绑定、模型认证和发送能力 | Pi adapter；凭据不传客户端 |
| sidecar writer、恢复 epoch、命名策略 | lifecycle 服务 |
| 焦点、选中项、滚动、展开、比较左右位置 | 各客户端；TUI 保持现有 session 内记忆 |
| 未提交输入/修订表单 | 各客户端，或按 client + session + source 隔离的有界内存草稿；不默认跨端实时共享、不落 sidecar |
| 已保存 Unsent 及偏好选择快照 | 业务状态，三端共享并带版本校验 |
| 接受/恢复事务 | 唯一事务协调者；明确 editor target，不复制到各前端 |
| 已查看提醒 | 各端阅读状态；不得因 Web 读取列表自动清除 TUI 未读提醒 |

### 4.4 宿主端口与副作用

按受限能力定义 Context/Model/Completion、Editor、Send、SessionMetadata 等端口。存储继续在服务端。应用层不依赖 `Theme`、ANSI、TUI Component、`ctx.ui` 或 workspace 构造类型。

- Editor 需要明确 target、读取和带预期版本的替换；如果宿主不能原子校验并替换，先证明等价的串行保护，否则该端不开放接受/恢复。
- TUI 编辑器和 Web composer 是否同一逻辑缓冲区必须实测。不同目标的恢复快照不得互相应用。保持每目标仅一次恢复，不扩展为撤销历史。
- 需要确认时返回有期限、一次性、绑定操作/目标/版本/调用者的凭据；确认时重新检查业务、session 和编辑器。取消/过期不修改状态。
- 保留现有确认策略：接受/恢复覆盖冲突、历史清理、库删除等；“明确发送”不自动新增二次确认。
- 对远程重试采用有界幂等账本：作用域含 runtime/session/client + operationId，同 ID 不同参数拒绝。同一次提交重试复用结果；用户有意再次运行使用新 ID，不与模型运行去重混淆。
- 幂等保证限于有效 runtime/保留窗口；进程重启、账本过期或发送确认超时后不能宣称 exactly-once，显示未知并要求核查，不自动重发。

## 5. 功能对齐矩阵

阶段编号见下一节。所有行最终都需记录三端状态，不用“Web 已连接”代替功能验收。

| 能力 | 共用应用接口（概念名） | TUI | Slash | Web | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 当前/历史原稿与运行、详情、参考、用量、诊断 | listTasks/listRuns/getRun/getUsage | 保留树和详情 | 文本/可选结构化查询 | 列表、详情、订阅更新 | P1–P3 |
| 新建、编辑、复制、取消临时稿 | create/update/copy/removeDraft | 保留 n/i 保存边界 | 显式文本及 ID | 编辑表单 | P3 |
| 快捷捕获去重与直接优化 | captureDraft/optimizeText | 快捷键只捕获 | 兼容 optimize 直接启动 | 分开保存与优化按钮 | P3 |
| 模型/默认 thinking/收藏与单次运行 | listModels/setDefaultModel/startRun | picker，单次不改默认 | 参数化选择 | 模型控件 | P3–P4 |
| 排队、取消、同原稿重试/追加 | startRun/stopRun | 保留目标 x/m | 按运行/原稿 ID | 目标操作 | P4 |
| 编辑结果、修订、参考和比较 | editResult/revise/getRun | e/f/c，保留来源 | 明确结果 ID 与要求；读取两结果 | 结果编辑/修订/比较 | P5 |
| 接受、发送、恢复、会话命名 | accept/send/restore | 兼容现有体验 | 明确目标及确认协议 | capability 控制 | P6 |
| 偏好库、项目默认、单次快照 | preference services | 内联及完整子页 | 显式 CRUD/选择 | 库、选择与管理表单 | P7 |
| Context/Optimizer/Advanced/策略 | get/validate/updateSettings | 保留暂存/保存边界 | 查询与显式更新 | 表单、冲突与保存反馈 | P8 |
| 历史持久化状态、记录删除、sidecar 清理 | getStorage/deleteRecords/clearSavedHistory | Usage 与确认 | 明确区分命令 | 明确区分操作 | P9 |
| 兼容 view、候选切换、状态/帮助 | 查询 + 端内行为 | 保留兼容页面及快捷键 | 老命令继续可用，新帮助 | 等价阅读/状态能力 | P9 |
| reload/resume/switch/fork/tree/shutdown | 宿主事件入口 | 原行为 | 输出失效结果 | 连接失效/重新取快照 | P2、P9 |

说明：复制到剪贴板不等于接受。Web 缺 editor/send 能力时只能标记 unsupported，不能以复制按钮宣称完整对齐；最终发布需明确该差距或补齐宿主桥接。

## 6. 分阶段实施与退出条件

### P0 — 基线、能力核实与范围锁定

**工作**
- 记录实施起点 commit、工作区状态、typecheck、全量展开用例名称/状态；用户已有未跟踪 `foundations.md` 不纳入本次修改。
- 将第 5 节矩阵细化为操作与副作用清单，对照 `commands.ts`、workspace、兼容 preview、Settings 和 Preferences；记录现有别名与模式限制。
- 核实首个目标宿主——本机正在运行的 jmfederico/pi-web：先记录实际版本、安装/源码位置及与上游的差异，再核实插件页面入口、请求/响应通道、事件订阅、session 授权、模型/context 能力、编辑器读写与版本、发送回执、断线行为、构建/安装方式。不能以最新上游接口推定本机已支持。
- 开始宿主实现前，完整阅读相关 Pi 扩展/SDK 文档与示例及交叉引用；只使用公开能力，不能把测试内部 API 用作生产方案。
- 决定 Web UI 所属仓库及传输适配的责任边界。首选复用宿主已认证通道，不默认启动额外公开 HTTP 服务。

**验证/退出**
- 输出实际基线与宿主能力表，每项注明 verified / unsupported / unknown 和证据。
- 本计划不是宿主核实结果；若宿主缺桥接，记录外部依赖与最小扩展需求，获得对应实施授权后再动宿主。
- Web 被阻塞不妨碍核心/TUI/slash 推进，但相关切片只能标记部分完成，不能宣称三端完成。
- 本机 pi-web 是承载当前会话的运行实例。能力核实优先只读；需要实验性第二实例时使用隔离的数据目录、daemon socket 和端口。未获明确授权不得停止或重启承载当前会话的 daemon；需要修改宿主、部署或中断活动会话时另行确认。

### P1 — 只读 API 与最小三端查询切片

**Refactor**
- 从 history/controller 提取白名单 DTO：task/run summary、result/reference detail、usage、diagnostic、能力与禁用原因。
- 原 TUI 的列表/详情先经查询接口读取，保留原排序、选中和阅读位置，不强制重写渲染组件。
- DTO 不暴露完整 history snapshot、system prompt、prepared/sent payload、认证或任意文件路径；有意提供的用户策略/存储信息走专用授权查询。

**接入**
- Slash 增加显式列表/详情查询入口，输出不写入主 Agent 对话或模型上下文。
- Web 最小页面：只读任务列表与结果正文；正文按文本渲染，后续 Markdown 也须安全处理。

**验证/退出**
- 三端同 fixture 的 ID、顺序、内容、状态和用量一致；查询没有 Apply、模型调用、写编辑器/发送副作用。
- DTO 白名单测试、对象不可变测试；控制字符/ANSI、中文/emoji 和恶意 HTML 不造成 UI 注入。
- Web 真实宿主入口可打开并查询才算 Web 项通过；mock transport 仅算契约验证。

### P2 — 会话绑定、订阅与可用能力基础

**Refactor**
- runtime 分离宿主执行 context 与 TUI presentation context，维护显式 epoch；禁止最后一个 UI 请求覆盖正在执行任务的宿主绑定。
- controller 状态通知分别供 history 保存、应用事件与 TUI 展示使用；storage-only 更新和配置/偏好更新也有可观察事件，不只监听 controller。
- 后台时钟刷新与业务 revision 分离，避免每秒改变对象版本或重复写盘。
- 保留 context-jobs 的共享取消与销毁边界，准备移除 completion 的 TUI 限制，但必须以真实执行能力校验替代。

**接入**
- TUI 使用应用订阅刷新；Web 订阅失效通知并重新查询；slash 查询获取一致快照并显示稳定 ID。
- 定义 subscribe/snapshot 顺序或游标握手，避免取快照与订阅之间漏事件；慢客户端通知合并、有界缓冲，断线重连全量 resync。

**验证/退出**
- 两客户端不生成两个 controller/writer；乱序、漏事件、重复事件、断线、shutdown 均不会重复执行或跨 session 泄漏。
- 无 TUI mount 的 runtime 能恢复历史、查询与接收业务事件；TUI 定时器/订阅销毁无泄漏。
- session 切换后旧连接和旧请求被拒绝，不通过请求参数切换宿主会话。

### P3 — 创建原稿 → 启动优化 → 查询结果

**Refactor**
- 拆分 `triggerOptimize()`：显式文本操作、可选编辑器捕获、UI 提示/跳转分别负责；直接文本操作不要求 editor capability。
- 提取 createDraft、captureDraft、updateDraft、copyToCurrent、removeDraft、optimizeText/startRun；保持显式新建同文可重复与快捷捕获去重的区别。
- 模型服务先支持查询、有效性校验和设置默认模型，使非 TUI 用户可完成首次配置；thinking 规范化不依赖 picker。
- 提取宿主 context/model execution ports；移除 request-flows 与 completion 的模式判断时补齐能力/epoch 校验，冻结实际执行所需引用。
- 保留直接 slash 在空编辑器中恢复 supplied draft 的既有 TUI 行为，但放在兼容适配器，不成为 API 隐式副作用。
- 新原稿仍初始化项目默认；首次切片即需保留偏好快照初始化，不等到 P7 才补。

**接入**
- 原 TUI n/i/快捷捕获/Enter 调用 API；临时创建后的取消清理和位置恢复仍由明确事务与 TUI 协作。
- Slash 支持显式文本和 ID 操作；保留旧 `/refine <text>` 与 optimize 行为。
- Web 提供草稿编辑、保存、优化、运行状态和结果；保存/编辑绝不自动请求。

**验证/退出**
- 无 `ctx.ui` 的 harness 可完成首次模型配置、保存草稿、运行和查询；模型调用次数恰为预期。
- 未配置模型可新建草稿；空白/超长拒绝启动；重复捕获、同文显式新建、容量拒绝、保存期间启动/换轮竞态通过。
- round 背景冻结、项目目录/预算/输出解析/reference-preservation 相关回归不变。
- 第一条真实三端端到端路径验收完成，再展开后续功能。

### P4 — 多模型、排队、重试与取消

**Refactor**
- 将 model-selection 中列表数据、thinking 记忆、默认设置、单次任务运行与 picker 彻底拆开。
- 显式 task/run 目标；一次运行参数不改变默认模型；UI 定位重复运行由适配器处理。
- 业务返回 started/queued/duplicate/rejected 与目标 ID，不能仅 notify 后返回 void。

**接入**
- TUI 保留 m、x、默认 model/cycle；slash 指定模型/thinking 和停止目标；Web 对原稿追加模型、对运行取消。

**验证/退出**
- 三端共享 4 并发/FIFO；关闭任一界面不中止任务；同模型在途去重与完成后显式重跑区别正确。
- 部分运行失败/取消不影响其他运行与共享目录准备；排队不计超时、迟到结果不复活、迟到用量保留。
- 默认模型、单次 thinking、收藏与最近记录语义不被混淆；不可用模型、认证失效结构化报错。

### P5 — 显式结果身份、编辑与修订

**Refactor**
- controller 增加/调整按结果身份操作的路径，不用临时 applyResult 再执行来掩盖全局目标竞态。
- 新接口携带 expected result version 与 lifecycle 身份；兼容 applied candidate 只服务旧入口，不成为所有端的共享选择。
- 手工编辑保存独立版本；修订从明确来源生成，纯要求组合由共享服务完成；未提交表单按 client/session/source 隔离。

**接入**
- TUI e/f 保持输入、来源阅读、Ctrl+S 与取消行为；slash 接收结果 ID 和完整要求；Web 提供来源、编辑、修订和双结果比较。
- 比较使用只读查询，布局和阅读位置端内管理，不新增模型调用。

**验证/退出**
- TUI 选 A、Web 选 B，各自操作始终命中明确目标；查看/选中另一结果不能改变已打开表单的提交目标。
- 同对象并发修改冲突，无关对象更新不冲突；换 session/branch 或来源失效时拒绝旧提交。
- 修订失败保留来源，要求历史不无限累积；恢复记录拒绝修订；手工编辑没有模型用量继承。
- 兼容 view 的候选切换、已接受只读快照及回退行为仍通过回归。

### P6 — 接受、发送、恢复与确认事务

**Refactor**
- 拆分 UI editor/confirm 与结果操作；实现 editor target、预期版本替换、确认凭据和有界幂等账本。
- 审核当前 controller 同步 writeEditor 回调与 Web 异步编辑器桥接的差异：只有写入确认成功后才提交 accepted/restore 状态；错误、取消或超时不可先标成功。
- 发送绑定明确结果，保留 pending-send 守卫、busy followUp、失败处理、确认超时不自动重发；与主消息开始事件正确关联。
- 会话命名从 UI context 解耦，只在现有成功边界且尚未命名时执行，命名失败不回滚接受。

**接入**
- TUI 使用原确认/编辑器体验；slash 提交目标并在需要时提供明确 confirm 后续入口；Web 使用实际宿主 composer 桥接。
- 缺失能力返回 unsupported，复制作为不同动作，不假装接受或发送成功。

**验证/退出**
- 覆盖确认期间编辑器修改、结果改变、切 session/branch、凭据过期/重放、另一客户端提交等竞态。
- 接受/恢复写入失败不更新成功状态；不同 editor target 不可套用恢复快照。
- 重复请求不重复发送；同 ID 不同参数拒绝；发送超时状态可查询且不会诱导自动重试。
- message_start 才归档；发送保留草稿；会话命名不覆盖用户新名称。
- 若宿主不支持可靠编辑器事务，此阶段 Web 接受/恢复保持阻塞，不削弱保护来完成表格。

### P7 — Preferences 库、项目默认与选择

**Refactor**
- 将 workspace 的原稿选择提交、Revise 组合校验、库管理与项目默认统一到受限服务；复用既有 repository 锁和 expected version。
- 不把库正文作为客户端提交的可信“已选项”；客户端按库身份/版本选择，服务端建立快照并校验已删除/已更新项。
- 保持 inline 立即更新当前 Unsent 与子页暂存带回的差异；库保存、默认更新与单次选择是三个不同提交边界。

**接入**
- TUI 不改变 Space/Enter/Alt+Enter/Ctrl+S 边界；slash 提供 CRUD、明确选择及项目默认操作；Web 区分管理、当前选择、来源快照与库最新版。

**验证/退出**
- 两端编辑同一库条目产生版本冲突；锁忙、写盘失败、损坏库不空覆盖；无任意路径写入。
- 修改/删除库不改冻结要求；新建/复制初始化项目默认，编辑保留选择，重试/修订不偷偷重新应用默认。
- 组合顺序、去重、长度上限、快照来源、已删除但已选项与清空行为一致；浏览和保存库模型调用为零。
- TUI 搜索/全文输入不泄漏；Web IME composition 和 Enter 不误提交。

### P8 — Settings、策略与配置持久化

**Refactor**
- 从 workspace-actions/model-selection 提取设置查询、严格 patch 校验、expected config version、保存和策略更新。
- 复用 config 存储及写队列；非法配置保持禁止覆盖；区分 applied/persisted/生效范围。
- 当前加载配置的容错默认不等于远程写 API 的校验：未知字段、越界值、错误类型必须明确拒绝，不能静默回退后保存。
- UI 表单暂存属于各端；Context/限制统一保存边界和模型/thinking/策略独立保存边界保持现状。

**接入**
- TUI 原页面调用服务；slash 提供查询与字段白名单更新；Web 提供 Context/Optimizer/Advanced 与策略编辑。
- TUI 专属快捷键不强行移植到浏览器；可作为宿主设置显示，但不能承诺 Web 同样生效。

**验证/退出**
- 并发保存冲突、写队列顺序、失败后仅内存生效反馈一致；无丢失更新。
- Context/策略下一 round 生效；模型用于下一次显式运行；请求限制按现有实际启动时取值边界冻结，不擅改排队与在途语义。
- 取消表单不改变未提交配置；已生效但未持久化的设置不被取消伪装成回滚。

### P9 — 历史、生命周期及兼容功能闭环

**Refactor/接入**
- 清晰分开 deleteRecords 与 clearSavedHistory：后者只清 sidecar、保留内存记录、暂停保存直到 reload，不能映射成“清空工作区”。
- 将 history storage 更新、保存/省略编号、错误通过查询/订阅提供；授权后才显示必要的本地路径诊断。
- 完成 resume/reload/switch/fork/tree/shutdown 流程，取消旧订阅/确认，flush store，清理 context jobs；跨端恢复为只读历史而非重启队列。
- 清点旧 `/refine`、view、history/usage、cancel/dismiss、cycle、restore、兼容 preview i/g/r/[ ]/z 等路径，保留语义或提供明确兼容映射。
- 完成后台状态、错误/预算警告、帮助和能力缺失说明；操作反馈不能只依赖瞬时 toast。

**验证/退出**
- 原 history-store、extension-history、rounds、session naming/status 测试通过；容量与最小白名单没有扩张。
- 历史清理与在途 save/restore 竞态通过；失败保持正确暂停状态，不影响偏好库/项目默认。
- 客户端归档后保留正在阅读对象，列表仍按各自当前/历史筛选；后台完成不抢选中项。
- 功能矩阵无未解释空白；blocked/unsupported 不计为已完成。

### P10 — 总体验收与清理

- 移除已迁移的业务重复分支、临时桥接及无用兼容层；保留确有用户兼容用途的入口。
- 检查运行时依赖方向和循环：应用不反向引用 workspace/TUI，Web 不导入 Node fs/Pi 凭据，slash 不直接修改 controller 私有状态。
- 更新 architecture、usage、configuration、testing 和命令帮助，记录具体宿主支持范围与不足；不把提案语法写成已发布功能。
- 完成下节全量验收，给出基线对比、矩阵、手工检查和未完成项。只有三端适用业务均有证据，才标记三端对齐完成。

## 7. Slash 语法兼容策略

当前命令只保留完整匹配的子命令，其余输入都是原稿。直接新增 `tasks/settings/preferences` 等保留词会改变用户输入的含义。

建议在 P0 锁定一个显式操作命名空间（例如 `/refine api ...`，最终名字以兼容评估为准），将新增语法放在该空间；承认命名空间本身仍是新增保留模式，不能称为零冲突。始终保留 `/refine optimize <text>` 作为任意文本的逃生入口，并加迁移说明与解析回归。

建议语义族（非已实现命令）：

```text
/refine <操作命名空间> tasks list
/refine <操作命名空间> drafts create -- <text>
/refine <操作命名空间> runs start <task-id> --model <provider/model>
/refine <操作命名空间> runs stop <run-id>
/refine <操作命名空间> results show <run-id>
/refine <操作命名空间> results revise <run-id> -- <requirements>
/refine <操作命名空间> results accept <run-id>
/refine <操作命名空间> confirm <opaque-token>
```

- 明确引号、多行、`--` 后原文、错误参数和保留词规则；不得改写正文大小写/内部空白，不进行 Shell 求值。
- 旧无参数入口在 TUI 保持开工作台；Web 能打开对应页面则打开，否则输出能力/用法，不假装执行成功。
- 老 cancel/dismiss 与新 stop <run-id> 明确区分，不悄悄改变取消范围。
- 可选 JSON 是无 ANSI 的稳定结果投影，实际输出通道须经 P0 验证；不通过向主 Agent 发送消息实现命令输出。
- 无交互环境不能自动批准确认；提示 required confirmation 或使用显式后续确认操作。

## 8. Validation 体系与每切片完成标准

### 8.1 自动化分层

| 层级 | 核心覆盖 |
| --- | --- |
| unit | controller、对象版本、能力策略、DTO 白名单、错误码、幂等/确认、纯组合与解析 |
| application contract | 同一组业务 fixture 对 API 操作断言返回值、状态迁移与副作用；fake host 无任何 UI |
| integration | extension 实际命令、session 生命周期、编辑器/发送、模型/context、持久化；扩展现有 harness 而非替换 |
| adapter contract | TUI/slash/Web 的同一语义动作驱动相同应用结果；错误路径同样参数化 |
| UI / renderer | 保留全部 TUI 主题、尺寸、ANSI/Unicode、焦点/滚动/确认及 regular/fullscreen 覆盖 |
| Web transport | 授权、runtime/session 隔离、输入大小/类型、未知字段、幂等、订阅重连、乱序/慢客户端、版本不兼容 |
| Web UI / real host | DOM/交互、禁用原因、确认、键盘/IME、布局、重连后恢复；必须与真实宿主至少完成一次端到端链路 |

沿用 `test/unit`、`test/integration`、`test/ui`、`test/renderer` 和独立 `test/support`。新 Web 自动化若需要工具/依赖，先评估现有宿主设施并获得相应批准；没有浏览器 runner 时记录手工证据，不能用 transport mock 代替浏览器验收。

已有重点测试入口：
- `controller-operations/lifecycle/revisions`、`rounds`、`context-jobs`、`budget/context/reference-preservation`。
- `extension-editor-actions/model-selection/input-settings/revisions/preferences/project-defaults/history/rounds/session-naming/status`。
- `workspace-*`、`task-panel-*`、`revise-*`、`preference-panel-*`、`inline-preferences` 及 renderer 对应用例。

### 8.2 跨端竞态必测清单

- TUI 选中 A，Web 操作 B；双方目标稳定。
- 两端编辑同一 Unsent、结果或设置，只有符合版本者成功；无关运行更新不导致虚假冲突。
- 同一远程启动/发送重复投递，返回相同提交结果；不同参数复用 ID 被拒绝。
- 请求已生效但响应丢失，重试不重复副作用；重启后的未知状态不自动执行。
- 确认期间编辑器变化、切 branch/session、删除目标、凭据过期或另一端提交均安全拒绝。
- Web 断线期间后台完成、round 归档；重连后快照与服务器一致，不重新启动任务。
- 设置/库保存失败，三端都能看到 applied/persisted 区别；权限失败不泄露凭据或完整 payload。
- 三端同时操作不能突破并发、日志容量、长度预算或最小持久化白名单。

### 8.3 Web 安全与体验门槛

- 复用宿主认证/授权，服务端校验资源访问；不将客户端 ID 当作身份认证。
- 根据实际传输验证 Origin/CSRF/连接授权、消息大小/频率、订阅释放；禁止任意文件路径、凭据和任意方法透传。
- 用户正文、模型输出、偏好和错误均视为不可信文本；防 HTML/脚本注入，不把 ANSI 输出直接塞入 HTML。
- 至少覆盖桌面/窄屏、键盘、焦点恢复、滚动、长文、中文 IME、取消和确认。UI 可重新设计，但保存/运行/发送必须可区分。

### 8.4 每个切片的 Definition of Done

- [ ] 目标能力、适用端与非目标写清楚；原行为基线与新增行为分别列出。
- [ ] 业务只有一个实现；目标显式，校验在服务端，展示不产生副作用。
- [ ] 原 TUI 回归通过；slash 参数/输出通过；Web 适配与实际宿主证据齐全，或明确 blocked。
- [ ] 成功、失败、取消、过期、重复、并发和持久化错误有测试。
- [ ] `npm run typecheck`、相关测试、阶段全量 `npm test`、`git diff --check` 通过并记录；不启用真实 Provider/benchmark 默认策略。
- [ ] 原展开用例不丢失、不新增无解释 skip；新增测试另行列出。
- [ ] 文档与 capability matrix 同步；未完成的视觉/IME/真实宿主检查明确列为未验收。

## 9. 执行记录模板与完成判定

每个阶段完成时追加一条记录，不预填成功：

```text
阶段 / commit：
涉及业务及 API：
TUI / slash / Web 状态：未开始 | 进行中 | blocked | 已验证
宿主能力和证据：
新增/保留测试及执行结果：
并发与副作用验证：
手工验收：
兼容变化：
未解决问题与下一阶段依赖：
```

依赖主线：P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10。P7/P8 的纯服务提取可在基础契约稳定后提前，但不得跳过 P3 所依赖的默认偏好初始化、模型配置和基础输入验证。每个阶段可以再拆成多个小提交，避免一次提交同时更改事务语义、传输协议和所有 UI。

最终完成不是“代码里有三个 adapter 目录”，而是：功能矩阵有逐项证据，核心能脱离 TUI 运行，三端在同一业务状态上安全协作，宿主能力差距被解决或明确限定支持范围，并且原 TUI 行为和安全边界没有退化。
