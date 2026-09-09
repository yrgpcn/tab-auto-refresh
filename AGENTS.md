# AGENTS.md

项目记忆：给在本仓库工作的 AI 助手（以及未来的协作者）的上下文。

## 仓库结构

- 仓库远端为 `https://github.com/yrgpcn/tab-auto-refresh.git`，GitHub 仓库是 public，默认分支为 `main`；旧名 `chrome-extensions` 会由 GitHub 重定向
- 本地检出目录仍可能是历史名称 `D:\Github\chrome-extensions`
- 本仓库是 `tab-auto-refresh` 插件的专属仓库（2026-09-09 起不再作为多插件集合仓库）；插件源码在 `tab-auto-refresh/` 文件夹，测试与工具在仓库根
- 全仓库统一用根目录 `README.md` 承载插件功能、安装、边界与技术栈；插件文件夹内**不放**独立 README（已合并）
- `.github/workflows/release.yml`：tag 驱动的自动发布；先跑仓库校验与单元测试，再比对 tag 版本与 manifest 版本，任一失败即不发布
- `.github/workflows/ci.yml`：push/PR 时用 Node 24 跑仓库校验与单元测试
- `scripts/validate.mjs`：JSON/manifest/语言包/JS 语法仓库级校验
- `scripts/screenshot-popup.mjs`：mock chrome API 后用本机 Chrome 渲染弹窗截图
- `tests/`：Node 内置 test runner 的单元测试（位于仓库根，避免被打进插件 zip）
- `docs/`：README 用的截图等文档资源
- 根 `package.json` 是私有的仓库工具配置，声明 `"type": "module"`、脚本和 repository 元数据，无 npm 依赖；不影响插件打包
- `CHANGELOG.md`：按 Keep a Changelog 格式记录，按插件分段版本号

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- 主干分支是 `main`；发布 tag 仍为 `tab-auto-refresh/vX.Y.Z` 前缀格式
- UI 默认中文，同时维护英文语言包；提交信息使用英文 Conventional Commits（feat: / fix: / docs: / refactor: / chore:）
- 版本号在插件 `manifest.json` 中维护
- 发布流程：改 `manifest.json` 版本号并更新 changelog → 提交到 `main` → 打同名 tag（如 `tab-auto-refresh/v1.3.0`）→ 推送 `main` 和 tag，Actions 自动打包并创建 GitHub Release
- tag 保留 `tab-auto-refresh/` 前缀（与 release.yml 的匹配规则和既有历史一致，勿改）

## tab-auto-refresh 要点

- 权限：alarms / storage / tabs / contextMenus / notifications
- `minimum_chrome_version: 120`（30 秒级 alarms 依赖该版本）
- 任务与本机状态存于 `chrome.storage.local`：`tasks` 为 tabId → `{ intervalSec, createdAt, url }` 映射；`pausedAll` 为全局暂停标记
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
- 弹窗底部有仓库地址页脚（`#repoFooter`，popup.html 内静态 `<a target="_blank">`，URL 明文不参与 i18n）
- cookie 备份（`cookieBackup:<host>`）只写入与监控目标同根域的站点；备份对象含 `schemaVersion: 2` 与每条 cookie 的 `hostOnly`；还原时 `hostOnly === true` 省略 `domain`（防止 `__Host-` 票据写入失败/作用域扩大），`=== false` 传 `domain`，字段缺失的 v1 旧备份统一传 `domain`（旧行为）
- 备份淘汰三条件：站点不再被任何任务使用、超过 30 天 TTL、超过 20 站上限（按时间留新）；停止任务与启动恢复时统一执行。注意 `chrome.storage.local.get` 不支持通配符，清理必须 `get(null)` 后按前缀过滤
- 启动恢复 `prune()` 采用"标签页认领"：任务 tabId 仍被占用不代表挂接正确（重启后 ID 会重新分配），需该标签页 URL 与任务精确相等或 `urlKey` 相等才保留认领；未认领任务做重映射时跳过已被其他任务认领的页面，同一网址开在多个标签页时每页至多挂一个任务，认领不到则重开
- `prune(adoptLegacyUrls)` 区分触发来源：扩展安装/更新传 `true`（浏览器没重启，tabId 仍有效，可为 v1.4.3 前无网址的旧任务补记当前页面网址）；浏览器重启传 `false`（ID 已重新分配，旧任务无从辨认目标，淘汰并 console.warn）。注册必须写成 `() => prune(true/false)`，直接 `addListener(prune)` 会让 `onInstalled` 的事件详情对象把标志位判成真
- `startTask` 拿不到标签页或网址时抛错，不再创建无网址的幽灵任务（弹窗显示 `errTabGone`；右键菜单/快捷键路径仅 console.warn）
- `tabs.onUpdated` 先经过内存中的任务 tabId 快照过滤，非监控标签页不触发任何 storage 读取；快照在 `setTasks` 时更新，冷启动首次事件回读 storage

## 当前仓库状态

- GitHub 仓库 `yrgpcn/tab-auto-refresh` 已设置为 public

- `tab-auto-refresh` 最新**已发布**版本是 `1.4.5`，tag 为 `tab-auto-refresh/v1.4.5`；发布面只保留最新 Release 与 tag，旧版本发布随新版本清理
- `main` 上有未发布的 `1.5.0` 改动（弹窗仓库地址页脚 + 代码校对修复、cookie 备份生命周期治理与资源优化，含二次修复：storage 通配符、tabId 复用挂接、hostOnly 还原、发布版本防呆），发版前勿打 tag
- 该版本起 Release zip 顶层包含 `tab-auto-refresh/` 文件夹

## 打包规则

- zip 顶层必须包含 `tab-auto-refresh/` 文件夹，用户解压后可直接选择该文件夹；文件夹内根位置包含 `manifest.json`
- 优先用 `git archive --format=zip --prefix=tab-auto-refresh/ -o tab-auto-refresh-vX.Y.Z.zip <tag>:tab-auto-refresh`（正斜杠路径，跨平台安全）

## 验证清单

1. `node scripts/validate.mjs`：JSON/manifest/语言包/JS 语法一键校验（等价旧手工步骤 1-2）
2. `node --test "tests/**/*.test.mjs"`：纯逻辑单元测试（引号必需，避免 shell 提前展开；不要用目录形式，Windows 下不可靠。Windows 上 Node 22 不支持该 glob，本地改用显式路径 `node --test tests/tab-auto-refresh/logic.test.mjs`）
3. UI 改动后可用 `scripts/screenshot-popup.mjs` 重新生成 `docs/tab-auto-refresh/popup.png`
4. `chrome://extensions` 开发者模式加载插件文件夹，验证：设置/停止、倒计时归零后继续、右键菜单（页面+标签页）、立即刷新、角标计数、暂停/恢复全部、快捷键记住上次间隔、自动清理通知

## 环境备注

- 如果 GitHub 直连失败，可在本机使用 SOCKS 代理；推送示例：
  `git -c http.proxy=socks5://127.0.0.1:10808 push`
- 本机 Codex PowerShell 可能没有 `npm`；验证和测试直接使用 `node` 命令
