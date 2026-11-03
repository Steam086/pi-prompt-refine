# Pi Prompt Refine

Pi Coding Agent 的非阻塞 Prompt 优化扩展。使用独立选择的模型，结合当前草稿与有界上下文生成候选；后台展示进度和摘要，不抢焦点、不自动改稿或发送。

## 核心功能

- 后台优化，支持预览、微调、接受、明确发送和安全恢复。
- 独立选择优化模型，复用 Pi 的 Provider 与认证，不切换主 Agent 模型。
- 使用当前分支可见历史、宿主已加载的项目规则及有界目录信息。
- 默认追求最小有效修改，允许原样返回，保留用户约束、授权范围与不确定性。

## 安装与使用

Node.js **22.19+**；当前验证基线为 Pi **1.4.0**，其他版本需另行验证。

```bash
npm ci
pi install . --local
# 或仅为一次运行加载：pi --extension ./src/extension.ts
```

1. `/refine model` 选择优化模型；首次加载未配置时会提示此入口，不会借用主模型或自动发请求。模型和认证由 Pi 提供，扩展不下载模型。
2. 输入草稿，按 **Control+反斜杠（`Ctrl+\`）** 启动优化；已有任务或结果时，同一快捷键只打开面板。
3. 面板中按 `a` 接受到编辑器、`e` 微调、`s` 明确发送，或 `q` / Esc 返回。再次优化当前草稿用 `r`。

对当前候选继续调整：在面板按 `f`，输入“再短一点，命令原样保留”等要求，Enter 发起修订。`r` 仍优化主编辑器草稿，`i` 仍输入新草稿；修订不改主编辑器、不自动发送，失败保留原候选。

也可直接执行 `/refine 待优化文本`，再用 `/refine view` 查看结果。修改源码或快捷键配置后执行 `/reload`。

## 核心实现

```text
捕获草稿、历史和项目资源 → controller 管理后台请求
→ 组装系统协议与 JSON 输入 → Pi streamSimple 单次调用（tools: []）
→ 校验 prompt/title → 保留候选 → 用户接受或发送
```

Optimizer 不是独立的 Pi Agent session，没有工具和跨请求记忆。系统协议与可编辑策略分离；历史携带来源及完整性信息，输出通常回到原会话。取消、超时和会话失效通过请求身份校验阻止迟到结果生效。

默认不读取源码或技能正文，也不提供模型补读。所选 Provider 会收到草稿及启用的背景；字符预算尚不等于统一 token 预算。非 TUI 模式不发优化请求。

## 文档与开发

- [使用说明](docs/usage.md) · [配置参考](docs/configuration.md) · [上下文与 Prompt 协议](docs/context.md)
- [项目架构](AGENTS.md) · [设计取舍与验证边界](DESIGN.md) · [后续方向](ROADMAP.md)
- [快捷键排查](docs/shortcut-troubleshooting.md) · [Prompt 语义验收样例](docs/optimizer-evaluation.md)

本地检查：`npm run typecheck`、`npm test`。现有测试以离线验证为主，真实 Provider 的改写效果尚待验证。
