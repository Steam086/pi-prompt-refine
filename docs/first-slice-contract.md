# 第一切片：最小 API 契约、修改清单与 Web 构建方案

状态：设计草案，待实施授权。本文件不表示接口、插件或测试已实现；不授权依赖安装、发布配置修改、宿主修改、部署或服务重启。

关联：[总体计划](multi-surface-adaptation-plan.md)、[维护架构](architecture.md)、[测试约束](testing.md)。与总体计划存在阶段顺序差异时，本文明确列出的前移项是建议修订，不代表总体计划已被改写。

## 1. 已确认范围与证据边界

用户已确认：

- 首个可交付闭环：选择 Refine 模型 → 保存原稿 → 显式运行／取消 → 查询状态和结果。
- Web 与 slash 共享同一 hosted runtime；多个 Web 客户端承担真实并发、断线和重连验收。原生 TUI 使用同一应用契约做语义等价验收，不要求原生 TUI attach 到 pi-web runtime，不做跨进程共享 sidecar。
- 新增独立 `/refine-api`，保留 `/refine` 及现有快捷键、兼容结果页行为。
- Web 集成采用同仓独立子包，包含 browser/server 插件及独立构建；核心不依赖 pi-web。
- subagents 仅允许只读核实；代码实现、集成、回归由主 agent 完成。
- 若宿主能力不足，先提出最小改造，再另行授权；接受／恢复不能用复制或插入冒充。

P0 基线：commit `563073b43321296750df2102b9739d380d308810`；typecheck 通过；68 个测试文件通过、4 个默认跳过；1188 个展开用例通过、33 个跳过、0 失败。完整测试身份与状态位于 `/tmp/refine-p0-baseline-shMmp6/{tests,cases}.json`，属于临时证据，实施前需确认仍存在并重新采集起点。原有未跟踪 `foundations.md` 与总体计划未改动。

本机安装及运行自报 pi-web `1.202611.1` / Pi `1.5.2` / Node `24.18.0`；仓库测试依赖 Pi `1.4.0`。安装目录为 `/home/jjr/.nvm/versions/node/v24.18.0/lib/node_modules/@jmfederico/pi-web`（下称 H）。公共 browser/server API v5、scoped backend、session-local events 的类型及实现已阅读；尚未完成新插件握手、浏览器 E2E、真实 Provider、视觉／IME 验收。未比对上游同版本发布包的逐字差异，运行中的模块也不能仅凭同版本号视为与磁盘逐字一致。

## 2. 第一切片完成范围

### 2.1 纳入

- 当前／历史任务与运行摘要、单目标详情、正文、原稿及已有修订参考、用量和安全诊断。
- 可用模型查询、Refine 默认模型／thinking 查询与显式保存；仅使用宿主已可用模型，不新增凭据管理或修改主 Agent 模型。
- 显式新建、编辑当前 Unsent、复制到当前 round、取消未改变的临时稿；快捷捕获与直接文本优化的兼容语义。
- 明确任务目标的启动、明确运行目标的停止；既有 4 并发、FIFO、在途去重仍有效。首版 Web 不必提供完整多模型管理 UI。
- 项目默认偏好初始化和已选要求快照保留；显示实际采用的初始要求。完整偏好库管理仍在后续切片。
- runtime/session 绑定、对象版本、基础幂等、snapshot + invalidation、结构化反馈。
- Web 断线不取消运行；浏览和选择不产生 Apply、模型、编辑器、发送副作用。

### 2.2 不新增，但保留原 TUI 行为

- Web 接受／发送／恢复、结果编辑／Revise、比较页、完整 Settings、偏好库 CRUD、历史删除／清理。
- 全量 token streaming、跨端未保存表单同步、跨进程 runtime、自动启动离线 session。
- 主 Agent 工具、自动重试或 provider fallback。

第一切片只声明上述新增能力已对齐；原 TUI 的后续能力可以暂留兼容路径，不把未迁移项标成统一 API 已完成。

## 3. 所有权与边界

```text
原生 TUI adapter ──────────────┐
/refine + /refine-api adapter ─┼─ RefineApplication ─ controller / repositories
session-local event adapter ──┘            │
             ↑                         host ports
pi-web server plugin（路由／校验／传输）
             ↑ scoped backend request / channel
pi-web browser panel（表单／选择／阅读）
```

- 每个 Refine session runtime 只有一个 controller、sidecar writer、配置写队列和幂等账本。
- Web server plugin 连接已有 hosted session 的 `pi.events`，不创建 RefineApplication、不读取 sidecar、不运行模型、不将操作包装成主 Agent prompt。
- 应用层的 ports 只包含上下文捕获、模型查询／执行及所需配置／偏好服务；不接收 `Theme`、TUI Component、整个 ExtensionAPI 或 workspace 构造类型。
- Pi adapter 在可信生命周期事件中建立绑定。来自客户端的 sessionId 只能匹配，不得驱动 `ensureSession()` 切换。
- UI 通知失败不回滚业务；副作用提交后的输出错误不能报成“未执行”。
- 保留当前规则：新建或首次捕获即冻结 round 背景，保存不请求模型。取消最后一个临时草稿且当前 round 已无记录时，按现有规则释放该 round。

