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
- `scripts/validate.mjs` 仓库级校验（JSON、manifest、语言包、JS 语法、引用完整性、插件目录无未跟踪文件）；`scripts/screenshot-popup.mjs` 一次渲染 README 那两张弹窗截图，需要 playwright，CI 不跑，它那份 chrome mock 与弹窗用面的对齐由 `tests/tab-auto-refresh/screenshot-mock.test.mjs` 守着（见验证清单第 4 条）；同一份脚本加 `--measure` 只量整页高度、一个字节图都不写（A28）
- 上面那条"引用完整性"的判据全在 `scripts/validate-refs.mjs`（八个纯提取器：`manifestMsgKeys` 深走整份
  manifest 收 `__MSG_key__`、`htmlLocalRefs` 收本地 `src`/`href`、`htmlI18nKeys` 收 `data-i18n*` 三条通道、
  `jsMessageKeys` 只收 `getMessage` 的第一个实参、`i18nAliases` 现推别名包装、`stringLiterals` 收单双引号
  字面量给反向判据用，另有 `localePlaceholderFacts` 与 `jsMessageCalls` 一对给位数判据用），`validate.mjs`
  只剩遍历与报账。纪律 1 在工具上同样成立的理由是"正则要有单测"：
  执行器没有 fixture 也没有 DOM，能判的那一半必须能单独 import。门禁 `tests/tab-auto-refresh/validate-refs.test.mjs`
  （28 条，含五条通道与位数各自的数量下限——下限只挡"对着空集合绿过去"），末尾记着 41 处对照的落点，
  以及一处真实假报警的成因（三元条件里的 `"captcha"` 是拿去比值的、不是键，故 `jsMessageKeys` 先切分支）
- 语言包键的取用有**两条写法，判据两条都要走**：直调 `chrome.i18n.getMessage("键")`，或经包装函数
  `msg("键")`（popup.js 是 `function msg(key, subs)`，wechat-setup.js 是 `const msg = (key) => ...`）。
  别名名**不写死在表里**，由 `i18nAliases` 从源码现推（判据：谁把自己的入参原样递给 `getMessage`），
  所以改名与新增包装自动跟上；写死表就是第二份真相来源，包装改名时那条通道会静默退回零覆盖。
  **别名只在本文件内推导**：包装定义在 `shared/logic.js` 这类共享模块里、由别的页面 import 过去用的，
  判据看不见（现有两处都是同文件定义同文件调用）。A26 之前只有直调那半边有正向判据，于是
  `msg()` 传一个语言包里根本没有的键会一路 exit 0 过 CI：正向看不见别名，反向只查"语言包里的键有没有
  人提到"，而那条键压根不在语言包里，没有账可查
- 占位符的**位数**是"键在不在"之外的另一根轴（A27）：语言包那侧由 `localePlaceholderFacts` 量——
  消息里写的具名占位符必须在 `placeholders` 里声明（没声明的就原样进界面），声明了却没引用的
  也算坏（填进去的值无处可去）；调用点那侧由 `jsMessageCalls` 量——只认整个第一个实参是字面量的
  调用，数组字面量数顶层逗号，实参写成变量或用展开的一律回"判不了"、不比对。`validate.mjs` 三处
  对账：每份语言包自己自洽、两份的位数齐平、字面键调用点对得上；另外 manifest 的 `__MSG_key__`
  与 `data-i18n*` 两条通道**没有传参面**，用了要传参的键就点名。**新增要填占位符的文案时，
  两份语言包的 `placeholders` 与调用点实参个数得一起改**，漏哪一头 CI 会说出是哪一处
- 语言包键的**取用通道**不止调用点那一处（A33）。键名还住在表里（`ALARM_SKIP_REASONS`、
  `ALARM_SKIP_UNKNOWN_KEY`、`WECHAT_ERROR_KEYS`、`WEBHOOK_STATUS_BUCKETS`、`PRESETS`、
  `WECHAT_EVENT_TITLE_KEYS`、`WECHAT_BODY_KEYS`、`WECHAT_FIELD_LABEL_KEYS`）和 `errorKey`
  这类属性值里，取用时递的是变量而不是字面量，于是 validate 的正向一条都看不见它们；反向按
  "提到过"查，只能挡住"改坏之后旧键成了孤儿"那一半 —— 旧键在别处还被提及时，
  **表值拼错或改到同族另一个真键上，validate 与全套单测两头全绿**（第十五轮在仓库外副本上
  跑 20 个变异实测）。门禁 `tests/tab-auto-refresh/i18n-indirection.test.mjs` 七条：抽取形状
  （每张表"值槽数等于抽出的条目数"，形状一改就红而不是静默少收几条）、正向（语境里的每个
  字面量两份语言包都得有）、反向（**先剔注释**，每个键都要有一条真通道，实测 180 个键齐平）、
  表键与值之间的名字关系加表内不许两槽同值（`WECHAT_ERROR_KEYS` 是唯一容许同值的表，
  40001 与 42001 本就同义）、`NOTIFY_EVENTS` 在标题表与正文两侧都要有着落、HTML 用到的
  `data-i18n` 属性后缀与该页注入器的选择器两头齐平。**新增一张装文案键名的表、或新增一种
  属性后缀，都要去那张表的登记清单加一行**，忘了登记的表现是反向那一条点名"这个键没有通道"，
  而不是静默。两处刻意留下的边界：数字键的错误码表把值改到同族另一个真键上仍无人拦（键与值
  之间没有命名可推、被弃用的键还挂在别的码上），文案**本身**超没超微信那 20 字也不在这根轴上
- 上一条留下的那句"文案本身超没超"是**另一根轴**，第十六轮补上门禁（A34）。卡片两个字段的
  字数上限与不支持换行写在 `shared/logic.js` 的注释里，插件自己先截（`clipOneLine`、
  `wechatTitleOf`），所以文案变长的后果不是报错而是**平台那边静默去掉半句话**；更阴的一层是：
  标题那一格装的是"事件 + 分隔符 + 站点"三段，标签加长之后自己仍然在预算内、算术也全绿，
  被挤没的是站点名——而短标签存在的理由恰恰是给站点腾字数。改前那套机器对此一条都红不出来
  （第十五轮实测：短标签改成 26 个汉字，validate 与全套单测两头全绿）。门禁
  `tests/tab-auto-refresh/wechat-budget.test.mjs`：键清单从 `WECHAT_EVENT_TITLE_KEYS` /
  `WECHAT_BODY_KEYS` 与两处 `getMessage` 实参位置现切，值从两份语言包取，字数上限 import
  `logic.js` 的真常量、站点地板从 `wechatTitleOf` 源码里那句预算判断现推，**带站点的事件要真跑
  一遍 `wechatTitleOf`** 并要求示范域名的注册段完整出现；另有一条"最紧的一处余量必须已经贴到
  预算边上"挡判据自己变成空跑。覆盖面不靠人登记：反向从语言包的命名族（`wechatEv*Short` /
  `wechatBody*` / `wechatTitleSep`）推账，新增一条卡片文案却没进预算账就点名它。
  **判据分两层是这一轮的正题**：只比字数的那几条管住"标签超上限"，"标签装得下而站点没了"
  那一类只有跑真函数才看得见。切表行与函数体的那套抽取原语搬进了 `tests/helpers/source-tables.mjs`，
  两轮的门禁 import 同一份——同一类判据写第二份必然漂移，而这里"漂"的表现是不报错。
  两处刻意不管：站点地板那个数本文件跟着代码放宽（写死它就成了第二份真相来源，代价记在
  文件末尾），弹窗那两行状态文字的容量由 CSS 与版面定，不在这根轴上
- 存储这本账（源码里到底读写哪些键、落在哪个区 ↔ 下面 `### 存储` 那三行清单）此前零判据，
  第十七轮补上（A35）。相邻三条门禁各从自己的切面看存储，没有一条问过这本账本身：
  `permission-map` 管 API 要哪一项权限、`settings-map` 管 `settings` 那一个键的五段、
  `rt-lifecycle` 管 `rtRoundKeys` 里放哪几族以及清不清得干净。实测（仓库外整仓副本 14 台变异，
  下表记在门禁文件末尾）六类改法在删掉本门禁之后 `validate.mjs` 与其余 534 条全绿：
  新增一个键而文档只字不提、新增一笔解析不出的读写、文档删掉一项、文档多列一项、
  第二处 `chrome.storage.local.get(null)` 全量读、会话态包装函数的调用方递一个解析不出的键名。
  这六类的共同形状是"代码与测试自洽，只有跨文件那本账漂移"，而两头的症状都是**安静**：
  键进错区不崩，只是让状态在没人预期的时刻活着或消失；文档少一行也不崩，直到下一个人照着它改代码
  （实测真收获就是这样出来的：`settings` 与 `cookieBackup` 两个只在旧数据上存在的 local 键，
  源码真读写而 `### 存储` 没写，正向那一条当场点名）。门禁
  `tests/tab-auto-refresh/storage-map.test.mjs` 七条：抽取形状（45 个调用点每个都要有归宿，
  未定的按"哪个文件的哪个函数里有几笔"登记在册，`n` 参与比对）、正向（源码→文档）、反向
  （文档→源码，那个区真碰它一次）、包装函数这一头（`rtGet` / `rtSet` / `rtRemove` / `rtBump`
  的 17 处调用点递出去的键都要解析得出来）、全量读（只此一处，且函数体必须按 `COOKIE_BACKUP_PREFIX`
  过滤，否则全量读回来不筛等于把整个区的键都当成自己那一族）、文档那三行的形状与数量下限、
  参照物（只有间接通道才进得了账的键实测 10 个，断的是精确数）。动态段一律归一成 `前缀:<*>`
  再比，所以文档写 `cookieBackup:<host>` 还是 `<tabId>` 都不影响判据，占位符名字不进比较。
  **新增一个存储键要同时进 `### 存储` 对应那一区的清单**；把状态换区更要进来，因为区的语义
  就是"活过 SW 回收放 session、要活过浏览器重启才放 local"那把尺。刻意留下的边界：只管键名与区，
  值的形状不在这根轴上（除 `settings` 另有 `settings-map`）；"这一族生命周期里清得干净不干净"
  是 `rt-lifecycle` 的账，两头都绿才叫这本账齐
