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
- `_code-review/`：**本地**代码审核归档（多轮报告 + 回归脚本），被 `.gitignore` 忽略；**不入库、不进 Release、新 clone 中不存在**——故本文件里凡引用 `_code-review/...` 的路径都只在本地有效，详见"代码审核归档与回归脚本"一节
- 根 `package.json` 是私有的仓库工具配置，声明 `"type": "module"`、脚本和 repository 元数据，无 npm 依赖；不影响插件打包
- `CHANGELOG.md`：按 Keep a Changelog 格式记录，按插件分段版本号

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- **借鉴外部代码的许可证红线**：本仓库是 MIT。参照项目里 tab-reloader / staying_alive 无许可证（默认保留所有权利）、Keep-Alive-Pro 是 GPL-3.0（copyleft 传染）——对这些**只能取思路、不得粘贴代码字面**，注释里至多写"与 X 思路一致"；仅 MIT 项目（如 auto-refresh-extension）的片段可借鉴，且需保留来源 URL 与版权声明
- 主干分支是 `main`；发布 tag 仍为 `tab-auto-refresh/vX.Y.Z` 前缀格式
- UI 默认中文，同时维护英文语言包；提交信息使用英文 Conventional Commits（feat: / fix: / docs: / refactor: / chore:）
- 版本号在插件 `manifest.json` 中维护
- 发布流程：改 `manifest.json` 版本号并更新 changelog → 提交到 `main` → 打同名 tag（如 `tab-auto-refresh/v1.3.0`）→ 推送 `main` 和 tag，Actions 自动打包并创建 GitHub Release
- tag 保留 `tab-auto-refresh/` 前缀（与 release.yml 的匹配规则和既有历史一致，勿改）
- **三条持续生效的改法纪律**（07 裁定提出、08 复核要求升格进本文件——原先只写在 `_code-review/`，而那里被 `.gitignore` 排除、新 clone 里根本不存在，等于没有纪律）：
  1. **复杂流程拆"纯函数计划 / 执行"两半**：凡含"先读后写、跨异步步骤共享状态"的流程（典型如启动恢复 `prune`），把顺序决策抽成纯函数产出计划、执行器只负责落盘，让顺序可被单元测试直接断言，而不是靠读代码推断（1.8.0 重构首位，目标函数名 `planPrune`）
  2. **权限 ↔ 功能成对记账**：每次新增权限，在 `CHANGELOG.md` 该版本 Added 里点名，并在"tab-auto-refresh 要点"的权限清单补一行；反之新增需要权限的功能也必须同步更新权限说明。这既是防"权限面悄悄扩大"，也是将来上商店时的隐私说明底稿
  3. **默认值变更一律过"行为倒退"审查**：开关默认开/关、阈值、间隔等默认值任何变动，都要逐条列出受影响路径与"用户已显式设过值"分支，确认不会改变既有用户的既有行为（内例：`0d9fa8a` 引入、`0b04251` 修复的僵尸 alarm 回归）

## tab-auto-refresh 要点

