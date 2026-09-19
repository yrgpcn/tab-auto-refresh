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

import { makeEnv, bootBackground, settles } from "../helpers/background-harness.mjs";
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
/* 等条件成立；等不到就返回 false，由调用方当"本用例是不是空跑"的哨兵用 */
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
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

test("站点挂住、15 秒到点 abort：连击计数一个字都不动", async () => {
  /* 这一类在 E3 之前结构上测不出来：桩件从不 await promise 型应答，也不兑现 init.signal，
     于是"心跳是一笔带 Range 的请求"那条用例里 `assert.ok(init.signal, ...)` 钉住的只是
     控制器的**存在**——到点不生效的话，这一拍永远悬着，而全套门禁照样全绿。
     现在把这一拍挂住、从桩件句柄打断（等价于计时器到点，不必真等 15 秒）。
     计数刻意从 1 起：往上加（当成一次 5xx）与清零（当成一次 2xx）两个方向都看得见 */
  const env = await boot({ session: { "rt:error:7": 1 } });
  env.reply(new Promise(() => {})); /* 收了请求不回应的站点 */
  const inflight = env.fire.alarm("hb-7");
  assert.ok(await until(() => env.pendingFetch().length === 1), "没把心跳挂住，本用例是空跑");
  assert.equal(reqs(env).length, 1, "挂住之前一笔请求都没发出");
  assert.ok(reqs(env)[0].init.signal, "这一笔没上超时控制器：站点挂起会把整拍悬住");
  env.pendingFetch()[0].abort();
  /* 等待必须带上限：桩件句柄的 abort 不生效时，后台自己那笔 15 秒计时器照样会把
     这一拍推落定，`await inflight` 就会等 15 秒然后全绿——句柄成了摆设却没人红（H5） */
  assert.ok(await settles(inflight), "叫停句柄没有让这一拍落定：桩件那半边的 abort 通道断了");
  assert.equal(streak(env), 1, "一次挂起被记成了服务器故障：连击阈值被这种抖动推着走");
  assert.equal(paused(env), undefined);
  assert.equal(env.store.local.sessionProbe, undefined, "挂起既不是掉线信号，也不是恢复");
  assert.deepEqual(env.calls.alarmsCleared, [], "站点慢不等于心跳该停，不能把 alarm 摘掉");
});