- cookie 存档这本账（一份 `cookieBackup:<host>` 后面那份对象里有哪些字段、谁写的、谁读的、测试夹具
  手抄的那一份对不对）此前零判据，第十八轮补上（A36）。上一轮审键名与区，这一轮审键**后面那个值**：
  存档没有 schema 声明，字段名只以字面量的形式散在三处——`backupCookies` 的采集映射（条目级唯一的
  写侧真相）、`logic.js` 的 `applyBackupAction` 与 `planBackupConvergence`（存档级，两处通道：
  `entry:` / `write:` 后面的字面量，和就地合并的那个对象）、以及 `cookie-backup.test.mjs` 与
  `logic.test.mjs` 里手写的夹具，三者之间一个字节都没有 import 过来。实测（仓库外整仓副本，下表记在
  门禁文件末尾）三类改法在删掉本门禁之后 `validate.mjs` 与其余 541 条**一条不红**
  （13 台变异里十类是这样，下表逐条点名；每台 pre 固定另有两条 `doc-anchors` 红，
  那是"删掉本文件指向的门禁"这个动作自己的副作用，与改法无关）：把写侧的
  `hostOnly` 改名（还原时它恒为 undefined，每张备份都走"旧备份"那一支、一律带 `domain` 写回浏览器，
  于是 `__Host-` 票据写不进去、其余票据的作用域被扩大）、还原侧不再读 `sameSite`、采集侧不再写
  `httpOnly`（`cookieTicketScore` 最强那道判据跟着失效，超限截断开始切掉真正的票）。之所以全绿：
  夹具自己手抄了一份 `hostOnly: true`，读侧那条用例喂进去的字段是抄本给的、不是写侧给的——
  这是全套门禁里"第三份抄本掩盖第一份与第二份不一致"的又一个现场。门禁
  `tests/tab-auto-refresh/cookie-schema.test.mjs` 八条：抽取形状（采集映射全仓库只许一处、切不到计算键与展开，
  存档字段从上面那两条通道一起现推，登记在册的读侧别名每个都要真取用字段）、正向（读侧读到的字段，
  本层存档必须有）、反向（盖章的字段要有人读；只写不读的要登记并写明凭什么，`schemaVersion` 就是这一类）、
  往返回路（`restoreCookies` 读的字段集合与采集写的齐平，一项不多一项不少；采集那笔去重键用的名字也要能被存档带走）、
  Chrome 参数账（`cookies.set` 与 `getAll` 递出去的每一项都在官方 details 里；"存档专有字段"按
  Cookie 对象有它而写回接口不认它现推，一项都不许原样递过去）、夹具账（测试里手写的条目与存档对象不许发明字段名）、
  文档账（下面 `### cookie 备份与登录保持` 那条还原三分支的说明要有源码落点，`schemaVersion` 的数字从源码取）、
  参照物（四条通道各自的数量下限）。**改一个存档字段要在一次提交里改齐四处**：采集映射、还原侧、夹具、
  以及下面那条说明；给存档加一个新状态字段还要进 `SCOPES` 那张读侧别名表，忘了登记的表现是抽取形状那一条
  点名"这个别名一次都没取用字段"，而不是静默。刻意留下的边界：字段**值**的形状（`sameSite` 给什么、
  `expirationDate` 是什么单位）不在这根轴上，那是 `logic.test.mjs` 与 `cookie-backup.test.mjs` 用真数据
  跑出来的账；旧备份缺字段这一事实按"读侧不许依赖它一定在"判，不按清单齐不齐判
- `tests/` 单元测试放在仓库根，避免被打进插件 zip
- `docs/` README 用的截图
- `_code-review/` 是本地审核归档（多轮报告与回归脚本），被 `.gitignore` 忽略，不入库、不进 Release、新 clone 里不存在。所以本文件里引用 `_code-review/...` 的路径只在本地有效
- 根 `package.json` 只是仓库工具配置（`type: module`、脚本、repository 元数据），没有依赖，不影响打包

## 约定

- Manifest V3 + 原生 JS，无构建步骤、无 npm 依赖
- 许可证红线：本仓库是 MIT。tab-reloader 与 staying_alive 没有许可证（默认保留所有权利），Keep-Alive-Pro 是 GPL-3.0。对这些只能取思路、不得粘贴代码字面，注释里至多写"思路与 X 一致"。只有 MIT 项目（如 auto-refresh-extension）的片段可以借鉴，且要保留来源 URL 与版权声明
- 提交信息用英文 Conventional Commits（feat / fix / docs / refactor / chore）
- UI 默认中文，同时维护 `_locales/zh_CN` 与 `_locales/en`，两边键必须齐平。**新增一条文案必须同时在源码里
  提到它**：`validate.mjs` 除"两份键齐平"外还跑正向（四处 `__MSG_`、`data-i18n*`、`getMessage` 字面量、
  以及 `msg()` 那类别名包装，都得上语言包）与反向（语言包里每条键都要在插件源码某处以字符串出现过）两头，
  只加文案没接线就 exit 1。
  反向判据认不出注释——键名带引号写在注释里也算"提到"，这是刻意选的宽松面（宁可漏报也不去写一套认不出注释的切分）。
  带占位符的文案还多一道位数账，见上面那条
- 版本号在 `tab-auto-refresh/manifest.json` 维护
- 发布：改 manifest 版本号并更新 CHANGELOG → 提交到 `main` → 打 tag `tab-auto-refresh/vX.Y.Z`（前缀勿改）→ 推 `main` 与 tag，Actions 自动打包、建 Release 并清理旧 Release 与 tag

### 三条改法纪律

1. 含"先读后写、跨异步步骤共享状态"的流程要把顺序决策抽成纯函数、执行器只负责写盘，让顺序能被单测直接断言，而不是靠读代码推断。已按这条落地的是 `planPrune`（启动恢复）、`decideAlarmAction`（到点处置）、`decideBackupWrite`（备份写入），以及检测链的 `aggregateFrameHits` + `decideWallFromFrames`（多框架结果怎么合并、逐框架怎么判墙）——页内注入体只回原始事实，判断一概留在 `logic.js`。新写的同类流程照这个形状做
2. 权限与功能成对记账：新增权限要在 CHANGELOG 该版本 Added 里点名，并更新下面的权限清单；新增需要权限的功能同样要更新权限说明（这本账现在四段都对得上，见"权限这本账有四段"那一条）
3. 默认值（开关、阈值、间隔）任何变动都要逐条列出受影响路径和"用户已显式设过值"的分支，确认不会改变既有用户的行为。新增一个设置项要一次改齐五处，理由见下面"设置这本账有五段"那一条

### 测试纪律

- 三条外发链路（webhook、微信、静默心跳）的用例必须经桩件 `env.reply(spec)` 给出真应答：共享桩件在 `bootBackground` 里同时装 `globalThis.chrome` 与 `globalThis.fetch`，只设 `env.reply` 而拿不到 `fetch` 等于请求根本没发出去
- 凡是只断言"没发、没写、没通知"的用例，永远不可能证明那条链路被执行过——新写用例要先有一条"链路确实跑到了"的正向断言，再叠加"这条路径不该跑"的负向断言。红→绿对照的做法记在每个测试文件末尾
- 桩件里的空函数不记调用，等于那段代码零覆盖而全套照样全绿（E3 实测两处：`chrome.power` 两个空函数让 `applyKeepAwake` 一次也没跑过；`fetch` 不 `await` promise 型应答、不认 `init.signal`，让三条外发链路各自那笔 15 秒超时从未被走过）。所以**给一个新接口先问它记不记**：power 记在 `env.calls.keepAwake`，外发记在 `env.calls.fetch`，未决的那笔列在 `env.pendingFetch()`，句柄 `.abort()` 等价于计时器到点
- "把请求挂住、再叫停、然后等链路落定"的用例，等待必须走桩件导出的 `settles(p)`（带上限，默认 500 毫秒），不许写裸的 `await inflight`。理由：后台那三笔 15 秒计时器接在 `init.signal` 上，桩件的句柄坏掉时计时器照样会在 15 秒后把请求推落定——用例"等得到结果"，只是每次慢 15 秒，**红不出来**（H5 第一轮实跑就是红 0、时长从 0.7 秒变 30.3 秒）。坏掉的一面门如果表现为慢而不表现为红，就得让用例自己带上限
- 断言本地化过的显示（时刻、日期、数字）时不许写字面量期望值：本机与 CI 的 locale 与时区不同，`"09:07"` 与 `"09:07 AM"` 只能在其中一边成立。钉形状（数字分组的个数与位数）、按本地分量构造喂进去的时刻。A19 那批用例照这个形状写，理由写在用例里
- 挑对照（改坏哪一处）要挑**净结果变了**的那一种。互补的两行代码上有一类改法会被下一行原样抵消——A20 里"heartbeat 为 false 时顺手 `stopActivityWatch()`"实跑零红，因为紧接着一行 `if (cfg.activityWatch) startActivityWatch()` 又把监听器起回来了，行为与原文完全一致；换成删掉 `else stopActivityWatch()` 才红。零红先分清是门禁缺口还是等价变异，把判读写进文件末尾，别急着记成缺口。**红得过多同样要核**：第十六轮有一处对照把表值换成一个未定义的调用，被改的那个模块当场加载失败，两百条红把本轮真正的增量（两条）淹得看不见——单独复跑一遍点名之后，换成语法合法且求值结果相同的表达式才量得出来。条数不等于覆盖面，判据要能逐条点名
- 文档引用代码位置一律**按名字锚**（函数名、消息类型、存储键、用例标题），不写行号；写的文件路径必须真存在。行号是会被下一次插入式改动冲掉的坐标，而且**冲掉时零症状**：不报错，只是安静地指着别的一句话。A7 之后本仓库定过这条规矩，A24 仍抓出五处漏网的（其中两处是当天新写进去的），于是规矩本身有了门禁：`tests/tab-auto-refresh/doc-anchors.test.mjs` 扫 `AGENTS.md` 与 `README.md` 反引号里的符号名与路径、扫 `BACKLOG.md` 全文与 `CHANGELOG.md` 的 `[未发布]` 段的两种行号锚形状。改完文档顺手跑它，别等下一轮审计人肉重扫；它也不区分"引用某个名字"与"违反某条判据"，抄一段带行号的实例进去它会立刻红，写"第 N 行"这种描述形状即可
- 上面那条门禁判"符号名还在不在"用的是**整词**（前后再接一个 `[\w$]` 就算不接）：**少写一个字母反而"存在"**
  是子串判据的形状，`corpus.includes("aggregateBadgeFact")` 因为真名 `aggregateBadgeFacts` 在场就绿。
  第三种方向同理要抓住——代码改名成文档那个名字的超集（真名后面加个后缀、说明书不动）也算名字没了，
  而那正是这条门禁立起来要抓的一类（第二十一轮 A39 实测：三种写法在旧判据下各红 0 条）。红的时候
  **点名语料里最接近的真名字**（候选要求共享至少四个字符的前缀，对不上就留空，绝不凑一个不相干的名字），
  这样"改完代码忘了改文档"不用回头 grep。代价是几处非标识符反引号内容要进豁免表：实测 312 个符号名里
  只有一处（import 说明符前缀 `node:`，源码里它后面永远接着模块名），所以豁免清单很短——**新增一类
  点号/冒号开头的反引号字面量时要回来看它会不会被认成缺符号**