- 权限：alarms / storage / tabs / contextMenus / notifications / cookies / scripting / idle / power；站点 host 权限常驻 `host_permissions: [<all_urls>]`——**不要再改按需申请**（决策与依据见 1.7.0 节权限面记录）
- `minimum_chrome_version: 120`（30 秒级 alarms 依赖该版本）
- 任务与本机状态存于 `chrome.storage.local`：`tasks` 为 tabId → `{ intervalSec, createdAt, url, keywords?, onHit?, notifiedKeys?, autoPaused? }` 映射（旧数据 `keyword` 单串经 `getTaskKeywords` 兼容读取，读侧是唯一入口，后台与弹窗共用）；`pausedAll` 为全局暂停标记；`sessionProbe` 为掉线行为通道状态（根域 → `{sus, lost, lastNotifiedAt}`）；`cookieBackupWarnedOnce` 持久化"备份失败只告警一次"。**跨 SW 实例的运行时计数/标记存 `chrome.storage.session`**（`rt:error:*` / `rt:captcha:*` / `rt:activity:*` / `rt:awake`，浏览器会话结束后自然清空）——需要活过 SW 回收的才放这里，需要活过浏览器重启的才放 `local`
- 偏好设置存于 `chrome.storage.sync`：`settings` 为 `{ bypassCache, skipDiscarded, cookieBackup, keepAlive, httpHeartbeat, skipOnActivity, keepAwake, captchaGuard, webhookUrl, webhookEvents, lastIntervalSec }`；默认值统一在 `shared/config.js` 的 `DEFAULT_SETTINGS`（弹窗与后台共用）；读取时若 sync 为空会尝试从 local 迁移旧设置。**当前默认开着的是** `bypassCache` / `keepAlive` / `httpHeartbeat` / `skipOnActivity` / `captchaGuard`，**默认关的是** `skipDiscarded` / `cookieBackup` / `keepAwake`，webhook 默认空（=彻底关闭）。**改默认值只影响新装**——`getSettings()` 是 `Object.assign({}, DEFAULT_SETTINGS, 已存值)`，老用户存盘的值优先；想让老用户也吃到新默认必须写迁移，别指望改 `DEFAULT_SETTINGS` 生效
- 快捷键启动任务复用 `settings.lastIntervalSec`（最近一次成功任务的实际间隔）；无记录时由默认值回退到 5 分钟
- 手动开始新任务（弹窗/右键/快捷键）会自动解除 `pausedAll`；暂停期间 alarm 跳过触发，恢复后按原周期继续；角标五态：掉线 `!`（红）> 异常自动暂停 `⚠`（橙）> 暂停 `‖`（灰）> 数量（蓝）> 空，集中在 `updateBadge` 一个函数切换，且所有任务增删路径都经过它、顺带收敛 `chrome.power` 锁（applyKeepAwake：keepAwake 开且 tasks 非空时 requestKeepAwake("system")，反之 release）；可解释性标注统一在弹窗任务行：`discardedHint`（休眠跳过）、`pausedErrorChip`/`pausedCaptchaChip`+恢复按钮（自动暂停）、`keywordChip`/`keywordChipWatch`（盯守状态）
- alarm 命名：刷新 `refresh-<tabId>`、静默心跳 `hb-<tabId>`；`PREFIX` / `HB_PREFIX` / `PRESETS` 定义在 `shared/config.js`，后台与弹窗共用（service worker 是 ES module）。刷新采用"一次性 when（jitteredDelayMs 在原周期上 ±15% 抖动、下限 30 秒；**30 秒档因贴地板改为只正向抖动**，否则约一半样本被抬回 30000、去相关失效）+ periodInMinutes 兜底"的双保险调度，每次 onAlarm 触发后重新 arm；心跳 alarm 带随机初始相位（1 秒~一个周期，下限防首拍立即触发）避免多任务同拍；`chrome.idle` 回到 active 时把过期刷新 alarm 重走完整周期、过期心跳打散 0~60 秒重建（睡眠漂移自愈）
- 纯逻辑（间隔兜底、格式化、域名/URL 匹配、掉线决策 `decideBackupWrite` + 落盘映射 `applyBackupAction`、登录页探测 `looksLikeLoginPage`、关键词命中 `keywordHit`、抖动 `jitteredDelayMs`、关键词解析/读取 `parseKeywords`/`getTaskKeywords`、在场与新增命中划分 `pickHits`、webhook 地址校验 `normalizeWebhookUrl`、错误状态判定 `isErrorStatus`）在 `shared/logic.js`，被 `tests/tab-auto-refresh/logic.test.mjs` 覆盖。**关键**：`backupCookies` 写盘与测试都走同一个 `applyBackupAction`（决策+落盘二合一，返回 `{write, notify}`，write=null 即冻结且节流不写）——04 复审 §4.4 指出"测试复刻一遍映射、后台另写一遍"是契约两半漂移的温床（当初死代码 bug 即此类），共用纯函数后测试与实现不可能悄悄分家
- 右键菜单 contexts 为 `["tab", "page"]`；快捷键 `toggle-refresh` 默认 `Alt+Shift+R`
- 国际化：`_locales/zh_CN` 与 `_locales/en` 全量文案，popup HTML 通过 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` 注入（`title` 这条通道专门用来把开关的长解释挪出可见版面、只留悬停可见，2026-09-14 弹窗精简时引入）；manifest 的 `name` / `description` / `action.default_title` / 命令 `description` 均引用 i18n 键
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
- **1.7.0 已完成开发并全部落盘（manifest 版本号 `1.7.0`，尚未打 tag 发布）**：`0b04251` 为 1.7.0 主体（后台保活 + 会话失效检测），其后的 `f0e8ef4` 为本轮"07 裁定批次"——吸收 Webhook、异常自动暂停、尊重用户操作（`skipOnActivity`）、防系统休眠（`keepAwake`）与关键词"检测链"，并在同批修掉这批新功能的一处共性缺陷（运行时状态落 `chrome.storage.session`、webhook 四处调用点补 `await`、`autoPaused` 与标签页存在性检查换序）。实现要点见下节
- `437b7f5` 精简弹窗文案（可见字数约减半，解释移入悬停提示）；`7f7dd49` 为"档 1 修缮批次"：验证墙匹配面收窄 + 阈值拆分 + `captchaGuard` 开关、webhook 非法地址内联提示、本地 prune 门禁补可判退出码（详见 `_code-review/10-档1修缮批次….md`，仅本地）
- `skipOnActivity` 默认值由关改开（"用户正在看这个页面时不要把它重载掉"），并重做弹窗尺寸消除滚动条——两处都见下节「弹窗尺寸预算」与「尊重用户操作」条；新增常驻门禁 `_code-review/verify-popup-height.mjs`（详见 `_code-review/11-…md`，仅本地）
- 发布前只差"打 tag → 推 `main` 与 tag"（版本号 `1.7.0` 与 CHANGELOG 段均已就绪，流程见"约定"）
- **1.8.0 已开发完成并推送（manifest `1.8.0`，提交 `c29e9ee`，CI #44 success；未打 tag）**：新增**微信直连通知**——扩展 SW 直接调腾讯官方接口推模板消息，不经中继、不经第三方服务商；新增**微信配置教程页** `wechat-setup.html`（弹窗配置页有「配置教程」直达，教程文件本身就在仓库里）；事件清单键名 `webhookEvents` → `notifyEvents`（旧值自动接续）；修 `[hidden]` 被作者样式 `display` 压过的通用缺陷；并接手 **12 号独立复审**（基线 `4fad900`）核对出的 6 处缺陷（§1 空事件集合反而全发已在上一批修掉，§2/§3/§4/§5/§6/§7 本轮修完——逐条裁定与证据见 `_code-review/15-12报告核对与修复.md`）。**教程页配图与 VPS 中继下线见 16 号报告**。**2026-09-14 追加（17 号报告，改动还在工作区、未提交）**：微信卡片的字段改按平台硬上限发送——`WECHAT_FIELD_MAX` 由 400 收到 **20**（2023-05-04 生效的《关于规范公众号模板消息的再次公告》：单个字段 ≤20 字、不支持换行、超长由平台自动去掉且不给提示、首行/尾部字段被整体去除），标题改「事件 · 站点」、正文改按事件给一句话结论。要点见下节「1.8.0 实现要点」

## 1.8.0 实现要点（2026-09-14 完成开发）

背景：用户要"不经任何第三方服务商、也不自建中继，把通知直接送到手机微信"。判定路径：手机收消息只有两条——系统推送（走 Google/厂商服务器＝第三方）或装 App 自拉长连接（自建 ntfy＝得跑服务）。**微信是封闭的**，外部服务器不可能直连微信 App；但**腾讯官方接口**可以。所以可行解是：扩展 SW 直连 `api.weixin.qq.com` 推模板消息，链路上只有用户与腾讯（腾讯是平台本身，与"经手第三方服务商"性质不同）。

- **可行性是实测出来的（对照实验，非推理）**：同一浏览器、同一目标地址，网页语境 `fetch` → `Failed to fetch`（CORS 拦死）；扩展 SW 语境 → `HTTP 200` + `{"errcode":40013,"errmsg":"invalid appid"}`（业务错误码＝请求真的抵达并被微信处理）。微信不返回 CORS 头对扩展不构成障碍——`manifest.json` 既有的 `host_permissions:["<all_urls>"]` 已覆盖，**未新增任何权限**（也就不会触发商店重审）。复现：`_code-review/_probe_wechat_cors.mjs` + `_cors-probe/`（探针扩展，含普通网页对照组以证明探针有判别力；探针 manifest 必须声明 `storage` 权限，否则 SW 里 `chrome.storage` 是 undefined、结果无处落盘）
- **令牌**：走官方 `stable_token`（**别用老的 `/cgi-bin/token`**——它每刷一次就作废上一个，多端并发/多重启会互相打掉；stable_token 在 `force_refresh=false` 时有效期内返回同一个，多端并发安全）。缓存在 `chrome.storage.session`（放内存等于没有：SW 闲置 30 秒即回收；session 不同步、关浏览器即清，语义正好），距过期 5 分钟内提前重取（`tokenFresh`），命中 `40001/42001` 清缓存重取并重试一次（官方明确这两种码可重试）
- **凭据四项**（`wechatEnabled` / `wechatAppId` / `wechatAppSecret` / `wechatOpenId` / `wechatTemplateId`）：默认全空 + 开关关闭。存 `chrome.storage.sync`——用户已知情并接受同步到自己的 Google 账号，README 安全说明里如实披露。模板变量名**必须**是 `title` 与 `content`（对应后台 `{{title.DATA}}` / `{{content.DATA}}`），**且变量前必须有关键词加中文冒号**——官方运营规范要求模板内容中部是「关键词名称:关键词内容参数」（中文冒号）的组合，裸写变量（整行只有 `{{title.DATA}}`）会被平台**整行丢弃**，接口照样返回 `errcode=0`，用户收到的是一张「有标题、没正文」的空白卡片。这两条写进了配置页常驻提示与教程页，并各有一条常驻门禁（`_code-review/verify-wechat-template-doc.mjs`）
- **失败不留白**：错误码经 `wechatErrorKey` 翻成"该去哪改"（40013 appID 与密钥填反、43004 还没关注测试号、40164 需 IP 白名单、40037/47003 模板不匹配、45009 额度用尽、网络异常），最近一次推送结果写 `chrome.storage.local`（`wechatLastResult`），弹窗状态行实时显示（主视图一行概览、配置视图显示详情）
- **事件清单改名**：`webhookEvents` → `notifyEvents`（webhook 与微信共用一份）。**兼容必须按"原始 stored 里有没有新键"判断，且要在 `Object.assign(DEFAULT, stored)` 之前**——合并后新键总在（默认值注入），老用户勾选会被默认值静默覆盖成全选。后台 `normalizeStoredSettings()` 与弹窗 `refreshState()` 两处都要做（`logic.notifyEventsOf()` 只解决"读哪来的"这一半）
- **微信模板消息的平台硬限制（写死在注释与常量里，别再凭直觉给大值）**：2023-05-04 起，中间主内容的**单个字段 ≤ 20 个字、不支持换行**，超长由平台**自动去掉且不给省略号**（下发不受影响，所以"消息到了但只有半句话"是这种形态，不是发送失败）；**首行（`first`）与尾部备注（`remark`）字段被整体去除**——模板只写这两个变量的用户会收到一张**空白卡片**（用户实测出现过，见 17 号报告）。所以：`WECHAT_FIELD_MAX`/`WECHAT_TITLE_MAX` 都是 20，字段值一律过 `clipOneLine()`（单行化 + 截断 + 我们自己的省略号），**标题里不再放品牌名**（卡片头部本来就写着模板名，20 字预算里它最不值钱），**页面地址不占字数**、走卡片点击跳转（`url`）。正文另有一套按事件的一句话结论（`WECHAT_BODY_KEYS` + `wechatBody*` 语言键），**刻意不复用 `payload.content`**——那是系统通知/webhook 的完整句子（30~60 字），发到微信必被腰斩
- **外发出口统一入口 `notifyOut(event, payload)`**：依次 `postWebhook` + `postWechat`；四处事件调用点（关键词命中 / 任务停止 / 掉线确认 / 自动暂停）都走它。两个出口共用事件清单、各有独立开关
- **「发送测试消息」按钮**（配置视图内）：`postWechat("test", …, { ignoreToggle: true })` —— 测试只看凭据是否齐，**不受总开关与事件勾选约束**（"配好之前就得能试"）。没有它，用户填完凭据无从验证、只能等真事件发生——这正是"静默失败必须配可见反馈"纪律的落地
- **弹窗 UI**：微信开关并入既有双列网格（第 10 格，**不新增网格行**，故主视图高度零增量）；配置走**二级视图整页切换**（`body.wx-mode` + `body.wx-mode > *:not(#wechatView){display:none}`），四行输入框直接铺在主视图里必然顶破 600px。主视图那行"配置/状态"只在开关打开时占高度
- **踩坑（已修，且属通用缺陷）**：`hidden` 属性走的是**浏览器默认样式**，作者样式里的任何 `display`（如 `.row{display:flex}`）都会在同特异性下压过它 → 微信那行"开关关着也照样占高度"，而"总高 ≤ 600px"这条门禁**完全看不出来**（只有对比"开/关两态高度"才露头）。修法是全局 `[hidden]{display:none!important}`；门禁补上"开/关两态该行高度必须不同"的断言——修复前该断言实测报 12 项失败（红绿验证通过）
- **离线可验证面**：纯逻辑（凭据完整性 / 令牌请求体 / 模板消息请求体 / 令牌新鲜度 / 错误码映射）全在 `shared/logic.js`，`tests/tab-auto-refresh/logic.test.mjs` 离线覆盖；`_code-review/_dump_wechat_payload.mjs` 切片源码原文打印四类事件 + 测试消息的真实请求体（含 40001 重试链与失败留痕）；`_code-review/_smoke_extension_boot.mjs` 把真扩展加载进浏览器，断言 SW 能起来、`storage.session` 可用、弹窗元素齐备（补的是 validate/单测/桩都覆盖不到的盲区：一个拼错的 import 会让整个扩展失效）
- **教程页 `wechat-setup.html`（+`wechat-setup.js`/`.css`）**：既是仓库里的那份教程，也是弹窗「配置教程」指向的页面——**同一份文件**，不存在"文档站与包内页面各自漂移"。文案全部走语言包（与弹窗同一套 `[data-i18n]` 注入），页面只有结构与键名；**插图的 `alt` 也走语言包（`data-i18n-alt`）**——写死在 HTML 里的话英文界面会读出一段中文。步骤一、步骤二各配一张测试号页面的实拍图（`wechat-guide-1/2.png`），标出 appID / appsecret / openid / 模板 ID 四处位置；**图里的凭据是整段替换成的示例值，不是模糊打码**（既零泄露又能当示范看），昵称与二维码也不在图中。`_smoke_extension_boot.mjs` 会真开这个页面，断言五个小节齐全、`data-i18n` 全部注入（不残留键名）、外部 css 未被 CSP 拦、测试号链接指向官方域名，**以及两张插图真的加载出来（`naturalWidth > 0`）+ alt 已注入**（路径写错或被 CSP 拦，validate / 单测 / i18n 检查器全都看不见）
- **12 号独立复审的 6 处修复（本轮，逐条都留了可复现判据）**：
  - **§2 弹窗间隔输入静默不一致**（真缺陷）：预设下拉与"自定义秒数"原先都没有 `change`/`input` 监听 → "先填 90 再选每 5 分钟"界面显示 5 分钟、实际按 90 秒跑。现两个入口互斥（下拉加「自定义…」项；选预设清空秒数框、秒数框有数就切「自定义」、秒数框清空回落到默认预设）。门禁 `verify-interval-pick.mjs` 捕获「开始」真正发出的 `seconds`，并带**负对照**（同一 DOM 状态下旧规则的取值）证明断言有判别力
  - **§3 `backupCookies` 漏 `await`**（真缺陷）：同一函数在行为通道（`reportSessionSignal`）里本来就是 `await`，只有备份这条漏了 → `notifySessionLost` 内的 webhook/微信 `fetch` 不在被 await 的链路上，SW 回收会截断，丢的正是"会话掉线"这条。**纪律表述同步更正**：`notifyOut` 的四处调用点之外，`notifySessionLost` 自己的两个调用点（行为通道 / 备份通道）也必须 await
  - **§4 备份截断丢票据**（真缺陷）：`cookies.length = MAX` 按 `chrome.cookies.getAll` 的返回顺序切尾，而该顺序**未定义** → 票据落在尾部就"每次备份都稳定缺它"，且前后样本都缺票据时 `sessionLostDetected` 恒判"正常"（表现为"备份时间戳一直在更新、重启后恢复不出登录态"）。新纯函数 `capCookies` 只在超限时按"票据优先"排序（`httpOnly > 会话票 > __Host-/__Secure- > path=/ > 域更短`），正常规模保持原顺序
  - **§5 `sessionProbe` 不收敛**（真缺陷）：掉线探针没有清理路径 → 停掉任务后重建同站点任务时，`startTask` 里那次"防首次刷新前关浏览器"的备份被 `isProbeLost` **静默跳过**。现 `pruneCookieBackups` 按"仍被任务引用的根域"收敛探针（角标本就只读当前任务的根域，删无引用条目不改变任何判定），顺带止住无界增长
  - **§6 关开关不清备份**（真缺陷，偏危险方向）：README 承诺"关闭状态下不备份、不恢复，遗留备份也会被自动清除"，而清理只在 `stopTask` 与启动 `prune` 里发生 → 用户读完安全说明关掉开关，含 HttpOnly 票据的明文 cookie 仍在 `chrome.storage.local`。现把 `cookieBackup` 纳入 `storage.onChanged` 的收敛条件
  - **§7 CHANGELOG 自相矛盾**（文档缺陷）：1.7.0 的 Added 写着"标题/正文关键词"，同版本 Fixed 写着"不再扫 `document.body.innerText`"。另把「测试号…无时间限制」这一无法核实的说法改成「免资质、免费」（教程页与 README 同口径）
- **对比副本目录新增 `对照-修复前_12复审/`**（`background.js` + `shared/` + `package.json`，可独立 import）：`verify-12-fixes.mjs` 对它与当前源码各跑一次，实测**修复前 3/3 失败 → 修复后 3/3 通过**（§3/§5/§6）。§2 的修复前 `popup.js` 没留档（改在快照之前），故用脚本内的负对照替代"跑两份源码"——**这是本批唯一的证据降级，已写在报告里**
- **20 号独立复审（基线 `ce59240`）的 3 处修复（2026-09-14，同一工作区）**：`_code-review/20-独立复审（HEAD ce59240）.md`。① **英文界面的卡片标题**——20 字预算减事件名后只剩 0~6，而 `clipHostTail` 的 label 边界分支要放得下 `example.com`（11）才命中，于是英文**每一条**卡片都落进硬截分支（实际发出 `keyword hit - …e.com` / `session lost - …com`，`task auto-stopped` 更把站点名整段挤掉）。三处一起改：`clipHostTail` 放不下完整注册域时**返回 `null`**（绝不硬截碎片，无点主机仍左侧截）、卡片标题改用**短事件名**（`wechatEv*Short`，与弹窗复选框的长标签分开）、`wechatTitleSep` 改为**自带空格**（zh `" · "` / en `"·"`，`wechatTitleOf` 不再 trim 它）。**为什么原有三条门禁都没看见**：`_dump_wechat_payload.mjs` 只加载 zh_CN、单测里 `clipHostTail` 全部用 11~12 的预算（从没跑过英文真实的 4~6）、模板门禁只判变量名——**"预算维度"和"语言维度"一起漏，是这次最值得记的一条**。新门禁 `verify-wechat-title-i18n.mjs`：红 6 碎片/8 只剩顶级域/12 无站点 → 绿 0/0/4。② **「发送测试消息」补 `await saveSettings()`**——凭据走 `change`（失焦）保存，点按钮必然先触发它，而 `save-settings` 自己也要先 `await getSettings()` 才能写盘，于是 `wechat-test` 读到旧值、报"还缺四项"（首次配置主路径）。新门禁 `verify-wechat-save-test-race.mjs` 断言**消息次序**（`wechat-test` 必须晚于 `save-settings` 的回调落地），红→绿已实测。③ README 的「尊重你的操作」默认值口径由"默认关闭"改为"默认开启"（`skipOnActivity` 自 `4fad900` 起就是 `true`，CHANGELOG/AGENTS 都对、只有 README 说反）。另修 `clipOneLine` 改按**码点**截（原先按 UTF-16 码元，含 emoji 的关键词会被切出孤立代理、卡片上显示成乱码方块）
- **20 号报告里未采纳/未动**：§1 微信凭据落 `chrome.storage.sync`（与本仓 13 号报告"必须单独走 `storage.local`"的结论相反）**保留现状**——已按 README/教程页/`config.js` 注释三处如实披露；若要改回 `storage.local`，需同步改 `save-settings`、`getSettings`、弹窗 `refreshState` 三处。§4 `notifyEvents` 兼容逻辑后台/弹窗各一份、§5 `sessionProbe` 三写入者只有一个在锁内、§7 高度门禁耗时（**实测 2 分 15~17 秒**，比多数命令包装的默认超时更长，别把它当成失败）三条待排期

## 1.7.0 实现要点（2026-09-11 完成开发，同日吸收同类项目经验增强）

背景：1.4.5 实测出现“服务器端空闲超时掉登录”——cookie 备份只能恢复票据，救不回服务端已注销的会话。按判定机制分三类：按用户交互心跳计时（可注入合成活动解决）、按最后请求计时（后台静默请求可解，见同类项目 staying_alive；关机窗口无解）、绝对时长上限（无解）。

- **合成活动注入**（`settings.keepAlive`，默认开）：**标签页级**注入，不用 `registerContentScripts`（其 matches 是站点级，会溢出到同站无关标签页，且站点注册 id 与任务 id 语义分裂导致重启后清不掉）。注入点：startTask 即时 `executeScript`（仅补首屏）+ `tabs.onUpdated` complete 分支对任务页每次加载补注入；停止任务经 `keepalive-off` 消息让页面内脚本自停；`reconcileKeepAlive` 在 onStartup/onInstalled（prune 之后）与 sync.settings **真变化**（keepAlive/httpHeartbeat 值变动）时收敛存量任务页，`rememberLastInterval` 值未变不写盘，避免无关 sync 写引发心跳重置风暴。内容脚本 `content/keepalive.js` 向 `document` 派发 `mousemove` / `keydown`（document 级派发经冒泡同时覆盖挂 document 与 window 的监听器；挂 window 只覆盖 window 一级，严格更差——04 复审 P1）：首个心跳 12~20 秒（防短刷新周期把慢心跳永远憋死，复审§3.2）、之后 45~75 秒随机；守卫是可重启语义（`window.__tarKeepAlive` 存上一实例停止函数，重复注入=重启心跳，`keepalive-off` 清标记）。所有保活调用静默降级，不阻塞任务启停。已知边界：校验 `event.isTrusted` 的站点无效；`document.hidden` 时暂停心跳的站点无效
- **静默 HTTP 心跳**（`settings.httpHeartbeat`，默认开）：`hb-<tabId>` alarm 每 4 分钟对任务 URL 发 `fetch(credentials: include, cache: no-store, headers:{Range:"bytes=0-1023"})`（Range 截断防拉整页响应体，站点忽略时回退整页 200，206/200 均在 ok 判定内），15 秒 AbortController 超时；建 alarm 带随机初始相位（1 秒~一周期）、idle 唤醒重建打散 0~60 秒，多任务不同拍；站点回 416（拒收 Range）自动去 Range 重试一次，防该站心跳通道静默失效；Range 值必须保持 `bytes=数字-数字` 的 CORS 安全名单形式，改成 `bytes=-1024` 之类会引入预检、被拒即全通道失效（05 复审 §3.3 核实）。这是"按最后请求计时"类会话的保活路线（学 staying_alive 思路，其实现有默认配置 TypeError 死循环缺陷不抄），不动用户页面。响应落登录页 / 401 / 403 → 疑似掉线信号；正常 2xx → 恢复信号
- **掉线探测双通道 + 通知**：状态通道——`decideBackupWrite` 纯函数驱动，会话票据从有到无先记疑似（`sessionLostStreak`），疑似采样**只 MERGE 计数、绝不覆盖好备份**（复审§2 实证的死代码 bug：坏样本覆盖后 prev 无票据、streak 恒被清零），连续 2 次才冻结备份并按主机 6 小时节流通知；行为通道——`reportSessionSignal`（存 `sessionProbe`）把"任务页落在登录页 URL"（`looksLikeLoginPage` 只看 pathname，监控对象本身是登录页时不适用）与心跳重定向/401/403 计入同一 2 次确认窗口，确认后角标变红 `!` + 通知，`isProbeLost` 期间 backupCookies 拒绝写坏备份；重新登录（票据回来 / 页面回到正常 URL / 心跳 2xx）即恢复。信号写入做值快照比对（04 复审 §4.2）：`sus|lost|lastNotifiedAt` 三元组没变就不写盘、不刷角标；已确认 lost 后 sus 封顶不再累加；恢复（一次正常信号）时连同 `lastNotifiedAt` 一起清零——决策：掉线→恢复→再掉线视为两次独立故障，6 小时内也要通知（05 复审 §3.2）
- **关键词监控**（可选，任务字段 `keywords[]` 每条 ≤100 字、上限 10 个；旧 `keyword` 读侧兼容）：**检测链**（08 裁定方案 C，全在后台不碰注入通道）——每次页面 complete 起一条链：立即查 + 3s + 10s 有界重采样，`executeScript` 取 `body.innerText`（300KB 截断）跑 `pickHits`，正文与上次相同提前结束；`detectChains` Map 存链 token，新链起链即作废旧链（防并发重复通知/竞态停任务），SW 回收丢链由下个周期自愈。命中：通知 + Webhook；`onHit=stop`（默认）停任务，`onHit=continue` 把在场集回写 `notifiedKeys`（关键词消失再现已移出集合→重新通知）
- **异常自动暂停**（06 §4.3）：心跳侧 5xx/404 连续 2 次（`PAUSE_CONFIRM_SAMPLES`，`rt:error:<tabId>`）→ `autoPaused:{reason:"error-page"}`，恢复 2xx 自动解除；页面侧 `probeCaptcha`（`CAPTCHA_CONFIRM_SAMPLES = 3`，`rt:captcha:<tabId>`）→ `autoPaused:{reason:"captcha"}`，过墙后弹窗"恢复"按钮解除。**两个阈值刻意分开，别合并回一个常量**：错误页暂停由独立的心跳 alarm 兜着、回 2xx 自愈，验证墙的解除却依赖页面再次加载——而暂停后刷新循环停下、页面不再加载、探测也不再运行，所以验证墙误判会**卡死不自愈**，代价不对称。**验证墙匹配面只取 `document.title`（截 300 字）+ 挑战域名（Cloudflare/reCAPTCHA/hCaptcha）的 iframe/script，绝不回退到扫正文**（`body.innerText` 里的"验证码/安全验证"是日常词，登录框提示、帮助文案、页脚都会命中；10 报告即为此修复）；`access denied` 也刻意不在词表——401/403 的登录墙语义另走掉线通道（`reportSessionSignal`），此处重复判定会破坏 `background.js:458` 写下的分工。探测受 `settings.captchaGuard` 控制（默认开=07 批次原行为；关闭仅停止探测，**不会解除已存在的暂停**，需用户点"恢复"）。alarm 照常续跑、onAlarm 见 `autoPaused` 早退——暂停零重建；**独立计数不进 sessionProbe**，不污染备份冻结语义；角标 `⚠` + 通知 + webhook `task-paused` 全链路可解释（08 §3.5 要求同批落实）。onAlarm 里 **tab 存在性检查排在 autoPaused 之前**：被自动暂停的任务若标签页被关掉，仍按老行为"停任务 + 通知"，不留僵尸
- **注入通道配置协议**（08 §3.1 门控解耦）：`syncKeepAliveConfig` 在 keepAlive **或** skipOnActivity 任一开启时注入并推 `keepalive-config`；脚本启动 `keepalive-query` 拉快照。heartbeat 与 activityWatch 独立热开关，互不连坐；真人活动经 `isTrusted` 过滤 + 5s 节流上报 `user-activity`，后台 60s 窗口内跳过刷新（策略是跳过不是重置计时）。`storage.onChanged` 收敛门控扩展为四个注入类开关
- **尊重用户操作**（`settings.skipOnActivity`，**默认开**）：刷新意图是"盯变化"，用户自己正在看这个页面时再把它重载掉只会打断他，跳一轮的代价远小于打断，故默认开。代价要说清楚：它同时是内容脚本注入门控之一（`keepAlive || skipOnActivity`），所以默认开启意味着**默认会向被监控页注入活动监听**（`isTrusted` 过滤 + 5s 节流上报，合成事件不会被误判为真人）。默认值变更按"行为倒退"审查走了一遍：唯一新增行为是"用户在该页操作后 60 秒内不刷新"，属预期语义而非倒退。**对已有安装不生效**（存盘值优先，见"要点"里的 `getSettings` 条）——想让老用户也开，得自己勾一次
- **弹窗尺寸预算（Chrome 弹窗外框硬上限 800×600，改弹窗必看）**：整页高度必须留在 600px 内，超了就长滚动条，而"超了"在 validate / 单元测试 / i18n 检查里**全都没有信号**（它们都不渲染页面）。现状与红线：宽 360→400px；9 个开关用 `repeat(2, minmax(0,1fr))` 双列网格（9 行压成 5 行，**必须 `minmax(0,1fr)` 而非 `1fr`**——`1fr` 的隐含下限是 `min-content`，长标签会把列撑成不等宽，实测英文下 162/237px），**所以开关标签必须够短、一律单行**，改长会折行或吃省略号、栅格随之错位；`body` 用 `display:flex; flex-direction:column; max-height:600px; overflow:hidden` 兜底，唯一弹性块是任务列表（`.card-tasks` + `#taskList` 的 `flex:0 1 auto; min-height:0`），列表封顶 108px（2 行 + 第 3 行露头当"下面还有"的提示）。**踩过的坑**：靠给列表定一个固定封顶值兜不住条件行——受限页面提示 / webhook 地址无效 / 操作结果 `#msg` 三者同时显形时英文界面到 631px（条件行高度是常量，压不进去），所以才改为 flex 兜底。实测最坏：中 541 / 英 564 / 英+三条件行 600px；微信配置视图 中 326 / 英 377px（2026-09-14 加了教程入口与"平台 20 字上限"提示后各增约 17~25px，仍远低于上限——**二级视图是整页切换，不占主视图高度**，改它只影响它自己）。**改完弹窗务必跑 `node _code-review/verify-popup-height.mjs`**（矩阵 = 语言×任务数 + 一个"条件行全显形"场景，断总高、断言无裁切、断言列表仍看得见；**实测耗时 2 分 15~17 秒**，比多数命令包装的默认超时更长——被 SIGTERM 截断时输出会停在场景表格之前，看起来就像门禁挂了，其实是超时，给足时间再判）
- **跨 SW 实例的运行时状态必须落 `chrome.storage.session`**（09 复审 §2，硬纪律）：MV3 的 service worker「闲置 30 秒即终止（收事件或调扩展 API 会重置计时器）」，官方要求"为意外终止做好准备：持久化状态"。任何**两端间隔为分钟级**的累计/标记都不能放内存变量——`rt:error:<tabId>`/`rt:captcha:<tabId>`（心跳 4 分钟一次、验证墙随刷新周期探一次）、`rt:activity:<tabId>`（60 秒跳过窗口）、`rt:awake`（keepAwake 持锁标记）四处全部改会话态；读写走独立串行队列 `rt()`（与 `withTaskLock` 无关，在锁内再入队会死锁），同一键的读改写串行防丢计数。会话态语义正好：跨 SW 回收存活、随浏览器会话结束清空（与 `chrome.power` 请求的真实生命周期一致），不落磁盘、不需要新权限。常驻回归：`_code-review/verify-sw-restart-state.mjs`（二次 import 模拟 SW 重启，含修复前对照）
- **Webhook**（默认空=关）：`postWebhook(event, payload)` 过 `normalizeWebhookUrl`（仅 http/s）+ 事件白名单；载荷并填 `content`(Discord) / `text`(Slack、Telegram) / `body`(冗余兜底，**无服务认它**) + `type`/`url`/`host`/`ts`；fetch 在 await 链路内 + 15s AbortController（防 SW 回收丢请求）；失败静默。事件源：掉线确认、关键词命中、`stopTaskWithNotice`（先取 url 再停——08 §3.6）、自动暂停。**await 纪律（别只数"四处"就收工）**：`notifyOut` 的四处调用点全部 `await`（09 复审 §3：首版全写成 `void`，与函数注释自相矛盾，实测处理器会先于 webhook 结束）；此外 **`notifySessionLost` 自己的两个调用点也必须 `await`**（行为通道 `reportSessionSignal` / 备份通道 `backupCookies`）——12 复审 §3 正是发现备份那处漏了，而它内含的 fetch 不在被 await 的链路上，SW 回收会截断掉"会话掉线"这条。**别再说"ntfy 开箱即用"**：实测 ntfy 只在根端点解析 JSON，POST 到 `/<主题>` 会把整个 JSON 当正文存下，且载荷无 `topic` 字段、无法改填根端点（会 400）——已把 README/popup 提示/代码注释统一为"能送达，但正文是原始 JSON"（除非将来给载荷补 `message` 字段）。地址非法时 `postWebhook` 静默返回，故弹窗另有 `renderWebhookValidity()` 内联提示（`webhookInvalid`）。**VPS 那套中继已于 2026-09-14 下线（可逆）**：阿里云上 `tar-webhook.service` 停用（`inactive`/`disabled`）、`ntfy` 容器停止且 `--restart=no`、`nas.xps9500.top.conf` 里 `/tar-hook/` 与 `/ntfy-58dc…/` 两个 location 整段注释（改前备份 `nas.xps9500.top.conf.bak-offline-20260914-142851`，`/opt/tar-webhook/` 与 `/opt/ntfy/` 原样保留）。验证取三条独立证据：两个入口经域名均 **404**（不是 502——502 只说明后端停了，404 才说明 location 也摘了）、`ss -lntp` 里 8788/2586 **0 条**、systemd 与容器状态。**注意**：1Panel 重存站点配置会把手改冲掉，恢复步骤见 `_code-review/16-教程页配图与中继下线.md`
- **调度抗抖动与睡眠自愈**（学 tab-reloader）：详见"tab-auto-refresh 要点"的 alarm 命名条（单一事实源）；30 秒档贴地板时改只正向抖动保住去相关（04 复审 §4.5）
- **权限面决策记录（勿再反复）**：host 权限维持常驻 `<all_urls>`。曾改为 `optional_host_permissions` + 手势内 `chrome.permissions.request` 按需申请，实测硬伤：系统授权框弹出即夺焦点关闭扩展弹窗，发起申请的脚本随之销毁，授权完成后任务**不会**自动开始，用户必须再点一次「开始」。本插件 GitHub Release 自用分发、不上商店，按需申请的合规收益为零、体验代价全额自受，已回退。将来真要提交商店时再做，且必须配套：监听 `permissions.onAdded` 在授权完成后自动续跑建任务流程，消灭二次点击。外部佐证：品类头部 ARP（chrome-stats 权限变更史）在 2024-06-30 同一版本里加了可选 host 权限又立刻移除回常驻——头部产品试过这条路也回退了，再提"改按需申请"前需先推翻这条双方证据
- **重启恢复增强**：`pending` 显式集合防两任务争抢同页覆盖丢单（复审§3.1）；现场认领不到先经 20 秒 `watchForUrl` 延迟窗口再接住 SSO 晚到页面，等不到再重开；未认领任务的旧 alarm 收集进 `staleAlarms`、推迟到 `setTasks` 落盘之后再清（04 复审 §4.1），清理时对照落盘后的最终键集合 `liveIds`——id 已被本轮重挂接/重开占用（tabId 互换、watch 等回原 id、Chrome 复用 id 三种路径）就跳过不清（05 复审 §2：上轮只做了"延后"没做"互斥"，把刚 arm 的 alarm 反手清成僵尸，属修复引入的回归，`_code-review/verify-prune-order.mjs` 持此场景为常驻回归）。SW 中途回收最坏只留"有 alarm 没任务"（onAlarm 找不到任务会自清），杜绝"有任务没 alarm"
- **使用边界说明**（已写入 README）：保活（合成事件）只对"按用户交互计时"有效；静默心跳对"按最后请求计时"有效；"绝对时长上限"无解。前提是机器开机不休眠、浏览器保持开启；关机空档靠 cookie 备份重启恢复，功能互补

## 打包规则

- zip 顶层必须包含 `tab-auto-refresh/` 文件夹，用户解压后可直接选择该文件夹；文件夹内根位置包含 `manifest.json`
- 优先用 `git archive --format=zip --prefix=tab-auto-refresh/ -o tab-auto-refresh-vX.Y.Z.zip <tag>:tab-auto-refresh`（正斜杠路径，跨平台安全）

## 代码审核归档与回归脚本（`_code-review/`，**仅本地**）

- **去向**：仓库根 `_code-review/`，被 `.gitignore` 第 11 行忽略——只本地留存，不推送、不进 Release zip（`release.yml` 用 `git archive <tag>:tab-auto-refresh`，只取插件子目录）。**本文件中所有 `_code-review/...` 路径引用在 CI 与新 clone 中都悬空**，仅对本机审阅有效
- **不要把它挪进 `tab-auto-refresh/`**：`scripts/validate.mjs` 的"未跟踪文件"守卫只覆盖插件目录，挪进去会让本地校验 exit=1
- **组织约定**：报告按轮次编号（`01` 首轮 … `13` 扩展直连微信可行性实测、`14` 微信直连集成批次、`15` 12 报告核对与修复 + 教程页、`16` 教程页配图 + VPS 中继下线、`17` 微信卡片 20 字上限与消息重排、`18` 卡片空白（模板示范不符合微信解析规则）、`19` 教程页被注入编辑器属性、`20` 独立复审（HEAD `ce59240`）），每轮同步更新 `_code-review/README.md` 索引；引用结论写 `函数名 @ <commit>:<行>` 而非裸行号——行号每轮都在漂（实证：`checkKeyword` 从 `0d9fa8a:637` 漂到 `0b04251:640`）
- **回归脚本**（改动对应功能后必跑）：
  - `verify-sw-restart-state.mjs` — 跨 SW 实例的运行时状态（二次 `import` 模拟 SW 重启 + 共享 storage 桩）；配套 `对照-修复前_内存计数/` 冻结修复前源码做红→绿对照，退出码可直接判定
  - `verify-prune-order.mjs` — `prune` 重挂接/清理顺序（05 §2"把刚 arm 的 alarm 反手清成僵尸"的回归场景）；配套 `对照-修复前(73a8be6)-prune顺序.mjs`。**退出码可判**（0/1，10 报告补齐）；改它必须改生成器 `_gen_prune_harness.mjs` 后重新生成，**不得手改产物**
  - `verify-streak.mjs` — 掉线探测的采样序列
  - `_check_i18n.mjs` — 语言包完整性（zh/en 键位对齐、`data-i18n*`（含 `-title`）与 `getMessage`/`msg` 引用无悬空、manifest `__MSG__` 可达）。**扫插件目录下全部 HTML 与 JS**（原先只扫 `popup.html` + 4 个 JS，新增页面/脚本会被漏掉——微信教程页就是这么漏的）
  - `verify-popup-titles.mjs` — 弹窗端两处渲染断言：① 悬停文案 `data-i18n-title` 是否真的渲染（与语言包逐字比对 + 空跑守卫）；② webhook 非法地址是否给可见提示（8 用例）。堵的盲区：i18n 检查器只验"键存在"，截图只覆盖 `applyI18n` 前四步，`title` 循环被删掉时两者都照常通过、提示却静默变空。需本机 Chrome + playwright
  - `verify-popup-height.mjs` — 弹窗尺寸门禁：矩阵 = 语言(zh/en) × 任务数(0/1/2/5/10) + 一个"三个条件行同时显形"的最坏场景，断言总高 ≤ Chrome 的 600px 上限、**内容没被 `overflow:hidden` 裁掉**、任务列表仍至少留一行可见。堵的盲区：高度超限在 validate/单测/i18n 里全无信号（都不渲染页面）。需本机 Chrome + playwright。**注意它有两条断言是结构性真命题**（`max-height:600px` 兜底后"总高 ≤ 600"永远成立、"自然高度 > 600"只作提示不判失败），真正有判别力的是"无裁切"与"列表可见高度"——设计改动时别只看总高那一列。2026-09-14 增补：矩阵加入"微信开关开"与"微信配置视图（含失败态长文案）"两组场景；并新增**"该行开/关两态高度必须不同"**的断言——`[hidden]` 被 `.row{display:flex}` 压过时，那行会一直占 26px，而"总高 ≤ 600"照样通过；该断言在修复前实测报 12 项失败（判别力已实测）
  - `_dump_webhook_payload.mjs` — 打印 `postWebhook` 四条事件的真实请求体（离线，桩掉 `fetch`）：判断"某服务能不能用、手机上会看到什么"必须先看真实字段，README 只讲语义不列字段
  - `_dump_wechat_payload.mjs` — 打印微信直连的真实请求体：四类事件 + 「发送测试消息」+ 40001 重试链（4 个请求：取令牌→发消息→重取→重发）+ 失败留痕 + 两个开关的拦截行为（离线，切 `background.js` 源码原文 + 桩 `chrome`/`fetch`/`getSettings`）。模板变量名、`url` 合法性、"开关关着也能测试"这类形状问题，只能看真实载荷。可传一个插件目录做红/绿对照（`git archive <commit> tab-auto-refresh` 解包后传进去）。**第七节是门禁**：逐字段判"≤20 字且不含换行"，越界即 `exit=1`（修复前对 `c29e9ee` 实测 14 个字段里 6 个越界）。**harness 的逻辑函数按 `logic.js` 实际导出自动展开**——曾写死名单，`background.js` 新增 import 后切片里的标识符变 `undefined`，被 `postWechat` 的 `try/catch` 伪装成"网络错误、请求数 0"，看着像网络问题其实是脚本没跟上
  - `_smoke_extension_boot.mjs` — 把**真扩展**加载进浏览器（playwright 自带 chromium；系统 Chrome 137+ 已移除 `--load-extension`），断言：SW 能起来且无未捕获错误、`chrome.storage.session` 可读回写入值、manifest 版本、弹窗含 10 格开关 / 二级视图与主视图互斥 / 微信行默认不占布局 / 间隔下拉含「自定义…」项；**并且真的点开教程入口**（勾开关 → 点「配置…」→ 点链接 → 等新标签页），再验教程页五个小节齐全、`data-i18n` 无残留、外部 css 未被 CSP 拦、测试号链接指向官方域名、**两张插图真的加载出来（`naturalWidth > 0`）且 alt 已注入语言包**。堵的盲区：background.js 是 ES module，一个拼错的导入名就能让整个扩展失效，而 validate（只查语法）、单测与所有桩都发现不了；插图路径写错/被 CSP 拦同理
  - `_grab_screen.py` / `_list_windows.py` / `_grab_window.py` / `_scroll_grab.py` / `_make_guide_image.py`（含 `--wipe-only`）— **在用户自己的浏览器里取证并出教程插图**的一套脚本（Pillow，装在隔离 venv）。要点：本机 PowerShell 的 `Add-Type` 被安全策略拦掉，截屏只能走 Pillow `ImageGrab`；窗口常是最小化的，要先按标题枚举再 `ShowWindow(SW_RESTORE)`+`SetForegroundWindow`（失败时 `AttachThreadInput` 借前台权限）；滚动只允许移光标 + 发滚轮，**绝不点击页面元素**，且光标位置要按窗口矩形算（固定坐标可能落在窗口外，表现为"滚了没反应"）。**两条硬教训**：① 想自动扫"暗像素包围盒"来定位值范围会被**同一行的表格横线与相邻列元素**污染（实测 `appID` 命中到窗口右界、`openid` 撞上「移除」按钮）→ 改用固定边界，取"标签右边界之后、右邻元素左边界之前"的余量；② 覆盖真实凭据后**必须出 `--wipe-only` 图（只涂白不写字）复核**——框没盖住时，正式图里"框内是示例值"看着很正常，只有放大逐块看才发现框左边缘跟着半个原值字符
  - `_probe_wechat_cors.mjs` + `_cors-probe/` — 扩展 SW 跨源直连微信的对照探针（含普通网页对照组，证明探针有判别力）；改"扩展能否直连某接口"的判断前先跑它
  - `verify-12-fixes.mjs` — 12 复审 §3/§5/§6 的常驻回归（备份通道的掉线通知是否真挂在 await 链路上 / 停任务后探针是否收敛、同站点重建任务是否仍做首次备份 / 关掉「重启后恢复登录」是否立即清掉明文备份）。**要接 `chrome.cookies` 桩**才能把备份通道跑起来；配套 `对照-修复前_12复审/`（可独立 import 的修复前副本），实测修复前 3/3 ❌ → 修复后 3/3 ✅。用法：`node _code-review/verify-12-fixes.mjs ["_code-review/对照-修复前_12复审/background.js"]`
  - `verify-interval-pick.mjs` — 弹窗"预设 ↔ 自定义秒数"互斥门禁：不看 DOM 显示，直接捕获「开始」发出的 `seconds`；带负对照（旧规则在同一 DOM 状态下的取值），断言"实发值 ≠ 旧规则值"。需本机 Chrome + playwright
  - `verify-wechat-title-i18n.mjs` — 微信卡片标题门禁（20 报告 §2）：两语言 × 五事件（键名与 `background.js` 的 `WECHAT_EVENT_TITLE_KEYS` 对齐）× 六站点穷举真实标题，硬失败 = 站点片段切进 label 中间，警告 = 只剩顶级域 / 站点整段缺失。**纯 Node，无需浏览器**。它堵的盲区是"语言 × 预算"两个维度一起漏：`_dump_wechat_payload.mjs` 只加载 zh_CN、单测只用 11~12 的预算、模板门禁只判变量名。**改任何标题文案或 `clipHostTail` 的预算逻辑后必跑**
  - `verify-wechat-save-test-race.mjs` — 弹窗「发送测试消息」的时序门禁（20 报告 §3）：playwright 加载真 `popup.js` + chrome 桩（`save-settings` 的回调故意慢 60ms），按真实时序填四项凭据再点按钮，断言 **`wechat-test` 的发出晚于 `save-settings` 的回调落地**。判别力已实测：把 `await saveSettings()` 改成 `void` 立刻变红。**改弹窗里任何"先保存再动作"的按钮后必跑**
  - `_shot_wechat_ui.mjs` — 渲染微信主视图（已配置 / 未配全）与配置视图三张 PNG 供人工过目；同一套 chrome 桩。**注意"两个本该不同的状态渲成同一张图"是无声失效**——第一版就让「已配置」走了"凭据为空"分支、与「未配全」逐像素相同（图正常、exit=0），故每个待对照状态都要有独立入参
  - `_gen_prune_harness.mjs` / `_extract_text.mjs` — 取源工具：顺序类缺陷用"从仓库源码原样切片"而非手写复刻；抓网页一律 `curl -sL`（不跟 301 只会拿到跳转壳）
- **方法学红线（踩过坑）**：若验证脚本连"修复前源码"也判过，先怀疑**桩件监听器数组跨实例累积**——chrome 桩的 `addListener` 共用同一数组、新实例的监听器在末尾，必须取 `listeners.x.at(-1)`；取 `[0]` 读到的是上个实例的处理器，会让基线假绿
- **待决（08 §3.8 路线 B）**：`verify-prune-order.mjs` / `_gen_prune_harness.mjs` 实为测试资产而非审核笔记，可考虑挪进 `tests/` 并挂 CI，使上述引用真正成立；未获批前维持本地。**退出码缺口已于 10 报告闭合**（此前无论 ✅/❌ 都 exit 0，等于没有门禁）——即"挪进 `tests/`"这件事现在是真有价值的，因为该脚本已成为机器可判的门禁
- **另一处仍未决**（10 报告 §4）：`isErrorStatus` 把 404 计入错误页暂停。**不要直接删 404**——站点返回 404 常意味着监控目标已不存在，值得提醒；可行做法是把 404 与 5xx 的阈值分开。该通道能自愈，紧急度低于验证墙

## 验证清单

1. `node scripts/validate.mjs`：JSON/manifest/语言包/JS 语法一键校验（等价旧手工步骤 1-2）。注意它会遍历**整个仓库根**做 JS 语法检查，故 `_code-review/` 里的脚本语法错同样会让本地校验 exit=1
2. `node --test "tests/**/*.test.mjs"`：纯逻辑单元测试（引号必需，避免 shell 提前展开。glob 形式在 Node 24 与较新的 Node 22（本机 22.22.2 实测可用）均可；Node 22 早期如 22.14 不支持、报找不到文件，该环境下改用显式路径 `node --test tests/tab-auto-refresh/logic.test.mjs`）
3. 常驻回归（改动心跳 / 掉线探测 / 自动暂停 / 验证墙探测 / 保活 / `prune` 时必跑，脚本在本地归档目录）：`node _code-review/verify-sw-restart-state.mjs`、`node _code-review/verify-prune-order.mjs`、`node _code-review/verify-streak.mjs`；语言包或弹窗文案改动另跑 `node _code-review/_check_i18n.mjs` 与 `_code-review/verify-popup-titles.mjs`；**弹窗布局或尺寸改动另跑 `_code-review/verify-popup-height.mjs`**（这三条需 playwright 的 `NODE_PATH`）。**这些脚本现在都是可判退出码的**（0=通过），但**别用管道截断退出码**——`| tail` 会把退出码换成 tail 的，要看输出就用 `${PIPESTATUS[0]}` 或先重定向到文件；判断 webhook 行为另跑 `_code-review/_dump_webhook_payload.mjs`（离线打印真实请求体）
4. UI 改动后可用 `scripts/screenshot-popup.mjs` 重新生成 `docs/tab-auto-refresh/popup.png`（它的 `viewport.width` 必须与 `popup.css` 的 `body width` 保持一致，否则截图被裁切）
5. `chrome://extensions` 开发者模式加载插件文件夹，验证：设置/停止、倒计时归零后继续、右键菜单（页面+标签页）、立即刷新、角标计数、暂停/恢复全部、快捷键记住上次间隔、自动清理通知；1.7.0 新增：点「开始」**不弹任何授权框**一次成任务、30 秒任务下 12~20 秒能看到注入的心跳事件（DevTools 里断点或加 listener 观察）、同站另开无关标签页无心跳、同页停任务再启心跳恢复、关键词命中弹通知并停任务、模拟掉线（清服务端会话）后角标变红并通知、睡眠唤醒后过期 alarm 被重建；验证墙/错误页自动暂停：**含"验证码"字样但标题正常的页面不应被暂停**（10 报告修的就是这个误判）、关掉「验证墙保护」后不再探测、被暂停的任务点「恢复」能回到原周期；webhook 填入非法地址应立刻出现红字提示，改回合法地址即消失；弹窗尺寸：**任何任务数下弹窗本身都不应出现滚动条**（含 5 个以上任务，此时改由任务列表自身滚动、且第 3 行应露头提示可滚），新装应默认勾选「操作时跳过刷新」与「验证墙保护」

## 环境备注

- 如果 GitHub 直连失败，可在本机使用 SOCKS 代理；推送示例：
  `git -c http.proxy=socks5://127.0.0.1:10808 push`
- **推送失败的两级成因与对策（2026-09-14 实测，先看这条再看上一条）**：
  1. 宿主会注入 `http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` 全指向 `http://127.0.0.1:51734`，而该通道到 GitHub 直接 `CONNECT tunnel failed, response 502`（此时 `curl https://github.com` 也是 `HTTP 000` 超时）。**环境变量优先级高于 git 的 `http.proxy` 配置**，所以光加 `-c http.proxy=...` 不管用，必须先把四个环境变量摘掉。
  2. 本机自己的 SOCKS 代理在 **10808**（实测 1.8 秒拿到 HTTP 200）。可用写法：
     `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy=socks5://127.0.0.1:10808 push origin main`
     `fetch` / `ls-remote` 同理。症状识别：报 502 → 是环境变量那个死代理；一直挂住无输出 → 直连被墙，换 10808
- 本机 Codex PowerShell 可能没有 `npm`；验证和测试直接使用 `node` 命令
- `scripts/screenshot-popup.mjs` 依赖 Playwright，本机不在 Node 默认解析路径；需显式给 `NODE_PATH="C:/Users/yrgpc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"`，否则报 `ERR_MODULE_NOT_FOUND: playwright`
- **判断"有没有推上去"不要看 `git status`**：本机 `origin/main` 远程跟踪引用会僵在旧 commit（实测卡在 1.6.0 的 `8b93bd7`，`git fetch` 与 `git update-ref` 均报更新成功但读回仍是旧值），于是 `git status` 会误报 `ahead N`。以 **`git ls-remote origin refs/heads/main`** 为准——它直连远端，不受本地引用影响