test("超时是从 init.signal 兑现的：把 abort 事件发到后台交出来的那个 signal 上", async () => {
  /* 与上一条的分工：上一条走桩件句柄（等价于计时器到点，但那是桩件自己的门），
     这一条不碰句柄，只把 abort 事件发到**后台传进来的那个 signal** 上。
     桩件要是压根没监听 init.signal（E3 之前正是那样），这一条就红在"那一拍始终没结束"。
     真实 Chrome 里 ctrl.abort() 还会把 signal.aborted 一并置真；这里只发事件，
     钉的是"这笔外发确实挂在该控制器上"那一半。等待必须自己带上限，
     否则桩件不回时挂的是用例本身，报出来的是超时而不是这句话 */
  const env = await boot({ session: { "rt:error:7": 1 } });
  env.reply(new Promise(() => {}));
  const inflight = env.fire.alarm("hb-7");
  assert.ok(await until(() => reqs(env).length === 1), "心跳没发出去，本用例是空跑");
  const sig = reqs(env)[0].init.signal;
  assert.ok(sig && typeof sig.addEventListener === "function", "后台没把超时信号交出来");
  sig.dispatchEvent(new Event("abort"));
  assert.ok(await settles(inflight), "signal 上的 abort 没人认账：这一拍永远悬在半路");
  assert.equal(streak(env), 1, "认了 abort 却又把它算进连击");
  assert.equal(paused(env), undefined);
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

/* 红→绿对照（2026-09-19 实跑，脚本 D:/Github/_tar_ctl_e3/run.mjs：整仓复制到仓库外，
   一轮只在副本里改坏一处——needle 必须正好命中一次，否则那处作废并打印出来。
   V1~V8 改的是 doHeartbeat 函数体内的一处，跑本文件；H3~H5 改的是桩件本身。
   基线（副本一字未改）本文件 12 条全绿。
   这八处此前在 10 条时代跑过一轮，这次是因为文件长到 12 条才重跑：结论一条没变，
   "只红在某一条"的说法在新增的两条超时用例上也成立——它们不碰状态码判据）：
     V1 Range 改成 "bytes=-1024"（会引入预检的那种写法）
        → 红 1：只红在"心跳是一笔带 Range 的 no-store 请求"
     V2 删掉 `if (res.status === 416) res = await send(false);`
        → 红 1：只红在"站点回 416"
     V3 删掉 else 分支里的 `await rtSet(rtTab(RT_ERROR, tabId), 0)`
        → 红 1：只红在"一次 2xx 就把错误连击清零"。
           没红在"回到 2xx 静默解除"上，符合预期：那条测的是解除暂停本身，
           计数清不清不影响它。所以"清零"这件事只有那一条在钉，别把它当冗余删掉
     V4 `if (s >= PAUSE_CONFIRM_SAMPLES)` 改成 `if (s >= 1)`
        → 红 2：连"一次 2xx 就把连击清零"也红（阈值没了之后第三次 5xx 直接暂停）
     V5 `looksLikeLoginPage(landed)` 改成 `looksLikeLoginPage(task.url)`（拿请求地址而不是落地地址）
        → 红 1：只红在"心跳被踢到登录页"。这条就是"判据靠的是 res.url"的门禁
     V6 把 `|| res.status === 401 || res.status === 403` 从掉线那一支摘掉
        → 红 1：只红在"401/403 走掉线通道，不走错误页通道"
     V7 doHeartbeat 开头的 `if (!task || !(await getSettings()).httpHeartbeat)` 改成 `if (false)`
        → 红 1：只红在"心跳开关关着、或任务已经没了"
     V8 `t2.autoPaused && t2.autoPaused.reason === "error-page"` 删掉 reason 判断
        → 红 1：只红在"验证墙造成的暂停不由心跳解除"

   ---------- E3：桩件这一头的三面门，各钉一面 ----------
   桩件此前既不 await promise 型应答、也不认 init.signal，所以"心跳是一笔带 Range 的请求"
   那条里的 `assert.ok(init.signal, ...)` 钉住的只是控制器的**存在**：到点不生效的话这一拍
   永远悬着，而门禁照样全绿。现在超时那一支有了四条用例（本文件两条），三面门各红各的：
     H3 桩件不 await promise 型应答（promise 当成空应答，等于 E3 之前）
        → 红 2，两处红点不同：走句柄的那条红在"没把心跳挂住，本用例是空跑"那句哨兵上
          （promise 被当成空应答，当场 200，pendingFetch 永远是空的）；走 signal 的那条
          红在最后的 streak 断言上（那一拍早在哨兵之前就结束了，于是 200 把连击清零）。
          合起来是：挂起这件事一旦不可表示，两条用例各退化成一种无意义的失败形状
     H4 桩件不监听 init.signal（只留 env.pendingFetch() 那个句柄门）
        → 红 1：只红在"超时是从 init.signal 兑现的"。另一条走句柄，看不见这面门坏了
     H5 桩件句柄的 abort() 变成空函数（只留 signal 那扇门）
        → 红 1：只红在"站点挂住、15 秒到点 abort"。两条各钉一面门，没有互相顶包
        H5 第一次跑是**红 0**：后台自己那笔 15 秒计时器照样会在 15 秒后把请求推落定，
        用例于是"等得到结果"，只是每次慢 15 秒——只看红绿看不出来，看时长才看出来
        （那次跑出来是 15.1 秒，而基线 0.7 秒）。改法是把 `await inflight` 换成
        桩件导出的 settles()（带上限的等），句柄这才变成有后果的机制。
        教训：凡是"打断挂起的请求再等链路"的用例，等待必须自己带上限，
        否则桩件坏掉的那一面门表现为慢，而不是表现为红
   桩件侧的反向事实（同一批实跑，H0：把 background-harness.mjs 里 `globalThis.fetch = env.fetch`
   那一行摘掉再跑）：本文件红 10/12，outbound.test.mjs 红 21/27。红的正是所有"断言请求发出去了"
   的用例，绿的 2 条是"心跳开关关着"与"验证墙造成的暂停不由心跳解除"——它们断言的都是"没有"，
   对 fetch 存不存在无感。这就是 A6 第 9 条修之前三条外发链路一行没跑的直接证据，也说明一件事：
   只断言"没发、没写、没通知"的用例，永远不可能证明一条链路被执行过。 */
