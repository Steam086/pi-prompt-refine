# 首片隔离宿主验收记录

## 范围与隔离

操作者明确批准了独立临时实例。使用 `env` 白名单等价的干净子进程环境：单独 HOME、Pi agent/session 目录、PI WEB config/data 目录、Unix socket、随机 loopback 端口和 Chrome profile；不继承生产凭据或 daemon 连接。

- 实际启动安装的 pi-web **1.202611.1**，显式选择 Pi SDK **1.5.2**，Node **24.18.0**。
- Chrome **156.0.8078.47**，使用已有浏览器的 CDP，无新增 browser runner/依赖。
- Web 安装候选仅含 manifest 和双构建 `dist`，没有 node_modules；核心使用候选源码与既有 `ignore` 运行依赖。两者通过正常宿主加载，不替换 capability。
- 配置仅提供 loopback OpenAI-compatible **确定性 stub**，没有真实 Provider、真实密钥或任务执行。正常验收调用均为 Refine 请求且 tools 数为 0。
- 初始环境排查发现核心源码需要 `ignore`；补齐隔离部署依赖。测试 stub 也调整为接收 SDK 的 text-block 数组。一次准备阶段误将内置 `/reload` 发给 raw prompt 路由，被本地 stub 拒绝；后续重载改用已注册的仅测试扩展命令 `ctx.reload()`。它们不是产品回归修复，也没有访问真实 Provider。

## 自动化/浏览器证据

| 检查 | 结果 |
| --- | --- |
| 真实插件加载、public session-events capability | 通过；server healthy |
| browser/server 配对版本 | 通过；修改临时候选后实际产生 staleRevision/restartRequired，browser manifest 拒绝旧配对；仅重启隔离进程后恢复一致 |
| 两个真实浏览器页面共享同一 hosted runtime | 同一 Binding；独立 client/lease，草稿与 invalidation 可互见 |
| Unicode 原稿输入、保存、默认 optimizer | 通过；编辑/保存/配置不调用模型 |
| 双端草稿版本冲突 | 拒绝旧版本，保留未保存的本地文本 |
| 实际 SDK `streamSimple`、结果及原稿参考 | 使用 loopback stub 通过；Pi 会话 messageCount 保持 0 |
| 长文输入 | 100,000 UTF-16 code units，含最坏 JSON 转义，完整往返 |
| 长文输出 | 2,097,152 个 NUL 字符完整往返；实际 request/channel 边界通过；另有 300,000 字符可读 Unicode 结果 |
| 回执丢失及重连 | 在真实请求完成后注入浏览器回执丢失，保留原 scope 查询 ledger；同一意图仅一次 stub 调用 |
| 并行排队/取消 | 四个 generating、一个 queued；取消排队项未调用 stub；活动项可取消；关闭 reader 不取消运行 |
| 跨 workspace / 路径伪造 | 真实 public capability 拒绝其他 workspace 的 session；未知 path 字段拒绝 |
| 宿主重载 | 新 runtime Binding；旧 Binding 的写入明确 binding-stale，没有新任务 |
| optimizer 乐观版本 | 拒绝过期版本；没有模型调用 |
| `/refine-api` 与 Web | 真实注册命令在同一 session 创建草稿；Web 可见，未发模型请求、未写入模型会话 |
| 浏览器公共文件边界 | server 文件和 package.json 均不可通过 browserRoot 读取（404） |
| Host、HTTP Origin、WebSocket Origin | 非允许 Host/跨源请求均 403；这不是身份认证证明 |
| 明暗主题/resize | 1440×1000、420×700 截图；内容 grid 无水平溢出 |
| 长结果滚动 | 独立滚动位置变化，所选 run identity 不变 |
| 浏览器 JS 异常 | 最终完整验收过程中 0 个未捕获异常 |

这里的“双客户端”是实际 Chrome 页面，不是两个离线 `RefineClient` mock；没有验证不同浏览器引擎。回执丢失是浏览器端故障注入，不等于所有真实网络故障组合。

### 浏览器实测发现并修复的缺陷

启动回执可能早于 snapshot 中的下拉选项。直接给 `<select>.value` 赋新 run ID 会被浏览器清空，随后 Read result 无目标，仍显示初次读取的 generating 内容。

现在独立保留所选 run ID 及 Binding，选项到达后恢复显示；Binding 更换时清除旧目标，不把其身份带入新作用域。增加 Node 回归测试模拟原生 select 的未匹配值行为，再重跑真实浏览器闭环通过。Web 离线测试增至 **8/8**。

另外，根据准备阶段未知斜杠可能进入普通 prompt 路径的观察，为命名冲突导致不可用的 `/refine-api` 补充 input handled 兜底，避免短名称退化为 Agent 请求。该错误分支由根集成回归覆盖，未另做真实宿主命名冲突注入。

一次后台页面截图超时后，显式将目标页置前再截图；最终四种尺寸/主题组合全部通过。截图检查不代替人工视觉或 IME 验收。

## 未验收/不在本次授权内

- 人工中文 IME 组合输入、真实用户视觉/可访问性验收，以及不同浏览器/终端的人工检查。
- 生产外网反向代理的 HTTP **及 WebSocket 身份认证**、TLS、远程机器/Fleet。loopback Host/Origin 防护不能替代这些项目。
- 真实 Provider、真实费用、供应商断线/取消表现。
- 当前生产实例的插件部署/重启；未触碰其配置、凭据、会话或终端。
- Web accept/send/restore，以及设计中后续完整 Settings/Preferences 能力，不属于本片。

因此结论是：**首片离线回归和授权范围内的隔离真实宿主/浏览器自动化通过；不标记全部三端/生产验收完成。**

## 证据与清理

本机临时证据目录：`/tmp/refine-s6.0luCoT/`。保留 `acceptance.json`、`host-checks.json`、`browser-final.json`、配对诊断、脚本、日志与截图；临时进程、socket、浏览器 profile、agent/auth/session/project/data 状态及候选副本均已清理。测试脚本未作为默认 CI 或新测试框架引入。

最终候选实际配对 revision：`sha256:a7e309478c1184bd97e379f3e889f77f7b2c6f15da954f2930c55e37184eeab7`（宿主包内容摘要，不是 Git commit）。

| 文件 | SHA-256 |
| --- | --- |
| acceptance.json | c12e76882bfa7e0961962cc4c6ebecd52bb558132cc7d028692fdd1a8c9e9ecf |
| host-checks.json | d0305920b053a31efd07da1c73924ce08dcd40ef72ebf528d5527d8c64b14567 |
| 1440-dark.png | c2a39ccc17a3d05b9052ded90a806341cfa7e8aa04498d934a99cd5cc4a56d4c |
| 1440-light.png | 55771efa0bd86ec80a03767f212ea2c1fd1209df751666c2e402855546a6e868 |
| 420-dark.png | 27cf6cb23aba10f3d3de9eb143679623ac78862650b667307315e2874452aa38 |
| 420-light.png | 3b32f23467caae5981c7b90abb3c043b07e450774e9e3399ceb53f9850b2bbfa |

清理后检查：生产 `pi-web.service` / `pi-web-sessiond.service` 均 active，原 `/home/jjr/.pi-web/sessiond.sock` 仍可用；没有向它们发送重启或停止命令。
