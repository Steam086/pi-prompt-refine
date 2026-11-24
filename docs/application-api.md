# 多入口应用接口

[应用类型](../src/app/api.ts)定义操作、DTO 和返回值，[wire 校验](../src/adapters/wire.ts)定义传输可接受的输入。写新客户端时先读这两处，再参考[应用契约测试](../test/integration/application-contract.test.ts)。

## 身份与查询

- 先通过 `hello` 取得 Binding 和 lease。任务／运行 ID 与 `{ runtimeId, sessionId, lifecycleEpoch }` 一起使用。会话或分支失效、重载、销毁使旧操作失效。浏览和 Apply 保持 Binding，读取时钟不推进领域版本。
- 先查摘要，再用原 Binding 查询单条任务或运行全文。DTO 是脱离内部状态的白名单快照。原稿、结果及已提交要求仍可能敏感。完整背景、prepared input、凭据、原始 Provider 响应和内部路径保留在实现侧。
- `run` 详情中的 `text` 是结果正文。可选的 `additional` 数组按本次附注选择顺序排列，每项包含冻结的名称 `name`，附注可用时还包含 `text`。
- 订阅只发合并后的失效通知，客户端用原 Binding 重新查询。解除订阅或断线只释放传输资源，后台运行继续。同一 hosted session 可以共享状态。

## 写操作与重试

- 保存、捕获、浏览和配置本身不调用模型。运行须显式提交。TUI 快捷键的首次直接启动规则由 TUI 入口处理。恢复记录缺少原背景，须显式复制到当前 round 才能再次运行。
- 需要对象版本的写操作须携带查询取得的版本。默认优化模型的修改影响后续运行，保存状态可独立查询。开始和排队回执可用于定位运行。重复回执只引用可解析的现有对象，例如命中已有 Unsent 可以有 task ID 而 `runId` 为 `null`。
- 有回执丢失时，先在原 Binding 和 lease 查询原 operation ID。同作用域、同 ID、同参数可重放已登记的结果；不同参数报冲突。未知或过期的重试需要显式处理，不能换新 ID 盲目重试。账本只保留在当前 runtime 内，其上限和有效期见[实现](../src/app/idempotency.ts)。
- 原生 TUI 复用领域守卫和本地用例。接受、发送和恢复保留原生确认流程。远端应用接口提供草稿、运行和模型配置能力，Web 不提供接受、发送或恢复。

## `/refine-api`

```text
/refine-api status
/refine-api drafts create -- 原文
/refine-api runs start task-1 --expected-version 1
/refine-api runs show run-1
```

使用查询返回的实际 ID 和版本。正文分隔符 `--` 后只消费一个约定的分隔符，其余原样保留。参数按有限语法解析，正文按字面处理，且不执行 shell 插值。未知子命令或字段直接拒绝。完整命令和边界示例见[解析器](../src/adapters/slash.ts)和[slash 测试](../test/unit/slash-api.test.ts)。

在 TUI 中可打开只读结果。RPC／print 的此命令提供短通知，全文通过应用查询读取。需要在 RPC 宿主直接打开优化结果时，使用独立的 [RPC `/refine`](rpc-slash-verification.md)。重试只使用该适配器已发出的 `--operation-id`，它保留原 Binding 和 lease。

## 事件传输

版本化事件限于宿主 session。长输入先分块暂存再提交，长输出按 token 拉取单页，可重放最近一页。超额、乱序或过期会明确失败，合法全文保持完整。提交丢回执仍按原 operation 查询。事件总线和 Host／Origin 检查各自约束路由与来源，公网访问需要独立身份认证。当前帧大小、配额、期限见[传输实现](../src/adapters/session-events.ts)，边界由[分页测试](../test/unit/output-paging.test.ts)和[Web 桥接测试](../packages/pi-web/test/bridge.test.mjs)验证。

安装和构建见 [Web 子包](../packages/pi-web/README.md)，真实宿主的证据范围见[隔离验收](multi-surface-acceptance.md)。
