# BACKLOG.md

待办清单，不是项目记忆。项目约定与"为什么这样设计"看 `AGENTS.md`，已发生的事看 `CHANGELOG.md`。

清单来源：2026-09-19 对 2.1.0 代码的一次从零审计（不采信文档结论，逐条对着源码确认）。
每条都带**源码位置**和**为什么现在测不出来**，因为这两样是动手时真正要用的信息；
修完任何一条，按 `alarm-gate.test.mjs` 与 `settings-cache.test.mjs` 末尾记的做法做一次红→绿对照，
"没有对照"就等于这条还没修。

维护方式：修完不删条目，整段移进 `CHANGELOG.md` 对应版本，本文件只留还在账上的。
新增条目同样要带源码位置，不接受"某处可能有问题"这种形状。
源码位置一律写符号名（函数名、消息类型、存储键）而不写行号——行号每动一轮就漂一次，
2026-09-19 的 A7 那轮之后，本文件所有位置已统一改成符号名。

2026-09-19 当日累计：A1（焦点三态）、A2（公共后缀越界采集）、A3（检测只覆盖顶层框架）、
A4（外发载荷带 query、凭据暴露面）、A5（弹窗不回填任务级字段）、A6（桩件十二条全部）、
A7（`settings` 两条无锁读-改-写互相覆盖）、A8（webhook 失败无痕、没有"发送测试"）、
A9（`onMessage` 不认来源、设置键无白名单）、E1（本机 node 门禁）已修完并移进 `CHANGELOG.md`
的 `[未发布]`，编号不复用。
A6 第 8 条欠的 cookie 执行器用例随 A2 一起交付（`tests/tab-auto-refresh/cookie-backup.test.mjs` 13 条）；
A5 让 popup 第一次有了门禁（`popup-repopulate.test.mjs` 10 条，切源码跑）；
A7 给 `settings-cache.test.mjs` 补了 4 条（并发覆盖、读前失效、锁方向、锁内"没变就不写"）；
A9 新增 `message-gate.test.mjs` 9 条（来源守卫逐类型、零副作用指纹、白名单端到端与纯函数、两条扫源码）；
A3 新增 `frame-scan.test.mjs` 27 条（多框架聚合与逐框架判定的纯函数层、切 `captchaProbe` 真实源码跑的
注入体层、两层接缝、执行器接线），并改动了 `detect-chain.test.mjs` 的验证墙桩件形状（布尔 → 事实对象）；
A4 剪枝落在 `notifyOut` 一处（不是三个调用点），`outbound.test.mjs` 补 4 条事件级用例并把全文件通用的
任务网址换成带令牌的形状、`logic.test.mjs` 补 `outboundUrl` 1 条、`popup-repopulate.test.mjs` 补 1 条
扫 `popup.html` 的守卫，七处对照记在两个文件末尾。
A8 两个出口对齐：`outbound.test.mjs` 补 10 条（留痕形状、覆盖、正文里的拒绝、逐码归桶、不留痕的两种、
两出口互不干扰、"发送测试"的边界）、`logic.test.mjs` 补 5 条 `webhookResultOf` 纯函数用例、
`popup-repopulate.test.mjs` 补 10 条（切 `renderWebhook` 真实源码 + 扫 `popup.html` 控件与 `popup.css` 颜色类）、
`message-gate.test.mjs` 补 1 条反向登记守卫（分发链每条弹窗专用分支都必须在 `POPUP_ONLY` 里），
23 处对照记在这四个文件末尾，其中两处第一次跑是绿的、补了输入形状才红。
A10 是纯文案改动：中英两份各 6 个键统一到"页面抄三项 + 建模板得第四项"，`wechatErrTemplate` 的
示范补上「关键词：中文冒号」前缀，`guideFixTemplate` 那条未实测的"换成英文冒号"兜底建议被删掉；
新增 `wechat-copy.test.mjs` 12 条（三条规则的数都从代码现推），18 处对照里 17 红、1 处是
"改一条守卫不该管的文案必须仍绿"的反向对照，其中 K10 第一次跑是绿的（英文句子没被当子句边界）。
A11 改的是弹窗侧的写盘时机：五个走 settings 的文本框从"只绑 change"换成 input 去抖 500ms +
change 即时 + 关窗补一次，微信「发送测试」补上 `try/finally`；新增 `popup-save-timing.test.mjs`
16 条（四个函数接假时钟与写盘计数器真跑），19 处对照 17 红 + 2 反向绿。有一处限制记在那个文件末尾：
"去抖时长改成 0"只有常量守卫抓得到，行为用例全绿（0 毫秒的 setTimeout 仍然推迟一拍）。
A12 两条一起交付。第 1 条：SKIP 的四种理由连同时间戳写进会话态 `rt:skip:<tabId>`，弹窗任务行显示
"上一次到点被跳过：某原因"，采集四条而显示两条（全局暂停与自动暂停行内已有角标，时间戳进 `title`
以保住 400×600 预算）；新增 `skip-trace.test.mjs` 20 条，22 处对照 19 红 + 3 反向绿。
第 2 条：备份读出 `cookieBackupHosts` 索引，三处 `get(null)` 换成"索引在位就定向读、缺失才退回
一次全量读并顺手补建"，判据抽成 `planBackupFetch` / `planBackupIndex` 两个纯函数；
`logic.test.mjs` +5、`cookie-backup.test.mjs` +6，14 处对照 11 红 + 3 反向绿，另有一处对照**零红**，
据此删掉了 `prune()` 收敛处那句摘索引的写（同一次启动末尾的清理必然再对一次账，改坏也没有症状）。
A 系列第一批十二条至此清账；当天在其后又跑了两轮审计，新增条目与它们的结案叙述都在下面的表与表后段落里。