## 4. 最小进程内契约

概念文件：`src/app/api.ts`。只含 JSON 友好的类型和接口，不导入 controller、Pi、Node、TUI 或 Web；用结构化模型身份而不是导入内部 `config.ts`。

### 4.1 身份、版本与会话

```ts
interface Binding {
  runtimeId: string;       // 构造／reload 后新随机身份，旧请求不能复用
  sessionId: string;       // 宿主完整 ID
  lifecycleEpoch: number; // session/branch 失效，不等于 candidate generation
}
interface ModelRefDto { provider: string; id: string }
interface MutationMeta {
  binding: Binding;
  clientLeaseId: string;
  operationId: string;
}
type ObjectVersion = number;
type TaskId = string;
type RunId = string;
```

- taskId/runId 为命名空间化不透明字符串，配合完整 Binding 使用；不得把裸局部数字当成跨 session 身份。DTO 不暴露内部 branch leaf；当前分支有效性由宿主绑定和 lifecycleEpoch 守卫，旧任务冻结的 branch 身份仅留服务端。
- taskId 映射现有 taskId；runId 映射日志 record ID，而非易混淆的 requestId。Unsent 不是运行；首次启动时原记录可转成运行，但任务身份不变。
- 第一切片结果是 run 的只读输出，不另造可写 Result 实体；未来编辑／修订再引入显式结果版本。
- `taskVersion` 由领域所有者维护：正文、偏好快照、原稿可编辑性／归档等相关变化使其增加；计时、其他任务完成、阅读位置不增加它。新 API 与暂留的旧 TUI 修改路径都必须经过同一版本更新点，不能只有 Web 写入会推进版本。版本是运行期元数据，不扩张 sidecar 白名单。
- `runVersion` 标记查询内容变化，不用它强制保护安全的 stop 操作，避免 queued→running 导致无意义取消冲突。
- `optimizerVersion` 保护默认模型／thinking 的同一保存单元；无关运行、时间刷新不影响它。
- `revision` 是应用订阅游标，不作为编辑 CAS 条件。只在可观察业务、配置保存状态、存储状态变化时推进，UI 每秒计时不推进。
- 普通用户 message_start 归档 round，不换 runtimeId/lifecycleEpoch；旧运行继续可查询、取消。tree/session 切换、reload/shutdown 按可信生命周期失效旧绑定。
- candidate generation 包含 Apply 等局部展示变化，禁止直接用作应用 lifecycleEpoch。

### 4.2 返回结果

```ts
type Reply<T> =
  | { kind: "ok"; value: T; revision: number }
  | { kind: "conflict"; code: ConflictCode; currentVersion?: number }
  | { kind: "rejected"; code: RejectionCode; field?: string }
  | { kind: "unsupported"; capability: string; reason: string }
  | { kind: "error"; code: string; message: string };
```

以上是类型形状，不是现成实现；枚举与 DTO 必须在实现前展开为封闭 union，不能将 `Record<string, unknown>` 当成业务输入。

最低错误码：

- conflict：`binding-stale`、`task-version`、`optimizer-version`、`operation-id-reused`。
- rejected：`invalid-input`、`empty`、`too-long`、`no-model`、`model-unavailable`、`not-found`、`not-editable`、`background-unavailable`、`journal-capacity`、`send-pending`、`lease-expired`、`ledger-capacity`。
- unsupported：明确缺失的 editor、send、后续 API 或协议能力。
- error：已分类的内部／repository 错误；不得原样返回异常栈、凭据、完整 provider payload。

第一切片无新增确认流程，不预建 confirmation-token 子系统。接受／清理等切片再增加 `confirmation-required`。请求传输超时另有 `delivery-unknown` 客户端状态，不伪装成领域 rejected。

### 4.3 查询

| 接口 | 输入 | 输出和约束 |
| --- | --- | --- |
| `getSnapshot` | Binding；`scope: current/all` | 同一 revision 的任务／运行摘要、当前 round、默认优化器、限制、能力、存储状态摘要；不含大段正文 |
| `getTask` | Binding、taskId | 共同原稿、taskVersion、round/归档/背景可用性、已选要求摘要及实际初始要求、运行 ID、可用动作 |
| `getRun` | Binding、runId | 状态、模型/thinking、原稿、结果、已有修订参考、时间/用量、诊断、动作可用性 |
| `listModels` | Binding | 可用 chat 模型身份、名称、支持的 thinking、必要的收藏标记；不返回连接参数或凭据 |
| `getOperation` | Binding、clientLeaseId、operationId | `pending/completed/not-seen/expired` 及原提交结果；不能触发执行 |
| `subscribe` | Binding、listener | 可销毁实例内失效订阅；不 replay 业务操作 |

