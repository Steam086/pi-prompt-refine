# 改写语义验收

先用相同草稿和冻结背景对照原稿与改写，检查表达是否更清楚、指代依据是否充分，以及约束、字面材料、不确定性和授权范围是否保留。清晰的原稿可以原样返回。明确授权的编辑必须完成。连续 Revise 还需检查已有合法修改是否被撤销，已删除要求是否复活。

记录真实模型、thinking、代码版本、实际使用的输入、输出、耗时和用量。使用合成或已批准的脱敏样例。自动化断言证明已覆盖的输入构造和输出封装，语义质量需要读候选并结合原对话判断。

| 目的 | 样例与证据 |
| --- | --- |
| 首次澄清、上下文纠正、字面保护、明确编辑和条件偏好 | [SDK live fixture 与断言](../test/live/refine-policy.live.test.ts) |
| 粘贴 TUI 原稿 | [保留案例与模型观察](experiments/luna-reference-preservation.md) |
| 连续修订、合法编辑和要求复活 | [连续修订对照](experiments/revision-semantics-experiment.md) |
| 统一语义评分 | [12 题合成 benchmark 设计](benchmarks/project-semantic-fidelity-v1/README.md) · [判题规则](benchmarks/project-semantic-fidelity-v1/judge.md) |
| 历史下游格式遵循 | [IFEval 实验及局限](experiments/README.md) |

## 保守策略的显式编辑防退化检查

真实模型测试需明确启用、已配置 Pi 凭据及模型调用授权，输出文件包含实际发送的样例和候选。用新的本地路径记录一次运行：

```sh
REFINE_POLICY_LIVE=1 REFINE_POLICY_OUTPUT=/tmp/refine-policy.jsonl \
  npm test -- test/live/refine-policy.live.test.ts
```

模型选择、默认参数和可用环境变量见[测试入口](../test/live/refine-policy.live.test.ts)。
