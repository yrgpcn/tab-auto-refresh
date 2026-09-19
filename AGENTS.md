# AGENTS.md

项目记忆：给在本仓库工作的 AI 助手和协作者。版本历史看 `CHANGELOG.md`，
还没修的账看 `BACKLOG.md`（2026-09-19 起，逐条带源码位置，修完移进 CHANGELOG 不算删掉），
审核过程与回归脚本清单看 `_code-review/README.md`（本地目录，见下）。

## 仓库

- 远端 `https://github.com/yrgpcn/tab-auto-refresh.git`，public，默认分支 `main`；本地检出 `D:\Github\tab-auto-refresh`。旧仓库名 `chrome-extensions` 由 GitHub 重定向
- 本仓库只放这一个插件（2026-09-09 起不再是多插件集合）。插件源码在 `tab-auto-refresh/`，测试与工具在仓库根
- 插件文件夹内不放独立 README，功能、安装、使用边界、技术栈统一写在根 `README.md`
- `.github/workflows/ci.yml`：push 与 PR 时用 Node 24 跑仓库校验与单元测试
- `.github/workflows/release.yml`：tag 驱动发布，先跑校验与单测，再比对 tag 版本与 manifest 版本，任一失败即不发布
- `scripts/validate.mjs` 仓库级校验（JSON、manifest、语言包、JS 语法、引用完整性、插件目录无未跟踪文件）；`scripts/screenshot-popup.mjs` 渲染弹窗截图，需要 playwright
- `tests/` 单元测试放在仓库根，避免被打进插件 zip
- `docs/` README 用的截图
- `_code-review/` 是本地审核归档（多轮报告与回归脚本），被 `.gitignore` 忽略，不入库、不进 Release、新 clone 里不存在。所以本文件里引用 `_code-review/...` 的路径只在本地有效
- 根 `package.json` 只是仓库工具配置（`type: module`、脚本、repository 元数据），没有依赖，不影响打包

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- 许可证红线：本仓库是 MIT。tab-reloader 与 staying_alive 没有许可证（默认保留所有权利），Keep-Alive-Pro 是 GPL-3.0。对这些只能取思路、不得粘贴代码字面，注释里至多写"思路与 X 一致"。只有 MIT 项目（如 auto-refresh-extension）的片段可以借鉴，且要保留来源 URL 与版权声明
- 提交信息用英文 Conventional Commits（feat / fix / docs / refactor / chore）
- UI 默认中文，同时维护 `_locales/zh_CN` 与 `_locales/en`，两边键必须齐平
- 版本号在 `tab-auto-refresh/manifest.json` 维护
- 发布：改 manifest 版本号并更新 CHANGELOG → 提交到 `main` → 打 tag `tab-auto-refresh/vX.Y.Z`（前缀勿改）→ 推 `main` 与 tag，Actions 自动打包、建 Release 并清理旧 Release 与 tag

### 三条改法纪律

1. 含"先读后写、跨异步步骤共享状态"的流程要把顺序决策抽成纯函数、执行器只负责写盘，让顺序能被单测直接断言，而不是靠读代码推断。已按这条落地的两处是 `planPrune`（启动恢复）与 `decideAlarmAction`（到点处置），新写的同类流程照这个形状做
2. 权限与功能成对记账：新增权限要在 CHANGELOG 该版本 Added 里点名，并更新下面的权限清单；新增需要权限的功能同样要更新权限说明
3. 默认值（开关、阈值、间隔）任何变动都要逐条列出受影响路径和"用户已显式设过值"的分支，确认不会改变既有用户的行为

### 测试纪律

- 三条外发链路（webhook、微信、静默心跳）的用例必须经桩件 `env.reply(spec)` 给出真应答：共享桩件在 `bootBackground` 里同时装 `globalThis.chrome` 与 `globalThis.fetch`，只设 `env.reply` 而拿不到 `fetch` 等于请求根本没发出去
- 凡是只断言"没发、没写、没通知"的用例，永远不可能证明那条链路被执行过——新写用例要先有一条"链路确实跑到了"的正向断言，再叠加"这条路径不该跑"的负向断言。红→绿对照的做法记在每个测试文件末尾

## 插件要点

### 权限与版本