## 优先级一览

| 编号 | 优先级 | 一句话 | 状态 |
| --- | --- | --- | --- |
| A15 | P2 | `startTask` 在任务锁里等外发，任务已落盘却没有 alarm | 待做 |
| A16 | P2 | 弹窗一打开就把会话恢复还没到位的任务静默停掉 | 待做 |
| A17 | P3 | 连击计数跨任务生命周期存活（重开标签页、重新开始任务、关再开验证墙开关） | 待做 |
| A18 | P2 | 弹窗的 settings 回流只重绘任务区，控件与二级视图停在打开那一刻，下一次保存整份写回会撤回对面设备的改动 | 待做 |
| A19 | P3 | `renderWechat` 与 `fmtClock` 在全套门禁里一次也没被执行过（改坏零红） | 待做 |
| V1 | — | 2.1.0 真机手工验证（含下面几条只能真机验的检查） | 待做 |
| E2 | — | `_code-review/` 门禁是否迁入入库路径（A10 已照此把 `verify-wechat-template-doc` 换成入库的 `wechat-copy.test.mjs`，剩下的按这个形状挑） | 待定 |
| E3 | — | 桩件缺 `chrome.power` 与 Promise 型 `fetch` 两块记录面，两类 bug 结构上测不出来 | 待做 |

A1~A12 十二条全部移进 `CHANGELOG.md`。2026-09-19 当天在 A12 落地之后的代码上又跑了一轮审计（同样不采信文档、
逐条对着源码确认，怀疑点用真 `background.js` + 共享桩件跑出来，或按红→绿对照做变异），新增 A13~A17 与 E3；
之后另有一趟面向弹窗与外发链路的审计，报回来的每一条都由本仓库自己重跑过变异再记账，收下 A18~A19、
否掉三条（那三条记在 A19 末尾，别被同一份报告再报一遍）。

