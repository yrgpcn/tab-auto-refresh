# 状态与 Agent 路由

Project Orchestrator 使用两个正交维度描述工作项。

## 状态

- `status:planning`：范围、方案、授权或验收标准仍需澄清；
- `status:ready`：范围与验收已足够执行；
- `status:implementation`：正在实现、验证或执行；
- `status:review`：已有可 Review 结果；
- `status:blocked`：受权限、外部输入、真机条件或未决决定阻塞；
- `status:done`：生命周期结束。

## Agent

- `agent:chat`：需求、架构、风险、发布与决策；
- `agent:workbuddy`：跨工具、多步骤协调、真机与状态同步；
- `agent:codex`：实现、测试、调试、重构。

每个 Issue / PR 最多一个 `status:*` 和一个 `agent:*`。

## 自动化边界

GitHub Actions 只维护可由事件可靠推导的事实：新 Issue 默认 planning、关闭即 done、PR draft 为 implementation、非 draft 为 review、关闭为 done。`planning → ready`、产品取舍、发布授权和是否 Merge 仍由人或 Agent 判断。

本仓库是 public。PR 标签路由使用 `pull_request_target` 只处理元数据；该 workflow 禁止 checkout、运行或 eval PR 提供的代码。这样既能给 fork PR 写标签，又不把外部代码带进高权限上下文。

迁移前 `BACKLOG.md` 不再是活跃状态来源；V1 / 发版已迁为 Issues #3 / #4。
