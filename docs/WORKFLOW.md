# Project Orchestrator 工作流

## 生命周期

1. **Capture**：新缺陷、功能、调查、真机验证、发布工作先进入 GitHub Issue；
2. **Plan**：写清问题、期望结果、边界、验收标准和依赖；
3. **Route**：使用一个 `status:*` + 最多一个 `agent:*` 表示阶段与下一角色；
4. **Execute**：Chat / WorkBuddy / Codex 只在当前授权范围内工作；
5. **Verify**：仓库改动至少跑 `node scripts/validate.mjs` 与 `node --test "tests/**/*.test.mjs"`；需要真机时按 Issue #3；
6. **PR**：实现进入 PR，正文包含关联 Issue、验证、风险/回滚和后续项；
7. **Review / Merge**：Review 通过后合并；长期状态变化同步 `docs/STATE.md`，长期决策进入 `docs/DECISIONS/`；
8. **Release**：发版是单独的授权动作，不从 Merge 自动推导。

## 授权边界

- 历史文档、旧 BACKLOG、已有 Issue、TODO 或 CHANGELOG 条目都不是新的执行授权；
- “待发版”不等于允许改版本、打 tag 或推 tag；
- 真机验证发现问题时，先建缺陷 Issue，再决定是否修改产品；
- 公开仓库外部 PR 的代码不能在个人 self-hosted runner 上执行，除非另有隔离与明确安全设计。

## 事实优先级

1. GitHub Issue / PR 实际状态；
2. 标签；
3. Issue / PR 正文与 Handoff；
4. `docs/STATE.md`；
5. `docs/ARCHITECTURE.md` / `docs/DECISIONS/`；
6. CHANGELOG 与迁移前历史只用于背景。

当文档与 GitHub 实际状态冲突时，以 GitHub 当前对象为准，并修正文档。
