# Project Orchestrator v1.4 工作流

核心原则：**按任务类型选择最小必要角色，不强制固定 Chat → WorkBuddy → Codex 顺序。**

## 生命周期

1. **Capture**：新缺陷、功能、调查、真机验证、发布工作先进入 GitHub Issue；
2. **Plan / Chat**：写清问题、期望结果、边界、非目标、验收标准、风险与授权；
3. **Route**：代码实现 → Codex；真实 Chrome/GUI/发布/跨工具执行 → WorkBuddy；自动化验证 → Runner/CI；Review / merge readiness → Chat；
4. **Execute**：Codex 或 WorkBuddy 只在当前授权范围内执行；WorkBuddy 不是代码任务必经步骤；
5. **Verify / Runner**：仓库改动至少按适用范围执行 `node scripts/validate.mjs` 与 `node --test "tests/**/*.test.mjs"`；需要真实 Chrome 时按 Issue #3；
6. **Failure classification**：代码/测试逻辑 → Codex；runner/环境/真实浏览器问题 → WorkBuddy；验收或发布授权不清 → Chat；
7. **PR / Review**：实现进入 PR，正文包含关联 Issue、验证、风险/回滚和后续项；Chat Review diff、验收和 CI 证据；
8. **Merge**：批准规则满足后合并；长期状态变化同步 `docs/STATE.md`，长期决策进入 `docs/DECISIONS/`；
9. **Release**：发版是单独授权动作，不从 Merge 自动推导。

## Runner / CI 边界

Runner / CI 是独立验证层，不使用 `agent:runner`。Codex 本地测试成功不能替代项目要求的 CI；同样，CI 基础设施故障也不能自动解释为应用缺陷。

本仓库是 public：

- CI 与 Orchestrator 自动化继续优先使用 GitHub-hosted runner；
- 不把公共 / fork PR 的任意代码送入个人 self-hosted runner；
- `pull_request_target` 只处理可信元数据，不 checkout、运行或 eval PR 内容。

## 授权边界

- 历史文档、旧 BACKLOG、已有 Issue、TODO 或 CHANGELOG 条目都不是新的执行授权；
- “待发版”不等于允许改版本、打 tag 或推 tag；
- 真机验证发现问题时，先建缺陷 Issue，再决定是否修改产品；
- Orchestrator v1.4 升级不改变 Issue #3/#4 的既有授权边界。

## 事实优先级

1. `.project-orchestrator.yml` 与 GitHub Issue / PR 实际状态；
2. `status:*` / `agent:*` 标签；
3. Issue / PR 正文与 Handoff；
4. `docs/STATE.md` / `docs/ROUTING.md`；
5. `docs/ARCHITECTURE.md` / `docs/DECISIONS/`；
6. `AGENTS.md` 中受测试约束的技术契约；
7. CHANGELOG 与迁移前历史只用于背景。

当文档与 GitHub 实际状态冲突时，以 GitHub 当前对象为准，并修正文档。
