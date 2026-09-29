# 状态与 Agent 路由

`tab-auto-refresh` 使用 **Project Orchestrator v1.4**。版本声明见根目录 `.project-orchestrator.yml`。

v1.4 按任务类型路由，不要求每项工作都经过所有角色。GitHub 是 Issue、PR、状态、决策和 CI 结果的权威来源。

## 状态

- `status:planning`：范围、方案、授权或验收标准仍需澄清；
- `status:ready`：范围与验收已足够执行；
- `status:implementation`：代码实现或真实环境执行正在进行；
- `status:review`：已有结果，正在 Verify / Review；
- `status:blocked`：受权限、外部输入、真机条件、runner 或未决决定阻塞；
- `status:done`：生命周期结束并完成验收。

每个 Issue / PR 最多一个 `status:*`。

## Agent 路由

### `agent:chat`

用于需求、架构、安全、发布/授权、Issue 拆解、验收标准、PR Review、merge readiness 和项目状态迁移。

### `agent:workbuddy`

用于真实 Chrome/GUI、跨工具操作、真机验收、发布/外部环境操作和多步骤执行。Issue #3 的 Chrome 真机手工验证属于这一类。

**WorkBuddy 不是代码任务的必经步骤。** 纯仓库代码工作可以从 Chat 直接路由 Codex。

### `agent:codex`

用于仓库代码、测试、调试、重构、build/workflow 代码和实现 PR。

每个需要人工/Agent 执行的活跃工作项最多一个 `agent:*`。

## Runner / CI

Runner / CI 是独立自动验证层，不是 reasoning agent，也不使用 `agent:runner`。

默认验证仍包括项目实际要求的 `node scripts/validate.mjs`、`node --test "tests/**/*.test.mjs"` 和适用的截图/发布检查。CI 失败先分类：

- 代码 / 测试 / build / workflow 逻辑 → `agent:codex`；
- runner / 网络 / credential / 浏览器真实环境 → `agent:workbuddy`；
- 期望行为、授权或发布决策不清 → `agent:chat`。

本仓库是 public。公共 / fork PR 的任意代码不得因为 v1.4 而被送入个人 self-hosted runner。

## 自动化边界

GitHub Actions 只维护可由事件可靠推导的事实：新 Issue 默认 planning、关闭即 done、PR draft 为 implementation、非 draft 为 review、关闭为 done。`planning → ready`、产品取舍、发布授权和是否 Merge 仍由人或 Agent 判断。

PR 标签路由使用 `pull_request_target` 时只允许处理可信元数据；禁止 checkout、运行或 eval PR 提供的代码。

迁移前 `BACKLOG.md` 不再是活跃状态来源；V1 / 发版已迁为 Issues #3 / #4。
