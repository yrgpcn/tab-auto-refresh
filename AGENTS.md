# AGENTS.md

项目记忆：给在本仓库工作的 AI 助手（以及未来的协作者）的上下文。

## 仓库结构

- Chrome 扩展集合（monorepo），每个插件一个独立文件夹，当前有 `tab-auto-refresh/`
- 根目录 `README.md` 是仓库总览；每个插件文件夹内有自己的 README
- `.github/workflows/release.yml`：tag 驱动的自动发布

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- UI 文案使用中文；提交信息使用英文 Conventional Commits（feat: / fix: / docs: / refactor: / chore:）
- 版本号在插件 `manifest.json` 中维护
- 发布流程：改版本号 → 提交 → 打 tag `tab-auto-refresh/vX.Y.Z` → push，Actions 自动打包并创建 GitHub Release
- tag 必须带插件前缀（多插件仓库，避免标签冲突）

## tab-auto-refresh 要点

- 权限：alarms / storage / tabs / contextMenus / notifications
- `minimum_chrome_version: 120`（30 秒级 alarms 依赖该版本）
- 任务存于 `chrome.storage.local`：`tasks` 为 tabId → `{ intervalSec, createdAt }` 映射；`settings` 为 `{ bypassCache }`
- alarm 命名 `refresh-<tabId>`；`PREFIX` / `PRESETS` 定义在 `shared/config.js`，后台与弹窗共用（service worker 是 ES module）
- 后台对 `tasks` 的读改写必须经过 `withTaskLock` 串行队列，防止弹窗 / 右键菜单 / 定时器并发覆盖
- 弹窗每秒重新拉取 alarm 列表再重绘倒计时：alarm 周期触发不会触发 `storage.onChanged`，只重绘文本会让倒计时停在 00:00
- 国际化：已接入 `chrome.i18n` 骨架（`_locales/zh_CN/`），popup HTML 通过 `data-i18n` / `data-i18n-placeholder` 注入文案

## 打包规则

- zip 根目录必须直接包含 `manifest.json`，不要多套一层文件夹
- 优先用 `git archive --format=zip -o tab-auto-refresh-vX.Y.Z.zip <tag>:tab-auto-refresh`（正斜杠路径，跨平台安全）

## 验证清单

1. JS 改动先做语法检查：ESM 文件复制为 `.mjs` 后 `node --check`
2. `ConvertFrom-Json` 校验 `manifest.json` 与 `_locales/*/messages.json`
3. `chrome://extensions` 开发者模式加载插件文件夹，验证：设置/停止、倒计时归零后继续、右键菜单、立即刷新、角标计数、自动清理通知

## 本机环境备注

- 直连 GitHub 经常失败；本机 10808 端口有 SOCKS 代理，临时推送可用：
  `git -c http.proxy=socks5://127.0.0.1:10808 push`