- 权限：alarms / storage / tabs / contextMenus / notifications / cookies / scripting / idle / power
- host 权限常驻 `host_permissions: ["<all_urls>"]`，不要再改成按需申请。试过，硬伤是系统授权框弹出即夺走焦点、关掉扩展弹窗，发起申请的脚本随之销毁，授权完成后任务不会自动开始，用户必须再点一次"开始"。本插件自用分发、不上商店，按需申请没有合规收益。将来真要上商店再做，且必须监听 `permissions.onAdded` 在授权完成后自动续跑
- `minimum_chrome_version: 120`，30 秒级 alarms 依赖它

### 存储

- `chrome.storage.local`：`tasks`（tabId → `{intervalSec, createdAt, url, keywords?, onHit?, notifiedKeys?, autoPaused?}`，旧数据的单串 `keyword` 由 `getTaskKeywords` 兼容读取，后台与弹窗共用这一个入口）、`pausedAll`、`sessionProbe`（根域 → `{sus, lost, lastNotifiedAt}`）、`cookieBackup:<host>`、`cookieBackupWarnedOnce`、`wechatLastResult`
- `chrome.storage.session`：跨 SW 回收要活下来的运行时计数与标记，即 `rt:error:<tabId>` / `rt:captcha:<tabId>` / `rt:activity:<tabId>` / `rt:awake` / `wechatToken`。判断标准是要活过 SW 回收放这里，要活过浏览器重启才放 local
- `chrome.storage.sync`：`settings`。默认值集中在 `shared/config.js` 的 `DEFAULT_SETTINGS`，弹窗与后台共用；sync 为空时会从 local 迁移旧设置
- 后台的 `getSettings()` 带内存快照（`settingsCache` / `settingsLoading` / `settingsEpoch`）：一次任务页加载周期里它被调 5~7 次，原先每次都发两笔存储读。**新增的 `settings` 写入一律走 `patchSettings(partial)`，别自己 `get`/`set`**：它在 `withSettingsLock` 里读盘、合并、整份写回，读写两头各 `invalidateSettings()` 一次（读前不失效会拿过期快照当基座，把用户这次没碰的开关按旧值写回去；写后不失效则 `onChanged` 回流前的一切读取仍是写前的值）。`partial` 给函数时按当前设置决定增量、返回 `null` 即不写，"没变就不写"的判断因此与写盘同处一把锁。唯一例外是 `loadSettings` 的 local→sync 迁移（整份写入、只发生一次、且在 `getSettings` 调用栈内，走 `patchSettings` 等于自锁）。两把锁的方向是契约：`startTask` 在 `withTaskLock` 内 `await` 设置写盘（单向等待），设置锁内绝不排 `withTaskLock`，否则互相等死。失效点、串行、锁方向均由 `tests/tab-auto-refresh/settings-cache.test.mjs` 钉住，文件末尾记着红→绿对照与两处第一次不合格的对照
- 当前默认开：`bypassCache`、`keepAlive`、`httpHeartbeat`、`skipOnActivity`、`captchaGuard`；默认关：`skipDiscarded`、`cookieBackup`、`keepAwake`、`wechatEnabled`；`webhookUrl` 默认空即关闭
- 改 `DEFAULT_SETTINGS` 只影响新装：`getSettings()` 是 `Object.assign({}, DEFAULT_SETTINGS, 已存值)`，老用户的存盘值优先。想让老用户也吃到新默认必须写迁移

### 调度与任务