A13（A12 第 2 条自己引入的回归）当日结案，走的是"不引入第二个真相来源"那一支：`cookieBackupHosts` 连同
`planBackupFetch` / `planBackupIndex` 一并删除，存档枚举只剩 `readBackupEntries()` 这一次 `get(null)`，
一趟启动的全量读从三次并成两次。判据落在用例里而不是注释里：6 条索引用例换成 5 条"先造清单外的孤儿、
再证明它被删掉"（启动 / 关开关 / 停任务三条路径 + 一条扫源码的守卫，因为"登记写回"没有读侧症状）。
变异对照 5 处：把删除依据换回清单可红 9 条（同一天上午这批门禁对着这个方向是一条都不红地全绿），
前缀过滤可红 15 条，关闭开关只查不删可红 2 条，登记写回只红源码扫描那一条；三处反向绿。
另有一处**零红**并如实记下：恢复侧只枚举被监控根域——不在根域里的存档既不会被恢复、下游也必然被清理删掉，
两个分支同结果，与上一批的 P8 同类，不为此改代码也不为此补断言。

A14 同日结案，走的是"登录页不参与改写"那一支：`task.url` 的语义定死为**用户指定的监控对象**，
判据抽成 `shared/logic.js` 的纯函数 `shouldAdoptTaskUrl(taskUrl, tabUrl)`（同站 **且** 新地址不是登录页才跟随），
`refreshTaskUrl` 只剩执行。没有另加"用户填的原始目标"字段——多一个键就多一处要跟 `prune` 的
挂接/重映射/补记对齐的地方，而"监控对象永不完全等于登录页"这一条本身就堵死了自指。
门禁的现场形状是这次的关键：页面**停在** `/login`、`complete` 事件不带 `url`，后台只能从 `tabs.get` 读到；
原先那条行为通道用例给的是 `changeInfo.url` 带地址、标签页仍停在业务页，正好绕开自指。
新增 `tests/tab-auto-refresh/task-url.test.mjs` 4 条 + `logic.test.mjs` 1 条纯函数表。
对照 7 处在仓库外整份副本上实跑（副本里 `tests/` 与 `tab-auto-refresh/` 同级，一次改坏纯函数与 e2e 两头都看得见）：
改回 A14 之前的形状红 2、去掉同站约束红 2、改过头成"永不跟随"红 2、确认窗口降成 1 次红 2、
去掉"网址没变就不写盘"红 1、畸形网址放行红 1，另有一处不在这条路上的对照只红在既有用例上。零红的一条也没有。
已受损记录（旧版本已经改写成 `/login` 的任务）不需要迁移：用户登录成功、页面离开登录路径的那一刻就跟随更新回去，
这条有专门用例盯着。残余边界如实记下——用户从此不再登录，任务就一直监控着那张登录页，
行为通道对它照旧豁免（那是"用户故意监控登录页"该有的语义，不为它加特例）。

## P2

### A15 `startTask` 在任务锁里等外发；这段时间任务已落盘却没有 alarm

- 位置：`startTask` → `withTaskLock` → `setTasks` → `backupCookies` → `notifySessionLost` →
  `notifyOut`/`postWebhook`/`postWechat`，之后才是 `armRefresh` / `ensureHeartbeat`
- 症状：开了"cookie 备份 + webhook（或微信）"、且这一拍恰好确认掉线的用户点「开始」之后：`tasks` 里已经有
  这条任务，`refresh-<id>` 与 `hb-<id>` 一条都没建，弹窗按钮卡在"开始"上，**其它标签页的起停全排在同一把锁后面**。
  外发是 fetch，15 秒超时，微信还要多取一次令牌，最坏几十秒。MV3 的 SW 若在等待中被回收，就留下
  `AGENTS.md` 里那句"任务在、永不刷新"的僵尸
- 实测：把 `globalThis.fetch` 换成永不 resolve 的桩（必须在 `bootBackground` 之后覆盖，桩件安装时会替换它）→
  `start(7)` 与另一家站点的 `start(9)` 同时 PENDING，`calls.alarmsCreated` 为空，而 `tasks` 已是 `["7"]`
- 为什么测不出来：桩件的 `fetch` 从不返回 Promise（见 E3），`outbound.test.mjs` 判的是请求形状与留痕，
  不看"锁是不是压在网络上面"
