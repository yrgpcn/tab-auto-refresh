/* 静默 HTTP 心跳（doHeartbeat）的端到端用例——三条外发链路里唯一会自己动的那一条。
   此前一次也没执行过：共享桩件没有 fetch 桩件，background.js:522 那一句 fetch 在测试里是
   ReferenceError，被 doHeartbeat 外层的 catch 整个吞掉。于是"错误页连续两次才暂停"、
   "416 去掉 Range 重试"、"落到登录页算掉线信号"、"回到 2xx 静默自愈"四条判据
   全都只在纯函数层测过（logic.test.mjs 测的是 isErrorStatus/looksLikeLoginPage 本身），
   执行器侧一行没跑。现在桩件补了 env.reply()，才第一次真的把请求发出来。

   与 alarm-gate / detect-chain 的分工：那边管到点之后做什么，这边管
   "不重载页面的那条续会话通道"，它的返回值同时喂错误页、掉线两条判定。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import { SESSION_LOST_CONFIRM_SAMPLES } from "../../tab-auto-refresh/shared/logic.js";

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

async function boot({ tasks, settings, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || { 7: task() };
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: true, cookieBackup: false },
    settings
  );
  env.putTab(7, PAGE);
  await bootBackground(env);
  return env;
}

/* spec 留空表示"沿用上一次的应答" */
async function beat(env, spec, tabId = 7) {
  if (spec !== undefined) env.reply(spec);
  await env.fire.alarm("hb-" + tabId);
}

const reqs = (env) => env.calls.fetch;
const probe = (env) => env.store.local.sessionProbe || {};
const streak = (env, tabId = 7) => Number(env.store.session["rt:error:" + tabId]) || 0;
const paused = (env, tabId = 7) => (env.store.local.tasks || {})[tabId]?.autoPaused;
const ids = (env, prefix) => env.calls.notifCreated.map(([id]) => id).filter((i) => i.startsWith(prefix));
const badged = (env, key, want) => env.calls.badge.some(([k, v]) => k === key && v === want);

test("心跳是一笔带 Range 的 no-store 请求，只发这一笔", async () => {
  /* Range 的字面形状是要钉的东西：AGENTS.md 记着 bytes=数字-数字 落在 CORS 安全名单里，
     写成 bytes=-1024 之类会给每一次心跳引入一趟预检 */
  const env = await boot();
  await beat(env, { status: 200 });
  assert.equal(reqs(env).length, 1);
  const { url, init } = reqs(env)[0];
  assert.equal(url, PAGE, "请求的不是任务记录的网址");
  assert.equal(init.credentials, "include", "不带 cookie 的心跳续不了任何会话");
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "follow", "不跟随重定向就看不到「被踢到登录页」这件事");
  assert.match(String(init.headers && init.headers.Range), /^bytes=\d+-\d+$/, "Range 写成了 " + init.headers?.Range);
  assert.ok(init.signal, "没有超时控制器：站点挂起时这一拍会永远悬着");
  /* 健康的一拍什么都不该留下：探针的"值没变就不写盘"契约在这儿也要成立 */
  assert.equal(env.store.local.sessionProbe, undefined, "一次正常心跳就重写了一遍探针");
});

test("站点回 416：去掉 Range 重试一次，且只重试一次", async () => {
  const env = await boot();
  await beat(env, [{ status: 416 }, { status: 200 }]);
  assert.equal(reqs(env).length, 2, "416 之后没有重试，或重试个没完");
  assert.ok(reqs(env)[0].init.headers, "第一笔没带 Range");
  assert.equal(reqs(env)[1].init.headers, undefined, "第二次还带着 Range：站点照样回 416");
  assert.equal(reqs(env)[1].url, PAGE);
});

test("5xx 要连续两次才暂停，第一次只记计数", async () => {
  const env = await boot();
  await beat(env, { status: 503 });
  assert.equal(paused(env), undefined, "一次 5xx 就暂停任务：站点抖一下就把用户的监控停了");
  assert.equal(streak(env), 1);
  await beat(env, { status: 503 });
  assert.equal(paused(env) && paused(env).reason, "error-page");
  assert.deepEqual(ids(env, "task-paused"), ["task-paused-7"]);
  assert.ok(badged(env, "text", "⚠"), "角标没切到自动暂停那一态");
});

test("回到 2xx 静默解除暂停，并收掉那条暂停通知", async () => {
  const env = await boot({ tasks: { 7: task({ autoPaused: { reason: "error-page", at: 1 } }) } });
  await beat(env, { status: 200 });
  assert.equal(paused(env), undefined, "站点活着了还在暂停态：这条通道是错误页唯一的自愈出口");
  assert.ok(env.calls.notifCleared.includes("task-paused-7"), "通知留在通知中心里，任务其实已经恢复了");
  assert.equal(streak(env), 0);
});

test("一次 2xx 就把错误连击清零，判的是连续而不是累计", async () => {
  const env = await boot();
  await beat(env, { status: 500 });
  await beat(env, { status: 204 });
  await beat(env, { status: 500 });
  assert.equal(paused(env), undefined, "抖一下、恢复、再抖一下被当成了连续故障");
  assert.equal(streak(env), 1, "2xx 没把计数抹掉");
});

