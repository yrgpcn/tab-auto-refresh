# 决策：使用 Project Orchestrator 替换旧项目记忆源

- 状态：`accepted`
- 日期：2026-09-29
- 关联：Issue #2

## 背景

迁移前，根 `AGENTS.md` 明确自称“项目记忆”，同时保存大量架构、审计结论、测试纪律与操作说明；`BACKLOG.md` 保存仍活跃的工作，`CHANGELOG.md` 保存已发生的版本历史。这让状态、长期知识和 Agent 接手说明混在一处，并且待办不在 GitHub 工作项生命周期里。

## 决策

迁移到 Project Orchestrator：

- GitHub Issues / PRs：任务、执行、Review 的权威来源；
- `docs/STATE.md`：高层当前状态；
- `docs/ARCHITECTURE.md`：长期架构、跨文件不变量和硬约束；
- `docs/DECISIONS/`：新增长期决策；
- `docs/HANDOFF.md`：跨 Agent 交接；
- `docs/ROUTING.md`：`status:*` / `agent:*`；
- `AGENTS.md`：精简接手入口，不再承担项目记忆正文；
- `BACKLOG.md`：迁移前历史参考，不再新增活跃待办；
- `CHANGELOG.md`：继续只记录版本历史。

迁移前未结的 V1 / 发版分别迁为 Issues #3 / #4。

## 历史保留

不复制一份新的 58KB 旧 `AGENTS.md` 制造第三套事实源。迁移基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 本身就是逐字节历史快照；长期仍有效的内容提炼到 `docs/ARCHITECTURE.md`，需要审计旧表述时直接查该提交。

## 授权边界

任务迁成 Issue 只表示持久状态迁移，不自动授权产品修改、真机操作、发版、改版本号、打 tag 或推 tag。

## 公共仓库 runner 决策

本仓库 public，现有 CI 使用 GitHub-hosted runner 且最近可见运行成功。其他私有仓库因 Actions 额度/billing 采用 self-hosted 的做法不直接复制到本项目：公共 PR 对个人 self-hosted runner 的攻击面更高。Orchestrator 自动化继续用 hosted runner；如未来确需 self-hosted，必须另做隔离设计。