- 改法方向：把外发挪出任务锁（`setTasks` 之后与 alarm 一起收尾，或在锁外 `await` 一条独立事件队列）；
  `armRefresh` / `ensureHeartbeat` 排在任何可失败的等待之前——这与 `prune` 里"先写盘再挂心跳"是同一条纪律的另一半。
  **别顺手把 `await notifyOut` 改成裸甩**，那正是它当初被 await 的理由（SW 回收会截断）

### A16 弹窗一打开就把"会话恢复还没到位"的任务静默停掉

- 位置：`cleanupInvalidTasks`（消息类型 `prune-now`，`popup.js` 每次打开弹窗都发一次）、`stopTask`
- 症状：浏览器重启后立刻点弹窗。`chrome.tabs.get(tabId)` 对还没恢复出来的标签页会报错 → 每条这样的任务被
  `stopTask` 删掉、两条 alarm 清掉，**没有任何通知**（走的是 `stopTask` 而不是 `stopTaskWithNotice`）。
  同一时刻并跑的 `prune` 正因为知道"恢复会晚到"才先等 1500ms、再给未认领任务共享 20 秒窗口——
  两个函数对同一件事的假设正好相反
- 实测：`tasks:{7:…}` 而桩件里没有该标签页 → 发 `prune-now` → `tasks` 变 `{}`、`alarmsCleared` 是
  `["refresh-7","hb-7"]`、`notifCreated` 为空
- 为什么测不出来：`message-gate.test.mjs` 只把 `prune-now` 当消息白名单里的一个 token 过了一遍，
  没有一条用例叫得出 `cleanupInvalidTasks`
- 改法方向：把"标签页不存在"与"会话恢复还没到"分成两种判据（启动后一段时间内不删，或干脆交给 `planPrune`
  的认领窗口统一收尾）；真删的时候要通知——静默消失是这类 bug 里最难被用户报告的一种

### A18 弹窗的 settings 回流只重绘任务区；下一次保存按打开那一刻的 DOM 整份写回

- 位置：`popup.js` 的 `storage.onChanged` 监听（758-771）里 `changes.settings` 那一支、`saveSettings()`
  （已确认它把 15 个键全部从 DOM 现值拼成整份对象发出）、`background.js` 的 `save-settings` 处理
  （`chrome.storage.sync.set({ settings: msg.settings })`，整份覆盖，注释写明"不做陈旧读"）
- 症状：控件与二级视图的显隐只在 `init()` 里按当时的 settings 填过一次，`settings` 回流只走
  `refreshState()` + `renderAll()`，而 `renderAll` = `renderCurrentTab` + `renderTasks` + `renderCountdowns`，
  一个字都不碰设置区。于是弹窗显示的是打开那一刻的开关状态；用户在这个弹窗里点任意一个开关，
  `saveSettings` 就把那 15 个键按旧 DOM 整份写回，把对面设备改掉的那几键撤回
- 最坏的一格是凭据：B 设备刚在微信页填完 appID/appsecret/openid/模板 ID，A 设备上一个更早打开的
  弹窗里这四个框还是空的，此时在 A 随手勾一下"绕过缓存"→ B 的凭据整份被抹，而且没有任何提示，
  下一次推送才会以"凭据不全"的形式露出来
- 同一个监听器在 760-767 行**确实**为 `wechatLastResult` / `webhookLastResult` 各重绘了一次状态行，
  所以缺的不是能力，是 `settings` 那一支没做同样的事
- 为什么测不出来：弹窗侧的门禁（`popup-repopulate` / `popup-save-timing` / `skip-trace`）都是切片调用单个函数，
  没有任何一条把"外部写进来一笔 settings 变化"喂给监听器；`settings-cache.test.mjs` 的
  "另一台设备写的，不派发 onChanged"钉的是**后台**的快照失效，两头各管半边，中间这条链没人接
