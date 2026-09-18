# BACKLOG.md

待办清单，不是项目记忆。项目约定与"为什么这样设计"看 `AGENTS.md`，已发生的事看 `CHANGELOG.md`。

清单来源：2026-09-19 对 2.1.0 代码的一次从零审计（不采信文档结论，逐条对着源码确认）。
每条都带**源码位置**和**为什么现在测不出来**，因为这两样是动手时真正要用的信息；
修完任何一条，按 `alarm-gate.test.mjs` 与 `settings-cache.test.mjs` 末尾记的做法做一次红→绿对照，
"没有对照"就等于这条还没修。

维护方式：修完不删条目，整段移进 `CHANGELOG.md` 对应版本，本文件只留还在账上的。
新增条目同样要带源码位置，不接受"某处可能有问题"这种形状。

## 优先级一览

| 编号 | 优先级 | 一句话 | 状态 |
| --- | --- | --- | --- |
| A1 | P0 | `isTabOnScreen` 焦点回退：人走开之后任务永不刷新 | 待做 |
| A2 | P0 | 公共后缀使 cookie 备份越界采集到无关站点 | 待做 |
| A3 | P1 | 关键词与验证墙检测只覆盖顶层框架 | 待做 |
| A4 | P1 | 外发载荷带完整 query 网址；凭据存 sync 且明文 | 待做 |
| A5 | P1 | 弹窗不回填任务的关键词/继续盯守/间隔 | 待做 |
| A6 | P1 | 共享桩件 10 处偏离真实 Chrome，多条门禁实际空跑 | 待做 |
| A7 | P2 | `settings` 两条无锁读-改-写互相覆盖 | 待做 |
| A8 | P2 | webhook 失败无痕，且没有"发送测试" | 待做 |
| A9 | P2 | `onMessage` 不校验来源、设置键不做白名单 | 待做 |
| A10 | P3 | 语言包内部自相矛盾（四项/三项、英文冒号/中文冒号） | 待做 |
| A11 | P3 | 弹窗文本框只在失焦保存；测试按钮无 finally | 待做 |
| A12 | P3 | SKIP 原因无痕；三处 `storage.local.get(null)` 全量扫描 | 待做 |
| V1 | — | 2.1.0 真机手工验证（含下面三条只能真机验的检查） | 待做 |
| E1 | — | 本机 node 门禁恢复 | 进行中 |
| E2 | — | `_code-review/` 门禁是否迁入入库路径 | 待定 |

建议动手顺序：A6 → A1 → A2 → A5 → A7 → A9 → 其余。
A6 排最前是因为 A1/A3 的验收用例要先有"能真的变红"的桩件，否则改完仍然只是看着绿。

## P0：会让功能朝反方向静默失效

### A1 `isTabOnScreen` 的焦点回退把"人在别的程序里"当成"人在看着这页"

- 位置：`tab-auto-refresh/background.js:1226-1239`；桩件 `tests/helpers/background-harness.mjs:165-168`
- 链条：焦点切到别的应用 → Chrome 发 `onFocusChanged(WINDOW_ID_NONE)` → `focusedWindowId = null`
  → 下一次 alarm 走 `focusedWindowId === null` 分支去问 `getLastFocused()` → **真实 Chrome 在浏览器
  没有前台窗口时仍然返回最后聚焦的那个窗口**（只有完全没有窗口才 reject）→ 回填成 `tab.windowId`
  → 判定 `user-active` → 这一拍跳过。每次触发都重复，于是"用户走开之后永远不刷新"。
- 为什么这是 P0：`shared/logic.js:524-525` 写明这条通道"认不出来一律 false，宁可多刷一次，
  绝不能变成永不刷新"。实际代码在最常见的情形下（任务页是所在窗口的活动页，人去了 IDE）反着走。
- 为什么没被发现：桩件的 `getLastFocused` 在 `focusedWindow === null` 时抛错，等于把"焦点在别的
  应用里"建模成"完全没有窗口"。`tests/tab-auto-refresh/alarm-gate.test.mjs:151-155` 那条
  "焦点在别的应用里时照刷"因此是为错误的原因变绿的——它的红→绿对照（同文件 226-228 记录的第 4 处）
  改的是乐观分支返回值，碰不到这条真实路径。
- 改法：把"从没收到过焦点事件"（冷启动，未知）与"最后一个事件说 WINDOW_ID_NONE"（已知无焦点）
  分开。后者直接 `return false`，不再回退去问 `getLastFocused()`；只有前者才补查一次。
