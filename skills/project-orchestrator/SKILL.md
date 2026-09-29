# tab-auto-refresh Project Orchestrator v1.4

用于在本仓库恢复状态、按任务类型路由工作，并保持 Chat / WorkBuddy / Codex / Runner / GitHub 一致。

## 恢复

1. 读 `.project-orchestrator.yml`；
2. 读 `AGENTS.md` 顶部权威说明及受测试技术契约；
3. 读 `docs/STATE.md` 与 `docs/ROUTING.md`；
4. 读取当前相关 Issue / PR、标签与 CI；
5. 需要系统背景再读 `docs/ARCHITECTURE.md`；
6. 需要长期取舍再读 `docs/DECISIONS/`。

不要把聊天历史、迁移前 `BACKLOG.md` 或旧项目状态段落当成当前权威状态。

## v1.4 路由

- `agent:chat`：需求、架构、安全、发布授权、Issue 拆解、Review、merge readiness 与状态迁移；
- `agent:workbuddy`：真实 Chrome/GUI、真机验证、发布/外部环境操作和跨工具执行；
- `agent:codex`：代码、测试、调试、重构、build/workflow 代码与 Draft PR；
- Runner / CI：独立自动验证，不使用 `agent:runner`。

**WorkBuddy 不是必经步骤。** 纯代码任务可以直接 Chat → Codex → Runner Verify → Chat Review。

验证失败先分类：

- 代码 / 测试 / build / workflow 逻辑 → Codex；
- runner / 浏览器 / 网络 / credential / 真实环境 → WorkBuddy；
- 需求、验收或发布授权不清 → Chat。

## 实现前检查

- 找到关联 Issue 与验收标准；
- 确认是否涉及跨文件账本（i18n、settings、storage、message、permission、cookie、UI、badge、pipeline 等）；
- 确认许可证与外发隐私边界；
- 确认是否需要真机验证或发布授权。

## 验证

默认运行：

```bash
node scripts/validate.mjs
node --test "tests/**/*.test.mjs"
```

必要时增加 `node scripts/screenshot-popup.mjs --measure` 与 Issue #3 的真实 Chrome 步骤。Codex 本地结果与 Runner/CI 证据应分别记录。

## PR / Merge / Release

PR 必须写摘要、关联工作、验证、风险/回滚、文档/决策与后续事项。Merge 后关闭已完成 Issue，并只在高层状态真的变化时更新 `docs/STATE.md`。

Release 是独立授权动作；Merge 不自动授权改版本、打 tag 或推 tag。

## 公共仓库安全

不要把 fork/公共 PR 的任意代码送入个人 self-hosted runner。`pull_request_target` workflow 只能处理可信元数据逻辑，不 checkout、执行或 eval PR 内容。

## AGENTS 技术契约

`AGENTS.md` 的正文仍被测试直接解析，是技术规范而不是当前任务记忆。Orchestrator v1.4 不得为了统一文档形态而压缩、替换或搬迁这些契约；如未来抽离，必须作为单独测试重构并保持等价覆盖。

## 升级策略

后续 Project Orchestrator 版本变更必须通过独立 migration PR；不允许静默自动改写采用仓库。