- 改法方向：`changes.settings` 到达时把控件按新值同步一遍（含 `body.wx-mode` 的显隐与两行状态）。
  两条约束：① 不许吃掉用户正在输入的字——`webhookUrl` 与微信四个框在获得焦点、或有去抖写盘还挂在路上时
  一律跳过（A11 的 `input` 去抖就是为了不抹输入，两者不能互相打架）；② 别顺手改成"弹窗只发差异键"，
  `save-settings` 的整份覆盖是有意的（后台那条注释），要动就得连 `patchSettings` 的锁方向一起重新论证
- 触发要两台桌面 Chrome 登录同一账号、且弹窗一直开着。本机复现不了，能复现的是那条监听器用例：
  喂一次 `changes.settings`，断言十个复选框与四个凭据框跟着变

## P3

### A17 连击计数跨任务生命周期存活：重开标签页与重新开始任务都不清零

- 位置：`reopenTaskTab`（搬 tabId，不清 `rt:captcha|error|activity|skip:<旧 id>`）、`startTask`（清三条通知
  却不清 `rt:*`）、`probeCaptcha`（`captchaGuard` 关闭时在复位那一行之前就 `return`）
- 症状三则：① 用户在同一标签页上停掉再开始任务，上一轮 `rt:captcha` 连击还在，验证墙只需 1 次命中就自动暂停
  （本该 3 次），错误页同理（2 次变 1 次）；② 关掉"验证墙保护"再打开，中途残留的连击照样生效，用户以为开关
  复位了；③ `reopenTaskTab` 之后旧 id 的整批 `rt:*` 留在会话态，同一浏览器会话里反复重开会持续累积
  （tabId 在会话内不回收，所以 ③ 只是脏数据，不是误判）
- 实测：`rt:captcha:7=2`、`rt:error:7=1`、`rt:skip:7` 就位后 `env.fire.tabRemoved(7)` → 任务搬到 101、
  `refresh-7`/`hb-7` 被清，四条 `rt:*:7` 一条不少；此时全套门禁全绿（那是 A13 之前的 330 条）
- 为什么测不出来：没有一条断言扫过 `storage.session` 的键集合；`tab-removed.test.mjs` 钉的是"任务搬过去、
  alarm 重挂"，没往会话态里看
- 改法方向：`rt:*` 的清理时机与 `stopTask` 对齐（凡是把任务搬离一个 id、或在同一 id 上重新开始，
  都按 `stopTask` 那份清单清一遍）；`captchaGuard` 关闭时也要先复位计数再返回

### A19 `renderWechat` 与 `fmtClock` 在门禁里一次也没被执行过

- 位置：`tab-auto-refresh/popup.js` 的 `renderWechat()`（564）、`fmtClock()`（78）；
  见证用例在 `popup-repopulate.test.mjs`（172 起切的是 `renderWebhook`）与 `skip-trace.test.mjs`（243、267）
- 实测（整仓副本 + `TAR_POPUP_SRC` 指向副本 popup.js，每轮只改坏一处，跑全套 324 条）：
  - `function renderWechat() { return; ... }` → **零红**，324 条全绿
  - `function fmtClock(ms) { return ""; ... }` → **零红**，324 条全绿
  - 同一套跑法下 `function renderWebhook() { return; ... }` → 红 1 条（"渲染空跑守卫：状态文字确实被
    renderWebhook 写进元素"）。这条对照是判读前提：它证明重定向与改坏都真的生效了，上面两个零红不是没跑成
- `skip-trace.test.mjs` 有 9 条用例名字里带 `fmtClock`，但它们把 `fmtClock` 当**形参**注进去，
  给的是 `const clock = (ms) => "T" + ms`（243 行）——测的是"时刻有没有传到 `title` 这一路"，
  真实那个函数的补零与本地时区一次也没被调用过。名字容易让人以为这块有门禁
- 为什么是这两处：`renderWechat` 与 `renderWebhook` 是一对（微信/webhook 各自的状态行），
  后者有显式空跑守卫，前者没有；`fmtClock` 是 A12 第 1 条新引进的显示件，当时的 22 处对照
  全部打在"选哪个文案键、代入顺序对不对"上，没有一处打在时刻本身
