# AGENTS.md

项目记忆：给在本仓库工作的 AI 助手（以及未来的协作者）的上下文。

## 仓库结构

- Chrome 扩展集合（monorepo），每个插件一个独立文件夹，当前有 `tab-auto-refresh/`
- 根目录 `README.md` 是仓库总览；每个插件文件夹内有自己的 README
- `.github/workflows/release.yml`：tag 驱动的自动发布
- `.github/workflows/ci.yml`：push/PR 时用 Node 24 跑仓库校验与单元测试
- `scripts/validate.mjs`：JSON/manifest/语言包/JS 语法仓库级校验
- `scripts/screenshot-popup.mjs`：mock chrome API 后用本机 Chrome 渲染弹窗截图
- `tests/`：Node 内置 test runner 的单元测试（位于仓库根，避免被打进插件 zip）
- `docs/`：README 用的截图等文档资源
- 根 `package.json` 仅声明 `"type": "module"` 和脚本，无 npm 依赖；不影响插件打包
- `CHANGELOG.md`：按 Keep a Changelog 格式记录，按插件分段版本号

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- 主干分支是 `main`；发布 tag 仍为 `tab-auto-refresh/vX.Y.Z` 前缀格式
- UI 默认中文，同时维护英文语言包；提交信息使用英文 Conventional Commits（feat: / fix: / docs: / refactor: / chore:）
- 版本号在插件 `manifest.json` 中维护
- 发布流程：改 `manifest.json` 版本号并更新 changelog → 提交到 `main` → 打同名 tag（如 `tab-auto-refresh/v1.3.0`）→ 推送 `main` 和 tag，Actions 自动打包并创建 GitHub Release
- tag 必须带插件前缀（多插件仓库，避免标签冲突）

## tab-auto-refresh 要点

- 权限：alarms / storage / tabs / contextMenus / notifications
- `minimum_chrome_version: 120`（30 秒级 alarms 依赖该版本）
- 任务与本机状态存于 `chrome.storage.local`：`tasks` 为 tabId → `{ intervalSec, createdAt }` 映射；`pausedAll` 为全局暂停标记
- 偏好设置存于 `chrome.storage.sync`：`settings` 为 `{ bypassCache, skipDiscarded, lastIntervalSec }`；读取时若 sync 为空会尝试从 local 迁移旧设置
- 快捷键启动任务复用 `settings.lastIntervalSec`（最近一次成功任务的实际间隔）；无记录时由默认值回退到 5 分钟
- 手动开始新任务（弹窗/右键/快捷键）会自动解除 `pausedAll`；暂停期间 alarm 跳过触发，恢复后按原周期继续；角标暂停时显示 `‖`
- alarm 命名 `refresh-<tabId>`；`PREFIX` / `PRESETS` 定义在 `shared/config.js`，后台与弹窗共用（service worker 是 ES module）
- 纯逻辑（间隔兜底、格式化）在 `shared/logic.js`，被 `tests/tab-auto-refresh/logic.test.mjs` 覆盖
- 右键菜单 contexts 为 `["tab", "page"]`；快捷键 `toggle-refresh` 默认 `Alt+Shift+R`
- 国际化：`_locales/zh_CN` 与 `_locales/en` 全量文案，popup HTML 通过 `data-i18n` / `data-i18n-placeholder` 注入；manifest 的 `name` / `description` / `action.default_title` / 命令 `description` 均引用 i18n 键
- 后台对 `tasks` 的读改写必须经过 `withTaskLock` 串行队列，防止弹窗 / 右键菜单 / 定时器并发覆盖
- 弹窗每秒重新拉取 alarm 列表再重绘倒计时：alarm 周期触发不会触发 `storage.onChanged`，只重绘文本会让倒计时停在 00:00
- 后台保存设置时合并既有 `settings`，避免只更新复选框时丢失 `lastIntervalSec`

## 当前发布状态

- `tab-auto-refresh` 最新版本是 `1.3.0`，tag 为 `tab-auto-refresh/v1.3.0`
- 该版本起 Release zip 顶层包含 `tab-auto-refresh/` 文件夹

## 打包规则

- zip 顶层必须包含 `tab-auto-refresh/` 文件夹，用户解压后可直接选择该文件夹；文件夹内根位置包含 `manifest.json`
- 优先用 `git archive --format=zip --prefix=tab-auto-refresh/ -o tab-auto-refresh-vX.Y.Z.zip <tag>:tab-auto-refresh`（正斜杠路径，跨平台安全）

## 验证清单

1. `node scripts/validate.mjs`：JSON/manifest/语言包/JS 语法一键校验（等价旧手工步骤 1-2）
2. `node --test "tests/**/*.test.mjs"`：纯逻辑单元测试（引号必需，避免 shell 提前展开；不要用目录形式，Windows 下不可靠）
3. UI 改动后可用 `scripts/screenshot-popup.mjs` 重新生成 `docs/tab-auto-refresh/popup.png`
4. `chrome://extensions` 开发者模式加载插件文件夹，验证：设置/停止、倒计时归零后继续、右键菜单（页面+标签页）、立即刷新、角标计数、暂停/恢复全部、快捷键记住上次间隔、自动清理通知

## 本机环境备注

- 直连 GitHub 经常失败；本机 10808 端口有 SOCKS 代理，临时推送可用：
  `git -c http.proxy=socks5://127.0.0.1:10808 push`