- 文档里的**数字**同理要有门禁：`tests/tab-auto-refresh/doc-numbers.test.mjs` 把 `AGENTS.md` 与 `README.md` 写死的阈值、时长、上限、尺寸、数量词逐个从源码现推再比对（值只从源码取，测试里不抄第二份常量，也不 import 模块——对照跑在仓库外的副本上，import 解析不过去）。所以改任何一个默认值或阈值，**文档那一侧一定会红**，纪律 3 那句"逐条列出受影响路径"从此有机器可查的一半兜着。改完数字先跑它，别把文档留在原地

## 插件要点

### 权限与版本

- 权限：alarms / storage / tabs / contextMenus / notifications / cookies / scripting / idle / power
- 权限这本账有四段：上面那行清单 ↔ `manifest.json` ↔ 源码里的真实调用点 ↔ 共享桩件暴露的 chrome 表面。第一段由 `doc-numbers.test.mjs` 钉，后三段由 `tests/tab-auto-refresh/permission-map.test.mjs` 钉——它带一张 `API_PERMISSION` 表（哪个 API 要哪一项权限，抄自 Chrome 官方文档，仓库里不再抄第二份清单）。**新增一处 API 用法先去查它要哪一项权限**：漏配不会响亮地崩，调用点多数带 catch，表现是那块功能就是不生效；而桩件那份 chrome 对象抄的是"代码用了什么"、不是"代码被允许什么"，所以测试照绿（实测：删掉 power 权限并同步改掉上面那行清单，改前的整套 500 条全绿）。删功能同理要连权限一起删——manifest 里一项没人用的就是白要，`host_permissions` 那一笔由源码里两类"按任意网址干活"的调用点（裸 fetch 与 executeScript）背书
- host 权限常驻 `host_permissions: ["<all_urls>"]`，不要再改成按需申请。试过，硬伤是系统授权框弹出即夺走焦点、关掉扩展弹窗，发起申请的脚本随之销毁，授权完成后任务不会自动开始，用户必须再点一次"开始"。本插件自用分发、不上商店，按需申请没有合规收益。将来真要上商店再做，且必须监听 `permissions.onAdded` 在授权完成后自动续跑
- `minimum_chrome_version: 120`，30 秒级 alarms 依赖它

### 存储

- `chrome.storage.local`：`tasks`（tabId → `{intervalSec, createdAt, url, keywords?, onHit?, notifiedKeys?, autoPaused?}`，旧数据的单串 `keyword` 由 `getTaskKeywords` 兼容读取，后台与弹窗共用这一个入口）、`pausedAll`、`sessionProbe`（根域 → `{sus, lost, lastNotifiedAt}`）、`cookieBackup:<host>`、`cookieBackupWarnedOnce`、`wechatLastResult`、`webhookLastResult`（两个出口各一份最近一次投递结果，只存本机、不走 sync）、`settings`（1.1.0 及之前把设置存在 local，迁移读到就整份搬去 sync 再删掉这一份）、`cookieBackup`（v1.4.1 及之前的"单一对象"格式旧备份，`prune` 一进来就整条删）。这两项都只在旧数据上存在、读一次就没，但 local 里为什么会出现这两个名字，只有这一行说得出。
- `chrome.storage.session`：跨 SW 回收要活下来的运行时计数与标记，即 `rt:error:<tabId>` / `rt:captcha:<tabId>` / `rt:activity:<tabId>` / `rt:skip:<tabId>` / `rt:awake` / `rt:pruneDone`（本轮浏览器会话的启动恢复是否收尾，给弹窗那条清理网看，A16）/ `wechatToken`。判断标准是要活过 SW 回收放这里，要活过浏览器重启才放 local
- `chrome.storage.sync`：`settings`。默认值集中在 `shared/config.js` 的 `DEFAULT_SETTINGS`，弹窗与后台共用；sync 为空时会从 local 迁移旧设置
- 上面那三行是**两头账的一头**：另一头是插件源码里每一个 `chrome.storage.<区>.<动作>` 调用点，由 `tests/tab-auto-refresh/storage-map.test.mjs` 现切现比（正向：源码里出现的键要在那一区列名；反向：那行列出的键源码要真碰一次）。所以**新增一个存储键要回来改对应那一行**，把状态换区更要回来改，理由写在上面 `## 仓库` 那一条里
- 设置这本账有五段：`DEFAULT_SETTINGS` 的键 ↔ 弹窗 `saveSettings` 发出的载荷键 ↔ `popup.html` 里能填值的控件 ↔ 插件源码里的读写点 ↔ `NOTIFY_EVENTS` 与弹窗那几个事件格子。原先只有两头有人核（A18 钉"保存读的控件＝回流铺的控件"、A29 钉"`popup.js` 取的 id 在 HTML 里存在"），中间三段零判据，现在由 `tests/tab-auto-refresh/settings-map.test.mjs` 钉。每一段的静默形状：载荷多出一个 defaults 没登记的键 → `pickKnownSettings` 把它丢掉，用户点了看着生效、落盘一个字都没有（实测：把 `keepAlive` 那一项改个名、载荷键数仍是 15，改前的整套 504 条全绿）；defaults 里长出一个没人读也没人写的键 → 它跟着 `sync` 漫游却改不掉任何行为；HTML 里摆一格 `popup.js` 从不取的控件 → 一个从来没能生效过的开关；`.checked` 读到文本框存进去的是 undefined（序列化时整个键消失）、`.value` 读到复选框存进去的是永远真值的 `"on"`；事件名在清单、格子、载荷、`notifyOut("…")` 调用点四处里任一处漂一格 → 那一格勾与不勾一模一样。**新增一个设置项要一次改齐**：`DEFAULT_SETTINGS` 的默认值、载荷键、HTML 的格子与类型（复选框用 `.checked`、文本框用 `.value`）、真实的读写点，若是一类通知还要同时进 `NOTIFY_EVENTS` 并在 `background.js` 有 `notifyOut` 调用点。只改一头就是这条门禁的红
- 后台的 `getSettings()` 带内存快照（`settingsCache` / `settingsLoading` / `settingsEpoch`）：一次任务页加载周期里它被调 5~7 次，原先每次都发两笔存储读。**新增的 `settings` 写入一律走 `patchSettings(partial)`，别自己 `get`/`set`**：它在 `withSettingsLock` 里读盘、合并、整份写回，读写两头各 `invalidateSettings()` 一次（读前不失效会拿过期快照当基座，把用户这次没碰的开关按旧值写回去；写后不失效则 `onChanged` 回流前的一切读取仍是写前的值）。`partial` 给函数时按当前设置决定增量、返回 `null` 即不写，"没变就不写"的判断因此与写盘同处一把锁。唯一例外是 `loadSettings` 的 local→sync 迁移（整份写入、只发生一次、且在 `getSettings` 调用栈内，走 `patchSettings` 等于自锁）。两把锁的方向是契约：`startTask` 在 `withTaskLock` 内 `await` 设置写盘（单向等待），设置锁内绝不排 `withTaskLock`，否则互相等死。失效点、串行、锁方向均由 `tests/tab-auto-refresh/settings-cache.test.mjs` 钉住，文件末尾记着红→绿对照与两处第一次不合格的对照
- 当前默认开：`bypassCache`、`keepAlive`、`httpHeartbeat`、`skipOnActivity`、`captchaGuard`；默认关：`skipDiscarded`、`cookieBackup`、`keepAwake`、`wechatEnabled`；`webhookUrl` 默认空即关闭
- 改 `DEFAULT_SETTINGS` 只影响新装：`getSettings()` 是 `Object.assign({}, DEFAULT_SETTINGS, 已存值)`，老用户的存盘值优先。想让老用户也吃到新默认必须写迁移

### 调度与任务