`getSnapshot` 返回已加载模型设置；异步模型目录独立查询，不能为了目录 I/O 长期锁住快照。初版日志只有 100 条，摘要不先引入分页；大正文按需获取。

DTO 白名单：

- TaskSummary：id、version、roundId、displayNumber、当前／归档、原稿短摘要、runIds、背景可用性、动作及禁用原因。
- RunSummary：id、taskId、kind、status、model、thinking、createdAt、startedAt（有则提供）、elapsedSeconds、输出是否存在、用量摘要、诊断摘要、动作及禁用原因。
- Detail 只增加用户原稿／结果／明确提交要求／可用的修订前文本，以及白名单 budget 数值。恢复记录缺失参考时明确标注，不从库或背景猜测。
- Usage 复用当前规范化口径：input/output/cacheRead/cacheWrite/reasoning/totalTokens、请求时参考 cost、subscription；未知保持缺失，不重算为实际账单。
- 不暴露 history snapshot、system prompt、project rules、prepared/sent payload、认证、任意本地路径、未提交表单或完整库。存储仅投影状态／数量；路径诊断留专用后续接口。
- 原稿／结果正文保持原样；TUI 在渲染前清理控制字符，Web 用文本节点，不能修改领域正文来获得安全显示。诊断文本另做长度限制和敏感数据过滤。
- 进程内返回 detached、深只读快照；wire 不携带类、闭包、Map、undefined 的隐式含义。

排序由共享纯查询负责，沿用 `task-panel.ts` 规则：当前优先、round 倒序、任务组按最新保留记录 ID 倒序、组内运行倒序。完成和计时不改变排序。客户端维护自己的选中与阅读位置，Web 查询不清除 TUI 未读提醒。

### 4.4 写操作

所有写操作携带 MutationMeta；下面的 expectedVersion 是目标对象版本，不是快照 revision。

| 操作 | 主要输入 | `ok.value` | 副作用／边界 |
| --- | --- | --- | --- |
| `setDefaultOptimizer` | expectedVersion、model、thinking：明确级别或 `inherit` | 当前设置及 version，`applied`、`persistence: pending/persisted/failed/blocked` | 规范化 thinking、维护现有记忆；同一配置写队列；不切换主模型／请求模型 |
| `createDraft` | text | taskId、taskVersion | 允许空白、无模型、显式同文；初始化当前项目默认，冻结 round；不落 Unsent sidecar |
| `captureDraft` | text | `captured/duplicate`、明确定位目标 | 保留快捷捕获的模型／非空前置条件与精确去重；不读编辑器、不运行 |
| `updateDraft` | taskId、expectedVersion、text | taskId、新 version | 仅当前可编辑 Unsent；保留已选快照，不重载默认 |
| `copyToCurrent` | sourceTaskId、expectedSourceVersion | 新 taskId、version | 包括恢复／旧轮次来源；使用当前背景与项目默认；无模型也可复制 |
| `discardDraft` | taskId、expectedVersion | `removed` | 仅当前、未运行且版本匹配的 Unsent；取消临时编辑不能删他人已修改／已启动对象 |
| `startRun` | taskId、expectedTaskVersion、可选单次 model/thinking | `started/queued/duplicate`、taskId、runId、实际模型/thinking | 共用启动流程；完整背景才可运行；首个启动冻结要求；不因单次选择改默认 |
| `optimizeText` | text、可选单次 model/thinking | 与 startRun 相同 | 兼容明确直接优化；校验／去重／容量检查后原子提交，不用 create+start 两次客户端调用拼装 |
| `stopRun` | runId | `cancelled/already-terminal`、runId | 单目标；无 CAS 要求；晚到结果不复活，晚到用量仍可记账 |

补充：

- `startRun` 对当前或内存旧轮次的完整背景任务沿用现有 `runOriginal/startRecord` 语义；磁盘恢复背景不可运行，需 copyToCurrent。完整多模型 picker/收藏管理可后置，但不能破坏已有运行语义。
- `duplicate` 是领域在途去重，不等于幂等重放；返回已有运行 ID。相同 operationId 的重试重放原结果，原结果可能是 started 而非 duplicate。
- 当前 `TriggerResult.started` 也包含排队；controller 的新增目标操作应提供真实 record/request 身份及 started/queued，不靠“取最后一条 history”推测。保留旧入口返回兼容。
- capture 的重复目标可能是原稿或已接受结果；若只剩捕获记忆、日志已淘汰，返回 `duplicate` 和 `target: null`，不得假造 ID。
- TUI `n/i` 可继续立即创建临时稿；取消携带创建时版本，冲突则保留共享对象并提示。Web 新建表单默认本地暂存，Save 才 create；不同 UI 不要求同样的临时分配时机。
- 同一目标的同步校验／提交不能被 await 切开；如必须等待配置或资源操作，在提交前重新校验 Binding 和对象版本。不要用覆盖模型整个执行期的全局串行锁。
- 模型调用、目录采集由 controller 持有的执行 signal 控制，不能继承 HTTP/channel 的取消 signal。
- 已生效配置即使落盘失败仍返回 `ok + persistence: failed/blocked`，保存完成更新查询状态和 revision；不能让取消表单伪装成回滚。
- 项目默认要求超长时保留可读原稿并拒绝启动。第一切片 Web 暂不提供库管理／选择修改：明确提示需去现有 TUI 管理再创建或编辑选择，不截断、自动忽略默认或默默运行。

