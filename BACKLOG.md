# BACKLOG.md

待办清单，不是项目记忆。项目约定与"为什么这样设计"看 `AGENTS.md`，已发生的事看 `CHANGELOG.md`。

清单来源：2026-09-19 对 2.1.0 代码的一次从零审计（不采信文档结论，逐条对着源码确认）。
每条都带**源码位置**和**为什么现在测不出来**，因为这两样是动手时真正要用的信息；
修完任何一条，按 `alarm-gate.test.mjs` 与 `settings-cache.test.mjs` 末尾记的做法做一次红→绿对照，
"没有对照"就等于这条还没修。

维护方式：修完不删条目，整段移进 `CHANGELOG.md` 对应版本，本文件只留还在账上的。
新增条目同样要带源码位置，不接受"某处可能有问题"这种形状。

2026-09-19 三轮之后：A1（焦点三态）、A2（公共后缀越界采集）、A5（弹窗不回填任务级字段）、
A6（桩件十二条全部）、E1（本机 node 门禁）已修完并移进 `CHANGELOG.md` 的 `[未发布]`，编号不复用。
A6 第 8 条欠的 cookie 执行器用例随 A2 一起交付（`tests/tab-auto-refresh/cookie-backup.test.mjs` 13 条）；
A5 让 popup 第一次有了门禁（`popup-repopulate.test.mjs` 10 条，切源码跑）。下一条动手是 A7。其余条目原样在账。

## 优先级一览

| 编号 | 优先级 | 一句话 | 状态 |
| --- | --- | --- | --- |
| A3 | P1 | 关键词与验证墙检测只覆盖顶层框架 | 待做 |
| A4 | P1 | 外发载荷带完整 query 网址；凭据存 sync 且明文 | 待做 |
| A7 | P2 | `settings` 两条无锁读-改-写互相覆盖 | 待做 |
| A8 | P2 | webhook 失败无痕，且没有"发送测试" | 待做 |
| A9 | P2 | `onMessage` 不校验来源、设置键不做白名单 | 待做 |
| A10 | P3 | 语言包内部自相矛盾（四项/三项、英文冒号/中文冒号） | 待做 |
| A11 | P3 | 弹窗文本框只在失焦保存；测试按钮无 finally | 待做 |
| A12 | P3 | SKIP 原因无痕；三处 `storage.local.get(null)` 全量扫描 | 待做 |
| V1 | — | 2.1.0 真机手工验证（含下面三条只能真机验的检查） | 待做 |
| E2 | — | `_code-review/` 门禁是否迁入入库路径 | 待定 |

建议动手顺序：A7 → A9 → A3 → 其余。A6 排在最前面那条理由（要先有"能真的变红"的桩件）
已经兑现，A2、A5、A6 三条都已移进 `CHANGELOG.md`。

## P1

### A3 关键词与验证墙都只查顶层框架

- 位置：`background.js:675-679`（`matchInPage` 注入）、`background.js:1608-1626`（`probeCaptcha`）
- 两处 `executeScript` 都只给 `target: { tabId }`，没有 `allFrames`，只在顶层框架跑。
  有 <all_urls> 主机权限，跨源 iframe 一样能注入，所以现在检不到纯粹是没要。
- 不要盲目加 `allFrames: true`：
  1. 返回结构变成多框架数组，现在读的是 `results[0].result`（`background.js:680`、`1627`），
     关键词（返回数组）与验证墙（返回布尔）的聚合方式不一样；
  2. 个别框架注入失败会给 `undefined`，要按"取到几个算几个"处理，不能让一个失败吞掉整次判定；
  3. 验证墙侧防反向误判：正常页面的广告/统计 iframe 里出现 recaptcha 脚本不等于整页是墙。
     `probeCaptcha` 的判据刻意是"整页就是墙"（标题优先，见 1611-1615 注释），放宽判定面必须
     同时保住这一点——误判验证墙的代价是"卡在暂停态且不自愈"，与错误页能自愈不对称。
- 验收：`keyword-inpage.test.mjs` 只测函数体语义，覆盖不到框架聚合；多框架聚合要在执行器层新写单测。
  桩件已备好两条口子：`env.onScript((opts) => ...)` 按调用点改口返回多框架数组，
  `calls.executeScript` 记下每次的 `target` / `allFrames` 实参（注入面本身就是要断言的东西）。
  `detect-chain.test.mjs` 里已有用例在用这条通道，照它的形状写。

### A4 外发内容与凭据的暴露面

- 位置：`background.js:726-731`（keyword 命中载荷）、`1185-1190`（task-stopped）、
  `1669-1674`（task-paused）、`752-778`（webhook 本体）、
  `popup.js:341-368`（saveSettings）、`popup.html` 里 `webhookUrlInput` / `wechatSecretInput`