- alarm 命名：刷新 `refresh-<tabId>`，静默心跳 `hb-<tabId>`；前缀与预设定义在 `shared/config.js`
- 刷新用"一次性 when + period 兜底"双保险，每次触发后重新 arm，间隔 ±15% 抖动。30 秒档只正向抖，否则一半样本会被 30 秒地板抬回原值
- `onAlarm` 到点之后的处置全在 `shared/logic.js` 的 `decideAlarmAction`（纯函数，返回 `{action, reason}`），后台只负责把事实取齐再执行 `ALARM_ACT` 四选一。次序是语义的一部分，三条不能调换，注释写在纯函数侧：全局暂停早于标签页存在性（暂停期随手关页不该收到停止通知）、存在性早于 `autoPaused`（否则自动暂停的任务关页后无人清理）。`ACTIVITY_SKIP_MS`（60 秒）随之住在 `logic.js`
- `skipOnActivity` 有两条判据，是 or：内容脚本上报的活动时间戳（会话态 `rt:activity:<tabId>`），以及 `isTabOnScreen`——该页是所在窗口的活动页且那个窗口是焦点窗口。后者不依赖注入，注入失败的页面不至于在用户眼皮底下反复重载。焦点窗口 id 跟 `windows.onFocusChanged` 记，**三态不能压成两态**：`undefined`（本 SW 实例还没收到过焦点事件）才允许补查一次 `getLastFocused()`，`null`（最后一个事件是 `WINDOW_ID_NONE`）是"已知浏览器不在前台"、必须直接放行去刷，因为真实 Chrome 在焦点去了别的应用之后**仍然返回最后聚焦的那个窗口**，把两态合并会让用户走开期间的每一次触发都判成"人正看着这页"，从此永不刷新。认不出来一律 `false`（宁可多刷一次，绝不能变成永不刷新），且只在 `skipOnActivity` 开着时才去查（关着就别为每次触发多问两回）。门禁由 `tests/tab-auto-refresh/alarm-gate.test.mjs` 钉住
- 心跳每 4 分钟一次，建 alarm 时带随机初始相位；`chrome.idle` 回到 active 时，过期的刷新 alarm 重走完整周期，过期的心跳 alarm 打散 0~60 秒重建
- 后台对 `tasks` 的读改写必须走 `withTaskLock` 串行队列
- 快捷键 `toggle-refresh`（Alt+Shift+R）复用 `settings.lastIntervalSec`，没有记录时回退 5 分钟；右键菜单 contexts 是 `["tab", "page"]`
- 手动开始任务（弹窗、右键、快捷键）会解除 `pausedAll`；暂停期间 alarm 跳过触发，恢复后按原周期继续
- 角标四态在 `updateBadge` 一处切换：掉线 `!` 红 > 自动暂停 `⚠` 橙 > 暂停 `‖` 灰 > 数量 蓝 > 空。所有任务增删路径都要经过它，`chrome.power` 锁的收敛也挂在那里
- 单独关掉一张被监控的页会按任务里记录的网址**在后台重开一张**并把任务搬到新 id（先 `setTasks` 落盘、再挂新 alarm、最后清旧 id 的两条 alarm）；`removeInfo.isWindowClosing` 为真时整个不动，交给启动恢复。`!task.url` 也不动，免得给旧格式任务开出幽灵页。门禁由 `tests/tab-auto-refresh/tab-removed.test.mjs` 钉住
- `tabs.onUpdated` 先用内存里的任务 tabId 快照过滤，非监控标签页不读存储；快照在 `setTasks` 时更新，冷启动首次事件回读存储
- `startTask` 拿不到标签页或网址时抛错，不建没有网址的幽灵任务
- 受限页面（`chrome://` 等）由 `RESTRICTED_URL` 判定，`startTask` 直接拒绝

### 启动恢复

