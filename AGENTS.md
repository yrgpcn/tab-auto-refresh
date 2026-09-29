# AGENTS.md

本仓库使用 **Project Orchestrator** 管理项目协作与持久状态。`AGENTS.md` 只保留接手入口与硬约束，不再承担大段“项目记忆”。

## 恢复顺序

1. 先读 [`docs/STATE.md`](docs/STATE.md)：当前阶段、开放 Issue / PR、下一动作；
2. 检查相关 GitHub Issues / Pull Requests 以及 `status:*` / `agent:*` 标签；
3. 需要长期背景、系统边界和跨文件不变量时读 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；
4. 协作协议见 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)、[`docs/HANDOFF.md`](docs/HANDOFF.md)、[`docs/ROUTING.md`](docs/ROUTING.md)；
5. 长期决策见 [`docs/DECISIONS/`](docs/DECISIONS/)；
6. 产品版本历史看 `CHANGELOG.md`。

GitHub Issues / Pull Requests 是任务、执行和 Review 的 system of record。聊天历史不是 canonical project state。

## 原项目记忆

2026-09-29 以前，本文件本身承担“项目记忆”，`BACKLOG.md` 保存活跃待办。Project Orchestrator 迁移后：

- 原 `AGENTS.md` 的长期架构与约束已提炼到 `docs/ARCHITECTURE.md`；
- 迁移前完整 `AGENTS.md` 与 `BACKLOG.md` 可在基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 中追溯；
- `BACKLOG.md` 只作为迁移前历史参考，不再新增活跃待办；
- 迁移前未结的 V1 与发版工作已迁为 GitHub Issues #3 / #4；Issue 的存在不等于执行授权。

## Agent 分工

- **Chat**：需求、范围、架构、风险、发布决定、授权边界和 Review 决策；
- **WorkBuddy**：跨工具、多步骤验证、真机协调、状态同步和交接；
- **Codex**：仓库实现、单元测试、调试、重构和代码 Review。

交接使用 `docs/HANDOFF.md`。

## 项目硬约束

- Chrome Manifest V3 + 原生 JavaScript；无构建步骤、无 npm 运行依赖；
- UI 默认中文，同时维护 `_locales/zh_CN` 与 `_locales/en`，新增文案必须保持两边和源码引用齐平；
- MIT 许可证；对无许可证或 GPL 项目只能借鉴思路，不复制代码字面；
- 版本号维护在 `tab-auto-refresh/manifest.json`；发布 tag 固定为 `tab-auto-refresh/vX.Y.Z`；
- 改默认值、权限、存储键、消息名、设置项、语言键、cookie 字段或 UI id/class 前，先读 `docs/ARCHITECTURE.md` 对应跨文件账本；
- 外发页面 URL 默认只允许 `origin + pathname`，不能把 query/hash 中可能存在的令牌、邮箱、手机号重新带出去；
- 需要先读后写、跨异步步骤共享状态的流程，优先把顺序决策抽成纯函数并用单测直接钉住；
- 历史审计结论不是新指令；任何产品行为变化都需要当前 Issue / 用户指令授权。

## 验证

仓库改动至少运行：

```bash
node scripts/validate.mjs
node --test "tests/**/*.test.mjs"
```

涉及弹窗真实布局时按需要运行 `node scripts/screenshot-popup.mjs --measure`。涉及真机路径时使用 Issue #3 的验证清单，不得用“自动化全绿”替代真实 Chrome 验收。

## GitHub Actions 安全

本仓库是 **public**。现有 CI / release 使用 GitHub-hosted runner。不要为了绕过其他私有仓库的 Actions 额度问题，把来自公共 PR 的工作流直接接到个人 self-hosted runner；如未来必须引入 self-hosted，先单独做威胁模型与权限隔离。

提交信息继续使用英文 Conventional Commits（`feat` / `fix` / `docs` / `refactor` / `chore`）。