- 三件事：
  1. 载荷带完整 `task.url`。**三个**外发点各有 `url:` 字段（上面列的前三处），
     `session-lost` 只带 `host`，不在其列。只改关键词那一处等于留两个出口。
     `URL` 的 query 常含会话令牌、一次性签名、邮箱手机号（工单与后台系统
     尤其如此）。改成默认只发 `origin + pathname`（`urlKey` 已有实现）。**已定：不加开关，直接切**——
     精简版照样可跳转、可定位页面，而"带 query"这个选项等于长期留一个把令牌外发的入口。
     属纪律 3 范畴，CHANGELOG 要点名。
     外发点由 `outbound.test.mjs` 钉住，加一条"任意事件的载荷里不得出现 query"的断言比逐处改更有效。
  2. 关键词命中的 `text` 就是把用户监控的字面发给外部端点。这是用户主动配的，可接受，
     但 README 外发一节要点名（现在只说"通知内容会发出去"）。
  3. `webhookUrl` 与微信 appsecret 存在 `settings`（即 `chrome.storage.sync`），随 Google 账号
     漫游到其它桌面 Chrome 且明文。README 说明了微信凭据同步，**没提 webhook 地址本身也是凭据**
     （带 token 的 URL 拿到就能发）。另外 appsecret 输入框是 `type="text"`，旁边有人就能看到——
     改 `type="password"`。

## P2

### A7 `settings` 两条无锁读-改-写互相覆盖

- 位置：`background.js:588-602`（`rememberLastInterval`）、`background.js:1719-1731`（`save-settings`）
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

- 位置：`background.js:752-778`，对照 `887-953`（`postWechat` 有 `wechatLastResult`、`errorKey`、弹窗显示）
- `await fetch` 之后不看 `res.ok`（Discord webhook 过期、Slack 被踢都算成功）；不记录任何结果；
  弹窗只有微信有测试按钮。三条不对称，同一后果：用户以为"配好了、在发"。
- 改法：与微信同构——`{ok, status, errorKey, at}` 写 `chrome.storage.local` 的 `webhookLastResult`，
  弹窗复用 `wechatState` 那套显示；补 `webhook-test` 消息类型（`ignoreToggle` 语义同微信：
  只要求地址合法，不受事件勾选约束）。HTTP 状态分类放 `shared/logic.js` 做纯函数。

### A9 `onMessage` 不校验来源与设置键白名单

- 位置：`background.js:1699-1761`（分发全程不看 `sender`）
- MV3 下 `runtime.onMessage` 收不到网页消息，所以这不是"任意网页能调"的洞；但消息表里已有能写盘
  与外发的入口，两条值得收紧成代码约束：
  1. `save-settings` 把 `msg.settings` 整份合并（`1726-1729`），不做键白名单 → 只接受
     `DEFAULT_SETTINGS` 里存在的键，其余丢弃；
  2. `user-activity`（`1739-1743`）已经正确地只用 `sender.tab.id` 而忽略 msg 里的 id，这就是对的形状——
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

1. `background.js:1279-1299`：`decideAlarmAction` 返回的 `reason` 只在 `action === STOP` 时被用掉，
   SKIP 的 `paused-all` / `user-active` / `discarded` / `auto-paused` 一律不留痕。用户看到"任务没在刷"
   只能靠猜，而 A1 那个误判正落在这里——不可见。改法：SKIP 时把最近一次 reason + 时间戳写会话态
   `rt:skip:<tabId>`（别写 local，那是每个刷新周期都要动的键），弹窗任务行显示一行原因。
2. `background.js:361` 与 `367`（同在 `pruneCookieBackups`）与 `1416`（`prune` 里 A2 新写的备份收敛读取）：
   备份上限 20 站 × 200 条，最坏一次读要反序列化
   几 MB 明文进 SW，只为拿键名做前缀过滤。注释里"get 不支持通配符，必须全量读取"是对的，但不是唯一解
   ——写备份时同步维护一个 `cookieBackupHosts` 索引键，清理只读索引。要带迁移：索引缺失时退回全量读
   并顺手建索引，**绝不能**把老用户的备份当无主数据清掉。

## 只能真机验（V1）

在 `chrome://extensions` 加载插件目录，按 `AGENTS.md` 验证清单第 5 条走一遍，本批新增三条：

- (c) 开着"尊重你的操作"，把某任务页设为所在窗口的活动页，然后把焦点切到别的应用，等 2~3 个刷新
  周期——它**必须照常刷新**（对应 A1）。
- (d) 给某页开一个带关键词的任务，关掉弹窗再打开，关键词框与"命中后继续盯守"要显示该任务的实际值；
  直接点"开始"（先停后起）不能把关键词弄丢。A5 已修，判据与调用顺序由 `popup-repopulate.test.mjs` 钉住，
  但"控件真的被填上了"这一步切片用例给不了。
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
  在桩件把 `getLastFocused` 建模反了。对应条目已修完移进 `CHANGELOG.md` 的 `[未发布]`。