## 5. 基础幂等与过期行为

这是 P3 第一个远程写操作的前置条件，不等 P6。

- hello 建立应用侧短期 client lease：建议 30 分钟、每 runtime 最多 16 个活动 lease；每 runtime 总计最多 256 条已接纳操作记录。客户端在本标签页保留关联 ID 和 lease，重连优先恢复仍有效的原 lease，不能每次连接都分配新 lease。数值属于实现默认提案，需边界测试；不新增用户配置项。
- ledger key 为 Binding + clientLeaseId + operationId。fingerprint 包括操作名、全部语义输入和 expectedVersion；正文保留大小写／空白，采用确定性编码后摘要，不长期复制大正文。省略的运行模型／thinking 在首次接纳时解析并冻结，重试不能因默认设置变化而执行另一份请求；重复识别仍基于原始语义输入。
- 顺序固定为：结构／Binding／lease 校验 → fingerprint 与账本查重 → 为新操作预留 pending → 领域版本／能力校验 → 解析首次默认值并提交 → 记录结果。已有操作必须先重放，不能先用重试中的旧 expectedVersion 拒绝它。已接纳尝试的领域拒绝也留结果；同 key 同 fingerprint 共享结果，不重复提交，不同参数返回 operation-id-reused。正文上传引用先解析成文本，再计算 fingerprint。
- 在 lease 有效期内不逐出已接纳操作；额度满时在副作用前拒绝新操作，而非丢弃旧记账。已在执行的记录保持到提交状态明确，lease 到期不取消已经提交的业务。
- lease 过期即拒绝旧 lease 的写入；不能把“账本已清除”解释成新操作。lease/clientId 只用于关联与隔离，不是身份认证。
- 响应丢失：同 lease/operationId 重试或 getOperation；not-seen 不证明在途网络请求以后不会到达，因此也只允许原 ID 重试。runtime 更换、lease 过期时显示未知，先核查已有任务，不自动换 lease 重发旧提交。
- 幂等结果缓存只含短小提交回执；后续生成结果／配置持久化状态通过查询获取，不将一整个结果正文留在账本。
- 操作查询仅展示提交状态，不提供重启后的 exactly-once 保证，也不把“模型失败”变成再次提交许可。

## 6. 订阅和 pi-web wire 协议

概念文件：`src/adapters/wire.ts`（纯数据／编解码），`src/adapters/session-events.ts`（Pi events 适配）。API v1 与宿主插件 API v5 是不同版本。

### 6.1 会话握手与通道

- browser 在捕获的 workspace scope 上请求 `hello`，input 只带完整 sessionId、支持的协议版本和客户端关联信息；不提供路径。
- server plugin 使用 host-resolved project/workspace，调用公开 `pi-web.host/pi-session-events@1.connect()`；只连接已经 hosted 的 session，不自动打开离线会话。
- 注册响应监听后发 `prompt-refine:v1:request`；扩展在 `prompt-refine:v1:response` 返回带 transportRequestId 的结果。客户端只可选择白名单方法；不能透传任意事件名、函数或 controller 方法。
- transportRequestId 每次投递唯一；operationId 同次业务重试不变。响应还要匹配连接、Binding、lease；迟到或其他客户端响应不得被误收。桥接等待期限建议 8 秒，低于宿主 10 秒 callback 上限；超时释放等待者，但保留应用提交账本，不取消已接纳运行。
- hello 返回 Binding、lease、protocolVersion、应用能力、限制及当前 revision；应用初始化未完成返回明确 not-ready，不暴露半恢复快照。
- plugin 与扩展只在各自已有 runtime 内注册；reload/shutdown 清理旧监听。连接 close 不停止会话，不创建新的 controller。

### 6.2 无漏事件的快照流程

1. 客户端打开订阅，服务端先安装应用 listener，再发送 `ready { binding, revision }`。
2. 客户端查询 snapshot；订阅期间缓存见到的最大 revision。
3. 若最大 revision 大于 snapshot.revision，重新查询；落后／重复通知可忽略。
4. 后续每条 invalidation 仅含 Binding、revision、影响域（tasks/models/settings/storage/capabilities），不含大正文。
5. 通道断开显示 stale；重连重新握手／订阅／取快照，不重放任何写操作。相同有效 lease 可以显式恢复，但不能静默改变旧提交的 scope。

