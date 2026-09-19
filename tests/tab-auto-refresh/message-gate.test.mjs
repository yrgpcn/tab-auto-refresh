/* A9 的门禁：runtime.onMessage 的分发口要认来源，设置增量要按已知键收。
   改之前的状态是"分发全程不看 sender"，且 save-settings 把 msg.settings 整份合并进 settings
   再写盘。MV3 下普通网页到不了这个入口，所以这不是"任意网页能调"的洞——真实存在的来源是
   我们自己注入到被监控页里的 content/keepalive.js，它带的就是 sender.tab。
   这条守卫把"页面不能起停任务、不能改设置"从"碰巧没写"变成代码里的约束。
   白名单守的是另一半：意外来键一旦进 settings 就会跟着 sync 漫游到用户其它设备、占配额，
   而且没有任何代码读它，属于纯污染（`lastIntervalSec` 被弹窗载荷抹掉是同一形状的事故）。

   桩件来自 tests/helpers/background-harness.mjs，被测的是真实的 background.js。
   env.send(msg, sender) 第二参就是 sender，缺省为 {}，正好对应弹窗（扩展自身，无 tab）。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import { DEFAULT_SETTINGS } from "../../tab-auto-refresh/shared/config.js";

/* 被测的三个文件都能指到仓库外的副本：TAR_BG 是背景本体（沿用共享桩件的口子），
   TAR_LOGIC 是白名单纯函数所在那份——对照里有一处改的就是它的判据 */
const { pickKnownSettings } = await import(
  process.env.TAR_LOGIC
    ? pathToFileURL(process.env.TAR_LOGIC).href
    : new URL("../../tab-auto-refresh/shared/logic.js", import.meta.url).href
);