- `prune(adoptLegacyUrls)` 做三件事：恢复 cookie、把任务重新挂接到会话恢复出来的标签页、失效任务兜底重开
- `adoptLegacyUrls` 只在扩展安装或更新时为真，那时浏览器没重启、tabId 仍有效，可以给 v1.4.3 及更早（任务里只有间隔和创建时间、没有网址）的旧任务补记当前网址。浏览器重启后 tabId 已重新分配，只能淘汰
- 注册必须写成 `() => prune(true/false)`。直接 `addListener(prune)` 会让 `onInstalled` 的事件详情对象被当成真值
- 顺序决策全在 `shared/logic.js` 的 `planPrune({ tasks, tabs, adoptLegacyUrls })`（纪律 1 的兑现处），`prune` 只剩执行：`keep`/`adopt`/`remap`/`watch`/`dropped`/`staleIds`/`claims`/`dirty`。计划跑两遍——锁外一遍只为了判断要不要等待，等待结束后在锁内用最新的 tasks/tabs 再跑一遍再应用（套用等前的旧计划会把等待期间用户的起停算进去）
- 认领规则：ID 被占用不代表挂接正确，要网址一致（精确或 `urlKey` 相等）才保留。重映射时跳过已被其他任务认领、或仍是其他未处理任务键的页面（`pending` 集合，防两个任务争抢同一页时后者被覆盖而静默丢失）。同一网址开在多个标签页时每页至多挂一个任务。现场认领不到的进 `watch`：候选**共享一个** `RECLAIM_WATCH_MS` 上限窗口（在任务锁之外等），等完仍认不到才按记录的网址重开。原先是按任务逐个等 20 秒且全程持锁，N 个未认领任务能让弹窗与刷新整体停摆 N×20 秒
- 应用阶段一律**先 `setTasks` 落盘、再 arm 刷新与心跳、最后清陈旧 alarm**。心跳排在写盘后面是硬要求：`ensureHeartbeat(新 id)` 要按落盘后的键读任务，先挂会让它读到"这个 id 没任务"而把心跳清掉，恢复后的任务只剩刷新、没有静默心跳。`startTask` 与 `reopenTaskTab` 同样是先写后挂
- 未认领任务的旧 alarm 收集到 `plan.staleIds`，`setTasks` 写盘之后再清，清理时对照写盘后的最终键集合（`liveIds`）。被本轮重挂接或重开占用的 id 不能清，否则会造出"任务在、永不刷新"的僵尸。由 `tests/tab-auto-refresh/prune-plan.test.mjs` 钉住

### cookie 备份与登录保持

- 由 `settings.cookieBackup` 控制，默认关闭。关闭时不备份不恢复，`pruneCookieBackups` 清空全部备份
- 备份存在 `chrome.storage.local` 的 `cookieBackup:<host>`，明文，README 有安全说明。采集范围三道约束：① 注册域判据是形状规则（末段两字母国家/地区码 + 倒数第二段品牌段 → 多切一段），**别再退回手写完整后缀清单**，漏一条就整条踩空；② `domainChain` 下探到注册域为止，绝不查注册域以上（`getAll({domain:"co.nz"})` 的语义是"等于或子域于它"）；③ `siteRoot` 取不到可信注册域时返回 null，调用方一律不备份、不建探针——宁可丢登录态也不能越界。单段主机与 IPv4 无父域可切，整串即身份。纯函数层由 `tests/tab-auto-refresh/logic.test.mjs` 钉，查询面与恢复侧由 `tests/tab-auto-refresh/cookie-backup.test.mjs` 钉
- 启动恢复里历史越界备份的收敛是纯函数 `planBackupConvergence`（只剔注册域之外的条目，键本身是后缀或筛完为空才整条删，timestamp 不动），**必须排在按注册域恢复之前**：`restoreCookies` 按每条自己的 domain 写回浏览器，先恢复等于已经替别家站点复活了一遍登录态
- 条目带 `schemaVersion: 2` 与每条 cookie 的 `hostOnly`。还原时 `hostOnly === true` 省略 `domain`（否则 `__Host-` 票据写不进去，或作用域被扩大），`=== false` 传 `domain`，字段缺失的 v1 旧备份统一传 `domain`
- 单站点封顶 200 条，超限时先按"像登录票据的程度"排序再截（httpOnly > 会话票 > `__Host-`/`__Secure-` > `path=/` > 域更短）。正常规模不排序，避免无谓的顺序变化
- 启动恢复按注册域匹配，覆盖 SSO 登录所在的兄弟子域；恢复成功的根域记在 `restoredRoots`，据此决定认领的标签页要不要补刷新
- 淘汰三条件：站点不再被任何任务使用、超过 30 天、超过 20 站上限（按时间留新）。停止任务与启动恢复时统一执行。`chrome.storage.local.get` 不支持通配符，清理要 `get(null)` 后按前缀过滤

### 会话保活与掉线检测

