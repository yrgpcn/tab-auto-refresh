/* 会话态里那几族按 tabId 存的状态要不要跟着任务生命周期走（A17）。
   这些分支此前一次也没被执行过：全套门禁里没有一条断言扫过 chrome.storage.session 的键集合。
   skip-trace 钉"该写的那条写对了"，detect-chain 钉"三次才暂停"，tab-removed 钉"任务搬到了新 id"
   ——全是写入侧，没有一条问"任务已经不在这张页上了，上一轮留下的计数还在不在"。
   而残留不是攒脏键那么简单：它的效果是把阈值悄悄调低（还留着 2 时一次命中就暂停，本该三次），
   用户看到的是"我没做错什么，任务自己停了"，而且没有任何一条日志说明为什么。

   与相邻门禁的分工：
     detect-chain 管"这一拍探到的算不算墙"，这里管"上一拍的计数还作不作数"；
     tab-removed 管"任务有没有搬到新 id、alarm 有没有重挂"，这里管"旧 id 的会话态跟没跟着拆"；
     skip-trace 有一条"停任务要清 rt:skip"，那只是四族里的一族，这里补上整批。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import * as CONFIG from "../../tab-auto-refresh/shared/config.js";

/* 清单守卫要在测试侧把后台那两行求值，需要一个同式的 rtTab；两边都是 base + ":" + tabId，
   拼歪了由下面的对账断言拦住 */
const rtTab = (base, tabId) => base + ":" + tabId;

/* 红→绿对照用：TAR_BG 指另一份 background.js（既当文本读，也交给共享桩件 boot）。CI 上不设 */
const BG_SRC = readFileSync(
  process.env.TAR_BG || new URL("../../tab-auto-refresh/background.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

/* onRemoved 与检测链都是"裸调异步、不把 promise 交回来"，派发完要排一轮宏任务 */
const flush = () => new Promise((r) => setTimeout(r, 50));

/* 四族键的字面量写在用例里，不 import 常量：常量拼错时两边会一起错，只有按字面量断言
   才让"后台清的是另一族键"这种失败露出来（与 skip-trace 同一条理由，对账见文件末尾那条） */
const FAMILIES = ["rt:activity", "rt:error", "rt:captcha", "rt:skip"];
const seed = (tabId) => ({
  [`rt:activity:${tabId}`]: Date.now() - 1000,
  [`rt:error:${tabId}`]: 1,
  [`rt:captcha:${tabId}`]: 2,
  [`rt:skip:${tabId}`]: { reason: "user-active", at: 5 }
});
/* 会话态里这张页剩下的键：{键: 值}，值是 undefined 表示这条已经没了 */
const liveOf = (env, tabId) => {
  const out = {};
  for (const f of FAMILIES) out[`${f}:${tabId}`] = env.store.session[`${f}:${tabId}`];
  return out;
};
const survivors = (env, tabId) => Object.keys(liveOf(env, tabId)).filter((k) => env.store.session[k] !== undefined);

async function boot({ tasks, tabs, settings, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = Object.assign(
    /* 只留这一族用例真会读的几项：保活、静默心跳、cookie 备份全关掉，免得外发与注入混进来 */
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false, captchaGuard: true },
    settings
  );
  for (const t of tabs || []) env.putTab(t.id, t.url, t);
  await bootBackground(env);
  return env;
}

/* 让重开出来的 id 可预期（与 tab-removed.test.mjs 同一手法） */
function stubCreates(env, ids) {
  const seen = [];
  let i = 0;
  env.chrome.tabs.create = async (props) => {
    seen.push(props.url);
    const id = ids[i++];
    if (id === undefined) throw new Error("tabs.create 调用次数超出预期: " + props.url);
    env.putTab(id, props.url);
    return { id, url: props.url };
  };
  return seen;
}

/* 注入结果按调用形状分派：带 func 且不带 args = 验证墙探测（与 detect-chain 同形） */
const wallFact = (on) => ({
  top: true,
  title: on ? "Just a moment..." : "正常页面标题",
  url: PAGE,
  w: 1280,
  h: 900,
  assets: []
});
const inject = ({ hits, wall } = {}) => (opts) => {
  if (opts.args) return [{ result: hits }];
  if (opts.func) return [{ result: wallFact(!!wall) }];
  return undefined;
};

test("空跑哨兵：四族种子确实落在会话态里", async () => {
  /* 下面每一条都以"某几族该没"为断言。种子少写一族，那些用例就会因为"本来就没有"而通过 */
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }], session: seed(7) });
  assert.deepEqual(survivors(env, 7).sort(), [...FAMILIES].map((f) => `${f}:7`).sort(), "种子没落全");
});

