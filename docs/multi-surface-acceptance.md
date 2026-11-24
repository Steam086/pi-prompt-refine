# 首片隔离宿主验收记录

## 范围与隔离

在授权的独立临时实例中验收。使用单独的 Pi 与宿主数据、Unix socket、随机 loopback 端口和 Chrome profile。模型请求只到确定性 stub。

- 实际启动安装的 pi-web **1.202611.1**，显式选择 Pi SDK **1.5.2**，Node **24.18.0**。
- Chrome **156.0.8078.47**，使用已有浏览器的 CDP，无新增 browser runner/依赖。
- Web 候选经真实宿主加载，沿用公开 session-events capability。Refine 请求的 tools 数为 0。重载通过测试扩展调用 `ctx.reload()`。

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

启动回执先于下拉选项时，浏览器会清空未匹配的选择值。为保留运行目标，将 run ID 与原 Binding 独立保存。补充[桥接回归](../packages/pi-web/test/bridge.test.mjs)后，实际浏览器闭环复验通过。

命令命名冲突进入普通 prompt 的风险由[根集成测试](../test/integration/slash-api.test.ts)覆盖。该分支未在真实宿主注入。截图覆盖两种尺寸和主题，人工视觉和 IME 仍需复验。

## 未验收/不在本次授权内

- 人工中文 IME 组合输入、真实用户视觉/可访问性验收，以及不同浏览器/终端的人工检查。
- 生产外网反向代理的 HTTP **及 WebSocket 身份认证**、TLS、远程机器/Fleet。loopback Host/Origin 防护不能替代这些项目。
- 真实 Provider、真实费用、供应商断线/取消表现。
- 当前生产实例的插件部署/重启；未触碰其配置、凭据、会话或终端。
- Web accept/send/restore，以及设计中后续完整 Settings/Preferences 能力，不属于本片。

## 证据与清理

记录、脚本、日志与截图保存在当次隔离环境的本地证据中。临时运行状态和候选副本已清理。

最终候选实际配对 revision：`sha256:a7e309478c1184bd97e379f3e889f77f7b2c6f15da954f2930c55e37184eeab7`（宿主包内容摘要，不是 Git commit）。

| 文件 | SHA-256 |
| --- | --- |
| acceptance.json | c12e76882bfa7e0961962cc4c6ebecd52bb558132cc7d028692fdd1a8c9e9ecf |
| host-checks.json | d0305920b053a31efd07da1c73924ce08dcd40ef72ebf528d5527d8c64b14567 |
| 1440-dark.png | c2a39ccc17a3d05b9052ded90a806341cfa7e8aa04498d934a99cd5cc4a56d4c |
| 1440-light.png | 55771efa0bd86ec80a03767f212ea2c1fd1209df751666c2e402855546a6e868 |
| 420-dark.png | 27cf6cb23aba10f3d3de9eb143679623ac78862650b667307315e2874452aa38 |
| 420-light.png | 3b32f23467caae5981c7b90abb3c043b07e450774e9e3399ceb53f9850b2bbfa |

清理后检查：生产 `pi-web.service` / `pi-web-sessiond.service` 均 active，原用户级 session socket 仍可用；没有向它们发送重启或停止命令。