- alarm 命名：刷新 `refresh-<tabId>`，静默心跳 `hb-<tabId>`；前缀与预设定义在 `shared/config.js`
- 刷新用"一次性 when + period 兜底"双保险，每次触发后重新 arm，间隔 ±15% 抖动。30 秒档只正向抖，否则一半样本会被 30 秒地板抬回原值
- `onAlarm` 到点之后的处置全在 `shared/logic.js` 的 `decideAlarmAction`（纯函数，返回 `{action, reason}`），后台只负责把事实取齐再执行 `ALARM_ACT` 四选一。次序是语义的一部分，三条不能调换，注释写在纯函数侧：全局暂停早于标签页存在性（暂停期随手关页不该收到停止通知）、存在性早于 `autoPaused`（否则自动暂停的任务关页后无人清理）。`ACTIVITY_SKIP_MS`（60 秒）随之住在 `logic.js`
- `SKIP` 那一拍要把 `{reason, at}` 写进会话态 `rt:skip:<tabId>`（刷新成功后清掉、停任务时随其它 `rt:` 键一起清），否则弹窗只能显示"倒计时归零了却没刷"，说不出是被谁挡下的。理由到短标签的映射表 `ALARM_SKIP_REASONS` 住在 `logic.js`，**新增一种 SKIP 理由必须同时进表**：漏了不会崩，只会退回"另有原因"这种没人会怀疑的显示，所以 `tests/tab-auto-refresh/skip-trace.test.mjs` 是真跑 `decideAlarmAction` 收集四种理由来比对，不是手抄清单
- `skipOnActivity` 有两条判据，是 or：内容脚本上报的活动时间戳（会话态 `rt:activity:<tabId>`），以及 `isTabOnScreen`——该页是所在窗口的活动页且那个窗口是焦点窗口。后者不依赖注入，注入失败的页面不至于在用户眼皮底下反复重载。焦点窗口 id 跟 `windows.onFocusChanged` 记，**三态不能压成两态**：`undefined`（本 SW 实例还没收到过焦点事件）才允许补查一次 `getLastFocused()`，`null`（最后一个事件是 `WINDOW_ID_NONE`）是"已知浏览器不在前台"、必须直接放行去刷，因为真实 Chrome 在焦点去了别的应用之后**仍然返回最后聚焦的那个窗口**，把两态合并会让用户走开期间的每一次触发都判成"人正看着这页"，从此永不刷新。认不出来一律 `false`（宁可多刷一次，绝不能变成永不刷新），且只在 `skipOnActivity` 开着时才去查（关着就别为每次触发多问两回）。门禁由 `tests/tab-auto-refresh/alarm-gate.test.mjs` 钉住
- 心跳每 4 分钟一次，建 alarm 时带随机初始相位；`chrome.idle` 回到 active 时，过期的刷新 alarm 重走完整周期，过期的心跳 alarm 打散 0~60 秒重建
- 后台对 `tasks` 的读改写必须走 `withTaskLock` 串行队列。锁的**作用域**与串行同样要紧：锁内只碰存储与内存快照，绝不排队等网络——`withTaskLock` 是全站共享的一把锁，压在锁上等外发时别的标签页连「开始/停止」都要排队。`startTask` 的首次 `backupCookies` 因此排在整条锁内流程之后（它会一路 `await` 到 `notifyOut` 的两笔 fetch，15 秒超时、微信还要先取令牌），但**仍然 `await`**，不改成裸甩。门禁 `tests/tab-auto-refresh/start-task-lock.test.mjs`
- 快捷键 `toggle-refresh`（Alt+Shift+R）复用 `settings.lastIntervalSec`，没有记录时回退 5 分钟；右键菜单 contexts 是 `["tab", "page"]`
- 手动开始任务（弹窗、右键、快捷键）会解除 `pausedAll`；暂停期间 alarm 跳过触发，恢复后按原周期继续
- 角标五态的**优先级与取值全在 `shared/logic.js` 的 `decideBadge`**（纯函数，纪律 1 的又一处兑现），
  四件事实怎么从 `tasks` 与 `sessionProbe` 推出来也在同一侧的 `aggregateBadgeFacts`，
  `background.js` 的 `updateBadge` 只读盘、递事实、再写盘。
  顺序：掉线 `!` 红 > 自动暂停 `⚠` 橙 > 全部暂停 `‖` 灰 > 数量 蓝 > 空。
  两条链的支数刻意不一样多（颜色不看数量、文字要 `count > 0` 才给
  `‖`），所以"全局暂停且一张任务都没有"是灰底配空字而不是某一态——别把它压成对称形状，
  用例把这件事钉着（第十九轮之前这两行嵌套三元式零判据：换一位优先级、删掉 `pausedAll` 那一支、
  把上面那行顺序整个倒过来写、把自动暂停与数量两态的色值对调，四类改法全套门禁全绿——
  实测记在 `badge-state.test.mjs` 末尾，其中"全绿"按"除本轮条目自身那一条 `doc-anchors` 路径红之外"算）。
  取事实那两条同样不许凭读代码相信：**每一条任务都要过一遍**（"有没有任何一张掉线"这种归约，
  看到第一张就停下在单张任务的现场一模一样，多开一张就把第二张的故障藏住，而角标是用户唯一的可见信号）、
  **探针的键是注册域**（与写侧 `reportSessionSignal` 递进去的那个 root 同一个算法，取整串主机名不报错，
  只是永远查不到那条探针）。第二十轮之前这两条零判据：把掉线那条改成只看第一个任务，
  全套门禁一条都不红——实测记在 `badge-facts.test.mjs` 末尾
  所有任务增删路径都要经过它，`chrome.power`
  锁的收敛也挂在那里（`void applyKeepAwake()`），另一条入口是 `reconcileKeepAlive` 末尾那一笔，
  管开关真变化的时候。`applyKeepAwake` 三条判据不许凭读代码相信：申请 `system` 不申请 `display`、
  持锁标记走会话态所以一个生命周期最多申请一次、**释放那一头无条件**（锁跨 SW 回收存活而标记只在
  本会话，靠标记决定释不释放就会漏掉回收后这一次）。门禁 `tests/tab-auto-refresh/keep-awake.test.mjs`
  （桩件按序列记 `env.calls.keepAwake`）、`tests/tab-auto-refresh/badge-state.test.mjs`
  （次序、取值、说明书那一行）与 `tests/tab-auto-refresh/badge-facts.test.mjs`（四件事实怎么取），
  **新增一态要三处同时改**：`decideBadge` 的分支、上面那行说明的顺序、以及那面门禁的态清单；
  新增一件**事实**（不是新态）还要同时改 `aggregateBadgeFacts` 的出口，两头都对着源码现推
- 单独关掉一张被监控的页会按任务里记录的网址**在后台重开一张**并把任务搬到新 id（先 `setTasks` 落盘、再挂新 alarm、最后清旧 id 的两条 alarm）；`removeInfo.isWindowClosing` 为真时整个不动，交给启动恢复。`!task.url` 也不动，免得给旧格式任务开出幽灵页。门禁由 `tests/tab-auto-refresh/tab-removed.test.mjs` 钉住
- `tabs.onUpdated` 先用内存里的任务 tabId 快照过滤，非监控标签页不读存储；快照在 `setTasks` 时更新，冷启动首次事件回读存储
- `task.url` 的语义定死一次：**用户指定的监控对象**，不是"这一页此刻的地址"。`refreshTaskUrl` 因此只跟随**同站且不是登录页**的新地址，判据是纯函数 `shouldAdoptTaskUrl`（在 `logic.js`，纪律 1 的兑现处），门禁在 `tests/tab-auto-refresh/task-url.test.mjs`。让登录页参与改写会自指（A14）：站点一跳 `/login`，监控对象就成了登录页，而行为通道那句"监控对象本身就是登录页时此信号不适用"从此恒成立 → `sus` 被清零 → 2 次确认窗口再也走不到 `lost`，掉线检测自己把自己 disarm；同时关键词在登录页正文里找、心跳对着 `/login` 发、用户重新登录也不会自动回到原页面。跨站漂移同样不覆盖，好让自动重开回到用户填的那一家
- `startTask` 拿不到标签页或网址时抛错，不建没有网址的幽灵任务
- 受限页面（`chrome://` 等）由 `RESTRICTED_URL` 判定，`startTask` 直接拒绝

### 启动恢复

- `prune(adoptLegacyUrls)` 做三件事：恢复 cookie、把任务重新挂接到会话恢复出来的标签页、失效任务兜底重开
- `adoptLegacyUrls` 只在扩展安装或更新时为真，那时浏览器没重启、tabId 仍有效，可以给 v1.4.3 及更早（任务里只有间隔和创建时间、没有网址）的旧任务补记当前网址。浏览器重启后 tabId 已重新分配，只能淘汰
- 注册必须写成 `() => prune(true/false)`。直接 `addListener(prune)` 会让 `onInstalled` 的事件详情对象被当成真值
- 顺序决策全在 `shared/logic.js` 的 `planPrune({ tasks, tabs, adoptLegacyUrls })`（纪律 1 的兑现处），`prune` 只剩执行：`keep`/`adopt`/`remap`/`watch`/`dropped`/`staleIds`/`claims`/`dirty`。计划跑两遍——锁外一遍只为了判断要不要等待，等待结束后在锁内用最新的 tasks/tabs 再跑一遍再应用（套用等前的旧计划会把等待期间用户的起停算进去）
- 认领规则：ID 被占用不代表挂接正确，要网址一致（精确或 `urlKey` 相等）才保留。重映射时跳过已被其他任务认领、或仍是其他未处理任务键的页面（`pending` 集合，防两个任务争抢同一页时后者被覆盖而静默丢失）。同一网址开在多个标签页时每页至多挂一个任务。现场认领不到的进 `watch`：候选**共享一个** `RECLAIM_WATCH_MS` 上限窗口（在任务锁之外等），等完仍认不到才按记录的网址重开。原先是按任务逐个等 20 秒且全程持锁，N 个未认领任务能让弹窗与刷新整体停摆 N×20 秒
- 应用阶段一律**先 `setTasks` 落盘、再 arm 刷新与心跳、最后清陈旧 alarm**。心跳排在写盘后面是硬要求：`ensureHeartbeat(新 id)` 要按落盘后的键读任务，先挂会让它读到"这个 id 没任务"而把心跳清掉，恢复后的任务只剩刷新、没有静默心跳。`startTask` 与 `reopenTaskTab` 同样是先写后挂，而且**写完就紧接着挂**：中间不夹任何可失败的等待（尤其不等外发），否则"任务已落盘、alarm 一条没有"的空档会被 SW 回收撞上（A15）
- 未认领任务的旧 alarm 收集到 `plan.staleIds`，`setTasks` 写盘之后再清，清理时对照写盘后的最终键集合（`liveIds`）。被本轮重挂接或重开占用的 id 不能清，否则会造出"任务在、永不刷新"的僵尸。由 `tests/tab-auto-refresh/prune-plan.test.mjs` 钉住
- 弹窗每次打开发一次 `prune-now`（`cleanupInvalidTasks`），它是"任务指向的标签页没了"的第二条网。**"取不到标签页"不等于"这条任务再也不会回来"**：浏览器重启后会话恢复晚到的那几秒里 `chrome.tabs.get` 就是失败的，而 `prune` 正因为知道这件事才先等 1500 毫秒、再给未认领任务一个共享的认领窗口——两个函数对同一件事的假设不能相反（A16）。所以这一条网在**本轮启动恢复收尾之前一条都不动**，收尾信号是 `prune` 整套动作跑完后写进会话态的 `rt:pruneDone`（要活过 SW 回收：弹窗通常晚到得多）；中途抛错就不写，宁可让网继续推迟也不在恢复现场上删任务。真删时逐条 `stopTask` **全部停完**再统一发 `task-stopped` 通知（外发是 await 的，逐条串起来会让后面几条任务的停止一起被堵），并且一定发通知——任务在用户没碰任何东西时静默消失是最难被报告的一类 bug。门禁 `tests/tab-auto-refresh/prune-now.test.mjs`

### cookie 备份与登录保持

