# 项目状态

`docs/STATE.md` 是 tab-auto-refresh 的高层恢复入口。任务级真实状态以 GitHub Issues / Pull Requests 为准。

## 当前阶段

- tab-auto-refresh 已采用 **Project Orchestrator v1.4**。
- v1.4 升级 Issue #6 已关闭；PR #7 已于 2026-09-29 squash merge，合并提交：`2503348f056581db6ede5d2ff2eb3a32abc47bd3`。
- 版本契约由根目录 `.project-orchestrator.yml` 声明，后续升级策略为 `manual-pr`。
- v1.4 按任务类型动态路由：Chat 负责规划/Review/授权，WorkBuddy 负责真实 Chrome/跨工具/发布环境执行，Codex 负责仓库实现，Runner/CI 独立负责自动验证。
- 正式发布版本仍为 `2.1.0`；当前正准备 `2.2.0`，尚未完成 Tag 和 Release。
- GitHub Issues / Pull Requests + `docs/STATE.md` 是当前状态、任务生命周期、执行与 Review 的权威体系。
- `AGENTS.md` 保留被测试直接对账的技术契约与长期工程约束，但不承担当前状态、活跃任务或执行授权的权威职责。
- `BACKLOG.md` 仅为迁移前历史参考，不再新增活跃任务。

## 权威来源

恢复项目时按以下顺序读取：

1. `.project-orchestrator.yml`；
2. GitHub Issue / Pull Request 的真实 open/closed/draft/merged 状态；
3. `status:*` / `agent:*` 标签；
4. 当前 Issue / PR 正文、Handoff 与 CI 证据；
5. 本文件与 `docs/ROUTING.md`；
6. `docs/ARCHITECTURE.md` 与 `docs/DECISIONS/`；
7. `AGENTS.md` 中被测试直接对账的技术契约与长期工程约束；
8. `CHANGELOG.md` 只负责版本历史；
9. `BACKLOG.md` 与迁移基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 仅用于迁移前历史追溯。

聊天历史不是 canonical project state。

## 当前开放工作

| 来源 | GitHub Issue | 状态 / 下一角色 | 当前含义 |
|---|---:|---|---|
| 发版 | #4 | `status:planning` / `agent:chat` | 2.2.0 发布准备中；用户确认按「保留历史 Release/Tag」策略发布，需经 CI 后完成版本 Tag 与正式 Release |
| 延期验收 | #15 | `status:planning` / `agent:chat` | Windows 通知、系统 DPI、微信真实渲染等未测专项持续跟踪，不能标为 PASS |

Issue #3 核心 Chrome 验收已完成关闭；Issue #8/#10/#11 的代码修复以及 #13 的疑点归因均已结案。PR #9/#12/#14 已合并，详情以对应 GitHub Issue/PR 和 CI 为准。准备分支中 manifest 已规划升至 2.2.0，发布完成前正式 Release 仍是 2.1.0。

## 自动化与 Runner

- Runner / CI 在 v1.4 中是独立自动验证层，不使用 `agent:runner`；Codex 本地测试不能替代要求的 CI。
- PR #7 的 GitHub-hosted CI **真实执行并成功**：Validate manifests/locales/JS syntax 与 Unit tests 两个主要步骤均成功；Orchestrator PR Check 也成功。
- 现有 `.github/workflows/ci.yml` / `release.yml` 保持原行为；
- CI 失败先分类：仓库代码/测试/build 逻辑 → Codex；runner/浏览器/网络/credential/真实环境 → WorkBuddy；期望行为或发布授权不清 → Chat；
- 本仓库是 public，CI 与 Orchestrator 自动化继续使用 GitHub-hosted runner；不把公共 PR 任意代码接到个人 self-hosted runner；
- `.github/workflows/orchestrator-state-router.yml` 使用 `pull_request_target` 只处理标签元数据，**不得 checkout、执行或 eval PR 提供的代码**；
- Merge 时标签初始化竞态已由提交 `acea533cd333ad1f9cebfef4ef922126861cbe56` 修复。

## AGENTS 技术契约特例

初版迁移曾尝试把 `AGENTS.md` 压缩成 Orchestrator 入口，导致 42 条契约测试失败。这证明 `AGENTS.md` 是可执行技术规范的一部分。

因此 v1.4 继续保持同一边界：Project Orchestrator 接管**当前状态、任务生命周期、Review、Handoff、路由与长期决策**；`AGENTS.md` 继续保留受测试约束的技术契约。未来若物理迁移这些契约，必须作为独立测试重构并保持等价覆盖。

## 当前重要约束

- Manifest V3、原生 JS、无构建、无 npm 运行依赖；
- 中英文 locale 键、设置、消息、权限、存储、UI id/class 等存在跨文件不变量；精确契约以 `AGENTS.md` 的受测正文为准；
- 外发 URL 不得重新泄漏 query/hash；
- 发布必须走既有版本校验与 tag 前缀，未明确授权不得打/推 tag；
- “Actions 绿”不能替代测试确实被发现并执行，也不能替代 Issue #3 的真机验证。

## 下一角色

`agent:chat`

## 下一动作

在 `release/prepare-v2.2.0` 的发布准备 PR 中，确认 manifest 2.2.0、CHANGELOG 用户摘要及完整工程记录、历史 Release/Tag 保留策略与发布契约回归。通过 GitHub-hosted CI、Chat Review 后，合并至 main，再创建 `tab-auto-refresh/v2.2.0` Tag 触发现有 Release workflow。核对资产与历史 v2.1.0 仍存在。Issue #15 继续作为延期实测账。

## 维护规则

- 本文件只保存高层状态，不复制 Issue 的逐条进度；
- 新工作进入 GitHub Issue；长期决策进入 `docs/DECISIONS/`；
- 产品历史继续进入 `CHANGELOG.md`；
- `AGENTS.md` 只维护受测试约束的技术契约与长期工程规则，不写当前任务状态；
- `BACKLOG.md` 不再新增活跃任务；
- 后续 Project Orchestrator 版本变更必须通过独立 migration PR，不能静默自动改写采用仓库。
