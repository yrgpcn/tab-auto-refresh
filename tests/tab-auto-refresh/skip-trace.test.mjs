/* A12 第 1 条的门禁：到点被跳过要留下能看见的理由。

   四种 SKIP 理由（全部暂停 / 自动暂停 / 你在操作 / 标签页休眠）原先在 onAlarm 里
   一律不留痕——用户只看得到倒计时一遍遍归零、页面却不刷，"任务没在刷"只能靠猜。
   现在 SKIP 把 {reason, at} 写会话态 rt:skip:<tabId>，RELOAD 把它清掉，弹窗按在场任务
   每秒读一回、在任务行里补一句解释。

   门禁分五层，各管一段这段链条上真实会断的地方：
   1. 纯函数侧：跑 decideAlarmAction 收集所有 SKIP 理由，与弹窗的理由表求并集相等，
      每个键在两份语言包里都要有内容。清单是跑出来的，不是抄来的
   2. 执行器侧：写的是哪个键、形状对不对、连续两拍只留最近一次、真刷新时要清掉、停任务清掉
   3. 弹窗侧：读键的表达式与后台写键的表达式必须算出同一个键（跨文件耦合，只有两边各钉一次
      才不会一边改完另一边静默失效），坏形状要当没有，理由认不出要走兜底键
   4. 版面侧：chip 节点建了、每秒填了、空文字时 hidden 跟上了，行内字数没破 400px 预算
   5. 时刻本身：3、4 两层注进去的都是假时钟，真实 fmtClock 的补零与"只取时分"由这一层跑
      （A19：名字里带 fmtClock 的用例一次也没调用过真身）

   红→绿对照实跑见文件末尾。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { SKIP_RT_PREFIX } from "../../tab-auto-refresh/shared/config.js";
import {
  ALARM_ACT,
  ALARM_SKIP_REASONS,
  ALARM_SKIP_UNKNOWN_KEY,
  decideAlarmAction
} from "../../tab-auto-refresh/shared/logic.js";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const load = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const loadMessages = (rel) => {
  const raw = JSON.parse(load(rel));
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v.message || "");
  return out;
};
const LOCALES = {
  zh_CN: loadMessages("../../tab-auto-refresh/_locales/zh_CN/messages.json"),
  en: loadMessages("../../tab-auto-refresh/_locales/en/messages.json")
};

/* 红→绿对照用：TAR_POPUP_SRC 指到仓库外那份副本里的 popup.js（只读文本，不 import）。CI 上不设 */
const POPUP_SRC = process.env.TAR_POPUP_SRC
  ? readFileSync(process.env.TAR_POPUP_SRC, "utf8").replace(/\r\n/g, "\n")
  : load("../../tab-auto-refresh/popup.js");
const CSS_SRC = load("../../tab-auto-refresh/popup.css");

/* ---------- 1. 理由表与判定函数的并集 ---------- */

const TASK = { intervalSec: 300, createdAt: 1, url: "https://a.test/board" };
const TAB = { id: 7, url: "https://a.test/board", windowId: 1, active: false };

/* 每种理由各给一份能真的判出它的输入。判不出来下面那条就会红，而不是悄悄少测一种 */
const SKIP_CASES = {
  "paused-all": { pausedAll: true },
  "auto-paused": { task: Object.assign({}, TASK, { autoPaused: { reason: "captcha" } }) },
  "user-active": { lastActivityAgoMs: 1000 },
  discarded: { tab: Object.assign({}, TAB, { discarded: true }), skipDiscarded: true }
};

const judge = (over) =>
  decideAlarmAction(
    Object.assign(
      { task: TASK, tab: TAB, pausedAll: false, skipOnActivity: true, skipDiscarded: false },
      over
    )
  );

test("跑一遍判定收集到的 SKIP 理由，与弹窗理由表两边对齐", () => {
  const produced = new Set();
  for (const [reason, over] of Object.entries(SKIP_CASES)) {
    const v = judge(over);
    assert.equal(v.action, ALARM_ACT.SKIP, `输入应该判成跳过 "${reason}"，实得 ${v.action}/${v.reason}`);
    assert.equal(v.reason, reason);
    produced.add(v.reason);
  }
  const declared = new Set(Object.keys(ALARM_SKIP_REASONS));
  assert.deepEqual(
    [...produced].sort(),
    [...declared].sort(),
    "判定能产出的理由与理由表不一致：表漏了一项弹窗会显示裸键名，表多了一项是死代码"
  );
});

