# AGENTS.md

项目记忆：给在本仓库工作的 AI 助手（以及未来的协作者）的上下文。

## 仓库结构

- 仓库远端为 `https://github.com/yrgpcn/tab-auto-refresh.git`，GitHub 仓库是 public，默认分支为 `main`；旧名 `chrome-extensions` 会由 GitHub 重定向
- 本地检出目录为 `D:\Github\tab-auto-refresh`（旧仓库名 `chrome-extensions` 由 GitHub 重定向）
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

- 权限：alarms / storage / tabs / contextMenus / notifications / cookies / scripting / idle；站点 host 权限为 `optional_host_permissions`（弹窗开始任务的手势里按 origin 申请，右键/快捷键路径缺权限时保活与关键词静默降级）
- `minimum_chrome_version: 120`（30 秒级 alarms 依赖该版本）
- 任务与本机状态存于 `chrome.storage.local`：`tasks` 为 tabId → `{ intervalSec, createdAt, url, keyword? }` 映射；`pausedAll` 为全局暂停标记；`sessionProbe` 为掉线行为通道状态（根域 → `{sus, lost, lastNotifiedAt}`）；`cookieBackupWarnedOnce` 持久化"备份失败只告警一次"
- 偏好设置存于 `chrome.storage.sync`：`settings` 为 `{ bypassCache, skipDiscarded, cookieBackup, keepAlive, httpHeartbeat, lastIntervalSec }`；默认值统一在 `shared/config.js` 的 `DEFAULT_SETTINGS`（弹窗与后台共用）；读取时若 sync 为空会尝试从 local 迁移旧设置
- 快捷键启动任务复用 `settings.lastIntervalSec`（最近一次成功任务的实际间隔）；无记录时由默认值回退到 5 分钟
- 手动开始新任务（弹窗/右键/快捷键）会自动解除 `pausedAll`；暂停期间 alarm 跳过触发，恢复后按原周期继续；角标四态：掉线 `!`（红）> 暂停 `‖`（灰）> 数量（蓝）> 空，集中在 `updateBadge` 一个函数切换
- alarm 命名：刷新 `refresh-<tabId>`、静默心跳 `hb-<tabId>`；`PREFIX` / `HB_PREFIX` / `PRESETS` 定义在 `shared/config.js`，后台与弹窗共用（service worker 是 ES module）。刷新采用"一次性 when（jitteredDelayMs 在原周期上 ±15% 抖动、下限 30 秒）+ periodInMinutes 兜底"的双保险调度，每次 onAlarm 触发后重新 arm；`chrome.idle` 回到 active 时把所有已过期的 alarm 打散 0~1 秒重建（睡眠漂移自愈）
- 纯逻辑（间隔兜底、格式化、域名/URL 匹配、掉线决策 `decideBackupWrite`、登录页探测 `looksLikeLoginPage`、关键词命中 `keywordHit`、抖动 `jitteredDelayMs`）在 `shared/logic.js`，被 `tests/tab-auto-refresh/logic.test.mjs` 覆盖；`decideBackupWrite` 的跨采样模拟测试锁住"疑似采样不得覆盖好备份"的集成契约（复审§2 死代码 bug 的回归防线）
- 右键菜单 contexts 为 `["tab", "page"]`；快捷键 `toggle-refresh` 默认 `Alt+Shift+R`
- 国际化：`_locales/zh_CN` 与 `_locales/en` 全量文案，popup HTML 通过 `data-i18n` / `data-i18n-placeholder` 注入；manifest 的 `name` / `description` / `action.default_title` / 命令 `description` 均引用 i18n 键
- 后台对 `tasks` 的读改写必须经过 `withTaskLock` 串行队列，防止弹窗 / 右键菜单 / 定时器并发覆盖
- 弹窗每秒重新拉取 alarm 列表再重绘倒计时：alarm 周期触发不会触发 `storage.onChanged`，只重绘文本会让倒计时停在 00:00
- 后台保存设置时合并既有 `settings`，避免只更新复选框时丢失 `lastIntervalSec`
- 弹窗底部有仓库地址页脚（`#repoFooter`，popup.html 内静态 `<a target="_blank">`，URL 明文不参与 i18n）
- cookie 备份（`cookieBackup:<host>`）由 `settings.cookieBackup` 开关控制（默认**关闭**，明文存储的安全说明在 README）：关闭时 `backupCookies` 直接跳过、启动恢复跳过、`pruneCookieBackups` 清空全部备份；开启后只写入与监控目标同根域的站点；备份对象含 `schemaVersion: 2` 与每条 cookie 的 `hostOnly`；还原时 `hostOnly === true` 省略 `domain`（防止 `__Host-` 票据写入失败/作用域扩大），`=== false` 传 `domain`，字段缺失的 v1 旧备份统一传 `domain`（旧行为）
- 启动恢复按注册域匹配：`cookieBackup:*` 键的 `siteRoot` 落在任一任务根域集合内即恢复，覆盖 SSO 登录所在的兄弟子域（此前只按 task.url 精确主机恢复，兄弟子域备份是死数据）；恢复成功的根域记录在 `restoredRoots`，用于决定认领的标签页是否补刷新
- 受限页面（`chrome://` 等）由 `shared/logic.js` 的 `RESTRICTED_URL` 判定：弹窗显示提示，`startTask` 直接抛 `errRestricted` 拒绝建任务
- `domainChain` / `urlKey` / `tabShowsUrl` 是纯函数，与 `RESTRICTED_URL` 同在 `shared/logic.js`，被单元测试覆盖
- 备份淘汰三条件：站点不再被任何任务使用、超过 30 天 TTL、超过 20 站上限（按时间留新）；停止任务与启动恢复时统一执行。注意 `chrome.storage.local.get` 不支持通配符，清理必须 `get(null)` 后按前缀过滤
- 启动恢复 `prune()` 采用"标签页认领"：任务 tabId 仍被占用不代表挂接正确（重启后 ID 会重新分配），需该标签页 URL 与任务精确相等或 `urlKey` 相等才保留认领；未认领任务做重映射时跳过已被其他任务认领**或仍是其他未处理任务键**的页面（`pending` 显式集合防两任务争抢同页时后者被覆盖静默丢失，复审§3.1），同一网址开在多个标签页时每页至多挂一个任务；现场认领不到先经 20 秒 `watchForUrl` 延迟窗口（救"会话恢复晚到 / 先跳 SSO 才到位"的页面），等不到再重开
- `prune(adoptLegacyUrls)` 区分触发来源：扩展安装/更新传 `true`（浏览器没重启，tabId 仍有效，可为 v1.4.3 前无网址的旧任务补记当前页面网址）；浏览器重启传 `false`（ID 已重新分配，旧任务无从辨认目标，淘汰并 console.warn）。注册必须写成 `() => prune(true/false)`，直接 `addListener(prune)` 会让 `onInstalled` 的事件详情对象把标志位判成真
- `startTask` 拿不到标签页或网址时抛错，不再创建无网址的幽灵任务（弹窗显示 `errTabGone`；右键菜单/快捷键路径仅 console.warn）
- `tabs.onUpdated` 先经过内存中的任务 tabId 快照过滤，非监控标签页不触发任何 storage 读取；快照在 `setTasks` 时更新，冷启动首次事件回读 storage