- 保活（`keepAlive`，默认开）按标签页注入 `content/keepalive.js`。不用 `registerContentScripts`：matches 是站点级会溢出到同站无关标签页，而且站点注册 id 与任务 id 语义分裂，重启后停任务清不掉
- 注入点是 startTask 即时一次，加 `tabs.onUpdated` 每次加载完成补注入；停止任务发 `keepalive-off` 让页面内脚本自停；`reconcileKeepAlive` 在启动与开关真变化时收敛存量任务页
- 内容脚本向 `document` 派发 `mousemove` / `keydown`，document 级派发经冒泡同时覆盖挂 document 与 window 的监听器。首个心跳 12~20 秒（短刷新周期下慢心跳永远来不及触发），之后 45~75 秒随机
- 静默心跳（`httpHeartbeat`，默认开）：每 4 分钟对任务 URL 发 `fetch(credentials: "include", cache: "no-store", headers: { Range: "bytes=0-1023" })`，15 秒超时。Range 值必须保持 `bytes=数字-数字` 这个 CORS 安全名单形式，改成 `bytes=-1024` 之类会引入预检。站点回 416 时去掉 Range 重试一次
- 掉线检测有两条通道。状态通道由 `decideBackupWrite` 驱动：会话票据从有到无先记疑似，疑似采样只并入计数、不覆盖好备份，连续 2 次才冻结该站点备份并按 6 小时节流通知。行为通道由 `reportSessionSignal` 写 `sessionProbe`：任务页落在登录页 URL、心跳被重定向到登录页或返回 401/403，计入同一个 2 次确认窗口。确认后角标变红，重新登录即恢复
- 信号写入做值快照比对，三元组没变就不写盘、不刷角标

### 关键词监控

- 任务字段 `keywords[]`，每条 ≤100 字、上限 10 个；旧 `keyword` 单串由 `getTaskKeywords` 兼容
- 检测链全在后台，不碰保活注入通道：每次页面加载完成起一条链，立即查一次，未命中再于 3 秒、10 秒重采样。新链起链即作废旧链，避免并发链重复通知或竞态停任务
- 匹配在页面里做：`executeScript({func: matchInPage, args: [keywords]})` 只回传命中的关键词，正文不跨上下文序列化，因此没有早先"截 300KB、之后的内容永远检不到"的盲区。`matchInPage` 必须自包含（executeScript 是 `toString()` 注入的，引用模块作用域会在页面里变 undefined 并被 catch 吞掉），所以判定逻辑与 `logic.js` 的 `presentOf` 是两份实现，由 `tests/tab-auto-refresh/keyword-inpage.test.mjs` 切真实源码执行、逐条比对钉住。取文本一律 `innerText`，换 `textContent` 会把 `<script>` 源码和 `display:none` 的隐藏文字算进正文
- 命中后按 `onHit` 决定停任务（默认）还是继续盯守，继续时把在场集回写 `notifiedKeys`，关键词消失后再出现会重新通知。原先"正文与上次相同就提前结束"的早停已删（回传的不再是要比较的正文）

### 自动暂停

- 错误页：心跳侧 5xx/404 连续 `PAUSE_CONFIRM_SAMPLES`（2）次即暂停，回到 2xx 自动解除
- 验证墙：页面侧特征连续 `CAPTCHA_CONFIRM_SAMPLES`（3）次即暂停，受 `settings.captchaGuard` 控制。两个阈值刻意分开，别合并回一个常量：错误页有独立的心跳 alarm 兜着、能自愈，验证墙的解除却依赖页面再次加载，误判会卡死不自愈，代价不对称
- 匹配面只取 `document.title` 与挑战域名（Cloudflare / reCAPTCHA / hCaptcha）的 iframe 和 script，不扫正文。正文里的"验证码""access denied"是日常词，登录框提示、帮助文案、页脚都会命中。401/403 的登录墙语义另走掉线通道，这里不重复判定
- 暂停期间 alarm 照常续跑，`onAlarm` 见到 `autoPaused` 早退，恢复零重建。`onAlarm` 里标签页存在性检查排在 `autoPaused` 之前，否则被自动暂停的任务在标签页关掉后没人清理
- 计数存会话态，不进 `sessionProbe`，不污染备份冻结语义

### 通知外发