test("每个理由键在两份语言包里都要有内容，且不许有反查不到的死键", () => {
  const keys = [...Object.values(ALARM_SKIP_REASONS), ALARM_SKIP_UNKNOWN_KEY];
  for (const loc of ["zh_CN", "en"]) {
    for (const key of keys) {
      assert.ok(LOCALES[loc][key], `${loc} 缺 ${key}，弹窗会把裸键名当文案显示`);
    }
    /* 兜底键必须真的兜得住：认不出的理由不能翻成空字符串 */
    assert.notEqual(LOCALES[loc][ALARM_SKIP_UNKNOWN_KEY], "");
    const orphans = Object.keys(LOCALES[loc]).filter(
      (k) => k.startsWith("skipReason") && !keys.includes(k)
    );
    assert.deepEqual(orphans, [], `${loc} 里有理由键不再被任何地方引用：${orphans.join(", ")}`);
  }
});

test("行内版面预算：理由文案短到挤得进 400px 宽的任务行", () => {
  /* 任务行左边是间隔 + 倒计时，右边是两三个小按钮，.task-sub 再挤上一句就会折行。
     折行本身不算错（列表内部滚动，弹窗不会长滚动条），但一句理由占两行就没法看了，
     所以中文按字、英文按字母各设一条上限，超了就得改短文案而不是放开限制 */
  for (const key of [...Object.values(ALARM_SKIP_REASONS), ALARM_SKIP_UNKNOWN_KEY]) {
    assert.ok(LOCALES.zh_CN[key].length <= 6, `zh ${key} 太长（${LOCALES.zh_CN[key]}）`);
    assert.ok(LOCALES.en[key].length <= 16, `en ${key} 太长（${LOCALES.en[key]}）`);
  }
  /* 可见那句只带理由，时刻归到悬停提示里 */
  for (const loc of ["zh_CN", "en"]) {
    assert.ok(LOCALES[loc].skipChip.includes("$REASON$"), "可见文案要给出理由");
    assert.ok(!LOCALES[loc].skipChip.includes("$TIME$"), "时刻挤在行内会折行，只放 title");
    assert.ok(LOCALES[loc].skipChipTitle.includes("$TIME$"));
  }
});

/* ---------- 2. 执行器：真实的 onAlarm 写会话态 ---------- */

async function boot({ tasks, tabs, settings, pausedAll, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  if (pausedAll) env.store.local.pausedAll = true;
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = Object.assign(
    /* 只留到点判定真会读的那几项，其余通道（心跳、备份、验证墙）全部关掉 */
    {
      keepAlive: false,
      httpHeartbeat: false,
      cookieBackup: false,
      captchaGuard: false,
      skipOnActivity: true,
      skipDiscarded: false
    },
    settings
  );
  for (const t of tabs || []) env.putTab(t.id, t.url, t);
  await bootBackground(env);
  return env;
}

const KEY = "rt:skip:7";

test("到点被全局暂停跳过：理由与时刻写进会话态，且这一拍仍然续跑定时器", async () => {
  const env = await boot({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url }], pausedAll: true });
  const before = Date.now();
  await env.fire.alarm("refresh-7");
  const e = env.store.session[KEY];
  /* 这里用字面量键而不是常量：常量拼错时两边一起错，只有后台侧钉住字面量
     才让"弹窗那边读不到"这种失败露出来（对照见文件末尾第 7 处） */
  assert.ok(e, `SKIP 没写 ${KEY}，弹窗无从解释`);
  assert.equal(e.reason, "paused-all");
  assert.ok(Number.isFinite(e.at) && e.at >= before && e.at <= Date.now() + 1, "时刻要能拿去显示");
  assert.deepEqual(env.calls.reloaded, []);
  assert.deepEqual(env.calls.alarmsCreated.map(([n]) => n), ["refresh-7"]);
  /* 写的是会话态，不能顺手落盘到 local */
  assert.equal("rt:skip:7" in env.store.local, false, "每拍都写的键落到了磁盘键区");
});

