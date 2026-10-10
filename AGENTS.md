<!-- governance-product:architecture-governance:start -->
## 架构治理

架构说明的建立、维护和只读审查使用[架构治理 Skill](.agents/skills/architecture-governance/SKILL.md)。正式架构规则只由 [docs/architecture/AGENTS.md](docs/architecture/AGENTS.md) 维护；`.agents/architecture/state.json` 只记录已定位的结论、归属和依据，不能引用自身作为依据。

核心约束使用[系统约束治理 Skill](.agents/skills/system-constraint-governance/SKILL.md)。只有用户在当前任务明确要求时，Agent 才能建立、修改或退役顶层能力；下层行为和测试只能在不改变父能力语义时维护。每条生效顶层能力必须在 `.agents/architecture/system-constraints.json` 中登记正常行为、变体行为及各自的可定位测试。

代码、配置、测试或外部边界改变后，先判断目的、边界、责任、核心流程或信任边界是否变化，再维护相应的架构文档和状态。状态只绑定已经引用的文档、依据和测试内容，不扫描或登记无关文件。不要以目录名、旧文档或 import 线索代替可定位的事实依据。

本地调查可使用 `candidate`，完成审阅且没有关键待确认事项时可整理为 `active`。目标项目可按自身交付流程决定是否运行：

```sh
node .agents/architecture-governance/check-state.mjs check --require-active
```
<!-- governance-product:architecture-governance:end -->