- 验收：桩件补一种状态——`focusWindow(null)` 之后 `getLastFocused()` 仍解析出上一个窗口；
  新增用例覆盖"浏览器退到后台但窗口还在"；对照改回现在的写法必须只红这一条。真机检查见 V1 (c)。

### A2 `siteRoot` 手写字表 + `domainChain` 下探过头，备份捞进无关站点的 cookie

- 位置：`tab-auto-refresh/shared/logic.js:65-84`（`MULTI_SUFFIXES` / `siteRoot`）、
  `logic.js:113-121`（`domainChain`）、`tab-auto-refresh/background.js:971-986`（采集）
- 链条：`siteRoot` 对不在手写字表里的多级公共后缀一律 `cut = 2`。例：`shop.example.co.nz` → `co.nz`
  （`co.nz` / `com.ua` / `com.ru` / `co.id` / `com.ph` / `com.vn` 等都不在表里）。
  而 `domainChain("shop.example.co.nz")` 返回 `["shop.example.co.nz", "example.co.nz", "co.nz"]`，
  `chrome.cookies.getAll({ domain: "co.nz" })` 的语义是"域等于或子域于它"，于是把浏览器里**所有**
  .co.nz 站点的 cookie 全捞进来，去重、按票据得分截到 200 条，明文写进
  `cookieBackup:shop.example.co.nz`；`restoreCookies` 再按每条自己的 `domain` 写回去，
  等于替无关站点复活一遍登录态。
- 同一根因还波及：`sessionProbe` 以 `siteRoot` 为键（两个无关站点共用一个掉线状态，A 站掉线会
  冻结 B 站的备份写入）、`pruneCookieBackups` 的"还在被监控"判断、以及 `background.js:971`
  那句注释承诺的"只备份与监控目标同根域的站点"本身。
- 前置条件：`settings.cookieBackup` 开启（默认关），且监控目标位于多级公共后缀之下。
- 改法（两处都要，缺一不可）：
  1. `domainChain` 在 `siteRoot` 处停止下探，绝不查询注册域以上的层；
  2. `siteRoot` 不能只靠手写字表。取不到可信注册域时**宁可不备份**，也不要退化成公共后缀。
- 已定路线（不改变既有用户的行为，按 `AGENTS.md` 纪律 3）：不整条清除老备份，而是做一次收敛——
  把已存条目里落在注册域之外的 cookie 剔掉，其余原样留着。整条清除会让"重启后恢复登录"
  在用户没碰过任何开关的情况下静默失效。
- 验收：`logic.test.mjs` 补 `co.nz` / `com.ua` / 单段内网名 / `localhost` / IPv4 的断言；
  新增一条门禁断言"对任意主机，`domainChain` 的末段恒等于 `siteRoot(该主机)`"。

## P1

### A3 关键词与验证墙都只查顶层框架

- 位置：`background.js:674-678`（`matchInPage` 注入）、`background.js:1583-1585`（`probeCaptcha`）
- 两处 `executeScript` 都只给 `target: { tabId }`，没有 `allFrames`，只在顶层框架跑。
  有 <all_urls> 主机权限，跨源 iframe 一样能注入，所以现在检不到纯粹是没要。
- 不要盲目加 `allFrames: true`：
  1. 返回结构变成多框架数组，现在读的是 `results[0].result`（`background.js:679`），
     关键词（返回数组）与验证墙（返回布尔）的聚合方式不一样；
  2. 个别框架注入失败会给 `undefined`，要按"取到几个算几个"处理，不能让一个失败吞掉整次判定；
  3. 验证墙侧防反向误判：正常页面的广告/统计 iframe 里出现 recaptcha 脚本不等于整页是墙。
     `probeCaptcha` 的判据刻意是"整页就是墙"（标题优先，见 1590-1600 注释），放宽判定面必须
     同时保住这一点——误判验证墙的代价是"卡在暂停态且不自愈"，与错误页能自愈不对称。
- 验收：`keyword-inpage.test.mjs` 只测函数体语义，覆盖不到框架聚合；多框架聚合要新写单测，
  依赖 A6 第 3 条把 `__fixture` 真正用起来。

### A4 外发内容与凭据的暴露面

- 位置：`background.js:725-730`（关键词命中载荷）、`background.js:751-777`（webhook）、
  `popup.js:341-368`（saveSettings）、`popup.html` 里 `webhookUrlInput` / `wechatSecretInput`
