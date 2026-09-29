# 项目状态

`docs/STATE.md` 是 tab-auto-refresh 的高层恢复入口。任务级真实状态以 GitHub Issues / Pull Requests 为准。

## 当前阶段

- Project Orchestrator 迁移已完成并进入 `main`。
- 迁移 Issue #2 已关闭；PR #5 已于 2026-09-29 squash merge。
- 迁移合并提交：`0548ac32adc0419bc656e4f13446030931fe1c29`。
- 当前产品版本仍为 `2.1.0`；迁移没有修改扩展产品代码、权限、manifest 行为、版本号或 release 语义。
- GitHub Issues / Pull Requests + `docs/STATE.md` 现在是当前状态、任务生命周期、执行与 Review 的权威体系。
- `AGENTS.md` 保留被测试直接对账的技术契约与长期工程约束，但不再承担当前状态、活跃任务或执行授权的权威职责。
- `BACKLOG.md` 降级为迁移前历史参考，不再新增活跃任务。

## 权威来源

恢复项目时按以下顺序读取：

1. GitHub Issue / Pull Request 的真实 open/closed/draft/merged 状态；
2. `status:*` / `agent:*` 标签；
3. 当前 Issue / PR 正文与 Handoff；
4. 本文件；
5. `docs/ARCHITECTURE.md` 与 `docs/DECISIONS/`；
6. `AGENTS.md` 中被测试直接对账的技术契约与长期工程约束；
7. `CHANGELOG.md` 只负责版本历史；
8. `BACKLOG.md` 与迁移基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 仅用于迁移前历史追溯。

聊天历史不是 canonical project state。

## 当前开放工作

| 来源 | GitHub Issue | 状态 / 下一角色 | 当前含义 |
|---|---:|---|---|
| V1 | #3 | `status:planning` / `agent:workbuddy` | Chrome 真机手工验证；迁移记录不自动授权产品修改 |
| 发版 | #4 | `status:planning` / `agent:chat` | 决定并执行 2.1.0 之后累计改动的下一版本；未授权自动发版、改版本或打/推 tag |

迁移 Issue #2 与迁移 PR #5 均为 `status:done`。新任务直接创建 GitHub Issue，不再向 `BACKLOG.md` 增加活跃待办。

## 自动化与 runner

- 现有 `.github/workflows/ci.yml` / `release.yml` 保持原行为；
- 本仓库是 public，CI 与 Orchestrator 自动化继续使用 GitHub-hosted runner；不把公共 PR 任意代码接到个人 self-hosted runner；
- PR #5 最终验证：`node scripts/validate.mjs` 成功；单测 `637 / 637` 通过；Orchestrator PR Check 成功；
- `.github/workflows/orchestrator-state-router.yml` 使用 `pull_request_target` 只处理标签元数据，**不得 checkout、执行或 eval PR 提供的代码**；
- Merge 时 Issue #2 closed 与 PR #5 closed 并发触发状态路由，两个 job 同时初始化标签，一条因 `422 already_exists` 竞态失败；Issue 路由成功并建立了标签目录；
- 已在 `main` 提交 `acea533cd333ad1f9cebfef4ef922126861cbe56`，让标签初始化把并发 `already_exists` 视为成功，避免相同竞态再次造成假失败；
- #3 / #4 的初始 `status:*` / `agent:*` 已完成落标。

## 迁移 Review 发现

初版曾尝试把 `AGENTS.md` 压缩成 39 行 Orchestrator 入口。仓库校验通过，但出现 42 条失败，集中在 `badge-state`、`cookie-schema`、`doc-anchors`、`doc-numbers`、`pipeline-ledger`、`storage-map` 等“技术文档与代码对账”门禁。产品代码没有变化。

这证明本仓库的 `AGENTS.md` 同时承担可执行技术规范职责。因此最终迁移边界是：Project Orchestrator 接管**当前状态、任务生命周期、Review、Handoff 与长期决策**；`AGENTS.md` 保留受测试约束的技术契约，并在顶部明确新的权威关系。未来若要把这些契约物理迁到独立文件，应作为单独测试重构完成，而不是治理迁移的副作用。

## 当前重要约束

- Manifest V3、原生 JS、无构建、无 npm 运行依赖；
- 中英文 locale 键、设置、消息、权限、存储、UI id/class 等存在跨文件不变量；精确契约以 `AGENTS.md` 的受测正文为准，架构导航见 `docs/ARCHITECTURE.md`；
- 外发 URL 不得重新泄漏 query/hash；
- 发布必须走既有版本校验与 tag 前缀，未明确授权不得打/推 tag；
- “Actions 绿”不能替代测试确实被发现并执行，也不能替代 Issue #3 的真机验证。

## 下一角色

`agent:chat`

## 下一动作

由用户选择并明确授权下一项工作：优先可进入 Issue #3 的 V1 真机验证；Issue #4 的发版决定依赖用户明确确认发布时机与版本号。两者均不会因为迁移完成而自动执行。

## 维护规则

- 本文件只保存高层状态，不复制 Issue 的逐条进度；
- 新工作进入 GitHub Issue；
- 长期决策进入 `docs/DECISIONS/`；
- 产品历史继续进入 `CHANGELOG.md`；
- `AGENTS.md` 只维护受测试约束的技术契约与长期工程规则，不再写当前任务状态；
- `BACKLOG.md` 不再新增活跃任务。
