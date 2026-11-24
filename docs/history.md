# 历史决策与验收

以下记录用于追溯设计与验收。当前操作、契约及待办从[文档索引](index.md)进入。旧计划中的原始提案、状态表和逐文件实施记录可在整理前的 Git 版本 `1d5b26d` 中查看。

| 主题 | 保留的决策与证据 |
| --- | --- |
| 多入口首片 | 先交付配置模型、保存草稿、显式运行和查询。单个 hosted runtime 共享 controller，远端副作用按 scope 和版本守卫。现行契约见[应用接口](application-api.md)，旧切片计划见 Git 中的 `first-slice-contract.md` 和 `multi-surface-adaptation-plan.md`，实际结果见[实施交接](multi-surface-progress.md)及[隔离验收](multi-surface-acceptance.md)。 |
| 历史与 Revise | 历史保存完整候选与最小元数据，省略整条超限记录，避免截断；恢复时不带旧背景。Revise 选择事务与偏好库写入分离，取消选择仍保留已落盘库写入。比较与修订计划原文见 Git 中的 `history-ux-plan.md` 与 `revision-preferences-plan.md`。 |
| TUI 布局与选中态 | 选中样式标识操作目标，阅读焦点切换仍保留标记。选中背景配合文字强调，便于颜色相近的主题辨认。下面的两张前后对照基于 `5a87ac4` 的对照画面和当时修改后的真实 ANSI 渲染；实体终端外观、键盘和 IME 需要另验。旧展开布局和性能测量见 Git 中的 `ui-refinement.md`，当前规则见[界面约束](ui-conventions.md)。 |
| 测试重构 | 基线 `f41e969`。当时保留全部 1,160 个展开用例的身份和状态并新增 15 项。另以两种主题、五个窗口尺寸和固定输入序列比较新旧 ANSI 帧、滚动、选择及动作，观测结果一致。这是该次重构的回归证据。 |
| 原生 `0.1.0` 候选审核 | 2026-11-22 记录了 Pi 1.6.0 在 Linux 上的干净安装、tarball 试装和 registry dry run。此前 macOS 人工验收由维护者报告，版本待核实。审核时的 registry 可见性、依赖审计和安全设置仅反映当时状态，最终候选仍须执行[发布清单](release.md)。完整记录见 Git 中的旧版 `release.md`。 |

[浅色选中态对照](assets/selection-states-light.svg) · [深色选中态对照](assets/selection-states-dark.svg)

例如，从仓库根查看原始 TUI 设计：

```sh
git show 1d5b26d:docs/ui-refinement.md
```