- 三件事：
  1. 载荷带完整 `task.url`。`URL` 的 query 常含会话令牌、一次性签名、邮箱手机号（工单与后台系统
     尤其如此）。改成默认只发 `origin + pathname`（`urlKey` 已有实现）。**已定：不加开关，直接切**——
     精简版照样可跳转、可定位页面，而"带 query"这个选项等于长期留一个把令牌外发的入口。
     属纪律 3 范畴，CHANGELOG 要点名。
  2. 关键词命中的 `text` 就是把用户监控的字面发给外部端点。这是用户主动配的，可接受，
     但 README 外发一节要点名（现在只说"通知内容会发出去"）。
  3. `webhookUrl` 与微信 appsecret 存在 `settings`（即 `chrome.storage.sync`），随 Google 账号
     漫游到其它桌面 Chrome 且明文。README 说明了微信凭据同步，**没提 webhook 地址本身也是凭据**
     （带 token 的 URL 拿到就能发）。另外 appsecret 输入框是 `type="text"`，旁边有人就能看到——
     改 `type="password"`。

### A5 弹窗不回填任务级字段，重开任务会丢掉监控

- 位置：`popup.js`（`init` 的回填段只回填全局设置；`popup.js:464-465` 是 `keywordInput` /
  `keepWatchingCheck` 唯一被读的地方，全文件没有第二处引用）
- 当前标签页已有任务时，弹窗不显示该任务的 `keywords` 与 `onHit`，也不显示它实际用的间隔。
  后果两条：用户看不到在盯什么、也改不了；只能停掉再重开，而重开时 `popup.js:464` 读的是空框，
  于是**原来那条关键词监控静默消失**。这是"看着像设置界面、实际是数据丢失入口"的形状。
- 改法：`refreshState` 之后若 `tasks[currentTab.id]` 存在，用 `getTaskKeywords`（已兼容旧单串）
  填关键词、用 `onHit === "continue"` 填复选框、回填间隔到 preset/custom。
  只在首次打开或 `currentTab` 变化时回填，别覆盖用户正在输入的内容。
- 验收：只能真机 + 弹窗 DOM 验，单测覆盖不到 popup。见 V1 (d)。

### A6 共享桩件偏离真实 Chrome，多条门禁实际空跑

思路（每新增一个 `addListener` 就会让手写桩件在 import 那步抛错）是对的，但有十处与真实行为不一致。
每修一处配一条红→绿对照，仓库里 `alarm-gate.test.mjs:226-228` 记的正是"断言看着有、实际空跑，
只有对照能抓出来"这个教训：

1. `storage.set` 无写日志（`harness:96-101`）。`prune-plan.test.mjs:250-258` 那条"什么都没要改时
   不写盘"比的是前后 JSON 相等，而 `set` 是 `Object.assign` 合并——写一份完全相同的内容也过。
   补 `calls.localSet` / `calls.syncSet`，断言改成写入次数为 0。
2. `alarms.getAll` 不带 `scheduledTime`（`harness:120-121`）。`background.js:302-324` 的 idle 重挂
   正是按 `scheduledTime` 判"已过期"，所以那整段在测试里永远走"没过期"分支，零覆盖。
3. `executeScript` 恒返回 `[{result:false}]`（`harness:186-189`），而 `opts.__fixture` 全仓库无人用
   （grep 只命中定义行）。后果：关键词命中分支（`background.js:688-703` → `onKeywordHit` 停任务/外发/
   回写 `notifiedKeys`）与验证墙暂停分支（`probeCaptcha` → `pauseTaskAuto`）端到端从未被执行过。
4. `env.send()` 只等 `sendResponse`，不看监听器返回值（`harness:249-253`）。`background.js:1736` 的
   `return true` 是异步应答契约，没有任何东西钉住；哪天被删，弹窗拿到 undefined，测试仍全绿。
5. i18n 回显键名（`harness:219-222`）。本身合理，但凡断言"文案里含站点名/关键词"都必须走 `subs`
   分支（现在的 `key:a,b` 形式恰好能过）。把这条写进文件头注释，别将来放宽。
6. `tabs.query` 忽略过滤（`harness:148-150`）：`{active:true, currentWindow:true}` 与 `{}` 同一批，
   依赖这两类过滤的路径都测不到。至少支持 `active` / `windowId`。
7. `contextMenus.onClicked: eventSink([])`（`harness:182`）没有登记表，测试无处派发，
   右键菜单起停任务（`background.js:1497-1512`）零覆盖。并进 `listeners`。