- 由 `settings.cookieBackup` 控制，默认关闭。关闭时不备份不恢复，`pruneCookieBackups` 清空全部备份
- 备份存在 `chrome.storage.local` 的 `cookieBackup:<host>`，明文，README 有安全说明。采集范围三道约束：① 注册域判据是形状规则（末段两字母国家/地区码 + 倒数第二段品牌段 → 多切一段），**别再退回手写完整后缀清单**，漏一条就整条踩空；② `domainChain` 下探到注册域为止，绝不查注册域以上（`getAll({domain:"co.nz"})` 的语义是"等于或子域于它"）；③ `siteRoot` 取不到可信注册域时返回 null，调用方一律不备份、不建探针——宁可丢登录态也不能越界。单段主机与 IPv4 无父域可切，整串即身份。纯函数层由 `tests/tab-auto-refresh/logic.test.mjs` 钉，查询面与恢复侧由 `tests/tab-auto-refresh/cookie-backup.test.mjs` 钉
- 启动恢复里历史越界备份的收敛是纯函数 `planBackupConvergence`（只剔注册域之外的条目，键本身是后缀或筛完为空才整条删，timestamp 不动），**必须排在按注册域恢复之前**：`restoreCookies` 按每条自己的 domain 写回浏览器，先恢复等于已经替别家站点复活了一遍登录态
- 条目带 `schemaVersion: 2` 与每条 cookie 的 `hostOnly`。还原时 `hostOnly === true` 省略 `domain`（否则 `__Host-` 票据写不进去，或作用域被扩大），`=== false` 传 `domain`，字段缺失的 v1 旧备份统一传 `domain`
- 单站点封顶 200 条，超限时先按"像登录票据的程度"排序再截（httpOnly > 会话票 > `__Host-`/`__Secure-` > `path=/` > 域更短）。正常规模不排序，避免无谓的顺序变化
- 启动恢复按注册域匹配，覆盖 SSO 登录所在的兄弟子域；恢复成功的根域记在 `restoredRoots`，据此决定认领的标签页要不要补刷新
- 淘汰三条件：站点不再被任何任务使用、超过 30 天、超过 20 站上限（按时间留新）。停止任务与启动恢复时统一执行
- 存档只有一个读法：`readBackupEntries()` 一次 `get(null)` 全量读、按 `cookieBackup:` 前缀过滤。**不要引入主机名清单**（`cookieBackupHosts` 试过、当天回退，见 CHANGELOG 的 A13）：登记是清单自己的一次无锁读-改-写，漏一条，那条明文存档就对"按清单取数"的恢复与清理永久隐身——丢登录态且没有任何本地症状。全量读的代价止于慢（最坏 20 站 × 200 条明文反序列化进 SW），一趟启动至多两次（收敛/恢复一次、清理一次），要再省只能共享这一次读，不能加第二份真相来源。门禁是"先造孤儿再证明它被删掉"那几条（启动 / 关开关 / 停任务三条路径），外加一条扫 `background.js` 里 `cookieBackupHosts` 字样的守卫——登记写回本身没有读侧症状，只有扫源码拦得住；`watchLocalGet` 记每次问的是全量还是键清单（桩件的 `set` 是合并写，"少读一次盘"在落盘结果上看不出来）。实跑红名单记在 `cookie-backup.test.mjs` 末尾

### 会话保活与掉线检测

- 保活（`keepAlive`，默认开）按标签页注入 `content/keepalive.js`。不用 `registerContentScripts`：matches 是站点级会溢出到同站无关标签页，而且站点注册 id 与任务 id 语义分裂，重启后停任务清不掉
- 注入点是 startTask 即时一次，加 `tabs.onUpdated` 每次加载完成补注入；停止任务发 `keepalive-off` 让页面内脚本自停；`reconcileKeepAlive` 在启动与开关真变化时收敛存量任务页（关掉开关时页面不会重新加载，`onUpdated` 那张网永远不来，这条是唯一能让存量任务页停下来的路径）。**注入必须排在配置推送之前**：脚本正是这次调用注进去的，推送早于注入时页面上还没有监听器；两笔调用在桩件里是两条独立记录列，看不出先后，用例要把它们并进同一条流水再比。`executeScript` 整次被站点拒绝时静默降级、绝不阻塞任务主流程——那一拍在 `withTaskLock` 里 await 着，抛出来就是"点开始没反应"。两头都有门禁：`tests/tab-auto-refresh/keepalive-channel.test.mjs` 把 `content/keepalive.js` 整份源码在假 window / document / chrome 上真跑一遍（该文件此前从未被执行过），另有一条拿后台真发出来的载荷喂给页面侧真监听器——类型名只改一头时两侧各自的用例都还会绿，这条会。对照入口是 `TAR_BG` 与 `TAR_KEEPALIVE`，CI 上都不设
- 内容脚本向 `document` 派发 `mousemove` / `keydown`，document 级派发经冒泡同时覆盖挂 document 与 window 的监听器。首个心跳 12~20 秒（短刷新周期下慢心跳永远来不及触发），之后 45~75 秒随机
- 静默心跳（`httpHeartbeat`，默认开）：每 4 分钟对任务 URL 发 `fetch(credentials: "include", cache: "no-store", headers: { Range: "bytes=0-1023" })`，15 秒超时。Range 值必须保持 `bytes=数字-数字` 这个 CORS 安全名单形式，改成 `bytes=-1024` 之类会引入预检。站点回 416 时去掉 Range 重试一次
- 掉线检测有两条通道。状态通道由 `decideBackupWrite` 驱动：会话票据从有到无先记疑似，疑似采样只并入计数、不覆盖好备份，连续 2 次才冻结该站点备份并按 6 小时节流通知。行为通道由 `reportSessionSignal` 写 `sessionProbe`：任务页落在登录页 URL、心跳被重定向到登录页或返回 401/403，计入同一个 2 次确认窗口。确认后角标变红，重新登录即恢复
- 信号写入做值快照比对，三元组没变就不写盘、不刷角标

### 关键词监控

- 任务字段 `keywords[]`，每条 ≤100 字、上限 10 个；旧 `keyword` 单串由 `getTaskKeywords` 兼容
- 检测链全在后台，不碰保活注入通道：每次页面加载完成起一条链，立即查一次，未命中再于 3 秒、10 秒重采样。新链起链即作废旧链，避免并发链重复通知或竞态停任务。**`stopTask` 也要作废该页那条链**（`detectChains.delete`）：链的 `task` 是在 `executeInAllFrames` 之前读好的，摘不掉 Map 里的 token 时，注入回来那道判据就认"我还是当前那条"，于是用户点了停止还弹命中；continue 模式更实在的一点是它回读 `tasks[tabId]` 写 `notifiedKeys`，同一张标签页上以新关键词重开之后，盖上去的是上一轮的在场集。造这种现场只有一个办法：把首拍那次带 `args` 的注入挂住再停任务（三次采样是 3s/10s 真 `setTimeout`，用例等不到第二拍），并且必须先有一条"挂住但没停任务 → 放开就发命中"的正向见证，否则负向用例靠"链压根没跑到"就能绿。门禁 `tests/tab-auto-refresh/detect-chain.test.mjs`
- 匹配在页面里做：`executeScript({func: matchInPage, args: [keywords]})` 只回传命中的关键词，正文不跨上下文序列化，因此没有早先"截 300KB、之后的内容永远检不到"的盲区。`matchInPage` 必须自包含（executeScript 是 `toString()` 注入的，引用模块作用域会在页面里变 undefined 并被 catch 吞掉），所以判定逻辑与 `logic.js` 的 `presentOf` 是两份实现，由 `tests/tab-auto-refresh/keyword-inpage.test.mjs` 切真实源码执行、逐条比对钉住。取文本一律 `innerText`，换 `textContent` 会把 `<script>` 源码和 `display:none` 的隐藏文字算进正文
- 两条检测链（关键词与验证墙）的注入统一走 `executeInAllFrames`：先 `allFrames: true`，被拒再退回 `frameIds: [0]`。`allFrames` 的失败方式是**整次调用 reject**，一个够不着的沙箱框架就能带走整页结果，所以必须有这个回退——加多框架不许把原来单框架能成的场景换成新的失败。关键词结果由 `aggregateFrameHits` 合并（取到几个算几个，一个都没取到才回 `null` 让链提前结束）；子框架有跨源标题与文字，顶层读法 `results[0]` 会漏。**保活心跳脚本仍只注顶层**，这是刻意的：同一份模拟活动注进每个子框架会向对方服务器放大请求量，子框架的 `document.hidden` 语义也不同。门禁在 `tests/tab-auto-refresh/frame-scan.test.mjs`
- 命中后按 `onHit` 决定停任务（默认）还是继续盯守，继续时把在场集回写 `notifiedKeys`，关键词消失后再出现会重新通知。原先"正文与上次相同就提前结束"的早停已删（回传的不再是要比较的正文）

### 自动暂停

- 错误页：心跳侧 5xx/404 连续 `PAUSE_CONFIRM_SAMPLES`（2）次即暂停，回到 2xx 自动解除
- 验证墙：页面侧特征连续 `CAPTCHA_CONFIRM_SAMPLES`（3）次即暂停，受 `settings.captchaGuard` 控制。两个阈值刻意分开，别合并回一个常量：错误页有独立的心跳 alarm 兜着、能自愈，验证墙的解除却依赖页面再次加载，误判会卡死不自愈，代价不对称
- 判据面只取标题与挑战域名（Cloudflare / reCAPTCHA / hCaptcha）：注入体 `captchaProbe` 只回**原始事实**（是否顶层、`document.title`、自身 `location.href`、自身视口宽高、挂在文档里的 iframe/frame/script 网址），两条正则一个都不下页面，判定全在 `logic.js` 的 `decideWallFromFrames`。与 `matchInPage` 那份"必须自包含所以重复实现"相反，这里刻意让页内不做判断，就没有会漂移的第二份实现。顶层判据与 A3 之前逐条一致；**子框架多过一道视口地板**（`WALL_FRAME_MIN_W`/`_H`，400×250）：reCAPTCHA 复选框 304×78、Turnstile 300×65、hCaptcha 300×88、隐藏框架 0×0 都在地板之下，整页挑战是视口尺寸，地板只挡得住前者。不扫正文：正文里的"验证码""access denied"是日常词，登录框提示、帮助文案、页脚都会命中。401/403 的登录墙语义另走掉线通道，这里不重复判定
- 那两条正则的**清单本身**也有账（第二十二轮 A40）：门禁 `tests/tab-auto-refresh/wall-list.test.mjs` 从 `WALL_TITLE_RE.source` / `CHALLENGE_URL_RE.source` 现推每一条备选，要求**每条备选都有一条夹具唯一命中它**、**每条夹具都还在清单射程内且只命中一条**、**每条带拉丁字母的特征都有一条只有靠 `/i` 才命中的夹具**，并把每条夹具经真 `decideWallFromFrames` 的三条通道（顶层标题、顶层资产、够大的子框架自身网址）各判一遍。**新增一条特征不登记夹具、删一条特征不删夹具、把某条改到同族另一条的拼写上、摘掉 `/i`，四种都会红**（改前实测：这四种全套零红，10 台变异的 pre/post 逐条记在那面门禁文件末尾的对照表里）。登记面在测试文件里、特征名一律现推，所以那份表不是清单的第二份抄本。夹具本身的形状真不真不在这根轴上——真实挑战页的标题写法仓库里没有真机样本可对，那是 V1 那一头的事
- 暂停期间 alarm 照常续跑，`onAlarm` 见到 `autoPaused` 早退，恢复零重建。`onAlarm` 里标签页存在性检查排在 `autoPaused` 之前，否则被自动暂停的任务在标签页关掉后没人清理
- 计数存会话态，不进 `sessionProbe`，不污染备份冻结语义
- 两条连击计数与 `rt:skip` 是**上一轮的结论**，不是站点状态：凡任务搬离一个 tabId（`reopenTaskTab`）、停止任务、或在同一个 tabId 上重新开始（`startTask` 不经过 `stopTask`），都要作废，否则阈值被悄悄调低（旧计数剩 2 时一次命中就暂停，本该三次）。清单只有一个来源：`rtRoundKeys(tabId)` 是结论那份，`rtTabKeys(tabId)` = `rt:activity` + 结论那份，删除处不许再手写键数组。`rt:activity` 不在作废清单里——它是"用户最后一次真在这个页面上操作"的**事实**，重开一个周期不改变它，跟着清反而会让下一拍刷到用户眼前，它自己按 `ACTIVITY_SKIP_MS` 过期。`captchaGuard` 关闭时 `probeCaptcha` 也要先复位计数再返回：关着的这段时间里页面正常加载过，重新打开守卫不该从残留值往上加。门禁 `tests/tab-auto-refresh/rt-lifecycle.test.mjs`

