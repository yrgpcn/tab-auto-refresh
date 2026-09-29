# 决策：使用 Project Orchestrator 替换旧项目记忆源

- 状态：`accepted`
- 日期：2026-09-29
- 关联：Issue #2

## 背景

迁移前，根 `AGENTS.md` 明确自称“项目记忆”，同时保存架构、审计结论、测试纪律、精确数值契约和操作说明；`BACKLOG.md` 保存仍活跃的工作，`CHANGELOG.md` 保存已发生的版本历史。

迁移 Review 进一步确认：`AGENTS.md` 不只是普通记忆文件。现有测试会直接解析其中的存储分区、cookie schema、badge 顺序、权限/版本、pipeline 数值和代码锚点等技术契约。初版迁移把它压缩成接手入口后，CI 出现 42 条文档契约门禁失败，而产品代码未变化。这说明“项目状态记忆”与“可执行技术规范”必须拆开理解，不能用治理迁移删掉后者。

## 决策

迁移到 Project Orchestrator：

- GitHub Issues / PRs：任务、执行、Review 的权威来源；
- `docs/STATE.md`：高层当前状态；
- `docs/ARCHITECTURE.md`：长期架构与系统边界的导航摘要；
- `docs/DECISIONS/`：新增长期决策；
- `docs/HANDOFF.md`：跨 Agent 交接；
- `docs/ROUTING.md`：`status:*` / `agent:*`；
- `AGENTS.md`：**保留被测试直接对账的技术契约与长期工程约束，但不再承担当前状态、活跃任务或执行授权的权威职责**；
- `BACKLOG.md`：迁移前历史参考，不再新增活跃待办；
- `CHANGELOG.md`：继续只记录版本历史。

迁移前未结的 V1 / 发版分别迁为 Issues #3 / #4。

## 为什么不把 AGENTS 强行缩短

本仓库已经把“文档必须与代码一致”做成可执行门禁：`doc-numbers`、`doc-anchors`、`storage-map`、`cookie-schema`、`badge-state`、`pipeline-ledger` 等测试直接读取 `AGENTS.md`。这些内容不是聊天记忆，而是测试体系的一部分。

因此本次迁移替换的是**状态/任务记忆源**，不是删除技术契约。`AGENTS.md` 顶部新增 Project Orchestrator 权威说明，原有受门禁约束的技术正文继续保留。未来若要把这些技术契约物理迁到独立规范文件，应作为单独重构，连同所有文档门禁一起迁移并保持等价覆盖，不与本次状态迁移混做。

## 历史保留

迁移基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 保留迁移前逐字节状态。当前 `AGENTS.md` 的技术契约正文仍在仓库中维护；迁移前的“AGENTS = 项目记忆 / BACKLOG = 活跃任务”治理关系不再有效。

## 授权边界

任务迁成 Issue 只表示持久状态迁移，不自动授权产品修改、真机操作、发版、改版本号、打 tag 或推 tag。历史审计记录也不等同于新指令。

## 公共仓库 runner 决策

本仓库 public，现有 CI 使用 GitHub-hosted runner 且最近可见运行成功。其他私有仓库因 Actions 额度/billing 采用 self-hosted 的做法不直接复制到本项目：公共 PR 对个人 self-hosted runner 的攻击面更高。Orchestrator 自动化继续用 hosted runner；如未来确需 self-hosted，必须另做隔离设计。