每连接只保留一个合并的待发失效通知；不使用无界事件队列。channel signal 结束时释放订阅和事件连接。展示计时由 startedAt/elapsedSeconds 的快照基准本地推进，不产生每秒 revision 或 sidecar 写入。

### 6.3 长文与硬边界

安装协议限制：请求 JSON 256 KiB、响应 JSON 8 MiB、channel 数据 64 KiB、request callback 10 秒。应用允许 100,000 UTF-16 code units 的原稿，JSON 转义后可能超过请求上限；结果和多份参考合计也不能假定小于响应上限。

设计选择：保留原有字符计数语义，补轻量有界文本搬运，避免把业务上限降低成宿主包大小。

- 普通文本走 inline；编码后的完整 envelope 超过安全阈值时，由 browser transport 使用 `text.begin / text.append / text.release`，再在业务 envelope 中传已完成 text handle。
- begin 带客户端 uploadId，同 lease 同 ID 同元数据重放原 handle，不因响应丢失分配多个暂存。append 走 request，不借订阅 channel 传正文；每块完整编码 envelope 控制在 48 KiB 以下。按顺序 offset 追加，相同 offset 相同内容重试幂等，冲突拒绝；拼接必须逐字还原（包括换行、emoji、反斜杠）。
- 暂存由 server bridge 持有，绑定具体事件连接／Binding／lease；限原稿字符上限、每客户端最多 2 个 handle、每个 1 MiB、总计 8 MiB、5 分钟 TTL。配额不足显式拒绝，不静默逐出提交中的文本。
- handle 不是文件路径，不落盘、不进入 sidecar、不修改任务；提交前验证完整长度并冻结，解析成文本后进入应用幂等层。响应丢失后优先 getOperation，不因上传释放就重跑。
- 读取大详情时把各正文投影为 inline 或 text handle，`text.read` 分块返回；绑定 run/task 版本。目标改变／淘汰或 handle 失效则返回冲突／失效，重新查询，禁止拼出跨版本正文。
- 输出暂存也计入独立有界内存预算（建议每连接 16 MiB、bridge 总计 64 MiB），超过配额返回 resource-limit；不把完整背景纳入任何暂存。
- 只在 transport 层分块；进程内 API 仍接收／返回字符串。协议对照测试覆盖 inline 与 staged 产生相同业务结果；首次真实闭环验收包括合法大文本。

限额是本轮设计提案，不是已测得的吞吐保证；若运行环境无法满足，应明确阻塞长文验收，不能宣称全部配置范围对齐。

## 7. Slash 与 TUI 接入

### 7.1 第一批 `/refine-api` 语法提案

```text
/refine-api status
/refine-api tasks list [--scope current|all]
/refine-api tasks show <task-id>
/refine-api runs show <run-id>
/refine-api models list
/refine-api optimizer set --expected-version <n> --model <provider/model> --thinking <level|inherit>
/refine-api drafts create -- <原文>
/refine-api drafts update <task-id> --expected-version <n> -- <原文>
/refine-api drafts copy <task-id> --expected-version <n>
/refine-api drafts discard <task-id> --expected-version <n>
/refine-api runs start <task-id> --expected-version <n> [--model <provider/model>] [--thinking <level>]
/refine-api runs stop <run-id>
/refine-api optimize -- <原文>
```

- 该列表是拟新增语法，不写成已发布命令。`captureDraft` 主要供 TUI 快捷捕获使用，不必为每个内部方法添加 slash 子命令。
- `--` 之后按原字符串切片保留正文，包含大小写和内部／末尾空白；只消费约定的一个分隔空格或换行，不全局 trim。支持带引号参数的有限 tokenizer，不执行 shell、环境替换或转义求值。
- 写操作要求明确目标版本；适配器按当前可信 session 创建 Binding 和 lease，不允许用命令参数切换 session。一般命令生成新 operationId；可选 `--operation-id` 只用于同一有效 scope 的显式重试，旧 scope 不迁移。
- 输出与主 Agent transcript/model context 分离。TUI 使用只读输出组件；Web 将完整输出放 Refine 插件的客户端结果视图，notify 只给短状态，不用大量通知承载正文。
- Web slash 若不能把结果可靠投影到插件结果视图，该输出项记 blocked；不能退回 sendMessage/appendEntry。可选 JSON 格式推迟到独立输出通道验证后，暂不承诺终端 stdout 自动化 API。
- 多浏览器的 slash 输出关联需明确：原生 slash handler 不天然携带 browser clientId。默认只允许共享的短状态，不广播私有未提交表单；完整结果可以通过任务／operation 查询读取。需要调用者专属输出时由插件显式请求入口携带 lease，而不是伪造宿主调用者身份。
- `/refine` 完整匹配保留词及其余文本规则不变；新增命令无需抢占 `/refine api ...` 原稿文本。