### 通知外发

- `notifyOut(event, payload)` 是唯一入口，依次 `postWebhook` 与 `postWechat`。两者共用 `notifyEvents` 事件清单、各有独立开关。调用方必须 `await`，两条链路都是 fetch，裸甩异步会在 SW 回收时被截断
- Webhook：`normalizeWebhookUrl` 只接受 http(s)，非法就静默不发（弹窗另有内联提示）。载荷填 `content` / `text` / `body` 三个别名，加 `type` / `url` / `host` / `ts`。ntfy 收到的是原始 JSON 文本，它只在根端点解析 JSON 而载荷里没有 topic 字段，别再说它开箱即用
- 外发网址一律由 `notifyOut` 剪成 `origin + pathname`（`shared/logic.js` 的 `outboundUrl`）：被监控页的 query 常带一次性签名、会话令牌、邮箱手机号，而"跳回哪一页"不依赖它。**剪在总入口而不是各调用点**——两个出口读的是同一份 `payload.url`，逐处改必然出现"改了 webhook 忘了微信"；解析不出来就当没有网址可发（回空串），绝不回退成原样传出去。`outboundUrl` 与页面认领用的 `urlKey` 形状相同而刻意不共用（匹配键将来放宽是合理的，那类改动对外发就是漏令牌）。`session-lost` 本来只有 `host`，没有 url
- 你填的 `webhookUrl` 本身就是凭据（这类地址内嵌 token，拿到就能往里发），且与其它设置一起走 `sync` 明文漫游，README 有说明；载荷里的关键词 `text` 是用户自己填的监控词，刻意保留（不外发就等于功能不存在）
- 微信直连（`wechatEnabled`，默认关）：扩展 SW 直接调 `api.weixin.qq.com` 推模板消息，不经中继。令牌走 `stable_token`（老的 `/cgi-bin/token` 每刷一次就作废上一个，多端并发会互相打掉），缓存在 `chrome.storage.session`，距过期 5 分钟提前重取，命中 40001/42001 清缓存重取并重试一次
- 微信平台的两条硬限制写死在常量与注释里，别凭直觉给大值。一是模板消息单个字段不超过 20 个字、不支持换行，超长由平台去掉且不给任何提示；二是模板正文里变量前必须有关键词加中文冒号，裸写变量会被平台整行丢弃，而接口照旧返回 errcode=0，用户收到的是一张空白卡片
- 微信文案有三条口径，由 `tests/tab-auto-refresh/wechat-copy.test.mjs` 钉住，改那一片文案前先读它们：① 凭据**集合**永远是四项（数字从 `DEFAULT_SETTINGS` 的 `wechat*` 字段数现推，加第五项时它会逼你回来重核教程里所有数字词），但测试号页面上只有**三项**，模板 ID 是建完测试模板才生成的——"一次拿到四项""抄四项凭据"这类写法一律算错，标题与步骤串也要过这条；② 给用户抄的模板示范只有一个来源（`wechat-setup.html` 的 `<pre>`，其变量名又来自 `WECHAT_TEMPLATE_KEYS`），文案里每处 `{{x.DATA}}` 前面必须是中文冒号，例外只允许是自带"光秃秃/bare"标记的反例句；③ 教程只教一种冒号。提到英文冒号的子句必须是否定句——A10 之前 `guideFixTemplate` 写着"换成英文 : 再试一次"，与同页 `guideStep2Why` 的硬规矩相反，而这条兜底从未实测过，删掉它不等于证明英文冒号不行，只是教程不再为一个未证的备选让用户改掉唯一合规的写法。真机验它记在 `BACKLOG.md` V1 (i)
- 卡片标题用一套短事件名（`wechatEv*Short`），不复用弹窗复选框的长标签：标题要和站点一起挤在 20 字里，英文长标签会把预算吃光。站点放不下完整注册域时整段不显示，不给"…e.com"这样的碎片。**改这一片文案（短事件名、`wechatTitleSep`、`wechatBody*`）之前先跑 `tests/tab-auto-refresh/wechat-budget.test.mjs`**：它拿两份语言包的真值跑一遍 `wechatTitleOf`，超预算的那一种不会报错，只是让卡片少半句话或让站点名整段消失
- 失败要留痕：错误码经 `wechatErrorKey` 翻成"该去哪改"的提示，最近一次结果写 `chrome.storage.local` 的 `wechatLastResult`，弹窗显示
- webhook 那头同构：投递结果写 `local` 的 `webhookLastResult`（`{ok, kind, status, errorKey, event, at}`，只留最近一次），状态分类是 `shared/logic.js` 的纯函数 `webhookResultOf(status, text)`（纪律 1 的又一处落地：执行器只取事实，判据全在纯函数）。2xx 还要读正文，因为 Slack 那类接收端对"hook 已删除"照样回 200、失败只写在 `ok: false` 里；正文只看前 2000 字，非 2xx 一律不看正文。刻意**不**猜第三方纯文本错误（`no_service` 那一类）也不跟 302——宁可显示"200 成功"，也不要凭猜把正常投递报成失败，那样用户就不信这条状态行了。地址非法与事件没勾上这两种"本该不发"**一笔都不留痕**（配置态不是投递失败），这条是显式决定、由用例钉住
- 两个出口都有「发送测试」（`wechat-test` / `webhook-test`，`ignoreToggle` 同语义：只要求凭据/地址本身能用，不受事件勾选与总开关约束），弹窗各自有一行条件显示的状态行，`{ok|error|} + 时刻` 的显示走同一套 `.wx-state`。**新增一条弹窗专用的 `onMessage` 分支必须同时登记进 `message-gate.test.mjs` 的 `POPUP_ONLY`**，该文件有一条扫分发链的守卫会红——"每条都拒"那条遍历的正是这张表，漏登记时它静默失去覆盖面
- 凭据四项存在 `settings`（即 `chrome.storage.sync`），会随 Google 账号同步到其它桌面 Chrome，README 有说明。弹窗里密钥那一格是 `type="password"`（只挡回显，存储与同步一个字没变），这条由 `popup-repopulate.test.mjs` 扫 `popup.html` 源码钉住（该文件另给对照用加了 `TAR_POPUP_HTML` 重定向入口）

### 系统通知

- 四类通知的 ID 一律由 `background.js` 的 `NOTIF_ID` 生成，`NOTIF_TAB_PREFIXES` 是点击反查用的清单，新增一类通知要同时进这两处，否则"清理"与"点开跳转"会静默对不上（`tests/tab-auto-refresh/notifications.test.mjs` 有一条扫源码的守卫）
- `session-lost` 的 ID 用注册域而不是整页主机名：SSO 常落在兄弟子域，按主机名会为同一次掉线发出两条。收掉的时机是探针从 `lost` 翻回正常，以及站点不再被任何任务监控（`pruneStaleProbes`）
- 清理按时机分，不按"任务还存不存在"一刀切：`startTask` 清该标签页的 keyword-hit / task-stopped / task-paused（上一轮的结论已作废）；`stopTask` 只清 task-paused（keyword-hit 往往正是命中即停的产物，在 `stopTask` 里清等于当场撤回用户刚收到的通知）；`resumeTaskAuto` 只在真恢复了才清
- 点通知 = 把对应标签页带到前台并聚焦它的窗口，然后自动收掉。`chrome.windows` 不需要新权限（`tabs` 已给到 `windowId`）；标签页早就不在了就什么都不做

### 消息入口（`runtime.onMessage`）

- 守卫排在异步分发体的**第一行**：带 `sender.tab` 的来源（我们自己注入的 `content/keepalive.js`）只能用 `keepalive-query` 与 `user-activity`，其余一律 `ok: false` 回掉。MV3 下网页本来到不了这个入口，这条守的是同样带 `sender.tab` 的自己人。**新增页面侧消息类型必须同时登记进 `FROM_PAGE_TYPES`**，漏登记的表现是那条功能静默失效（注入脚本自己吞掉失败），由 `tests/tab-auto-refresh/message-gate.test.mjs` 扫 `keepalive.js` 源码比对钉住
- 反向刻意不守：弹窗发 `user-activity` 自己就空转（只认 `sender.tab.id`，不看 msg 里的 id），`keepalive-query` 是只读配置快照
- `save-settings` 的载荷先过 `pickKnownSettings`（`shared/logic.js` 纯函数）再进 `patchSettings`：只留 `DEFAULT_SETTINGS` 的**自有**键（判据不能用 `in`，否则 `constructor` 那批原型链键全被收下），未知键丢弃——进了 `settings` 就会随 `sync` 漫游并占配额。只管键不管值，值的形状由读侧（`normalizeStoredSettings` / `normalizeWebhookUrl`）负责
- 一条消息有三处名字要两头对齐，此前一处也没对过（A32）：**① 类型名**（弹窗与页面发出的 `type` ↔ 分发链上 `msg.type` 那几个分支字符串）、**② 请求载荷键**（`send` 出去的每个键 ↔ 分支里读的每个 msg 属性）、**③ 应答字段**（`sendResponse` 回的对象 ↔ 弹窗读的每个 res 属性）。三段全是跨文件字面量、全没有 import，改一边另一边一个字都不会报错，症状永远是"点了没反应"而不是"报错了"：类型名打错落到分发链末尾，回一个 `{ok:false}`，而 `prune-now` 与 `resume-task` 两个调用点把返回值甩掉不看，连失败都不知道；载荷键打错那边读到 `undefined`，而 `undefined` 在这几个参数上全是合法输入（"继续盯守"当成没勾、关键词当成没填），没有一条路径抛错也没有一行日志说这里少了字段。判据在 `tests/tab-auto-refresh/message-ledger.test.mjs`，按花括号配对从真实源码里切出对象字面量求键名、不执行任何函数体（跑起来对账要先造一份假载荷，那等于把待核对的字面量再抄第三遍）。**新增一条消息、加删一个载荷键或改一个应答字段，三本账一起对**；该文件末尾记着实测：从弹窗这一头改坏 ①②③ 全盲，从背景那一头改坏 ② 也盲，因为测试侧那一份是**第三份抄本**——唯一发过 `keepWatching: true` 的用例发完从没回头看 `onHit`，两份真源码之间的账没人对，抄本自己多齐都对不上任何东西
- 保活配置到页面有两条路：注入后 `keepalive-query` 拉一次快照，之后 `tabs.sendMessage` 推变更。两条路必须给同一个形状——推送载荷、`keepalive-query` 应答、`applyConfig` 读的字段**三方齐平**，同一条门禁钉住。字段名对不上时页面上那个 cfg 属性是 `undefined`，等于把对应开关判成关，页面不报错，只是从此不心跳