- `notifyOut(event, payload)` 是唯一入口，依次 `postWebhook` 与 `postWechat`。两者共用 `notifyEvents` 事件清单、各有独立开关。调用方必须 `await`，两条链路都是 fetch，裸甩异步会在 SW 回收时被截断
- Webhook：`normalizeWebhookUrl` 只接受 http(s)，非法就静默不发（弹窗另有内联提示）。载荷填 `content` / `text` / `body` 三个别名，加 `type` / `url` / `host` / `ts`。ntfy 收到的是原始 JSON 文本，它只在根端点解析 JSON 而载荷里没有 topic 字段，别再说它开箱即用
- 微信直连（`wechatEnabled`，默认关）：扩展 SW 直接调 `api.weixin.qq.com` 推模板消息，不经中继。令牌走 `stable_token`（老的 `/cgi-bin/token` 每刷一次就作废上一个，多端并发会互相打掉），缓存在 `chrome.storage.session`，距过期 5 分钟提前重取，命中 40001/42001 清缓存重取并重试一次
- 微信平台的两条硬限制写死在常量与注释里，别凭直觉给大值。一是模板消息单个字段不超过 20 个字、不支持换行，超长由平台去掉且不给任何提示；二是模板正文里变量前必须有关键词加中文冒号，裸写变量会被平台整行丢弃，而接口照旧返回 errcode=0，用户收到的是一张空白卡片
- 卡片标题用一套短事件名（`wechatEv*Short`），不复用弹窗复选框的长标签：标题要和站点一起挤在 20 字里，英文长标签会把预算吃光。站点放不下完整注册域时整段不显示，不给"…e.com"这样的碎片
- 失败要留痕：错误码经 `wechatErrorKey` 翻成"该去哪改"的提示，最近一次结果写 `chrome.storage.local` 的 `wechatLastResult`，弹窗显示
- 凭据四项存在 `settings`（即 `chrome.storage.sync`），会随 Google 账号同步到其它桌面 Chrome，README 有说明

### 系统通知

- 四类通知的 ID 一律由 `background.js` 的 `NOTIF_ID` 生成，`NOTIF_TAB_PREFIXES` 是点击反查用的清单，新增一类通知要同时进这两处，否则"清理"与"点开跳转"会静默对不上（`tests/tab-auto-refresh/notifications.test.mjs` 有一条扫源码的守卫）
- `session-lost` 的 ID 用注册域而不是整页主机名：SSO 常落在兄弟子域，按主机名会为同一次掉线发出两条。收掉的时机是探针从 `lost` 翻回正常，以及站点不再被任何任务监控（`pruneStaleProbes`）
- 清理按时机分，不按"任务还存不存在"一刀切：`startTask` 清该标签页的 keyword-hit / task-stopped / task-paused（上一轮的结论已作废）；`stopTask` 只清 task-paused（keyword-hit 往往正是命中即停的产物，在 `stopTask` 里清等于当场撤回用户刚收到的通知）；`resumeTaskAuto` 只在真恢复了才清
- 点通知 = 把对应标签页带到前台并聚焦它的窗口，然后自动收掉。`chrome.windows` 不需要新权限（`tabs` 已给到 `windowId`）；标签页早就不在了就什么都不做

### 弹窗