- 改法方向：`popup-repopulate.test.mjs` 已经在切 `renderWebhook`，照同一段形状给 `renderWechat`
  补一条空跑守卫加两三条状态判据（未启用 → 整行藏起来；凭据不全 → 报缺失；配置齐 → 报后台最近一次结果）；
  `fmtClock` 补纯函数用例，喂固定时刻钉住补零与"只取时分"。两处都属于"改了不会红"的欠账，
  不是当下有 bug：今天这两个函数的实现都是对的
- 同一批探针顺手排掉的三个假警报（记下来免得再报一遍）：`sortTasks` 这个函数**根本不存在**；
  `getTaskKeywords` 丢掉旧单串 `keyword` 的兼容读 → 红 2 条（有门禁）；`looksLikeLoginPage` 恒返回 false →
  红 4 条，其中一条是 `outbound.test.mjs` 的"两个出口一共只发出 0 笔，下面的断言会空跑"

## 工程账（E）

### E3 桩件缺两块记录面，有几类 bug 结构上测不出来

- `tests/helpers/background-harness.mjs` 的 `power` 是两个空函数、没有调用日志，于是 `applyKeepAwake` 的
  "持锁标记靠 `rt:awake` 兜底、一个 SW 生命周期最多 request 一次"写不出用例（`AGENTS.md` 说 power 锁的收敛
  挂在 `updateBadge`，这条链目前只能靠读代码相信）。补齐形状与 `calls.alarmsCleared` 同形：记
  `requestKeepAwake` / `releaseKeepAwake` 的调用序列
- `fetch` 桩不 await Promise 型应答，所以"外发挂住时后台正在做什么"（A15）在现有桩件下永远测不出来。
  `env.onFetch` 要允许返回一个由测试握着的 promise（配合"永不 resolve"与"到点 resolve"两种现场）
- 两条都是先补面、再谈各自那条链的判据；补面时要连带记一句"哪几条门禁因此从空跑变成真跑"

## 只能真机验（V1）

在 `chrome://extensions` 加载插件目录，按 `AGENTS.md` 验证清单第 5 条走一遍，本批新增 (c)~(j) 八条：

- (c) 开着"尊重你的操作"，把某任务页设为所在窗口的活动页，然后把焦点切到别的应用，等 2~3 个刷新
  周期——它**必须照常刷新**（对应 A1）。
- (d) 给某页开一个带关键词的任务，关掉弹窗再打开，关键词框与"命中后继续盯守"要显示该任务的实际值；
  直接点"开始"（先停后起）不能把关键词弄丢。A5 已修，判据与调用顺序由 `popup-repopulate.test.mjs` 钉住，
  但"控件真的被填上了"这一步切片用例给不了。
- (e) 在 webhook 框里打完字，不按 Tab、不点别处，直接点弹窗外关闭；重开弹窗内容要还在（对应 A11）。
  A11 之后这条从"必然丢"变成"多半救得回来"：`input` 去抖 500ms 已经写了一笔，关窗时 `pagehide` /
  `visibilitychange → hidden` 各补一次，而那两笔发生在文档正在销毁的路上，`sendMessage` 不保证赶得上。
  所以要验的是**残留窗口**：打完立刻点外（不到 0.5 秒）重开在不在，停一下再点外在不在。
  判据与"没有待写就不白写"由 `popup-save-timing.test.mjs` 钉住，"这一笔赶不赶得上"只有真机说得清。
  顺带两个五秒的检查，都属同一条：非法地址一边打一边出红字（修前要等失焦，等于从没出现过）；
  凭据填缺时点微信「发送测试」，报错之后按钮要能退回"发送测试"，而不是永远停在"发送中"
