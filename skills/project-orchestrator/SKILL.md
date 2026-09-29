# tab-auto-refresh Project Orchestrator

用于在本仓库恢复状态、路由工作并保持 Chat / WorkBuddy / Codex / GitHub 一致。

## 恢复

1. 读 `AGENTS.md`；
2. 读 `docs/STATE.md`；
3. 读取当前相关 Issue / PR 与标签；
4. 需要系统背景再读 `docs/ARCHITECTURE.md`；
5. 需要长期取舍再读 `docs/DECISIONS/`。

不要把聊天历史、迁移前 `BACKLOG.md` 或旧 `AGENTS.md` 当成当前权威状态。

## 路由

- 需求/架构/安全/发布授权不清 → Chat；
- 真机验证、跨工具协调、状态同步 → WorkBuddy；
- 代码、测试、调试、重构 → Codex。

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

必要时增加 `node scripts/screenshot-popup.mjs --measure` 与 Issue #3 的真实 Chrome 步骤。

## PR

PR 必须写摘要、关联工作、验证、风险/回滚、文档/决策与后续事项。Merge 后关闭已完成 Issue，并只在高层状态真的变化时更新 `docs/STATE.md`。

## 公共仓库安全

不要把 fork/公共 PR 的任意代码送入个人 self-hosted runner。`pull_request_target` workflow 只能处理可信的元数据逻辑，不 checkout、执行或 eval PR 内容。