- Chrome 弹窗外框上限 800×600，整页高度必须留在 600px 内。宽度 400px，10 个开关用 `repeat(2, minmax(0,1fr))` 双列网格（不能写成 `1fr`，`1fr` 的隐含下限是 `min-content`，长标签会把列撑成不等宽），所以标签必须短且一律单行
- `body` 用 `flex` 加 `max-height: 600px` 兜底，唯一的弹性块是任务列表，列表封顶 108px，第 3 行露头当"下面还有"的提示
- 微信配置走二级视图整页切换（`body.wx-mode`），四行输入框直接铺在主视图里必然顶破上限
- `[hidden]` 会被作者样式里的 `display` 压过（`.row` 是 `display:flex`），已全局声明 `[hidden] { display: none !important }`
- 弹窗每秒重新拉 alarm 列表再重绘倒计时，因为 alarm 周期触发不会触发 `storage.onChanged`
- 保存设置时要合并既有 `settings`，否则只改复选框会丢掉 `lastIntervalSec`
- 当前标签页已有任务时，`init` 要把该任务的 `keywords`（走 `getTaskKeywords`，旧单串也认）、`onHit === "continue"`、实际间隔回填进输入控件（`populateTaskFields`）。不回填的后果是数据丢失而不是显示缺失：用户只能停掉再重开，而重开读的是空框，原来的关键词监控静默消失。回填只在 init 做一次、排在 `initPresetSelect()` 之后（要盖掉它按 `lastIntervalSec` 的预填），**不得挂到 `storage.onChanged` 的重绘回流上**——回流反复发生，挂上去会抹掉用户正在输入的字；没有任务时早退，一个字都不动。判据与顺序由 `tests/tab-auto-refresh/popup-repopulate.test.mjs` 钉住（切源码跑，popup 没有 DOM 库可测）
- i18n 通过 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` 注入，`title` 这条通道专门用来把开关的长解释挪出可见版面

### 跨 SW 实例的运行时状态

- MV3 的 service worker 闲置 30 秒即终止（收到事件或调扩展 API 会重置计时器），任何两端间隔为分钟级的累计或标记都不能放内存变量，否则计数每次从 0 起、功能静默失效。全部走 `chrome.storage.session`，读写用独立的串行队列 `rt()`。它与 `withTaskLock` 无关，在锁内再入队会死锁

## 验证清单

1. `node scripts/validate.mjs`。它会遍历整个仓库根做 JS 语法检查，所以 `_code-review/` 里的脚本语法错也会让它 exit=1
2. `node --test "tests/**/*.test.mjs"`（引号必需）
3. 改了对应功能后跑 `_code-review/` 里的回归脚本，清单与用法见 `_code-review/README.md`。这些脚本不在 CI 里跑，要手动跑；判退出码时别接管道（`| tail` 会把退出码换成 tail 的），需要看尾部输出就用 `${PIPESTATUS[0]}` 或先重定向到文件
4. UI 改动后可用 `scripts/screenshot-popup.mjs` 重新生成 `docs/tab-auto-refresh/popup.png`，它的 `viewport.width` 必须与 `popup.css` 的 `body width` 一致，否则截图被裁
5. 手工验证：在 `chrome://extensions` 开发者模式加载插件文件夹，验证设置与停止、倒计时归零后继续、右键菜单、立即刷新、角标、暂停恢复、快捷键记住上次间隔、自动清理通知（停任务、重开任务、重新登录后各自的通知要从通知中心消失，点通知要跳到对应标签页并带到前台）；30 秒任务下能在 DevTools 里看到注入的心跳事件，同站另开无关标签页无心跳；关键词命中弹通知并停任务；掉线后角标变红；验证墙与错误页自动暂停（含"验证码"字样但标题正常的页面不该被暂停）；webhook 填非法地址应立刻出现红字提示；任何任务数下弹窗本身都不该出现滚动条。启动恢复这条只能真机验：开几个任务后重启浏览器（或在 `chrome://extensions` 重新加载扩展），任务要全部挂回原页面、不额外多开标签页、弹窗不卡住，被恢复的任务在 DevTools 的 `chrome://extensions → 背景 → Alarms` 里要同时看到 `refresh-<id>` 与 `hb-<id>`（缺 `hb-` 就是心跳又被排到写盘前面了）。开着"尊重你的操作"时，把某个任务页摆在当前窗口前台等它到点，不该被重载

## 环境备注

- 推送失败先看这里：先直接试 `git push`。2026-09-18 发布 2.1.0 时不带任何代理参数，推 main 与推 tag 都在几秒内成功。只有它失败才走下面那条 SOCKS 的路。
- 宿主有时会注入 `http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` 四个环境变量，全指向 `http://127.0.0.1:51734`，该通道到 GitHub 直接 502。环境变量优先级高于 git 的 `http.proxy` 配置，所以光加 `-c http.proxy=...` 不管用，必须先把四个变量摘掉，再走本机 10808 的 SOCKS：
  `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy=socks5://127.0.0.1:10808 push origin main`
  先 `env | grep -i proxy` 确认变量在不在。2026-09-19 实测这一次四个变量一个都没有，直连报的是 `curl 28 Recv failure: Connection was reset`、`ls-remote` 报 `Failed to connect to github.com port 443`，同一条命令带上 10808 SOCKS 立刻成功——所以摘变量只是变量在场时才需要，路走不通先试 SOCKS，别默认病因一定是那几个环境变量。
  症状区分：报 502 是环境变量那个死代理；报 connection reset / 连不上 443 是直连路本身不通，SOCKS 可解；一直挂着没输出，先分清是网络还是凭据（见下条）。