- (f) 多框架检测（对应 A3）：找一个整页挑战嵌在 iframe 里的站点（顶层只剩空壳标题那种），
  开任务后等 3 个加载周期，要被自动暂停、角标变 `⚠`；反过来，页面上只有一个验证挂件
  （reCAPTCHA / hCaptcha 那种小框）的正常页面**不该**被暂停。切片用例给不了这两条，
  它要的框架尺寸与自身网址都得是真实 iframe 才作数
- (g) 给一个**前端哈希路由**的页面（网址长这样：`https://x.test/#/orders/42?tab=1`）开任务并收到
  外发通知，点开微信卡片或 webhook 里的链接：A4 把 query 与 hash 一起剪掉了，落点会是
  `https://x.test/` 即应用根，而不是 `#/orders/42` 那一页。剪枝的收益（一次性令牌不出机器）
  由 `outbound.test.mjs` 钉住了，"落点还是不是用户要找的那一页"只有真机说得清。
  要验的是这件事对日常使用到底碍不碍事——不碍事就维持现状，碍事再谈怎么在不回吐 query
  的前提下把深链带上（记在 `CHANGELOG.md` 的 A4 那条里）
- (h) 在 webhook 框里填一个合法地址，弹窗要多出"发送测试 + 状态"那一行（A8）。要看的是**弹窗仍然不出
  现滚动条**：设置卡片本就贴着 600px 外框上限，这一行只在填了地址时出现、约 10px。本机没有 playwright，
  `scripts/screenshot-popup.mjs` 跑不了，量不了整页高度；`popup-repopulate.test.mjs` 钉的是显隐判据与
  控件齐备，"多出来这一行会不会把页面顶破"只有真机（或装回 playwright 后截图量一次）说得清。
  A10 之后同一处要看第二遍：微信配置二级视图的 `wechatIntro` 中英都改长了一点（来源从"页面给四项"
  纠正成"页面三项 + 建模板得第四项"），那个视图同样贴着上限
- (i) 中文冒号到底是必需还是仅仅充分（对应 A10）。本仓库从没实测过：依据只有 2.0.0 当时的调查记录
  加官方文档示例的写法。A10 的处理是不让教程为一个未证的备选写法留"换成英文冒号再试"这种兜底——
  照它做等于把唯一合规的写法改掉。真要结案得有微信测试号：按「标题：{{title.DATA}}」「内容：{{content.DATA}}」
  两行建模板，只把中文冒号换成英文 `:` 再发一次，看卡片是空白还是照旧渲染
  - 英文冒号也认 → `guideStep2Why` 的"微信只认「关键词：{{变量}}」"说过头了，改成"要有关键词加冒号，
    中英两种都收"，同时把 `wechat-copy.test.mjs` 的"只教一种冒号"放宽
  - 英文冒号不认 → 现状即正确，这条从 `BACKLOG.md` 删掉
  那条冒号守卫钉的是"教程口径唯一"，钉不了平台行为，别把它当成已验
- (j) 跳过痕迹与备份索引迁移（对应 A12）。两半都是切片用例给不了的现场：
  ① 开着"尊重你的操作"，把某任务页摆在当前窗口前台等它到点，任务行末要出现"· 上次跳过：你在操作"，
    鼠标停上去要带那一刻的时间；再分别看全局暂停与自动暂停这两种情形，这一行**不该**出现
    （行内已有角标与状态文字）。顺带看一眼弹窗仍不出滚动条——窄屏字体放大时最容易顶破
  ② 从 2.1.0 升上来（或在 `chrome.storage.local` 里手动删掉 `cookieBackupHosts` 那一个键）
    且备份开关开着：重启扩展之后各站点原有备份必须**原样还在**，并且能看到补建出来的
    `cookieBackupHosts`；此后一次启动不再把整个 local 读回来。这一条错起来的表现是"重启后不再恢复登录"，
    是丢数据不是变慢，而升级路径在真机上只走一次，值得亲眼看一遍

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
  在桩件把 `getLastFocused` 建模反了。对应条目已修完移进 `CHANGELOG.md` 的 `[未发布]`。