8. `cookies.getAll` 恒 `[]`（`harness:210-213`）：cookie 备份/恢复整套逻辑在 harness 下空跑。
   纯函数层由 `logic.test.mjs` 覆盖着，执行器层（`backupCookies` 的采集与冻结、`restoreCookies`
   的 `hostOnly` 分支）没有。
9. 没有 fetch 桩件：`postWebhook` / `postWechat` / 静默心跳三条外发链路一条都没被执行过。
10. `getLastFocused` 的建模反了，见 A1——这是本文件里唯一一处"与真实 Chrome 相反"的偏离，优先修。
11. 死表面：`fire.tabRemoved`、`fire.installed`、`__fixture` 三个入口无人调用。要么补用例要么删掉；
    留着比删掉更坏，因为它暗示"这条已经测了"。
12. 顺带同类：`keyword-inpage.test.mjs:99` 的"注入体不得引用模块作用域"用的是四个名字的枚举禁用表，
    将来任何新引用（`hostOf(`、`clipOneLine(` …）都能漏过去。改成扫标识符而不是列表黑名单。

## P2

### A7 `settings` 两条无锁读-改-写互相覆盖

- 位置：`background.js:587-601`（`rememberLastInterval`）、`background.js:1700-1706`（`save-settings`）
- 两处都是 `getSettings()` → `Object.assign({}, settings, 增量)` → `sync.set({ settings: 整份 })`，
  都没有走锁（`tasks` 有 `withTaskLock`，`settings` 没有）。点"开始"会走 `rememberLastInterval`，
  同一时刻切任何一个开关会走 `save-settings`，两条链各自读一份合并基座再整份写回，交错时后落地的
  把前一条刚改的值按旧值写回去——表现为"我明明勾了，它又自己弹回去"。
  `invalidateSettings()` 只保证读到最新落盘值，解决不了两个读-改-写之间的交错。
- 改法（对齐纪律 1）：`settings` 的读-改-写收进一个单飞串行队列（与 `withTaskLock` 同形状，
  另一把锁），只暴露 `patchSettings(partial)`。注意 `rememberLastInterval` 在 `startTask` 链路里，
  别挂进 `withTaskLock` 内造成互相等待。
- 验收：`settings-cache.test.mjs` 已钉住失效点契约，补"两个并发 patch 不互相覆盖"。

### A8 webhook 失败完全无痕，且没有与微信对等的"发送测试"

- 位置：`background.js:751-777`，对照 `886-949`（`postWechat` 有 `wechatLastResult`、`errorKey`、弹窗显示）
- `await fetch` 之后不看 `res.ok`（Discord webhook 过期、Slack 被踢都算成功）；不记录任何结果；
  弹窗只有微信有测试按钮。三条不对称，同一后果：用户以为"配好了、在发"。
- 改法：与微信同构——`{ok, status, errorKey, at}` 写 `chrome.storage.local` 的 `webhookLastResult`，
  弹窗复用 `wechatState` 那套显示；补 `webhook-test` 消息类型（`ignoreToggle` 语义同微信：
  只要求地址合法，不受事件勾选约束）。HTTP 状态分类放 `shared/logic.js` 做纯函数。

### A9 `onMessage` 不校验来源与设置键白名单

- 位置：`background.js:1674-1736`（分发全程不看 `sender`）
- MV3 下 `runtime.onMessage` 收不到网页消息，所以这不是"任意网页能调"的洞；但消息表里已有能写盘
  与外发的入口，两条值得收紧成代码约束：
  1. `save-settings` 把 `msg.settings` 整份合并（`1702-1704`），不做键白名单 → 只接受
     `DEFAULT_SETTINGS` 里存在的键，其余丢弃；
  2. `user-activity` 已经正确地只用 `sender.tab.id` 而忽略 msg 里的 id，这就是对的形状——
     给弹窗专用类型补"`sender.tab` 必须为空"的断言，把"内容脚本不能起停任务"写进代码。
- 验收：新增用例，由带 `sender.tab` 的来源发 `save-settings` / `start`，必须被拒。

## P3

### A10 语言包内部自相矛盾