test("四种理由各记各的，弹窗才点得出名", async () => {
  const cases = {
    "paused-all": { pausedAll: true },
    "auto-paused": { tasks: { 7: Object.assign({}, TASK, { autoPaused: { reason: "captcha" } }) } },
    "user-active": { session: { "rt:activity:7": Date.now() - 1000 } },
    discarded: {
      settings: { skipDiscarded: true },
      tabs: [{ id: 7, url: TASK.url, discarded: true }]
    }
  };
  for (const [reason, over] of Object.entries(cases)) {
    const env = await boot(Object.assign({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url }] }, over));
    await env.fire.alarm("refresh-7");
    assert.equal(env.store.session[KEY] && env.store.session[KEY].reason, reason, `${reason} 记成了别的`);
    assert.deepEqual(env.calls.reloaded, []);
  }
});

test("连续两拍都跳过只留最近一次，旧痕迹被整条覆盖", async () => {
  const env = await boot({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url }],
    pausedAll: true,
    /* 上一拍留下的：理由不同、时刻是很久以前。追加而不覆盖的话这里看得出来 */
    session: { [KEY]: { reason: "user-active", at: 1 } }
  });
  const before = Date.now();
  await env.fire.alarm("refresh-7");
  const e = env.store.session[KEY];
  assert.equal(e.reason, "paused-all", "旧理由还留着，等于这一拍的结论丢了");
  assert.ok(e.at >= before, "时刻没刷新，弹窗会显示一句几分钟前的解释");
});

test("真的刷了这一拍：上一条解释要作废", async () => {
  const env = await boot({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url }],
    session: { [KEY]: { reason: "user-active", at: Date.now() - 5000 } }
  });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(env.calls.reloaded, [7]);
  assert.equal(env.store.session[KEY], undefined, "刷新成功后还挂着「上次跳过」，是一句过期话");
});

test("停任务把痕迹一并清掉", async () => {
  const env = await boot({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url }],
    pausedAll: true,
    session: { [KEY]: { reason: "paused-all", at: Date.now() } }
  });
  await env.send({ type: "stop", tabId: 7 });
  assert.equal(env.store.local.tasks[7], undefined);
  assert.equal(env.store.session[KEY], undefined, "会话态里留一条无人认领的痕迹");
});

/* ---------- 3. 弹窗侧：读键、认形状、翻理由 ---------- */

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 ${name}()`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}() 的花括号没闭合`);
}

/* sliceFunction 找的是 "function name("，async 前缀会被它丢掉——丢掉之后函数体里的
   await 直接是语法错，所以按源码原样补回 */
const slice = (name) =>
  POPUP_SRC.includes(`async function ${name}(`) ? `async ${sliceFunction(POPUP_SRC, name)}` : sliceFunction(POPUP_SRC, name);

const POPUP_FNS = [
  "syncSkipTraces",
  "skipChipText",
  "skipChipTitle",
  "skipEntry",
  "skipChipReason"
].map(slice).join("\n\n");

/* i18n 用回显假件（与共享桩件同一条理由）：不翻译文案，只证明"键与代入顺序走对了" */
const msgEcho = (key, subs) => (subs && subs.length ? `${key}:${subs.join(",")}` : key);
/* 假时钟：这几条要的是"时刻有没有传到 title"这个字面可比性。真身由第 5 层单独跑，
   别以为用例名字里带着 fmtClock 就等于测过它（A19 记的就是这个误会） */
const clock = (ms) => `T${ms}`;

function makePopup({ tasks = {}, session = {}, pausedAll = false } = {}) {
  const asked = [];
  const chrome = {
    storage: {
      session: {
        async get(keys) {
          asked.push(keys);
          const out = {};
          for (const k of [].concat(keys || [])) if (k in session) out[k] = session[k];
          return out;
        }
      }
    }
  };
  /* i18n 用回显假件：只证明"键与代入顺序走对了"，不证明文案翻得对（翻没翻由上面那层管） */
  const state = { tasks, skipMap: {}, pausedAll };
  const api = new Function(
    "chrome",
    "SKIP_RT_PREFIX",
    "ALARM_SKIP_REASONS",
    "ALARM_SKIP_UNKNOWN_KEY",
    "msg",
    "fmtClock",
    "tasks",
    "pausedAll",
    "skipMap",
    `${POPUP_FNS}
     return { syncSkipTraces, skipChipText, skipChipTitle, skipEntry, skipChipReason };`
  )(
    chrome,
    SKIP_RT_PREFIX,
    ALARM_SKIP_REASONS,
    ALARM_SKIP_UNKNOWN_KEY,
    msgEcho,
    clock,
    state.tasks,
    /* 形参与模块级变量同名同型：给个函数会让 `if (pausedAll)` 恒真，
       "压掉重复解释"那条就变成永远绿的空断言 */
    state.pausedAll,
    state.skipMap
  );
  return { api, asked, state };
}