### 7.2 TUI 迁移边界

- 从工作台保存／启动／停止／模型配置路径改调应用操作；UI 自己负责 mount、focus、scroll、关闭、提示和位置恢复。
- 列表与第一切片详情逐步读取新 query DTO；不得为了适配旧 UI 向 Web DTO 填入假的 history/systemPrompt/preparedInput。
- 原有高级页面可以暂留内部只读兼容 selector，不能成为 Web 数据源或继续复制已经迁移的写逻辑。每个切片记录剩余路径，后续阶段移除。
- TUI 编辑器捕获在适配器读取，再传显式 text；正文 slash 的空编辑器补回留在旧兼容入口。
- 首个切片不重写整个 TaskPanel，不改几何、键位、主题或 Revise/Preferences 输入边界。

## 8. 文件修改清单（拟实施，不是本轮改动）

### 8.1 核心与适配

| 文件 | 拟修改职责 | 边界 |
| --- | --- | --- |
| 新 `src/app/api.ts` | 第一切片输入／输出、DTO、接口 | 纯数据，浏览器可引用，无平台依赖 |
| 新 `src/app/ports.ts` | Context/Model/Completion、配置与默认偏好的受限能力 | 不接收完整 ExtensionContext |
| 新 `src/app/queries.ts` | 白名单投影、排序、动作可用性 | 不 Apply、不写入；复用 usage 纯函数 |
| 新 `src/app/events.ts` | revision、合并 invalidation、订阅释放 | 不与 UI 时钟或 sidecar writer 混用 |
| 新 `src/app/idempotency.ts` | lease、限额、fingerprint、提交结果账本 | 不持有第二份任务／队列 |
| 新 `src/app/draft-actions.ts` | create/update/copy/discard 的用例编排 | 复用 controller 和现有默认偏好服务 |
| 新 `src/app/model-service.ts` | 模型查询、默认设置、thinking 规范化 | picker 留原文件，不改主模型 |
| `src/controller.ts`、`src/history.ts` | 明确目标操作结果、领域版本和必要计时查询 | 保留旧方法兼容；不改 sidecar 白名单 |
| `src/app/request-flows.ts` | 分离显式文本运行与 UI 提示／捕获 | controller 仍唯一负责调度和冻结 |
| `src/app/completion.ts` | 执行 port 与绑定；替代 TUI mode 限制 | 单次无工具请求；冻结 limits/执行引用 |
| `src/app/runtime.ts`、`lifecycle.ts` | 组装 API、可信绑定、初始化就绪、订阅／ledger 清理 | 一个 controller/writer，旧状态不跨 runtime |
| `src/app/model-selection.ts` | picker 调 model-service | 保留搜索、thinking 记忆、定位与保存边界 |
| `src/app/workspace-actions.ts`、`workspace-host.ts` | TUI 适配器调用 API，移除已迁移业务分支 | 未迁移高级能力明确保留，不整包状态透传 |
| `src/task-panel.ts`、`src/ui/task-content.ts` 等直接受影响视图 | 第一切片 DTO 读取与共享排序 | 仅必要类型／数据访问改动，保留完整 renderer 回归 |
| 新 `src/adapters/wire.ts` | 公共 wire 类型与有界结构校验 | 只依赖 api.ts 和标准 JS；不含业务实现 |
| 新 `src/adapters/session-events.ts` | Pi events 请求／响应／订阅桥 | 不 import pi-web；固定事件名、白名单方法 |
| 新 `src/adapters/slash.ts` | 新语法解析／输出适配 | 不直接改 controller，不做 shell 求值 |
| `src/app/commands.ts`、`src/extension.ts` | 保留旧路由，注册新命令与桥接生命周期 | 注册重名显式失败，不覆盖其他命令 |

不因文件表提前创建空模块；按下节阶段在确有职责时新增。`editor-actions.ts`、完整 Settings/Preferences 页面以及 sidecar 格式本切片不主动重构。

### 8.2 Web 子包

建议目录 `packages/pi-web/`，新增文件仅在实现授权后创建：

- `package.json`、独立 `package-lock.json`：private 集成包、插件 manifest、构建／检查脚本。
- `tsconfig.browser.json`、`tsconfig.server.json`：显式、分离的编译图。
- `src/browser/index.ts`：v5 插件注册和 host-provided html；不启动请求作为 render 副作用。
- `src/browser/client.ts`：握手、请求／幂等关联、订阅重连、长文 transport。
- `src/browser/panel.ts`：原生 Web Component，表单、列表、详情和明确保存／运行／停止动作。
- `src/server/index.ts`：v5 peer，公开 capability 连接、scope/参数校验、route 与销毁。
- `src/server/connections.ts`：有界连接／待响应映射、事件转发与清理，不持有业务队列。
- `src/server/text-transfer.ts`：限额／TTL 的临时文本搬运，不碰文件系统。
- `README.md`：支持范围、构建命令、安装和需授权的重启步骤、未验收项。

