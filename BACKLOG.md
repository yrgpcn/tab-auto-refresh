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
下一条动手是 A10。其余条目原样在账。

## 优先级一览

| 编号 | 优先级 | 一句话 | 状态 |
| --- | --- | --- | --- |
| A10 | P3 | 语言包内部自相矛盾（四项/三项、英文冒号/中文冒号） | 待做 |
| A11 | P3 | 弹窗文本框只在失焦保存；测试按钮无 finally | 待做 |
| A12 | P3 | SKIP 原因无痕；三处 `storage.local.get(null)` 全量扫描 | 待做 |
| V1 | — | 2.1.0 真机手工验证（含下面几条只能真机验的检查） | 待做 |
| E2 | — | `_code-review/` 门禁是否迁入入库路径 | 待定 |

建议动手顺序：A10 → A11 → A12。A6 排在最前面那条理由（要先有"能真的变红"的桩件）
已经兑现，A1~A9 九条都已移进 `CHANGELOG.md`；P2 及以上已经没有待做条目，剩下三条都是 P3。

## P3

### A10 语言包内部自相矛盾

- 位置：`tab-auto-refresh/_locales/zh_CN/messages.json`（en 同步检查同名键）
- 键齐平由 `scripts/validate.mjs` 守着（两边键数相同、无未引用/无缺失；具体数字每版都变，不抄在这里），问题在内容打脸：
  1. `wechatIntro` 说"一次拿到四项"，`guideStep1Body2` 说"复制三项"；
  2. `guideFixTemplate` 教用户用**英文冒号**，而 `wechatTplHint`、`wechatTplBody` 两条文案与
     `WECHAT_TEMPLATE_KEYS` 的注释、
     以及门禁 `verify-wechat-template-doc.mjs` 要求的是**中文冒号**。裸写或错写冒号的后果是平台
     整行丢弃变量而接口照旧返回 `errcode=0`，用户拿到空白卡片。第 2 条是错的教程，比数字不一致严重。
- 先确认真值（官方文档或实测），再统一文案，别按注释想当然。

### A11 弹窗文本框只在失焦保存；测试按钮无 finally

- 位置：`popup.js` 的 `init` 里三处绑定——`webhookUrlInput` 的 `change`、微信凭据四个输入框循环绑的
  `change`、`wechatTestBtn` 的 `click`
- 文本框只绑 `change`：在 webhook/凭据框打完字直接点弹窗外关闭，文档销毁、`change` 不触发，
  这次输入整条丢失，重开是空的（`renderWebhookValidity` 也挂在 `change` 上，所以红字提示从没出现过）。
  改法：`input` 事件去抖保存（凭据框 400ms），并在 `visibilitychange → hidden` 时 flush 一次；
  校验提示随 `input` 走，非法地址一边打一边提示。
- `wechatTestBtn` 没有 `try/finally`：中途 await 抛错（SW 刚好回收）就永远停在 disabled + "发送中"，
  错误本身也被吞成"什么都没发生"。

### A12 SKIP 原因无痕；三处 `storage.local.get(null)` 全量扫描

1. `background.js` 的 `onAlarm` 里套用 `decideAlarmAction` 结果的那一段：`reason` 只在 `action === STOP` 时被用掉，
   SKIP 的 `paused-all` / `user-active` / `discarded` / `auto-paused` 一律不留痕。用户看到"任务没在刷"
   只能靠猜，而 A1 那个误判正落在这里——不可见。改法：SKIP 时把最近一次 reason + 时间戳写会话态
   `rt:skip:<tabId>`（别写 local，那是每个刷新周期都要动的键），弹窗任务行显示一行原因。
2. 三处 `get(null)` 全量扫描：`pruneCookieBackups` 里两处（TTL 与站点额度各一次），
   `prune` 里 A2 新写的备份收敛读取一处。
   备份上限 20 站 × 200 条，最坏一次读要反序列化
   几 MB 明文进 SW，只为拿键名做前缀过滤。注释里"get 不支持通配符，必须全量读取"是对的，但不是唯一解
   ——写备份时同步维护一个 `cookieBackupHosts` 索引键，清理只读索引。要带迁移：索引缺失时退回全量读
   并顺手建索引，**绝不能**把老用户的备份当无主数据清掉。

## 只能真机验（V1）

在 `chrome://extensions` 加载插件目录，按 `AGENTS.md` 验证清单第 5 条走一遍，本批新增 (c)~(h) 六条：

- (c) 开着"尊重你的操作"，把某任务页设为所在窗口的活动页，然后把焦点切到别的应用，等 2~3 个刷新
  周期——它**必须照常刷新**（对应 A1）。
- (d) 给某页开一个带关键词的任务，关掉弹窗再打开，关键词框与"命中后继续盯守"要显示该任务的实际值；
  直接点"开始"（先停后起）不能把关键词弄丢。A5 已修，判据与调用顺序由 `popup-repopulate.test.mjs` 钉住，
  但"控件真的被填上了"这一步切片用例给不了。
- (e) 在 webhook 框里打完字，不按 Tab、不点别处，直接点弹窗外关闭；重开弹窗内容要还在（对应 A11）。
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
  控件齐备，"多出来这一行会不会把页面顶破"只有真机（或装回 playwright 后截图量一次）说得清

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
