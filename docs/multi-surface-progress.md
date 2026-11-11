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
| S5 | 已实现并通过离线测试，验收未完 | 独立 Web 子包；存在下述全范围长结果传输缺口 |
| S6 | 未执行 | 尚未部署到实际宿主、未做真实浏览器/外部认证/IME/Provider 验收 |

S1–S4 提交：`ace0615`。原有高级 TUI selector、快捷键 ready/捕获兼容、Revise、Preferences 和接受/发送保留在原流程；不对外暴露内部背景 DTO。核心仍只有一个 controller/sidecar writer，没有跨进程共享或 Web 自建运行队列。

## 已完成检查

- 根 `npm run typecheck` 通过。
- 根完整离线回归：**1233 通过、33 跳过、0 失败**；基线 1188 通过、33 跳过，新增 45 项。
- 固定种子 `20261109` 随机顺序运行同样通过；默认 live/benchmark 开关未改、未启用。
- 对照基线 JSON 的既有用例名称/状态/出现次数，没有减少；原有测试声明文件未删除或改写。
- Web 子包独立 typecheck、双构建、Node 离线测试 **4/4 通过**。移除根 `node_modules` 临时链接后再次通过，验证独立开发依赖图。
- 根 TypeScript 文件图不包含 Web 子包或 pi-web；浏览器 emitted graph 不含 Node、controller、history-store 或 server 代码；server 不需要运行时解析全局 pi-web 包。
- 根 package.json、package-lock.json、tsconfig.json、vitest.config.ts、sidecar 白名单未改变。
- 未修改或纳入主工作区的 `foundations.md`、`docs/first-slice-contract.md`、`docs/multi-surface-adaptation-plan.md`。
- 无服务部署/重启、无真实 Provider 请求、无凭据拷贝、无浏览器操作。没有委派实现或代码评审。

可重跑命令见 [测试说明](testing.md) 和 [Web 子包说明](../packages/pi-web/README.md)。本机临时证据：`/tmp/refine-implementation-baseline.json`、`/tmp/refine-implementation-final.json`、`/tmp/refine-implementation-shuffle.json` 及对应日志；这些临时文件不提交到仓库。

## 当前发现的问题：极端长结果未全范围对齐

输入 staging 已覆盖合法的 100,000 UTF-16 code units 原稿（包括 Unicode 与 JSON 转义），并有真实 core events adapter + browser client/server peer 的离线闭环。

但输出路径仍有两层不同的预算：core 最多 16 MiB JSON，Web server 最多 16 MiB **base64** 暂存。合法上限下的转义密集结果/修订前结果可能超过预算。新增配额测试使用 2,097,152 个 NUL 字符的模拟结果验证显式 `resource-limit` 和内存记账释放；这不是成功传输证明。

当前不会截断正文、泄露背景或自动重发，但**不能声称全部输出配置范围已经对齐**。优先修复方向是 core 边界按需分页/流式读取，避免同步喷发所有输出帧并由 server 再整份缓存；不能只加大所有队列而跳过宿主实际限制验证。

按“有问题先汇报”的要求停在此处，不将 S5/S6 标记完成，不做 FF 合并。解决该缺口并完成约定验收后，才按原要求 FF 到 main；若接受限制先合并，需要明确改变验收边界。

## S6 所需决定

建议使用独立数据目录、socket/端口和 Pi agent profile 的临时实例，先做实际插件加载、public capability/配对握手与无 Provider 的草稿闭环，再做双浏览器并发/重连、长结果、鉴权及视觉/IME 验收。不得继承当前宿主的 live state 路径。

现有 session daemon 没有获得重启授权；它的重启会中断活动 session 和终端。实际 Provider 调用也需单独明确授权。离线测试不会替代这些验收。