若上述模块规模很小可合并；浏览器资产目录绝不包含 server 输出、Node 代码、应用核心或配置。

### 8.3 测试与文档

- 新 `test/unit/application-queries.test.ts`、`application-versions.test.ts`、`application-idempotency.test.ts`、`slash-api.test.ts`、`web-protocol.test.ts`。
- 新 `test/integration/application-contract.test.ts`、`adapter-contract.test.ts`、`session-events.test.ts`；根测试只覆盖应用与纯协议/fake transport，不导入 Web 子包或宿主类型。
- 按职责新增 `test/support/` fake host/transport，不能替换现有 extension harness；修改已有 integration/UI/renderer 用例来覆盖迁移后的真实路径。
- 新 `packages/pi-web/test/` 构建产物图、实际 server bridge／public API 适配测试，可使用已有 Vitest，不默认增加浏览器 runner。只有子包测试依赖其开发类型；仅运行根仓库 npm ci/typecheck/test 的用户不必安装 Web 子包。
- 更新 architecture/usage/testing 的时机是对应功能实现后；设计语法不提前进入已发布使用说明。仅在获得构建授权后修改相关 tsconfig/test include。

## 9. 构建方案

### 9.1 推荐：两个 tsc 构建，无 bundler、无新增 UI 框架

复用 TypeScript 5.9.3。浏览器使用宿主提供的 `html` tag 返回插件模板，内部采用原生 HTMLElement/DOM；`TemplateResult` 和宿主上下文只用 type imports，不引入 Lit runtime、React 或 Vite。

公共契约只维护一份源文件：`src/app/api.ts` 与 `src/adapters/wire.ts`。不在子包手写另一套 DTO，不从 core barrel 导入 controller/runtime。

为避免 TypeScript 对跨子包源码产生 rootDir 错误，两个编译配置都显式设置仓库根为 `rootDir`，但 `include` 仅列各自入口及上述共享文件：

```text
packages/pi-web/
  dist/browser/
    src/app/api.js
    src/adapters/wire.js
    packages/pi-web/src/browser/{index,client,panel}.js
  dist/server/
    src/app/api.js
    src/adapters/wire.js
    packages/pi-web/src/server/{index,connections,text-transfer}.js
```

路径较长但无需 bundler 或拷贝源码。生成两份纯协议 JS 是构建产物重复，不是两份业务实现。

- browser：ES2022、ESM、DOM libs、`types: []`、`verbatimModuleSyntax`、noEmitOnError；运行时仅相对 import。
- server：NodeNext/ES2022、Node types、相对 import；不打包宿主 SDK。
- browserRoot 为 `dist/browser`；browser module 指向 `dist/browser/packages/pi-web/src/browser/index.js`；serverModule 指向 `dist/server/packages/pi-web/src/server/index.js`；`machineSpecific: true`。
- 插件 ID 提案为 `prompt-refine`，安装前核查 plugin ID 冲突；它与 slash 名称、Pi 扩展名不是同一命名空间。
- 样式首版随组件以静态 style 模板提供，使用宿主语义 CSS tokens；不加载动态脚本／远程 CDN。长文用 textContent／安全模板插值，不启用任意 HTML。
- 产物图检查必须证明 browserRoot 内只含 browser 与纯协议文件；没有 fs、Pi SDK、server entry、动态 Node import 或意外源文件。只看 tsconfig.include 不足以证明依赖图安全。

### 9.2 宿主类型与 runtime 依赖

子包拟新增开发依赖，安装前需授权：

| 包 | 版本提案 | 用途 |
| --- | --- | --- |
| `typescript` | `5.9.3` | 与根仓库相同，不升级 |
| `@types/node` | `22.20.5` | 与当前锁文件相同，仅 server/build/test |
| `@jmfederico/pi-web` | `1.202611.1` | 精确匹配已核实公共类型；仅开发阶段 |

根 package 不改成 npm workspaces，不改发布 `files` 或新增 pi-web runtime dependency。子包独立 lock，默认根仓库测试不因此安装整个宿主。

server plugin 使用公开 capability token `{ pluginId: "pi-web.host", id: "pi-session-events", version: 1, parse }`，由宿主注入能力；type import 使用官方声明，parse 仅校验 version/connect 形状并保留方法绑定。无需 runtime import `createCompanionBackend` 或宿主整个包，也不 deep-import 私有实现。此 token 与官方导出常量对照测试，防止拼写／版本漂移。

这样构建产物不含裸宿主 import，不依赖全局 npm 包的偶然解析路径。若实际 loader 证明必须使用 runtime helper，再单独评估 peer/dependency 方案，不能临时使用绝对安装路径或 NODE_PATH 绕过。

