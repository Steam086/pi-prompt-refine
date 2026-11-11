# 多入口应用接口（第一切片）

核心类型见 `src/app/api.ts`，运行期由 `src/app/runtime.ts` 为每个 Pi session runtime 组装一个 application/controller。新增 `/refine-api`；旧 `/refine`、快捷键、TUI 几何与 sidecar 格式保持兼容。

支持：优化模型配置、显式创建/修改原稿、运行/停止、状态与结果查询。保存、浏览、重新连接不请求模型；只有 `startRun` / `optimizeText`（或已有 TUI 明确提交）启动优化。API 不接受客户端提供的 history、system prompt、项目背景、认证信息或文件路径，也不接受/发送到 Pi 编辑器。Web 接受/恢复仍不在本切片范围内。

## 身份与查询

`hello(clientId, resumeLease?)` 返回 protocolVersion 1、Binding、lease 和 revision。所有后续读写都携带 Binding：

```ts
{ runtimeId: string, sessionId: string, lifecycleEpoch: number }
```

初始化恢复完成前返回 `not-ready`。切换、树变化、reload/销毁使旧 Binding 失效；Apply、阅读和默认模型选择不改变 lifecycleEpoch。不同进程/原生终端不共享 runtime。Web 多客户端通过同一 hosted session 的事件连接共享 controller，不各自运行 Agent。

`query(binding, query)` 的方法：

- `snapshot`，scope 为 `current` 或 `all`；仅摘要，不批量返回全文。
- `task` / `run`，分别传 taskId / runId；返回白名单全文 DTO。
- `models`：可用优化模型与支持的 thinking；没有认证配置。
- `operation`：传 clientLeaseId、operationId，查询未见、等待、完成或过期。

DTO 是脱离内部记录的不可变快照。不输出完整背景、prepared input、provider 原始响应、错误堆栈或 sidecar 绝对路径。原稿、结果、已采用的要求本身仍可能敏感，访问权限由宿主部署承担。任务/运行编号必须连同 Binding 使用，不能跨 runtime 单独识别。

`subscribe(binding, listener)` 只合并发送 `{binding, revision}` invalidation；订阅者重新查询。解除订阅/断线不停止请求。时钟读取不增加 revision，运行中 elapsed 从实际启动时计算，排队不计时。

## 写操作与重试

```ts
execute({ binding, clientLeaseId, operationId }, mutation)
```

支持 `setDefaultOptimizer`、`createDraft`、`captureDraft`、`updateDraft`、`copyToCurrent`、`discardDraft`、`startRun`、`optimizeText`、`stopRun`。具体字段与枚举以 `api.ts` 为准。

- `createDraft` 允许空白、未配模型及显式重复原稿，不启动模型；`captureDraft` 保留快捷捕获的非空/模型校验和去重语义。
- update/copy/discard/start 带 taskId 和 expectedVersion；默认模型配置带 optimizer expectedVersion。来自 TUI 的文本/偏好变化、提交与归档也更新领域版本，防止另一客户端覆盖旧原稿。
- 新文本背景只能在宿主采集；同 round 仍共用冻结背景。恢复记录不能用缺失的旧背景重跑，必须显式复制。
- started/queued/duplicate 回执含稳定任务/运行 ID。已停止或完成的运行再次 stop 返回 already-terminal。
- 默认模型设置只改变后续运行，不换 Pi 主模型、不重定向已有请求。persistence 区分 persisted/pending/failed/blocked，失败时内存设置仍有效。
- ledger 在领域版本校验之前检查已接受操作；同 nonce 同参数重放原回执，参数不同为 operation-id-reused。领域拒绝也记账。失去传输回执不等于操作未提交，应先 query operation，不生成新 nonce 盲目重试。
- 每 runtime 16 个有效 lease、256 条操作记录；lease 从颁发起 30 分钟，不滑动续期。容量满在副作用之前拒绝；过期 scope 永不重新执行。ledger 只在内存，不跨 reload/进程持久化。

原生同步 TUI 保存/运行/停止经 `tui-operations.ts` 调相同本地用例与领域版本守卫，不使用远端重试账本。原有快捷捕获/ready 预览、Revise、Preferences、接受/发送仍保留受限兼容流程；TaskPanel 保留高级页面需要的内部只读 selector，排序与公开查询共用。没有将内部 RefineRecord 伪装成 Web DTO。