- 位置：`tab-auto-refresh/_locales/zh_CN/messages.json`（en 同步检查同名键）
- 键齐平由 `scripts/validate.mjs` 守着（两边各 159 键、无未引用/无缺失），问题在内容打脸：
  1. `:127 wechatIntro` 说"一次拿到四项"，`:183 guideStep1Body2` 说"复制三项"；
  2. `:193 guideFixTemplate` 教用户用**英文冒号**，而 `:137/138`、`WECHAT_TEMPLATE_KEYS` 的注释、
     以及门禁 `verify-wechat-template-doc.mjs` 要求的是**中文冒号**。裸写或错写冒号的后果是平台
     整行丢弃变量而接口照旧返回 `errcode=0`，用户拿到空白卡片。第 2 条是错的教程，比数字不一致严重。
- 先确认真值（官方文档或实测），再统一文案，别按注释想当然。

### A11 弹窗文本框只在失焦保存；测试按钮无 finally

- 位置：`popup.js:487-506`、`popup.js:516-533`
- 文本框只绑 `change`：在 webhook/凭据框打完字直接点弹窗外关闭，文档销毁、`change` 不触发，
  这次输入整条丢失，重开是空的（`renderWebhookValidity` 也挂在 `change` 上，所以红字提示从没出现过）。
  改法：`input` 事件去抖保存（凭据框 400ms），并在 `visibilitychange → hidden` 时 flush 一次；
  校验提示随 `input` 走，非法地址一边打一边提示。
- `wechatTestBtn` 没有 `try/finally`：中途 await 抛错（SW 刚好回收）就永远停在 disabled + "发送中"，
  错误本身也被吞成"什么都没发生"。

### A12 SKIP 原因无痕；三处 `storage.local.get(null)` 全量扫描

1. `background.js:1245-1288`：`decideAlarmAction` 返回的 `reason` 只在 `action === STOP` 时被用掉，
   SKIP 的 `paused-all` / `user-active` / `discarded` / `auto-paused` 一律不留痕。用户看到"任务没在刷"
   只能靠猜，而 A1 那个误判正落在这里——不可见。改法：SKIP 时把最近一次 reason + 时间戳写会话态
   `rt:skip:<tabId>`（别写 local，那是每个刷新周期都要动的键），弹窗任务行显示一行原因。
2. `background.js:352-380`（两次）与 `1404`（一次）：备份上限 20 站 × 200 条，最坏一次读要反序列化
   几 MB 明文进 SW，只为拿键名做前缀过滤。注释里"get 不支持通配符，必须全量读取"是对的，但不是唯一解
   ——写备份时同步维护一个 `cookieBackupHosts` 索引键，清理只读索引。要带迁移：索引缺失时退回全量读
   并顺手建索引，**绝不能**把老用户的备份当无主数据清掉。

## 只能真机验（V1）

在 `chrome://extensions` 加载插件目录，按 `AGENTS.md` 验证清单第 5 条走一遍，本批新增三条：

- (c) 开着"尊重你的操作"，把某任务页设为所在窗口的活动页，然后把焦点切到别的应用，等 2~3 个刷新
  周期——它**必须照常刷新**（对应 A1）。
- (d) 给某页开一个带关键词的任务，关掉弹窗再打开，关键词框与"命中后继续盯守"要显示该任务的实际值；
  直接点"开始"（先停后起）不能把关键词弄丢（对应 A5）。
- (e) 在 webhook 框里打完字，不按 Tab、不点别处，直接点弹窗外关闭；重开弹窗内容要还在（对应 A11）。

既有缺口不变：开几个任务后重启浏览器或重新加载扩展，任务要全挂回原页面、不多开标签页、弹窗不卡住，
且 DevTools 背景页 Alarms 里 `refresh-<id>` 与 `hb-<id>` 同时存在（缺 `hb-` 说明心跳又被排到写盘前面）。

## 审计中推翻的结论（留档，避免被重新报一遍）

- "三处 `executeScript` 落在 MAIN world，保活脚本的 `chrome.runtime` 通道断了，页面可伪造活动"
  —— 假。`chrome.scripting.executeScript` 默认 `world: "ISOLATED"`，`content/keepalive.js` 的
  守卫与消息通道都在隔离世界正常可用。真实存在的只是相邻事实：合成事件带 `isTrusted: false`，
  站点看得见我们注入过。
- "`logic.test.mjs:294` 的 `hi >= 60000` 是恒真断言" —— 假。去掉 `pct` 上限夹取后 `hi` 会变 114000，
  这条会红，夹取实际是被钉住的。它只是范围宽，不是空跑。
- "`alarm-gate` 的焦点用例没做对照" —— 假，而且做过了（文件末尾第 4、5 处）。问题不在断言松，
  在桩件把 `getLastFocused` 建模反了，见 A1 / A6 第 10 条。