## 当前仓库状态

- GitHub 仓库 `yrgpcn/tab-auto-refresh` 已设置为 public

- `tab-auto-refresh` 最新**已发布**版本是 `1.6.0`，tag 为 `tab-auto-refresh/v1.6.0`；发布面只保留最新 Release 与 tag，旧版本发布随新版本清理（release.yml 的 Prune 步骤自动执行）
- `1.6.0` 包含：cookie 备份改 opt-in 开关（默认关）、启动恢复按注册域匹配全部备份主机（修复兄弟子域 SSO 票据恢复）、受限页面拒绝建任务、纯逻辑下沉 shared 并补测试、发布工作流自动清理旧 Release/tag
- 该版本起 Release zip 顶层包含 `tab-auto-refresh/` 文件夹
- **1.7.0 已完成开发（manifest 版本号已置 1.7.0，尚未打 tag 发布）**：后台保活（keep-alive，`settings.keepAlive` 默认开）+ 会话失效检测通知，实现要点见下节

## 1.7.0 实现要点（2026-09-11 完成开发，09-14 吸收同类项目经验增强）

背景：1.4.5 实测出现“服务器端空闲超时掉登录”——cookie 备份只能恢复票据，救不回服务端已注销的会话。按判定机制分三类：按用户交互心跳计时（可注入合成活动解决）、按最后请求计时（后台静默请求可解，见同类项目 staying_alive；关机窗口无解）、绝对时长上限（无解）。