## `/refine-api`

```text
/refine-api status
/refine-api tasks list [--scope current|all]
/refine-api tasks show task-1
/refine-api runs show run-1
/refine-api models list
/refine-api optimizer set --expected-version 1 --model provider/model --thinking inherit
/refine-api drafts create -- 原文
/refine-api drafts update task-1 --expected-version 1 -- 修改后的原文
/refine-api drafts copy task-1 --expected-version 1
/refine-api drafts discard task-1 --expected-version 1
/refine-api runs start task-1 --expected-version 1 [--model provider/model] [--thinking high]
/refine-api runs stop run-1
/refine-api optimize -- 原文
```

从查询结果取得实际 ID/版本，不照抄示例。`--` 后只消费一个分隔空格或换行，其余正文大小写、前后空白、换行原样保留；参数支持整项单/双引号，不求值 shell、变量或转义。未知字段/子命令直接拒绝，不回退为原稿。

TUI 结果在只读 overlay 中滚动阅读，Esc/Enter 关闭；不会 sendMessage 或 appendEntry。RPC/print 仅给短通知，全文通过应用查询/Web 面板阅读，**不承诺 stdout JSON 自动化接口或浏览器调用者专属 slash 全文输出**。

写操作生成 operationId。可使用 `--operation-id <已返回的 ID>` 重试同一命令；仅接受本适配器已发出的 ID，并保留其原 Binding/lease。未知、过期、reload 前或路由缓存已淘汰的 ID 不会被当作新的写入。路由缓存最多 256 项，不保存正文/结果。不要以换 operationId 的方式“修复”未知提交结果。

## 事件传输

`src/adapters/session-events.ts` 不依赖 pi-web，注册以下 session-local Pi 事件：

- `prompt-refine:v1:request`：`{connectionId, requestId, call}`。
- `prompt-refine:v1:response`：同一关联 ID + result；大回复先返回 output token，再按需读取单页。
- `prompt-refine:v1:invalidation`：connectionId + Binding/revision。

call 为 hello/query/mutate/subscribe/close、stage/commit 临时输入传输，或 readOutput/releaseOutput 按需输出读取。直接 frame 最大 60 KiB，结果块最大 48 KiB；长文本将完整 JSON 的 UTF-8 字节 base64 化，按序 stage 后 commit。单传输 2 MiB 编码文本、最多 128 块、60 秒固定 TTL、每连接最多两份、runtime 最多 16 份/16 MiB；缺失/乱序/冲突/过期拒绝，重复相同块可重传。commit 丢失回执仍按 operation 查询恢复，不自动换 nonce。

每 runtime 最多 16 个连接、64 个待响应调用；连接空闲 5 分钟释放。连接结束仅释放传输/订阅，不取消 controller 任务。

大回复只保留白名单 DTO 和有界编码迭代器，不先构造完整 JSON/base64 副本。每连接最多四份输出、16 MiB 保守内存计量（UTF-16 字符、结构和 scratch），runtime 最多 16 份/64 MiB；输出空闲 60 秒过期，最长存活 5 分钟。每次 readOutput 只返回一份最多 48 KiB 的 base64 part（index/done/text），检查原 Binding，并可重放最后一页；读取不会改变领域 revision 或请求模型。release、断开、过期回收资源。Web server 不再暂存整份输出，也不一次性推送大量帧；浏览器解码上限 64 MiB base64/2048 页。超配额明确拒绝，不截断。

离线回归覆盖 2,097,152 字符的结果 + 同等长度前结果 + 三份各 100,000 字符的原稿/要求，使用最坏 JSON 转义数据验证完整往返及单 frame 边界；这没有降低应用文本/输出字符限制，也不代替真实宿主或性能验收。

事件总线不是认证边界。只允许可信宿主 adapter 接入；不可将这些事件直接裸露为未鉴权公网 API。

## Web 状态与验收边界

独立集成包见 [`packages/pi-web`](../packages/pi-web/README.md)。根包不依赖 pi-web，根 typecheck/test 不要求安装该子包。

当前完成离线应用/适配器契约、构建图及模拟 public capability 连接验证；已修复最初整份 base64 暂存导致的长结果配额缺口，改为 core 按需分页。实际宿主插件加载、真实多浏览器、外部认证、浏览器视觉/IME 与真实 Provider 的 S6 验收另行进行；离线通过不等于已经部署或上线可用。