test("空跑守卫：切出来的确实是这几个函数", () => {
  assert.ok(POPUP_FNS.length > 900, "切出来的源码过短，等于什么都没测");
  assert.match(slice("syncSkipTraces"), /^async function syncSkipTraces\(\)/);
  assert.match(slice("skipChipText"), /^function skipChipText\(/);
});

test("弹窗读的就是后台写的那个键，且只按在场任务读", async () => {
  const { api, asked } = makePopup({
    tasks: { 7: TASK },
    session: { "rt:skip:7": { reason: "user-active", at: 5 } }
  });
  await api.syncSkipTraces();
  /* 数组字面量按值比：写成别的键（少个冒号、写成 local 的那一族）在这里红 */
  assert.deepEqual(asked, [[`${SKIP_RT_PREFIX}:7`]]);
  assert.equal(api.skipChipText("7"), "skipChip:skipReasonUserActive");
});

test("没有任务时一个键都不读；痕迹属于别的标签页也不读", async () => {
  const empty = makePopup({});
  await empty.api.syncSkipTraces();
  assert.deepEqual(empty.asked, [], "任务数为 0 还去读存储");

  const { api, asked } = makePopup({ tasks: { 7: TASK }, session: { "rt:skip:9": { reason: "discarded", at: 5 } } });
  await api.syncSkipTraces();
  assert.deepEqual(asked, [[`${SKIP_RT_PREFIX}:7`]], "把已停任务的痕迹也读了进来");
  assert.equal(api.skipChipText("9"), "", "不在场的标签页冒出一行解释");
});

test("形状不认识的痕迹当没有：半条记录不该变成一句半截话", async () => {
  const { api } = makePopup({
    tasks: { 7: TASK, 8: TASK, 9: TASK, 10: TASK },
    session: {
      "rt:skip:7": "user-active",
      "rt:skip:8": { at: 5 },
      "rt:skip:9": { reason: "user-active" },
      "rt:skip:10": { reason: "discarded", at: 5 }
    }
  });
  await api.syncSkipTraces();
  /* 四条各管一半判据：8 缺 reason、9 缺 at，各被一项判据挡下；
     第一轮对照只放了"缺 at"的输入，去掉 reason 判据居然还是全绿，就是这么漏的 */
  assert.equal(api.skipChipText("7"), "", "字符串形状的旧数据被当成有效痕迹");
  assert.equal(api.skipChipText("8"), "", "缺理由的记录不该显示");
  assert.equal(api.skipChipText("9"), "", "缺时刻的记录不该显示");
  assert.equal(api.skipChipText("10"), "skipChip:skipReasonDiscarded");
});

test("认不出的理由走兜底键，绝不把内部枚举名给用户看", () => {
  const { api, state } = makePopup({ tasks: { 7: TASK } });
  state.skipMap["7"] = { reason: "made-up-reason", at: 5 };
  const text = api.skipChipText("7");
  assert.equal(text, "skipChip:skipReasonUnknown");
  assert.ok(!text.includes("made-up-reason"), "内部枚举名直接出现在文案里");
  assert.equal(api.skipChipTitle("7"), "skipChipTitle:skipReasonUnknown,T5");
  /* 反向：这一行没有痕迹时两句都得是空 */
  assert.equal(api.skipChipText("99"), "");
  assert.equal(api.skipChipTitle("99"), "");
});

test("数字与字符串两种 tabId 取到同一条解释", () => {
  /* renderCountdowns 手上只有 dataset.tab（字符串），构建行时用的是数字 id。
     哪天把 skipMap 换成 Map，这里立刻红 */
  const { api, state } = makePopup({ tasks: { 7: TASK } });
  state.skipMap["7"] = { reason: "user-active", at: 5 };
  assert.equal(api.skipChipText(7), api.skipChipText("7"));
  assert.equal(api.skipChipTitle(7), api.skipChipTitle("7"));
});

test("同一行已经说清楚了就不再重复：全局暂停与自动暂停各自压掉痕迹", () => {
  const trace = { reason: "user-active", at: 5 };

  const paused = makePopup({ tasks: { 7: TASK }, pausedAll: true });
  paused.state.skipMap["7"] = trace;
  assert.equal(paused.api.skipChipText("7"), "", "行里的倒计时位已经写着「已暂停」");
  assert.equal(paused.api.skipChipTitle("7"), "", "文字与悬停提示必须一起消失");

  const auto = makePopup({ tasks: { 7: Object.assign({}, TASK, { autoPaused: { reason: "captcha" } }) } });
  auto.state.skipMap["7"] = trace;
  assert.equal(auto.api.skipChipText("7"), "", "红字 chip 已经说了自动暂停");

  /* 反向对照：任务没有自动暂停、也没全局暂停时，同一条痕迹必须显示 */
  const plain = makePopup({ tasks: { 7: TASK } });
  plain.state.skipMap["7"] = trace;
  assert.equal(plain.api.skipChipText("7"), "skipChip:skipReasonUserActive");
});

test("文字与悬停提示走同一个判据，不可能一个显一个不显", () => {
  for (const name of ["skipChipText", "skipChipTitle"]) {
    const src = slice(name);
    assert.match(src, /skipEntry\(tabId\)/, `${name} 要经过 skipEntry`);
    assert.ok(!src.includes("skipMap["), `${name} 不许绕过 skipEntry 直接翻痕迹`);
  }
});

/* ---------- 4. 版面接线：节点建了、每秒填了、藏得掉 ---------- */

test("buildTaskItem 给每一行建一个常驻的 skip 节点", () => {
  const src = slice("buildTaskItem");
  assert.match(src, /\.className = "skip";/);
  assert.match(src, /\.dataset\.tab = String\(tabId\);/);
  assert.match(src, /sub\.appendChild\(skip\)/, "节点没挂进任务行");
});

test("renderCountdowns 每秒填 skip 节点，空文字时连 hidden 一起管", () => {
  const src = slice("renderCountdowns");
  assert.match(src, /querySelectorAll\("\.skip\[data-tab\]"\)/);
  assert.match(src, /node\.textContent = text;/);
  assert.match(src, /node\.hidden = !text;/, "空 span 也会占住分隔符的宽度");
  assert.match(src, /node\.title = skipChipTitle/);
});

test("痕迹跟着倒计时每秒重读：alarm 触发不触发 storage.onChanged", () => {
  const src = slice("syncAlarms");
  assert.match(src, /await syncSkipTraces\(\);/, "只在打开弹窗时读一次，开着也看不到新解释");
  const tick = POPUP_SRC.slice(POPUP_SRC.indexOf("setInterval("));
  assert.match(tick.slice(0, 400), /await syncAlarms\(\);\s*\n\s*renderCountdowns\(\);/);
});

test(".skip 只上色不声明 display，全局 [hidden] 规则还在", () => {
  assert.match(CSS_SRC, /\.task-sub \.skip \{[^}]*color: #b45309;[^}]*\}/);
  const rule = CSS_SRC.match(/\.task-sub \.skip \{[^}]*\}/);
  assert.ok(!/display/.test(rule[0]), "作者样式带 display 会压过 hidden 属性，藏不掉");
  assert.match(CSS_SRC, /\[hidden\] \{ display: none !important; \}/);
});

/* ---------- 5. 时刻本身：真身 fmtClock ---------- */

/* 上面两层里 fmtClock 一直是那个 `(ms) => "T" + ms`，测的是"时刻传到 title 这一路断没断"。
   真身是 toLocaleTimeString 的包装，它的补零与"只到分钟"此前一次也没被执行过（A19）。
   断言里不许出现 "09:07" 这样的字面量：本机是 zh-CN + Asia/Hong_Kong，CI 是 en-US + UTC，
   "09:07" 与 "09:07 AM" 都得算对。所以钉的是数字分组的形状——正好两组、每组两位。
   掉一位（补零退化）、多出第三组（把秒带进来）、少一组（把分钟丢掉）都会红。
   喂的时刻用本地分量构造，不写 UTC 毫秒：这样换时区也仍是"本机的 9 点 07 分" */
const FMT_CLOCK_SRC = slice("fmtClock");
const runClock = (ms) => new Function(`${FMT_CLOCK_SRC}\nreturn fmtClock;`)()(ms);
const digitGroups = (s) => s.match(/\d+/g) || [];

test("空跑守卫：fmtClock 切到的确实是那个包装函数，三处调用都还在", () => {
  assert.match(FMT_CLOCK_SRC, /^function fmtClock\(ms\) \{/);
  assert.ok(FMT_CLOCK_SRC.length > 60 && FMT_CLOCK_SRC.length < 400,
    `切出来 ${FMT_CLOCK_SRC.length} 字节，不像一个 toLocaleTimeString 的包装`);
  /* 一次数进 title、两次数进状态行。删掉任何一处，上面那些用例都不会红——它们各测各的，
     只有这条计数看得到"这一路的时刻没了" */
  assert.equal([...POPUP_SRC.matchAll(/fmtClock\(/g)].length, 4,
    "fmtClock 是一个定义加三处调用，数目变了要回来看这一层");
});

test("小时与分钟各占两位：9 点 07 分不退化成 9:7", () => {
  /* 两位都取个位起的输入：2-digit 换成 numeric 时只有这种时刻会露出来 */
  const s = runClock(new Date(2026, 0, 5, 9, 7, 0).getTime());
  assert.deepEqual(digitGroups(s), ["09", "07"], `实得 ${JSON.stringify(s)}`);
});

test("只到分钟：同一分钟的两端得到同一个串", () => {
  const a = runClock(new Date(2026, 0, 5, 9, 7, 0).getTime());
  const b = runClock(new Date(2026, 0, 5, 9, 7, 59).getTime());
  assert.equal(a, b, "秒进了显示，状态行与悬停提示每秒都在换字");
});

test("分钟没被丢掉：相邻两分钟必须不同", () => {
  const a = runClock(new Date(2026, 0, 5, 9, 7, 30).getTime());
  const b = runClock(new Date(2026, 0, 5, 9, 8, 30).getTime());
  assert.notEqual(a, b, "只显示到小时，一小时内两次投递长得一模一样");
});

test("坏时刻不许抛：留痕缺 at 时这是 init 同步链上的一手", () => {
  /* 真身拿 undefined / NaN 只会得到本地化的"无效时间"字样，走不到 catch 里那个 ""；
     这里钉的是不许抛，不是钉返回值——返回什么由本地决定 */
  for (const bad of [undefined, null, NaN, {}]) {
    assert.equal(typeof runClock(bad), "string", `喂 ${String(bad)} 抛了`);
  }
});

/* 红→绿对照：2026-09-19 本机实跑。做法是把整份仓库复制到仓库外（D:\Github\_tar_ctl_a12），
   在副本上改源码、跑本文件，一次一条变异，记下的都是实际看到的红名单而不是预测。
   22 条：前 19 条按预期变红，后 3 条反向对照必须保持全绿。

     1) config 里 SKIP_RT_PREFIX 改成 "rt:skipx"
        → 红 7 条：执行器 5 条 + "弹窗读的就是后台写的那个键" + "形状不认识的痕迹当没有"。
          这条最有价值：弹窗侧用的是常量、后台侧钉的是字面量，改常量只让一边跟着动，
          于是跨文件的键耦合真的红了（两边都写常量的话这条变异是绿的）
     2) 删掉 onAlarm 里 SKIP 分支的 rtSet
        → 红 3 条："到点被全局暂停跳过" "四种理由各记各的" "连续两拍都跳过"
     3) reason 写死成 "user-active"
        → 红 3 条：同 2
     4) at 写死成 1
        → 红 2 条："到点被全局暂停跳过"（时刻范围）与"连续两拍都跳过"
     5) 删掉 RELOAD 分支的 rtRemove → 只红在"真的刷了这一拍"
     6) 删掉 stopTask 会话态清单里的 RT_SKIP → 只红在"停任务把痕迹一并清掉"
     7) ALARM_SKIP_REASONS 去掉 discarded 一项
        → 红 3 条：并集、语言包内容、"形状不认识"（skipReasonDiscarded 反查不到 → 走兜底键）
     8) 删掉 syncAlarms 末尾的 await syncSkipTraces() → 只红在"痕迹跟着倒计时每秒重读"
     9) 弹窗的 session.get 参数换成 null（读整个会话态）
        → 红 3 条：键表达式、"没有任务时一个键都不读"、"形状不认识"
    10) 形状判据去掉 `typeof e.reason === "string"` → 只红在"形状不认识的痕迹当没有"
    11) 删掉 `if (!ids.length) return;` → 只红在"没有任务时一个键都不读"
    12) skipEntry 去掉 `|| pausedAll` → 只红在"同一行已经说清楚了就不再重复"
    13) skipEntry 去掉 autoPaused 分支 → 只红在同一条
    14) skipChipTitle 绕过 skipEntry 直接读 skipMap
        → 红 2 条：同上一条（暂停时文字空、提示还在）+ "文字与悬停提示走同一个判据"
    15) renderCountdowns 去掉 `node.hidden = !text` → 只红在"每秒填 skip 节点"
    16) buildTaskItem 去掉 sub.appendChild(skip) → 只红在"建一个常驻的 skip 节点"
    17) popup.css 给 .skip 加 display:inline-block → 只红在".skip 只上色不声明 display"
    18) 中文删掉 skipReasonDiscarded → 红 2 条：语言包内容 + 版面预算（取不到就抛）
    19) 英文多出 skipReasonGhost → 只红在"不许有反查不到的死键"

     R1) 只改中文措辞（"你在操作"→"你在忙"）→ 20 条全绿：文案本身不该被钉，钉的是键与长度
     R2) 改 .task-sub .next 的颜色 → 全绿
     R3) ACTIVITY_SKIP_MS 60000 → 90000 → 全绿：本门禁与那个阈值没有意外耦合

   两个第一轮实跑踩到的教训，都是"看着有断言、实际空跑"：
   a) 副本里的文件是 CRLF。跨行的 needle 一律命中 0 次，变异根本没发生，第一批有 10 条
      印成 "!! NEEDLE 0x" 就那样滑过去了——它既不是红也不是绿。所以对照必须逐条看输出，
      不能只看退出码。读进来先 replace(/\r\n/g, "\n")，那 10 条才真的对上
   b) 第 10 条第一次跑是绿的。原因不在判据太松，而在用例的输入：我给的三条坏记录
      全都缺 at，缺 reason 那半边判据从来没有单独生效过。补一条 { at: 5 } 之后才红。
      "覆盖每一项判据"要按判据配输入，不是按分支数个数 */

/* 第 5 层（fmtClock 真身）的对照：同一天实跑，脚本与变体文件在仓库外 D:\Github\_tar_ctl_a19。
   跑法与上面这批不同——本轮变异全在 popup.js 的源码文本里，不必整仓复制，
   把改坏的 popup.js 写成变体文件、TAR_POPUP_SRC 指过去即可。每个用例对
   skip-trace 与 popup-settings-sync 两个文件**分开各跑一遍**，混在一次 --test 里就看不出
   红在哪一层。基线（未改动的 popup.js 指过去）25/25 + 18/18 全绿。

     F1  2-digit 换成 numeric        → 红 1 条：小时与分钟各占两位
     F2  分钟整个丢掉                → 红 2 条：各占两位、分钟没被丢掉
     F3  把秒也带进显示              → 红 2 条：各占两位、只到分钟
     F4  正文改成立刻 return ""（A19 那条零红探针）→ 红 2 条：各占两位、分钟没被丢掉
     F5  删掉 skip chip 那一处调用   → 红 2 条：空跑守卫的调用计数、"认不出的理由走兜底键"
         （后者红是因为它比的是整串 title：时刻退化成裸毫秒数照样露出来，
           这一层要的真不是"函数被调用过"，而是"三个调用点还在原位"）
     F6  整段函数体换掉：去掉 try/catch 且把 hour 写成非法值
                                    → 红 4 条：本层全部四条，其中"坏时刻不许抛"只有这一处才红。
                                       它不是装饰：光把选项写坏而留着 catch，catch 兜住回 ""，
                                       那条照样绿——所以它的牙只在"没了 catch"时露出来
     RF1 （反向）选项键序换一下、拆成两条语句，行为不变 → 25 条全绿

   F1~F4 与 F6 同一轮里，popup-settings-sync 的"真时钟接在真渲染链上"各红 1 次；F5 在它那侧 0 红，
   这是对的：F5 只动了 skip chip 的调用，两行状态那两处仍然在。
   另一处判读前提：A19 原账记的是"改坏 fmtClock 全套 324/364 条零红"，本轮 F4 在两个文件里
   各红 2 条与 1 条，缺口确实被堵上了。 */