- **合成活动注入**（`settings.keepAlive`，默认开）：**标签页级**注入，不用 `registerContentScripts`（其 matches 是站点级，会溢出到同站无关标签页，且站点注册 id 与任务 id 语义分裂导致重启后清不掉）。注入点：startTask 即时 `executeScript`（仅补首屏）+ `tabs.onUpdated` complete 分支对任务页每次加载补注入；停止任务经 `keepalive-off` 消息让页面内脚本自停；`reconcileKeepAlive` 在 onStartup/onInstalled（prune 之后）与 sync.settings **真变化**（keepAlive/httpHeartbeat 值变动）时收敛存量任务页，`rememberLastInterval` 值未变不写盘，避免无关 sync 写引发心跳重置风暴。内容脚本 `content/keepalive.js` 派发 `mousemove` / `keydown`：首个心跳 12~20 秒（防短刷新周期把慢心跳永远憋死，复审§3.2）、之后 45~75 秒随机；守卫是可重启语义（`window.__tarKeepAlive` 存上一实例停止函数，重复注入=重启心跳，`keepalive-off` 清标记）。所有保活调用静默降级，不阻塞任务启停。已知边界：校验 `event.isTrusted` 的站点无效；`document.hidden` 时暂停心跳的站点无效
- **静默 HTTP 心跳**（`settings.httpHeartbeat`，默认开）：`hb-<tabId>` alarm 每 4 分钟对任务 URL 发 `fetch(credentials: include, cache: no-store)`，15 秒 AbortController 超时；这是"按最后请求计时"类会话的保活路线（学 staying_alive），不动用户页面。响应落登录页 / 401 / 403 → 疑似掉线信号；正常 2xx → 恢复信号
- **掉线探测双通道 + 通知**：状态通道——`decideBackupWrite` 纯函数驱动，会话票据从有到无先记疑似（`sessionLostStreak`），疑似采样**只 MERGE 计数、绝不覆盖好备份**（复审§2 实证的死代码 bug：坏样本覆盖后 prev 无票据、streak 恒被清零），连续 2 次才冻结备份并按主机 6 小时节流通知；行为通道——`reportSessionSignal`（存 `sessionProbe`）把"任务页落在登录页 URL"（`looksLikeLoginPage` 只看 pathname，监控对象本身是登录页时不适用）与心跳重定向/401/403 计入同一 2 次确认窗口，确认后角标变红 `!` + 通知，`isProbeLost` 期间 backupCookies 拒绝写坏备份；重新登录（票据回来 / 页面回到正常 URL / 心跳 2xx）即恢复
- **关键词监控**（可选，任务字段 `keyword` ≤100 字）：任务页每次加载完成后 `executeScript` 取 `document.body.innerText`（300KB 截断）跑 `keywordHit`，命中 → 系统通知 + 自动停任务
- **调度抗抖动与睡眠自愈**（学 tab-reloader）：一次性 when ±15% 抖动（`jitteredDelayMs`，下限 30 秒）+ period 兜底 + 每次触发重 arm；`chrome.idle` 回 active 时过期 alarm 打散 0~1s 重建
- **权限面收缩**：host 权限 `optional_host_permissions`，弹窗开始任务的手势里 `chrome.permissions.request` 目标 origin；拒绝时任务照常刷新，保活/关键词/备份降级（弹窗提示 `msgNoPermission`）。备份读不到 cookie（未授权）时 `decideBackupWrite` 首份无票据正常写、有票据后无票据会走确认窗口而非立即冻结
- **重启恢复增强**：`pending` 显式集合防两任务争抢同页覆盖丢单（复审§3.1）；现场认领不到先经 20 秒 `watchForUrl` 延迟窗口再接住 SSO 晚到页面，等不到再重开
- **使用边界说明**（已写入 README）：保活（合成事件）只对"按用户交互计时"有效；静默心跳对"按最后请求计时"有效；"绝对时长上限"无解。前提是机器开机不休眠、浏览器保持开启；关机空档靠 cookie 备份重启恢复，功能互补

## 打包规则

- zip 顶层必须包含 `tab-auto-refresh/` 文件夹，用户解压后可直接选择该文件夹；文件夹内根位置包含 `manifest.json`
- 优先用 `git archive --format=zip --prefix=tab-auto-refresh/ -o tab-auto-refresh-vX.Y.Z.zip <tag>:tab-auto-refresh`（正斜杠路径，跨平台安全）

## 验证清单

1. `node scripts/validate.mjs`：JSON/manifest/语言包/JS 语法一键校验（等价旧手工步骤 1-2）
2. `node --test "tests/**/*.test.mjs"`：纯逻辑单元测试（引号必需，避免 shell 提前展开。glob 形式在 Node 24 可用；Node 22 早期如 22.14 不支持、报找不到文件，本机旧版本环境下改用显式路径 `node --test tests/tab-auto-refresh/logic.test.mjs`）
3. UI 改动后可用 `scripts/screenshot-popup.mjs` 重新生成 `docs/tab-auto-refresh/popup.png`
4. `chrome://extensions` 开发者模式加载插件文件夹，验证：设置/停止、倒计时归零后继续、右键菜单（页面+标签页）、立即刷新、角标计数、暂停/恢复全部、快捷键记住上次间隔、自动清理通知；1.7.0 新增：弹窗开始任务弹站点权限申请、拒绝后任务仍刷新但保活/关键词降级、30 秒任务下 12~20 秒能看到注入的心跳事件（DevTools 里断点或加 listener 观察）、同站另开无关标签页无心跳、同页停任务再启心跳恢复、关键词命中弹通知并停任务、模拟掉线（清服务端会话）后角标变红并通知、睡眠唤醒后过期 alarm 被重建

## 环境备注

- 如果 GitHub 直连失败，可在本机使用 SOCKS 代理；推送示例：
  `git -c http.proxy=socks5://127.0.0.1:10808 push`
- 本机 Codex PowerShell 可能没有 `npm`；验证和测试直接使用 `node` 命令