const BG_SRC = readFileSync(
  process.env.TAR_BG || new URL("../../tab-auto-refresh/background.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const KEEPALIVE_SRC = readFileSync(
  new URL("../../tab-auto-refresh/content/keepalive.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const PAGE = "https://shop.example.com/pricing";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);
const pageSender = { id: "extension-self", tab: { id: 7, accountId: "" }, url: PAGE };

async function boot({ tasks = {}, settings } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks;
  env.store.sync.settings = settings || {
    keepAlive: false,
    httpHeartbeat: false,
    /* 不写这条就从 DEFAULT_SETTINGS 补成 true，keepalive-query 的期望值变得说不清 */
    skipOnActivity: false,
    lastIntervalSec: 300
  };
  env.putTab(7, PAGE);
  await bootBackground(env);
  return env;
}

/* 一次调用之后的全部可见后果。守卫失效时这些里至少有一项会动 */
const fingerprint = (env) =>
  JSON.stringify({
    local: env.store.local,
    sync: env.store.sync,
    session: env.store.session,
    alarms: env.calls.alarmsCreated,
    cleared: env.calls.alarmsCleared,
    reloaded: env.calls.reloaded,
    navigated: env.calls.navigated,
    toTabs: env.calls.messagesSent,
    fetch: env.calls.fetch,
    notif: env.calls.notifCreated,
    badge: env.calls.badge
  });

/* 每条弹窗专用类型都要被页面来源拒掉，且拒得"什么都没发生"。
   参数表带 setup，是因为有几条要在有任务的环境下才谈得上副作用（stop / resume-task） */
const POPUP_ONLY = [
  { type: "prune-now" },
  { type: "start", msg: { tabId: 7, seconds: 60 } },
  { type: "stop", msg: { tabId: 7 }, task: true },
  { type: "reload-now", msg: { tabId: 7 }, task: true },
  { type: "toggle-pause-all" },
  { type: "save-settings", msg: { settings: { keepAlive: false } } },
  { type: "wechat-test" },
  { type: "webhook-test" },
  { type: "resume-task", msg: { tabId: 7 }, task: { autoPaused: true } }
];

test("页面来源发每一条弹窗专用类型：一律拒绝，且没有副作用", async () => {
  for (const c of POPUP_ONLY) {
    const env = await boot(c.task ? { tasks: { 7: task(c.task) } } : {});
    const before = fingerprint(env);
    const res = await env.send({ type: c.type, ...(c.msg || {}) }, pageSender);
    assert.equal(res.ok, false, `${c.type} 被页面来源调用成功了，守卫没挡住`);
    assert.ok(
      String(res.error || "").includes(c.type),
      `${c.type} 的拒绝理由没点名类型，出问题时看不出是哪条被拒`
    );
    assert.equal(fingerprint(env), before, `${c.type} 被拒的同时还是留下了副作用`);
  }
});

test("页面来源发它自己该发的两种消息：照常工作（守卫没掐死合法通道）", async () => {
  const env = await boot();
  const q = await env.send({ type: "keepalive-query" }, pageSender);
  /* 回的是配置快照：heartbeat ← keepAlive，activityWatch ← skipOnActivity，boot 里两条都显式关着 */
  assert.equal(q.heartbeat, false, "keepalive-query 被拒了，保活脚本会拿不到配置");
  assert.equal(q.activityWatch, false, "keepalive-query 被拒了，活动监听拿不到配置");

  await env.send({ type: "user-activity" }, pageSender);
  assert.ok(env.store.session["rt:activity:7"] > 0, "user-activity 被拒了，活动态没写进去");
});

test("user-activity 只认 sender.tab.id，msg 里带别人 id 也不算", async () => {
  const env = await boot();
  env.putTab(8, "https://other.test/x");
  await env.send({ type: "user-activity", tabId: 8 }, pageSender);
  assert.ok(env.store.session["rt:activity:7"] > 0, "活动态没记到发消息那张页上");
  assert.equal(env.store.session["rt:activity:8"], undefined, "冒充别的标签页在活动，等于让它永不刷新");
});

test("弹窗来源（无 sender.tab）起任务照旧成功", async () => {
  const env = await boot();
  const res = await env.send({ type: "start", tabId: 7, seconds: 60 });
  assert.equal(res.ok, true, "正常路径被守卫挡住了");
  assert.deepEqual(Object.keys(env.store.local.tasks).map(Number), [7]);
  assert.ok(env.calls.alarmsCreated.some(([n]) => n === "refresh-7"));
});

test("save-settings 按已知键收：未知键不进盘，已知键与没人碰的键各归各位", async () => {
  const env = await boot();
  const res = await env.send({
    type: "save-settings",
    settings: { keepAlive: true, evil: "x", webhookEvents: ["keyword"] }
  });
  assert.equal(res.ok, true);
  assert.equal(env.store.sync.settings.keepAlive, true, "合法键被白名单误伤了");
  assert.equal(env.store.sync.settings.evil, undefined, "未知键进了 settings，会跟着 sync 漫游");
  assert.equal(env.store.sync.settings.webhookEvents, undefined, "已废弃的旧键又被写回去了");
  /* 弹窗载荷里根本没有 lastIntervalSec（那是后台自己记的），它必须原样留着 */
  assert.equal(env.store.sync.settings.lastIntervalSec, 300, "没碰的键被这次写盘抹掉了");
});

/* ---------- 纯函数层 ---------- */

test("pickKnownSettings 只留 defaults 里有的键", () => {
  assert.deepEqual(pickKnownSettings({ keepAlive: true, junk: 1 }, DEFAULT_SETTINGS), {
    keepAlive: true
  });
  /* 每一个默认键都得过得了，否则弹窗保存会静默丢开关 */
  const all = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "v"]));
  assert.deepEqual(Object.keys(pickKnownSettings(all, DEFAULT_SETTINGS)).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test("pickKnownSettings 不收原型链上的键，也不收非对象载荷", () => {
  /* 判据用 `in` 而不是自有属性就会在这里露出来：constructor / toString 都在原型链上 */
  const picked = pickKnownSettings({ constructor: 1, toString: 2, isPrototypeOf: 3 }, DEFAULT_SETTINGS);
  assert.deepEqual(picked, {}, "原型链上的键被当成合法设置键收下了");
  for (const bad of [undefined, null, "keepAlive", 7, true]) {
    assert.deepEqual(pickKnownSettings(bad, DEFAULT_SETTINGS), {}, `${String(bad)} 不该被当成设置增量`);
  }
  /* 数组没有默认键，整份丢弃而不是按下标收下 */
  assert.deepEqual(pickKnownSettings([1, 2], DEFAULT_SETTINGS), {});
});

test("页面侧消息类型与 FROM_PAGE_TYPES 齐平：新增一条得同步登记", () => {
  /* 白名单漏登记的表现是静默的：内容脚本发出新类型 → 被守卫拒 → 那条功能当场失效，
     而注入脚本自己把失败吞掉（keepalive.js 的 sendMessage 都带 .catch 或回调判空）。
     所以这里扫真实源码，把 keepalive.js 发出的 type 全捞出来比对 */
  const sent = [...KEEPALIVE_SRC.matchAll(/type:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 2, `只从 keepalive.js 里捞出 ${sent.length} 个类型，切法失效了`);
  const table = BG_SRC.slice(
    BG_SRC.indexOf("const FROM_PAGE_TYPES = new Set("),
    BG_SRC.indexOf("chrome.runtime.onMessage.addListener")
  );
  assert.ok(table.length > 20 && table.includes("user-activity"), "没切到 FROM_PAGE_TYPES，本条是空跑");
  for (const t of new Set(sent)) {
    assert.ok(table.includes(`"${t}"`), `keepalive.js 会发 ${t}，但它不在 FROM_PAGE_TYPES 里，会被守卫拒掉`);
  }
});

test("分发链里每条弹窗专用分支都登记在 POPUP_ONLY：新增分支漏登记就红", () => {
  /* 上一条守"页面能发的类型要登记"，这条守另一半：背景里新写一条分支而 POPUP_ONLY 没加，
     那条分支就不再被"页面来源要拒"覆盖，测试却照样全绿。A8 加 webhook-test 时就是这么露出来的 */
  const handled = [...BG_SRC.matchAll(/msg\.type === "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(handled.length >= 6, `只从分发链切出 ${handled.length} 个类型，needle 失效了，本条是空跑`);
  const pageTypes = BG_SRC.slice(
    BG_SRC.indexOf("const FROM_PAGE_TYPES = new Set("),
    BG_SRC.indexOf("chrome.runtime.onMessage.addListener")
  );
  assert.ok(pageTypes.length > 20, "没切到 FROM_PAGE_TYPES，本条是空跑");
  for (const t of new Set(handled)) {
    if (pageTypes.includes(`"${t}"`)) continue;
    assert.ok(
      POPUP_ONLY.some((c) => c.type === t),
      `${t} 是弹窗专用分支却没进 POPUP_ONLY，来源守卫对它没有覆盖用例`
    );
  }
});

test("守卫排在分发链最前面，新增分支自动在守卫之后", () => {
  const guard = BG_SRC.indexOf('if (sender && sender.tab && !FROM_PAGE_TYPES.has(');
  const firstBranch = BG_SRC.indexOf('if (msg.type === "prune-now")');
  assert.ok(guard > 0 && firstBranch > guard, "守卫不在分发入口，后面新增的分支会绕过它");
});

/* 红→绿对照（副本一律放仓库外，别污染 validate.mjs 的全仓扫描；两个入口都要指过去）：
     V=/tmp/tar-a9 && rm -rf $V && mkdir -p $V && cp -r tab-auto-refresh/. "$V/"
     # 1) 改前源码 = A9 之前那版（实跑时就是当时的 HEAD：A7 已提交、A9 还没动手），
     #    background.js 与 shared/logic.js 两份一起换。A9 提交后 HEAD 已含守卫，
     #    要取回这一版得用 A9 那个 commit 的父，别照抄下面的 HEAD
     git show HEAD:tab-auto-refresh/background.js > "$V/background.js"
     git show HEAD:tab-auto-refresh/shared/logic.js > "$V/shared/logic.js"
     # 2~8) 每次只改副本里的一处（字符串替换）
     V="$(cygpath -w "$V")" && TAR_BG="$V/background.js" TAR_LOGIC="$V/shared/logic.js" \
       node --test tests/tab-auto-refresh/message-gate.test.mjs

   2026-09-19 实跑结果（八处，逐处的红名单是跑出来的、不是推的）：
     1 改前源码          → 红 6 条：「每条都拒」「save-settings 白名单」「齐平」「守卫在最前面」，
                           外加两条纯函数用例——改前的 logic.js 里没有 pickKnownSettings，
                           动态导入拿到 undefined 就抛错。这算"函数不存在"而不是"判据不对"，
                           真正判白名单判据的是下面第 6 处
     2 去掉来源守卫      → 红 2 条：「每条都拒」+「守卫在最前面」（后者扫的是源码，守卫整块删掉就没有 needle）
     3 守卫方向反了      → 红 4 条：「每条都拒」「页面两种照常」「user-activity 认 sender」
                           +「守卫在最前面」——第 4 条是顺带红：needle 里带着 `!`，取反后扫不到
     4 守卫挪到第一条分支之后 → 红 2 条：「每条都拒」（prune-now 那一行逃过守卫）+「守卫在最前面」。
                           这处是"顺序"那条用例存在的理由：行为上只有第一条分支受影响，
                           循环里其它七条照旧全绿，只靠行为断言会漏掉它
     5 save-settings 绕过白名单 → 只红「save-settings 按已知键收」
     6 白名单判据换成 in         → 只红「不收原型链上的键」
     7 user-activity 改认 msg.tabId → 只红「msg 里带别人 id 也不算」
     8 FROM_PAGE_TYPES 漏登记 user-activity → 红 3 条：「页面两种照常」「user-activity 认 sender」
                           +「齐平」。前两条是功能真的被守卫掐死了（合法通道断），第三条才是本意：
                           白名单与内容脚本实际发的类型对不上，表现就是这个静默拒

   ---------- A8 加的第 9 处（同一天实跑，脚本在仓库外 ctl-a8/）----------
   跑法换了：A8 的变异要同时落在 background.js 与 tests/ 自己，TAR_BG/TAR_LOGIC 两个入口
   换不到测试文件本身，所以整仓复制到仓库外、在副本里跑本文件（基线 122 条全绿，四个文件一起）。
     9 POPUP_ONLY 漏登记 webhook-test → 只红 1 条：「分发链里每条弹窗专用分支都登记在 POPUP_ONLY」。
        「每条都拒」照旧绿——它遍历的是 POPUP_ONLY 自己，少一条就少查一条，永远不会红。
        这正是这条新守卫存在的理由：新增一条分发分支而忘了登记，表现是覆盖面静默缩水。
        说明一下证据的边界：守卫与登记行是同一次改动里写的，没跑过"只写守卫、漏登记"那一版，
        所以这条的红来自上面的第 9 处变异，不是来自当时的现场 */