test("停任务：四族会话态键一次清干净", async () => {
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }], session: seed(7) });
  await env.send({ type: "stop", tabId: 7 });
  assert.deepEqual(survivors(env, 7), [], "停任务之后会话态还留着上一轮的计数");
});

test("同一张页上重新开始任务：上一轮的连击与跳过理由作废", async () => {
  /* 弹窗改间隔、右键再点一次"开始"都走这条路，它不经过 stopTask，所以清通知那半边有、
     清计数那半边没有——正是 A17 的症状① */
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }], session: seed(7) });
  await env.send({ type: "start", tabId: 7, seconds: 120 });
  assert.deepEqual(survivors(env, 7), ["rt:activity:7"], "连击计数或 rt:skip 跨轮活下来了");
});

test("重新开始不清 rt:activity：那是事实，不是上一轮的结论", async () => {
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }], session: seed(7) });
  const before = env.store.session["rt:activity:7"];
  await env.send({ type: "start", tabId: 7, seconds: 120 });
  assert.equal(env.store.session["rt:activity:7"], before, "活动戳被清了，下一拍就会刷到用户眼前");
});

test("重新开始之后，验证墙要重新数满三次才暂停", async () => {
  const env = await boot({
    tasks: { 7: task() },
    tabs: [{ id: 7, url: PAGE }],
    session: seed(7)
  });
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  env.onScript(inject({ wall: true }));
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "旧计数还在：一次命中就暂停了");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "两次就暂停，等于把阈值降到了 2");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused.reason, "captcha", "三次没暂停，阈值被改掉了");
});

test("关掉验证墙守卫：连击计数照样复位", async () => {
  /* 关着的时候不注入、不判定，但"这一拍没确认到墙"这个事实是有的，计数要跟着归零 */
  const env = await boot({
    tasks: { 7: task() },
    tabs: [{ id: 7, url: PAGE }],
    settings: { captchaGuard: false },
    session: seed(7)
  });
  let probed = 0;
  env.onScript((opts) => {
    if (opts.func && !opts.args) probed++;
    return undefined;
  });
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(probed, 0, "开关关着还在注入探测脚本");
  assert.equal(Number(env.store.session["rt:captcha:7"]) || 0, 0, "守卫关着时攒下的计数原封不动留着");
  assert.equal(env.store.local.tasks[7].autoPaused, undefined);
});

test("关掉再打开守卫：重新打开后的第一次命中不该被当成第三次", async () => {
  const env = await boot({
    tasks: { 7: task() },
    tabs: [{ id: 7, url: PAGE }],
    settings: { captchaGuard: false },
    session: seed(7)
  });
  await env.fire.tabUpdated(7, { status: "complete" }); /* 关着的这段时间里页面正常加载过 */
  await env.send({ type: "save-settings", settings: { captchaGuard: true } });
  env.onScript(inject({ wall: true }));
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(Number(env.store.session["rt:captcha:7"]), 1, "复位没生效，从残留值往上加");
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "用户以为开关复位了，任务却被暂停");
});

test("重开标签页：旧 id 的会话态整批拆掉，新 id 拿到一份干净的现场", async () => {
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }], session: seed(7) });
  stubCreates(env, [42]);
  await env.fire.tabRemoved(7, false);
  await flush();
  assert.deepEqual(Object.keys(env.store.local.tasks).map(Number), [42], "任务没搬到新 id，后面白断言");
  assert.deepEqual(survivors(env, 7), [], "旧 id 的四族键留在会话态里");
  assert.deepEqual(survivors(env, 42), [], "新 id 一上来就带着上一张页的计数");
});

test("只搬走一张页：别的标签页的会话态一条不动（反向守卫）", async () => {
  const env = await boot({
    tasks: { 7: task(), 9: task({ url: "https://b.test/x" }) },
    tabs: [{ id: 7, url: PAGE }, { id: 9, url: "https://b.test/x" }],
    session: Object.assign(seed(7), seed(9))
  });
  const nine = liveOf(env, 9);
  stubCreates(env, [42]);
  await env.fire.tabRemoved(7, false);
  await flush();
  assert.deepEqual(liveOf(env, 9), nine, "按前缀清整片会话态，把无关标签页的计数一起清了");
});