### 弹窗

- Chrome 弹窗外框上限 800×600，整页高度必须留在 600px 内。宽度 400px，10 个开关用 `repeat(2, minmax(0,1fr))` 双列网格（不能写成 `1fr`，`1fr` 的隐含下限是 `min-content`，长标签会把列撑成不等宽），所以标签必须短且一律单行
- 弹窗按 id 取控件与 `popup.html` 要全量对账（A29）：`$()` 就是 `getElementById`，取不到回 null，紧跟的 `.addEventListener` 抛在模块顶层——整个弹窗当场白屏，不是少一行。今天 42 处字面量取值全对得上，判据在 `popup-repopulate.test.mjs`（带"至少切出 40 个"的正向见证，方向单向：HTML 多一个没人取的 id 不算错）。按变量取的那两处由 `popup-save-timing.test.mjs` 钉。**改 id 名要连着改 js**，这条就是防它
- 渲染那条通道（截图与 `--measure` 同一套）遇到页面报错一律判红（A29）：pageerror 与 console error 攒进同一份清单，末尾非空就 exit 1。此前它们只往终端打一行，退出码照 0——意思是"上一轮那六个高度数字"出自一条页面死了也照样绿的通道。原先那句"跑完固定有一行 404"的已知噪音这次从源头去掉：临时服务器对 `/favicon.ico` 直接回 204（Chrome 每次加载都来要，而报错文本里不含网址、没法与真错按文本分开），于是剩下的每一条 404 都是"该在而不在"；判据同时钉着"两条订阅都进同一份清单""清单非空必须改退出码""console 订阅里不许有按文本放行的分支"
- 这条 600px 上限怎么量（A28）：`node scripts/screenshot-popup.mjs --measure` 把弹窗按六个形状各真渲染一遍，打印**最深一条底边**并跟 600 比，任一超出就 exit 1。之所以量底边而不是"有没有滚动条"：`body` 是 `overflow: hidden`，超出部分不折叠也不出滚动条，**直接裁掉**，所以"弹窗不出滚动条"这句话判不了任何事。2026-09-19 实测六个形状 541 / 571 / 561 / 510 / 540 / 380px，最紧的是"填了合法 webhook 地址"那一种，预算 29px。**新增一条会显示的行就要回来加一个形状**（形状清单在脚本里的 `PROBES`，它引用哪个场景、补丁键真不真实由 `screenshot-mock.test.mjs` 钉住）
- `body` 用 `flex` 加 `max-height: 600px` 兜底，唯一的弹性块是任务列表，列表封顶 108px，第 3 行露头当"下面还有"的提示。任务再多也不会拉长整页——那 108px 是硬封顶，所以 `--measure` 不逐任务数一样量
- 微信配置走二级视图整页切换（`body.wx-mode`），四行输入框直接铺在主视图里必然顶破上限
- `[hidden]` 会被作者样式里的 `display` 压过（`.row` 是 `display:flex`），已全局声明 `[hidden] { display: none !important }`
- 弹窗每秒重新拉 alarm 列表再重绘倒计时，因为 alarm 周期触发不会触发 `storage.onChanged`；同一个循环里读一次跳过痕迹（`syncSkipTraces`，只点名读在场任务的 `rt:skip:<tabId>`）
- 任务行末的 `.skip` 是"上一次到点为什么没刷"。它由 `renderCountdowns` 每秒重绘，`span` 在 `buildTaskItem` 里就挂好、平时 `hidden`。**正文只放短理由，时间戳进 `title`**：400px 宽的行内多一段时分秒会把 `task-sub` 挤到换行，行高一换整页就破 600px。显示还要过 `skipEntry` 的压制：全局暂停与 `task.autoPaused` 两种情形不显示（这两件事行内本来就有角标和状态文字，再缀一句是重复），所以"采集四条、显示两条"是刻意的，别按显示的口径去改采集
- 保存设置时要合并既有 `settings`，否则只改复选框会丢掉 `lastIntervalSec`
- 走 `settings` 的文本框一律绑两条：`input`（去抖 500ms 写盘，同时重算状态行）与 `change`（回车、失焦即时写）。新增这样的框必须同时进 `popup.js` 的 `TEXT_SETTING_INPUT_IDS`，只写进 `saveSettings` 就等于让它退回"只有失焦才保存"——那条反-drift 守卫会红。为什么不逐字符立即写：一笔 `sync.set` 会回流成 `storage.onChanged`，弹窗每敲一个字就重读一遍存储、整体重绘一次，后台那份 settings 快照也跟着每次失效。弹窗一失去焦点就整体销毁，`change` 常常根本不触发，所以 `visibilitychange → hidden` 与 `pagehide` 各补一次 `flushPendingSave()`（没有待写就一笔都不写）；那是补救不是保证，文档正在销毁，真机检查记在 `BACKLOG.md` V1 (e)。两个「发送测试」都必须先 `await saveNow()` 再 `send`，且都要 `try/finally` 复位按钮。以上由 `tests/tab-auto-refresh/popup-save-timing.test.mjs` 钉住：四个写盘时机的函数接假时钟真跑，其余按源码形状
- 当前标签页已有任务时，`init` 要把该任务的 `keywords`（走 `getTaskKeywords`，旧单串也认）、`onHit === "continue"`、实际间隔回填进输入控件（`populateTaskFields`）。不回填的后果是数据丢失而不是显示缺失：用户只能停掉再重开，而重开读的是空框，原来的关键词监控静默消失。回填只在 init 做一次、排在 `initPresetSelect()` 之后（要盖掉它按 `lastIntervalSec` 的预填），**不得挂到 `storage.onChanged` 的重绘回流上**——回流反复发生，挂上去会抹掉用户正在输入的字；没有任务时早退，一个字都不动。判据与顺序由 `tests/tab-auto-refresh/popup-repopulate.test.mjs` 钉住（切源码跑，popup 没有 DOM 库可测）
- 设置区那 15 个控件只有一个填充函数 `populateSettingsFields()`，`init` 与 `storage.onChanged` 的 `changes.settings` 分支各调一次（回流那一次**必须排在 `refreshState()` 后面**，读的是刚归一化过的 `settings`；直接吃 `changes.newValue` 会绕过默认值合并与 `webhookEvents` 迁移）。不这么做的后果不是显示滞后而是撤销别人的改动：`saveSettings` 整份覆盖，弹窗开着多久，另一台设备的改动就被按打开那一刻的 DOM 翻回去多久（A18）。两个文本框判据缺一不可：五个走 settings 的文本框在**获得焦点**或**有去抖写盘挂在路上**时整组跳过（不逐框——凭据四项填三段留一段会拼出两边都不认识的组合，且马上被那笔待写的盘提交），复选框没有输入中间态所以照常同步；`saveSettings` 仍发整份快照（要改成只发差异键得连 `patchSettings` 的锁方向一起重新论证），所以这次修的是撤销窗口的长度，不是竞态本身。**新增设置项必须同时进 `saveSettings` 与这个函数**，那条"清单同源"守卫会红。远程关掉微信时退出 `body.wx-mode`，反向刻意不做。门禁 `tests/tab-auto-refresh/popup-settings-sync.test.mjs`（同步函数、`wechatStatus`、两个渲染、监听器整条链全切真实源码跑）
- 两条状态行（`#wechatRow` / `#webhookRow`）都是"配了才出现"：整页贴着 600px 上限，平时不占高度，所以新增行一律走 `hidden` 而不是 CSS 折叠。状态文字统一挂 `.wx-state`（nowrap + ellipsis，文案必须短），颜色只有 `.wx-state.ok` / `.wx-state.error` 两种。`renderWebhook()` 刻意写成单个自包含函数（含地址非法那一半判断），因为门禁是按花括号配对切它的真实源码执行的，拆成两个函数就要多注入一个名字；它的用例同样记在 `popup-repopulate.test.mjs`，其中"假 DOM 的初值要带上一轮残留"是硬要求——初值全给空串时"清空"与"什么都不做"拿到同一个值，对照跑出来是绿的（该文件末尾处 10、处 11 两条教训）。两行末尾的时刻统一由 `fmtClock` 格式化（与跳过痕迹的 `title` 共用同一个），它是 `toLocaleTimeString` 的包装，**用例不许把 `"09:07"` 写成期望值**：本机 zh-CN 得到 `09:07`、CI en-US 得到 `09:07 AM`，钉的是数字分组的形状（正好两组、每组两位），时刻按本地分量构造所以换时区也不必改用例（A19 补的账，跑真身在 `skip-trace.test.mjs` 第 5 层与 `popup-settings-sync.test.mjs` 各一次）
- i18n 通过 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` 注入，`title` 这条通道专门用来把开关的长解释挪出可见版面

### 跨 SW 实例的运行时状态

- MV3 的 service worker 闲置 30 秒即终止（收到事件或调扩展 API 会重置计时器），任何两端间隔为分钟级的累计或标记都不能放内存变量，否则计数每次从 0 起、功能静默失效。全部走 `chrome.storage.session`，读写用独立的串行队列 `rt()`。它与 `withTaskLock` 无关，在锁内再入队会死锁。新增一族按 tabId 存的键要同时进 `background.js` 的 `rtRoundKeys`，否则停任务与重开标签页都不清它——那就是 A17 的形状，由 `rt-lifecycle.test.mjs` 把清单取出来求值再对账钉住

## 验证清单

1. `node scripts/validate.mjs`。它会遍历整个仓库根做 JS 语法检查，所以 `_code-review/` 里的脚本语法错也会让它 exit=1；同一条理由适用于变异对照——**整仓副本必须放在仓库之外**，放在仓库里会被这次遍历当成待检文件（它还会报未跟踪文件）。
2. `node --test "tests/**/*.test.mjs"`（引号必需）
3. 改了对应功能后跑 `_code-review/` 里的回归脚本，清单与用法见 `_code-review/README.md`。这些脚本不在 CI 里跑，要手动跑；判退出码时别接管道（`| tail` 会把退出码换成 tail 的），需要看尾部输出就用 `${PIPESTATUS[0]}` 或先重定向到文件
4. UI 改动后用 `scripts/screenshot-popup.mjs` 重新生成 README 那两张图（`docs/tab-auto-refresh/popup.png` 与 `popup-wechat.png`，脚本一次写两张，两张都必须由它产出——手工截的那张没有再生成路径，必然漂移）。它的 chrome mock 是弹窗用面的**手抄副本**：抄漏一面的表现不是报错，是"截图看着挺好、其实那一块根本没渲染"（真实事故：mock 没有 `storage.session`，于是 A12 那句"上次跳过：你在操作"在图上永远出不来）。这条对齐由 `tests/tab-auto-refresh/screenshot-mock.test.mjs` 钉住，弹窗新增一块 chrome 读取就要回来加。`viewport.width` 必须与 `popup.css` 的 `body width` 一致，否则截图被裁；页面报错（pageerror 与 console error）现在一条都不放过——清单非空就 exit 1，原先那种"跑完固定有一行 404"（Chrome 自己来要 `/favicon.ico`）已改成服务器直接回 204，所以再出现任何 404 都是真缺资源。**重跑之后 diff 里出现图片不等于 UI 变了**：这两张图不是幂等产物，同一份源码隔一段时间再跑字节就会变（连跑两次则相同），要不要提交看的是产品源码自上次生成以来有没有过提交，没有就把图片 checkout 回去。改完 UI 顺手跑同一份脚本的 `--measure`（只量高度、一张图都不写）：六个形状各渲染一遍，最深一条底边超出 600px 就 exit 1，**新增一条会显示的行就要往 `PROBES` 里加对应形状**（形状清单旁边那条门禁钉的是"形状引用的场景真实、补丁键是真实设置键、清单非空"，不是"接线还在"）
5. 手工验证：在 `chrome://extensions` 开发者模式加载插件文件夹，验证设置与停止、倒计时归零后继续、右键菜单、立即刷新、角标、暂停恢复、快捷键记住上次间隔、自动清理通知（停任务、重开任务、重新登录后各自的通知要从通知中心消失，点通知要跳到对应标签页并带到前台）；30 秒任务下能在 DevTools 里看到注入的心跳事件，同站另开无关标签页无心跳；关键词命中弹通知并停任务；掉线后角标变红；验证墙与错误页自动暂停（含"验证码"字样但标题正常的页面不该被暂停；A3 之后再加两个面——整页挑战嵌在 iframe 里、顶层只剩空壳标题的要能自动暂停，页面上只有 reCAPTCHA 那种挂件小框的正常页面不该被暂停，见 `BACKLOG.md` V1 (f)）；webhook 填非法地址应立刻出现红字提示；弹窗整页高度不用在真机上量了（A28 起由第 4 条那个 `--measure` 就地量六个形状），真机只需扫一眼系统字体与浏览器 zoom 之下最底下那几张卡片有没有被裁掉。启动恢复这条只能真机验：开几个任务后重启浏览器（或在 `chrome://extensions` 重新加载扩展），任务要全部挂回原页面、不额外多开标签页、弹窗不卡住，被恢复的任务在 DevTools 的 `chrome://extensions → 背景 → Alarms` 里要同时看到 `refresh-<id>` 与 `hb-<id>`（缺 `hb-` 就是心跳又被排到写盘前面了）。开着"尊重你的操作"时，把某个任务页摆在当前窗口前台等它到点，不该被重载。A18 那条设置回流同步只能双机验：B 机改设置时 A 机开着的弹窗勾选要跟着变；在 A 机的 webhook 地址框里打一半别停手，B 机再改设置不该吃掉那半行字

