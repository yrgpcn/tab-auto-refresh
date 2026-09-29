# 项目状态

`docs/STATE.md` 是 tab-auto-refresh 的高层恢复入口。任务级真实状态以 GitHub Issues / Pull Requests 为准。

## 当前阶段

- 当前工作：用 Project Orchestrator 替换旧的“`AGENTS.md` 同时承担项目记忆 + `BACKLOG.md` 承担活跃待办”治理模式。
- 迁移 Issue：#2；迁移 PR：#5。
- 迁移分支：`chore/project-orchestrator-migration`。
- 当前产品版本：`2.1.0`。
- 本次迁移只改项目治理、状态载体、模板和轻量自动化；不修改扩展产品代码、权限、manifest 行为、测试语义或 release 语义。
- Review 已确认：现有测试直接解析 `AGENTS.md` 中的精确技术契约。因此迁移后 `AGENTS.md` 保留这部分受门禁约束的工程规范，但不再承担当前状态、活跃任务或执行授权的权威职责。

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

| 来源 | GitHub Issue | 当前含义 |
|---|---:|---|
| Orchestrator 迁移 | #2 | 替换原项目状态/任务记忆源；PR #5 Review 中 |
| V1 | #3 | Chrome 真机手工验证；迁移记录不自动授权产品修改 |
| 发版 | #4 | 决定并执行 2.1.0 之后累计改动的下一版本；未授权自动发版/tag |

迁移后新任务直接创建 GitHub Issue，不再向 `BACKLOG.md` 增加活跃待办。

## 自动化与 runner

- 现有 `.github/workflows/ci.yml` / `release.yml` 保持原行为；
- 该仓库是 public，现有 CI 使用 `ubuntu-latest`，最近可见的 2026-09-23 CI 运行成功；
- 新的 Orchestrator PR Check 已在 PR #5 上实际使用 GitHub-hosted runner 并成功执行；
- 新的 Orchestrator 元数据自动化继续使用 GitHub-hosted runner；
- 不复用私有仓库为额度问题准备的个人 self-hosted runner，因为公共 PR 对个人机器的攻击面不同；
- `orchestrator-state-router.yml` 使用 `pull_request_target` 仅处理标签元数据，**不得 checkout、执行或 eval PR 提供的代码**。

## 迁移 Review 发现

初版曾把 `AGENTS.md` 压缩成 39 行 Orchestrator 入口。仓库校验通过，但单测 631 条中 42 条失败；失败集中在 `badge-state`、`cookie-schema`、`doc-anchors`、`doc-numbers`、`pipeline-ledger`、`storage-map` 等“技术文档与代码对账”门禁。产品代码没有变化。

据此修正迁移边界：Project Orchestrator 接管**当前状态、任务生命周期、Review、Handoff 与长期决策**；`AGENTS.md` 保留其可执行技术契约职责，并在顶部明确新权威关系。技术契约未来若要物理迁到独立文件，应作为单独测试重构完成，而不是本次治理迁移的副作用。

## 当前重要约束

- Manifest V3、原生 JS、无构建、无 npm 运行依赖；
- 中英文 locale 键、设置、消息、权限、存储、UI id/class 等存在跨文件不变量；精确契约以 `AGENTS.md` 的受测正文为准，架构导航见 `docs/ARCHITECTURE.md`；
- 外发 URL 不得重新泄漏 query/hash；
- 发布必须走既有版本校验与 tag 前缀，未明确授权不得打/推 tag；
- “Actions 绿”不能替代测试确实被发现并执行，也不能替代 Issue #3 的真机验证。

## 下一角色

`agent:workbuddy`

## 下一动作

完成 PR #5 的第二轮 CI / Review；Merge 后初始化 `status:*` / `agent:*` 标签，并以 Issues #3 / #4 作为后续未结工作的唯一活跃任务入口。

## 维护规则

- 本文件只保存高层状态，不复制 Issue 的逐条进度；
- 新工作进入 GitHub Issue；
- 长期决策进入 `docs/DECISIONS/`；
- 产品历史继续进入 `CHANGELOG.md`；
- `AGENTS.md` 只维护受测试约束的技术契约与长期工程规则，不再写当前任务状态；
- `BACKLOG.md` 不再新增活跃任务。