test("心跳被踢到登录页：连续确认才判掉线，确认后角标变红并发通知", async () => {
  /* 判的是**跟随重定向之后**的最终地址，请求地址本身没变——所以桩件必须能把
     res.url 与请求 url 分开给（真实 fetch 正是这样） */
  const env = await boot();
  const LOGIN = { status: 200, url: "https://a.test/login?next=%2Fboard" };
  for (let i = 1; i < SESSION_LOST_CONFIRM_SAMPLES; i++) await beat(env, LOGIN);
  assert.ok(!probe(env)["a.test"].lost, `${SESSION_LOST_CONFIRM_SAMPLES - 1} 次疑似就确认掉线：单次抖动即通知`);
  await beat(env, LOGIN);
  assert.ok(probe(env)["a.test"].lost, "达到确认次数却没判掉线");
  assert.deepEqual(ids(env, "session-lost"), ["session-lost-a.test"]);
  assert.ok(badged(env, "color", "#dc2626"), "角标没变红");
});

test("401/403 走掉线通道，不走错误页通道", async () => {
  /* 两条通道的语义必须分开：401 是"你没登录"，不是"站点坏了"。
     混进错误页通道就会把登录墙当成故障把任务暂停掉 */
  const env = await boot();
  await beat(env, { status: 401 });
  assert.equal(probe(env)["a.test"].sus, 1, "401 没被当成掉线信号");
  assert.equal(streak(env), 0, "401 进了错误页连击计数");
  await beat(env, { status: 403 });
  assert.ok(probe(env)["a.test"].lost);
  assert.equal(paused(env), undefined, "连续 401/403 就把任务暂停了：那是掉线，不是故障");
});

test("离线（fetch 被拒）什么都不留", async () => {
  const env = await boot();
  await beat(env, new Error("Failed to fetch"));
  assert.equal(reqs(env).length, 1, "一次都没发出去");
  assert.equal(env.store.local.sessionProbe, undefined);
  assert.equal(paused(env), undefined);
  assert.equal(streak(env), 0, "把网络异常记成了服务器故障：断网一会儿就会停掉任务");
  assert.deepEqual(env.calls.alarmsCleared, [], "离线不是停任务的理由，不能把心跳摘掉");
});

test("心跳开关关着、或任务已经没了：不发请求，把 alarm 摘掉", async () => {
  const off = await boot({ settings: { httpHeartbeat: false } });
  await beat(off, { status: 200 });
  assert.equal(off.calls.fetch.length, 0, "开关关着还在发请求");
  assert.deepEqual(off.calls.alarmsCleared, ["hb-7"], "关着却还留着定时器：每一拍都白跑一趟");

  const gone = await boot({ tasks: {} });
  await beat(gone, { status: 200 });
  assert.equal(gone.calls.fetch.length, 0, "没有任务还对着空气发心跳");
  assert.deepEqual(gone.calls.alarmsCleared, ["hb-7"]);
});

test("验证墙造成的暂停不由心跳解除", async () => {
  /* 心跳只看状态码，看不见墙。按 2xx 就解除的话，墙还立在那儿任务却重新开始刷页面 */
  const env = await boot({ tasks: { 7: task({ autoPaused: { reason: "captcha", at: 1 } }) } });
  await beat(env, { status: 200 });
  assert.equal(paused(env) && paused(env).reason, "captcha", "心跳把验证墙的暂停解除了");
  assert.equal(ids(env, "task-paused").length, 0);
});

/* 红→绿对照（2026-09-19 实跑：整份插件目录复制到仓库外，每处只改坏 doHeartbeat 函数体内的一处
   ——needle 在该区段内断言正好命中一次——TAR_BG 指过去跑本文件，结果如下）：
     1) Range 改成 "bytes=-1024"（会引入预检的那种写法）
        → 红 1：只红在"心跳是一笔带 Range 的 no-store 请求"
     2) 删掉 `if (res.status === 416) res = await send(false);`
        → 红 1：只红在"站点回 416"
     3) 删掉 else 分支里的 `await rtSet(rtTab(RT_ERROR, tabId), 0)`
        → 红 1：只红在"一次 2xx 就把错误连击清零"。
           没红在"回到 2xx 静默解除"上，符合预期：那条测的是解除暂停本身，
           计数清不清不影响它。所以"清零"这件事只有第 5 条用例在钉，别把它当冗余删掉
     4) `if (s >= PAUSE_CONFIRM_SAMPLES)` 改成 `if (s >= 1)`
        → 红 2：连"一次 2xx 就把连击清零"也红（阈值没了之后第三次 5xx 直接暂停）
     5) `looksLikeLoginPage(landed)` 改成 `looksLikeLoginPage(task.url)`（拿请求地址而不是落地地址）
        → 红 1：只红在"心跳被踢到登录页"。这条就是"判据靠的是 res.url"的门禁
     6) 把 `res.status === 401 || res.status === 403` 从掉线分支挪进 isErrorStatus 分支
        → 红 1：只红在"401/403 走掉线通道，不走错误页通道"
     7) doHeartbeat 开头的 `if (!task || !(await getSettings()).httpHeartbeat)` 改成 `if (false)`
        → 红 1：只红在"心跳开关关着、或任务已经没了"
     8) `t2.autoPaused && t2.autoPaused.reason === "error-page"` 删掉 reason 判断
        → 红 1：只红在"验证墙造成的暂停不由心跳解除"
   桩件侧的反向事实（同一天实跑，把 background-harness.mjs 里 `globalThis.fetch = env.fetch`
   那一行摘掉再跑）：本文件红 8/10，outbound.test.mjs 红 7/11。红的正是所有"断言请求发出去了"
   的用例，绿的 3+4 条全是"断言不该发请求"的否定式用例——它们对 fetch 存不存在无感。
   这就是 A6 第 9 条修之前三条外发链路一行没跑的直接证据，也说明一件事：
   只断言"没发、没写、没通知"的用例，永远不可能证明一条链路被执行过。 */