## 环境备注

- 推送失败先看这里：先直接试 `git push`。2026-09-18 发布 2.1.0 时不带任何代理参数，推 main 与推 tag 都在几秒内成功。只有它失败才走下面那条 SOCKS 的路。
- 宿主有时会注入 `http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` 四个环境变量，全指向 `http://127.0.0.1:51734`，该通道到 GitHub 直接 502。环境变量优先级高于 git 的 `http.proxy` 配置，所以光加 `-c http.proxy=...` 不管用，必须先把四个变量摘掉，再走本机 10808 的 SOCKS：
  `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy=socks5://127.0.0.1:10808 push origin main`
  **但这条命令在这台机器上多一个更阴的失败面**（2026-09-19 查明）：`env` 被 `~/.local/bin/env` 挡在前面（`which -a env` 第一条就是它），它一个字节都不输出、退出码还是 0，于是 `env -u ... git <任何子命令>` 压根没执行 git——连 `env -u http_proxy git --version` 都是空的。这就是下面那种"零输出加退出码 0 的假成功"的成因之一。
  所以先用 `printenv | grep -i proxy` 确认变量在不在（**别用 `env | grep -i proxy`**，同样被挡，`env | head` 也是空的）。四个变量不在时就直接走 SOCKS、别套 `env`：
  `git -c http.proxy=socks5://127.0.0.1:10808 push origin main`
  2026-09-19 就是这样推成功的，`socks5://` 与 `socks5h://` 两种写法都实测可用。那天的现状：四个变量一个都没有，直连报 `curl 28 Recv failure: Connection was reset`、`ls-remote` 报 `Failed to connect to github.com port 443`，同一命令带上 10808 SOCKS 立刻成功——摘变量只是变量在场时才需要，路走不通先试 SOCKS，别默认病因一定是那几个环境变量。
  症状区分：报 502 是环境变量那个死代理；报 connection reset / 连不上 443 是直连路本身不通，SOCKS 可解；零输出加退出码 0 是 `env` 前缀把命令吞了；一直挂着没输出，先分清是网络还是凭据（见下条）。
- 上面那条推送命令有两种更难查的假成功：一是**一个字节都不输出**、退出码还是 0，实际什么都没推上去（2026-09-18 实遇到；2026-09-19 查明其中一种成因就是上面那个把命令整条吞掉的 `env` 前缀）；二是**照常打印 `Everything up-to-date`** 并返回 0，而同一次 push 前面已经写着 `RPC failed; curl 28`、`fatal: the remote end hung up unexpectedly`（2026-09-19 实遇到，远端仍停在旧 commit）。所以推送成功与否一律按下条用 `git ls-remote` 复核，别按退出码或按那行 up-to-date 收工。
- 推送挂住不动时，先确认到底是网络还是凭据，别默认是代理问题。2026-09-14 实测：`ls-remote` 与 `curl -X POST .../git-receive-pack` 都正常（后者 1.3 秒返回 401），说明网络通、缺的是凭据。而本机的凭据助手是 `git-credential-manager.exe`，它拿不到缓存的凭据时会去开交互界面，在非交互环境里表现为**一直挂住**（`git credential fill` 超时也返回不了任何东西）。快速判别：
  `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c http.proxy=socks5://127.0.0.1:10808 push origin main`
  （四个变量不在时去掉 `env -u ...` 前缀，否则这条也是零输出零退出码。2026-09-19 实测：`GIT_TERMINAL_PROMPT=0 git -c http.proxy=socks5h://127.0.0.1:10808 push origin main`——不带 `env` 前缀、也不清空凭据助手——一次推成功，缓存凭据可用，没弹任何界面。）
  立刻报 `could not read Username` 就是凭据缺失，需要在能弹界面的终端里推一次（或改用带 PAT 的地址），与代理无关。
- 判断有没有推上去不要看 `git status`。本机的 `origin/main` 远程跟踪引用会僵在旧 commit，会误报 `ahead N`。以 `git ls-remote origin refs/heads/main` 为准
- playwright 类脚本（弹窗截图、`_code-review/` 里几个门禁）需要显式给 NODE_PATH，否则报找不到 playwright。原先记的那个 codex-runtimes 路径随运行时一起没了，别再照抄；现在怎么给见下面"恢复本地门禁"
- 本机 node 是 2026-09-19 以便携压缩包装回的，**不在 PATH 上**：bash 与 PowerShell 里 `node` 仍解析不到，验证清单第 1、2 条一律按绝对路径调用，具体路径见下面"恢复本地门禁"。真实装不了的那段缺口由 CI 兜：push 后看 Actions，release workflow 自己跑 `validate.mjs` 与单测，任一失败就不建 Release。2.1.0 就是本地零条实跑、只靠 CI 发的——别把 CI 绿当成"本地验过"

### 恢复本地门禁

2026-09-19 本机现状：node v24.21.0 在 `C:\Users\<user>\AppData\Local\node-tools\node-v24.21.0-win-x64\node.exe`，不在 PATH 上；`winget` 可用但这条路走不通（见下）；`choco` / `scoop` / `nvm` 都没有。

1. 别再试 `winget install OpenJS.NodeJS.LTS --disable-interactivity`：实测它一个字节都不输出、几十分钟不结束、也不装出任何东西——它在等一个非交互环境给不出的提权确认。换官方压缩包：`https://nodejs.org/dist/` 下取 `node-vX.Y.Z-win-x64.zip`（本机默认代理能直连 nodejs.org），解压到 `%LOCALAPPDATA%\node-tools\`，全程不需要管理员权限
2. `node --version`（按绝对路径）要是 24.x，与 CI 的 `setup-node@v4 / node-version: 24` 对齐。22.x 也跑得起来，但那不等于 CI 的结果
3. 验证清单第 1、2 条：`node scripts/validate.mjs` 与 `node --test "tests/**/*.test.mjs"`（引号必需，去掉就被 shell 吃掉），本机把 `node` 换成上面那个绝对路径。这两步**不需要 `npm install`**——`scripts/` 与 `tests/` 里除了 `node:` 内置模块没有任何第三方 import，根 `package.json` 也没有 dependencies。压缩包里确实带 npm，但 `node.exe npm` 直接调不行，要用 npm 得先把解压目录加进 PATH
4. 只有截图与量高度（清单第 4 条）才需要 playwright，它是脚本运行时用 `createRequire` 现找的、不在仓库依赖里：`npm install -g playwright`，再在 PowerShell 里 `$env:NODE_PATH=(npm root -g)`，然后 `node scripts/screenshot-popup.mjs`（加 `--measure` 就只量高度）。bash 那一头同一条命令写成 `NODE_PATH="<解压目录>\\node_modules" node scripts/screenshot-popup.mjs --measure`——本机 2026-09-19 实测过一遍，六个形状最深 571px。脚本里 Chrome 路径写死 `C:\Program Files\Google\Chrome\Application\chrome.exe`，本机该文件在；换机器要连着改
5. 清单第 3 条不在这次恢复范围内：`_code-review/` 不入库，这台机器上从未存在，只能从原来那台拷过来，或按 CHANGELOG 里的描述重写门禁