注意：安装宿主的开发类型依赖可能拉入较大依赖树；仅用于子包构建，不声称“零安装成本”。禁止复制安装目录的 d.ts 作为永久 fork，也不修改根 lock 来强制升级 Pi 1.4.0。

### 9.3 拟执行命令与授权边界

以下仅是未来脚本约定，本轮未执行：

```text
npm --prefix packages/pi-web ci
npm --prefix packages/pi-web run typecheck
npm --prefix packages/pi-web run build
npm --prefix packages/pi-web run test
npm run typecheck
npm test
```

- 子包测试优先调用同仓现有 Vitest（明确配置 root/include），不新增第二套测试框架；前提是根仓库已 npm ci。子包依赖安装与 lockfile 独立，但它是同仓开发单元，不承诺脱离仓库单独测试；实际脚本要能从任意 cwd 经 --prefix 工作。
- 不新增 Playwright/browser runner 依赖作为默认前提；先采用构建图／transport 自动化 + 明确记录的真实浏览器手工验收。需要浏览器自动化时另行批准。
- 子包构建不得触发宿主 build/install/update。构建产物现有 `.gitignore` 已忽略 dist；安装之前仍核查 diff。
- 建议在隔离实例验收插件，配置独立 data dir/socket/port；启动实例本身也需授权。使用生产宿主时，首次 server plugin 安装、启用或更新需要单独授权 daemon 重启，并提前说明会中断活动会话和终端。
- 新子包 manifest 与开发依赖属于必要的新构建配置，不等于已获批准；根包发布规则保持不变，发布整合留后续决定。

## 10. 实施拆分与退出条件

| 小阶段 | 工作 | 退出证据 |
| --- | --- | --- |
| S1 契约与只读 | api/ports/queries；最小可信 Binding；无 UI harness | DTO 白名单、排序、不可变、跨 session 拒绝；原 TUI 回归 |
| S2 写操作基础 | task/optimizer 版本、lease/ledger、模型服务、原稿保存 | 无模型可保存；版本冲突、同 ID 重试、过期拒绝、持久化失败区分 |
| S3 运行闭环 | 执行 port、明确 start/stop 回执、TUI 接入 | 无 ctx.ui 可运行；一次无工具调用；4 并发/FIFO/超时/取消/冻结不变 |
| S4 Slash 与事件桥 | /refine-api、兼容旧入口、events handshake/订阅 | 参数与正文保真、输出不入 Agent、listener 清理、无重复 runtime |
| S5 Web 构建与适配 | 独立子包、公共 peer、浏览器面板、长文搬运 | 编译图隔离、能力缺失/参数/配额/断线测试、无隐式启动 session |
| S6 实际宿主验收 | 经授权加载插件；多 Web 客户端和真实浏览器 | 主闭环、双端冲突、响应丢失、重连、窄屏/长文/中文 IME；未做项显式未验收 |

S1 前移 P2 的最小绑定；S2 前移 P6 的基础幂等；不提前实现整个编辑器事务系统。S1–S4 可在宿主部署阻塞时推进，但 S5 mock 不能替代 S6。

最低验收断言：

- 新建／保存／查看／模型配置均为零模型调用；只有显式运行增加一次调用。
- 原稿文本、已选要求和冻结背景分别保存，正文绝不因 transport/命令解析被重写。
- 两客户端编辑同一 Unsent/默认模型产生正确冲突；其他任务完成不使编辑失效。
- 同 ID 丢响应重试不新建、不再运行；额度／lease 过期不重新接纳不确定旧操作。
- Web 关闭、订阅超时、切换阅读目标不取消任务；应用 shutdown 仍清理模型和 context jobs。
- current/all 排序与 TUI 一致；归档后读取明确目标不被重定向；恢复记录只能复制后运行。
- 首次配置、无可用模型、项目默认超长、日志满、保存失败都有可查询且可操作的错误说明。
- 真实 Web 与 slash 同 runtime；原生 TUI 为契约等价，不用两个进程共享 sidecar 伪造协作。
- 保留全部现有用例身份和默认 skip 策略；必要的预期变化单列说明，不删除 non-TUI 安全回归来获得绿灯。

## 11. 实施前尚需批准／验证

1. 批准此契约与拟改文件范围后才能改源码；可以先只批准 S1–S4。
2. S5 前批准独立子包 manifest、开发依赖、lockfile 和构建／测试配置；不默认升级任何已有依赖。
3. S6 前确定隔离实例还是生产实例，以及部署、重启、浏览器操作和真实 Provider 调用的分别授权。
4. slash 的完整输出落点、public capability token 的实际加载、Pi 1.5.2 与当前测试依赖差异必须用实验补证。若受阻，输出具体缺口而非绕过公共接口。
5. 本文所有接口名、wire 事件名和数值限额是设计提案；正式冻结 protocol v1 前完成对应参数表和错误码测试，不把未实现草案写成已有支持。
