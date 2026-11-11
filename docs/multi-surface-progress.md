# 多入口实施进度与停止点

基线：`563073b43321296750df2102b9739d380d308810`。
工作分支：`feat/multi-surface-s1-s6`；实现工作在独立 worktree 完成，未改主工作区的既有未跟踪文档。

## 当前状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| S1 | 离线实现/验证通过 | 纯 API/ports、白名单 DTO、就绪与 Binding、共享排序 |
| S2 | 离线实现/验证通过 | task/run/optimizer 版本、有界 lease/ledger、草稿操作、模型设置、invalidation |
| S3 | 离线实现/验证通过 | 非 TUI 单次无工具执行、明确 started/queued/duplicate ID、停止；TUI 工作区保存/运行/停止/默认模型使用共享用例 |
| S4 | 离线实现/验证通过 | `/refine-api`、保留旧路由、只读输出、重试 scope、命令冲突提示、session-events 及有界传输 |
| S5 | 离线实现/验证通过 | 独立 Web 子包；长结果暂存缺口已通过 core 按需分页修复，真实宿主验证留给 S6 |
| S6 | 未执行 | 尚未部署到实际宿主、未做真实浏览器/外部认证/IME/Provider 验收 |

S1–S4 提交：`ace0615`。原有高级 TUI selector、快捷键 ready/捕获兼容、Revise、Preferences 和接受/发送保留在原流程；不对外暴露内部背景 DTO。核心仍只有一个 controller/sidecar writer，没有跨进程共享或 Web 自建运行队列。

## 已完成检查

- 根 `npm run typecheck` 通过。
- 根完整离线回归：**1238 通过、33 跳过、0 失败**；基线 1188 通过、33 跳过，新增 50 项。
- 固定种子 `20261109` 随机顺序运行同样通过；默认 live/benchmark 开关未改、未启用。
- 对照基线 JSON 的既有用例名称/状态/出现次数，没有减少；原有测试声明文件未删除或改写。
- Web 子包独立 typecheck、双构建、Node 离线测试 **7/7 通过**。移除根 `node_modules` 临时链接后再次通过，验证独立开发依赖图。
- 根 TypeScript 文件图不包含 Web 子包或 pi-web；浏览器 emitted graph 不含 Node、controller、history-store 或 server 代码；server 不需要运行时解析全局 pi-web 包。
- 根 package.json、package-lock.json、tsconfig.json、vitest.config.ts、sidecar 白名单未改变。
- 未修改或纳入主工作区的 `foundations.md`、`docs/first-slice-contract.md`、`docs/multi-surface-adaptation-plan.md`。
- 无服务部署/重启、无真实 Provider 请求、无凭据拷贝、无浏览器操作。没有委派实现或代码评审。

可重跑命令见 [测试说明](testing.md) 和 [Web 子包说明](../packages/pi-web/README.md)。本机临时证据：`/tmp/refine-implementation-baseline.json`、`/tmp/refine-implementation-final.json`、`/tmp/refine-implementation-shuffle.json` 及对应日志；这些临时文件不提交到仓库。

## 发现并修复的问题：极端长结果暂存

输入 staging 已覆盖合法的 100,000 UTF-16 code units 原稿（包括 Unicode 与 JSON 转义），并有真实 core events adapter + browser client/server peer 的离线闭环。

最初实现中 core 的 16 MiB JSON 限额与 server 的 16 MiB base64 暂存不一致，合法的转义密集结果/参考会被拒绝。发现后增加复现测试，并改为 core 保留脱离内部背景的 DTO + 有界编码迭代器，按页请求才编码/返回；server 不再整份缓存，也不一次性推送大量帧。

新增根单测覆盖 Unicode/不成对 surrogate/转义的流式等价性、惰性编码、页重放、顺序/连接/Binding 守卫及释放/过期/断开。Web 回归完整传输 2,097,152 字符结果 + 同长度前结果 + 三份 100,000 字符原稿/要求，使用最坏转义数据，逐帧小于 60 KiB，超过 500 页且没有响应喷发；额外验证不合法超配额 DTO 的显式拒绝。

另补齐 Web 表单守卫：切换 scope 后保留原文及其 Binding，不暗中变为新 session 的 create；恢复保存回执只关联原表单，不覆盖后续编辑；未改动的 textarea 内容保留原始 CRLF；模块重载不复用旧版本 custom element class。相关检查是无 DOM/浏览器的状态与注册测试，不声称视觉/IME 已验收。

该问题已在离线链路解决，S5 不再因整份 base64 暂存而缩小合法输出范围。但真实宿主的 public capability、实际浏览器与部署边界仍未验收，所以 S6 未标完成、尚未 FF。完成约定验收后再按原要求 FF；若先合并离线实现，需要明确接受这一剩余验收边界。

## S6 所需决定

建议使用独立数据目录、socket/端口和 Pi agent profile 的临时实例，先做实际插件加载、public capability/配对握手与无 Provider 的草稿闭环，再做双浏览器并发/重连、长结果、鉴权及视觉/IME 验收。不得继承当前宿主的 live state 路径。

现有 session daemon 没有获得重启授权；它的重启会中断活动 session 和终端。实际 Provider 调用也需单独明确授权。离线测试不会替代这些验收。