test("清单是唯一来源：两份清单跑出来的键，与用例里那四个键字面量对得上", () => {
  /* 以后新增一族按 tabId 存的状态，写的人只会用 rtTab(RT_NEW, tabId) 去读写，
     不会想到停任务/重开标签页那两处——残留就又回到 A17 的形状。这条把"记得进清单"
     变成一次红而不是靠 review 时想起来。
     守卫第一版只按正则扫那一行有没有出现 RT_ACTIVITY，结果 rtTabKeys 把 :tabId 漏拼了
     （删的是根本不存在的 "rt:activity"）它照样绿——所以这里是把清单跑一遍再对账 */
  const consts = {};
  for (const m of BG_SRC.matchAll(/^const (RT_[A-Z]+) = "([^"]+)";$/gm)) consts[m[1]] = m[2];
  for (const name of ["RT_ACTIVITY", "RT_ERROR", "RT_CAPTCHA"]) {
    assert.ok(consts[name], `源码里读不到 ${name} 的字面量，这条守卫已经在空跑`);
  }
  consts.RT_SKIP = CONFIG.SKIP_RT_PREFIX; /* 那一条是转引 config 的，不是字符串字面量 */

  /* 把清单那一行的右侧原样取出来在测试侧求值；rtTabKeys 还要能把 rtRoundKeys 当实参用 */
  const evalList = (name, extra) => {
    const m = BG_SRC.match(new RegExp("const " + name + " = (\\(tabId\\) => .+);"));
    if (!m) throw new Error(`源码里找不到 ${name}，清单改了写法就要连着改这条守卫`);
    const argNames = ["rtTab", ...Object.keys(consts), ...Object.keys(extra)];
    const values = [rtTab, ...Object.values(consts), ...Object.values(extra)];
    return new Function(...argNames, `return (${m[1]});`)(...values);
  };
  const round = evalList("rtRoundKeys", {});
  const all = evalList("rtTabKeys", { rtRoundKeys: round });
  assert.deepEqual(round(7).sort(), ["rt:captcha:7", "rt:error:7", "rt:skip:7"]);
  assert.deepEqual(all(7).sort(), Object.keys(seed(7)).sort(), "全量清单与用例种子对不上");

  const used = new Set([...BG_SRC.matchAll(/rtTab\(\s*(RT_[A-Z]+)\s*,/g)].map((m) => m[1]));
  assert.ok(used.size >= 4, `只扫到 ${used.size} 族按标签页存的键，正则失效了（这条守卫本身在空跑）`);
  for (const name of used) {
    assert.ok(all(7).includes(`${consts[name]}:7`), `${name} 按标签页存却没进清单`);
  }
  /* 删除一律走清单，不许再出现手写的键数组——那正是"两处清单分叉"的起点 */
  assert.equal(
    BG_SRC.match(/chrome\.storage\.session\.remove\(\[/g),
    null,
    "又手写了一份会话态键删除清单，生命周期清理从此有两处真相"
  );
});

/* 红→绿对照（做法见 alarm-gate.test.mjs 末尾）：2026-09-19 本机实跑，副本
   D:\Github\_tar_ctl_a17（tests/ 与 tab-auto-refresh/ 同级，一轮只改坏一处，跑全套 350 条）。
   pristine 350 全绿，九条全部转红，这批没有零红项：
     K1 startTask 里那句 session.remove(rtRoundKeys) 删掉（回到 A17 之前的形状）→ 红 2：
        "同一张页上重新开始任务" + "重新开始之后，验证墙要重新数满三次才暂停"
     K2 rtRoundKeys 漏掉 RT_CAPTCHA → 红 5：停任务 / 重新开始 / 三次才暂停 / 重开标签页 / 清单守卫
     K3 rtRoundKeys 把 RT_ACTIVITY 也当结论清了 → 红 3：重新开始 / "重新开始不清 rt:activity" / 清单守卫
     K4 rtTabKeys 退回手写三份且与 rtRoundKeys 分叉（少 captcha）→ 红 3：停任务 / 重开标签页 / 清单守卫
     K5 probeCaptcha 关守卫时提前 return、不复位计数 → 红 2：关守卫复位 / 关掉再打开守卫
     K6 reopenTaskTab 不拆旧 id 的会话态 → 红 1：重开标签页
     K7 reopenTaskTab 改成 chrome.storage.session.clear()（清整片）→ 红 1：反向守卫那条
     K8 新增一族 RT_HOP 并用 rtTab 读写却没进清单 → 红 1：清单守卫（报 "RT_HOP 按标签页存却没进清单"）
     K9 行为不变、stopTask 退回手写四族 → 红 1：清单守卫（报"又手写了一份会话态键删除清单"）
   分工看得清楚：K1/K5/K6/K7 由行为用例抓，K2/K3/K4/K8/K9 由清单守卫抓——后者四条里有三条
   行为上也红，K8/K9 两条只有守卫红，正是"防以后"那半边。
   顺带记一笔本文件自己撞出来的：清单守卫的第一版只按正则扫 rtTabKeys 那一行有没有出现
   RT_ACTIVITY 这个名字，于是"漏拼 :tabId"（删的是不存在的 "rt:activity"）从它眼皮底下过掉了，
   是行为用例先红的。改成把清单取出来求值再对账之后，K4 这一类才真拦得住。 */