- 上面那条推送命令有两种更难查的假成功：一是**一个字节都不输出**、退出码还是 0，实际什么都没推上去（2026-09-18 实遇到）；二是**照常打印 `Everything up-to-date`** 并返回 0，而同一次 push 前面已经写着 `RPC failed; curl 28`、`fatal: the remote end hung up unexpectedly`（2026-09-19 实遇到，远端仍停在旧 commit）。所以推送成功与否一律按下条用 `git ls-remote` 复核，别按退出码或按那行 up-to-date 收工。
- 推送挂住不动时，先确认到底是网络还是凭据，别默认是代理问题。2026-09-14 实测：`ls-remote` 与 `curl -X POST .../git-receive-pack` 都正常（后者 1.3 秒返回 401），说明网络通、缺的是凭据。而本机的凭据助手是 `git-credential-manager.exe`，它拿不到缓存的凭据时会去开交互界面，在非交互环境里表现为**一直挂住**（`git credential fill` 超时也返回不了任何东西）。快速判别：
  `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c http.proxy=socks5://127.0.0.1:10808 push origin main`
  立刻报 `could not read Username` 就是凭据缺失，需要在能弹界面的终端里推一次（或改用带 PAT 的地址），与代理无关。
- 判断有没有推上去不要看 `git status`。本机的 `origin/main` 远程跟踪引用会僵在旧 commit，会误报 `ahead N`。以 `git ls-remote origin refs/heads/main` 为准
- playwright 类脚本（弹窗截图、`_code-review/` 里几个门禁）需要显式给 NODE_PATH，否则报找不到 playwright。原先记的那个 codex-runtimes 路径随运行时一起没了，别再照抄；现在怎么给见下面"恢复本地门禁"
- 本机 node 是 2026-09-19 以便携压缩包装回的，**不在 PATH 上**：bash 与 PowerShell 里 `node` 仍解析不到，验证清单第 1、2 条一律按绝对路径调用，具体路径见下面"恢复本地门禁"。真实装不了的那段缺口由 CI 兜：push 后看 Actions，release workflow 自己跑 `validate.mjs` 与单测，任一失败就不建 Release。2.1.0 就是本地零条实跑、只靠 CI 发的——别把 CI 绿当成"本地验过"

### 恢复本地门禁

2026-09-19 本机现状：node v24.21.0 在 `C:\Users\<user>\AppData\Local\node-tools\node-v24.21.0-win-x64\node.exe`，不在 PATH 上；`winget` 可用但这条路走不通（见下）；`choco` / `scoop` / `nvm` 都没有。

1. 别再试 `winget install OpenJS.NodeJS.LTS --disable-interactivity`：实测它一个字节都不输出、几十分钟不结束、也不装出任何东西——它在等一个非交互环境给不出的提权确认。换官方压缩包：`https://nodejs.org/dist/` 下取 `node-vX.Y.Z-win-x64.zip`（本机默认代理能直连 nodejs.org），解压到 `%LOCALAPPDATA%\node-tools\`，全程不需要管理员权限
2. `node --version`（按绝对路径）要是 24.x，与 CI 的 `setup-node@v4 / node-version: 24` 对齐。22.x 也跑得起来，但那不等于 CI 的结果
3. 验证清单第 1、2 条：`node scripts/validate.mjs` 与 `node --test "tests/**/*.test.mjs"`（引号必需，去掉就被 shell 吃掉），本机把 `node` 换成上面那个绝对路径。这两步**不需要 `npm install`**——`scripts/` 与 `tests/` 里除了 `node:` 内置模块没有任何第三方 import，根 `package.json` 也没有 dependencies。压缩包里确实带 npm，但 `node.exe npm` 直接调不行，要用 npm 得先把解压目录加进 PATH
4. 只有截图（清单第 4 条）才需要 playwright，它是脚本运行时用 `createRequire` 现找的、不在仓库依赖里：`npm install -g playwright`，再在 PowerShell 里 `$env:NODE_PATH=(npm root -g)`，然后 `node scripts/screenshot-popup.mjs`。脚本里 Chrome 路径写死 `C:\Program Files\Google\Chrome\Application\chrome.exe`，本机该文件在；换机器要连着改
5. 清单第 3 条不在这次恢复范围内：`_code-review/` 不入库，这台机器上从未存在，只能从原来那台拷过来，或按 CHANGELOG 里的描述重写门禁
