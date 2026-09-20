/* 睡眠唤醒后的 alarm 自愈（chrome.idle.onStateChanged → 过期重挂）。
   这段此前零覆盖：桩件的 alarms.getAll 不回 scheduledTime，而上面那段判"已过期"
   靠的就是它，于是任何驱动 idle 的用例都只会走"没过期"分支——看着在测自愈，实际没测。
   现在桩件按真实 Chrome 给出 scheduledTime，env.fire.idle 也补上了，才第一次真跑到
   （文末"反向事实"记的就是这件事：把桩件的 scheduledTime 摘掉，本文件正好红三条）。

   为什么要自愈：合盖期间 alarm 不触发，醒来时一次性 `when` 早已过期。刷新与心跳都有
   periodInMinutes 兜底，不会永久停住，但错过的那几拍不补、节奏被打乱；
   而无主的过期闹钟（任务早停了）没人清就一直挂在 Chrome 那里。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const HEARTBEAT_MINUTES = 4; /* 与 background.js 里那个常量同值，它没有导出 */

async function bootTask7({ intervalSec = 300 } = {}) {
  const env = makeEnv();
  env.store.local.tasks = { 7: { intervalSec, createdAt: 1, url: PAGE } };
  env.store.sync.settings = { keepAlive: false, httpHeartbeat: true, cookieBackup: false };
  env.putTab(7, PAGE);
  await bootBackground(env);
  return env;
}

/* 造一条"早就该触发"的闹钟：桩件的 getAll 会把 when 原样报成 scheduledTime。
   计数标记要在这次 create 之后取，否则切片会把用例自己挂的那条算进去，
   每条"重挂了几次"的断言都平白多一条——第一版就是这么红了四条的 */
async function expire(env, name, info) {
  await env.chrome.alarms.create(name, info);
  return { created: env.calls.alarmsCreated.length, cleared: env.calls.alarmsCleared.length };
}

const fresh = (env, mark) => ({
  created: env.calls.alarmsCreated.slice(mark.created),
  cleared: env.calls.alarmsCleared.slice(mark.cleared)
});

const scheduled = async (env, name) => {
  const all = await env.chrome.alarms.getAll();
  return all.find((a) => a.name === name);
};

test("唤醒后过期的刷新 alarm 重走完整周期（带抖动，落在区间内）", async () => {
  const env = await bootTask7({ intervalSec: 300 });
  const mark = await expire(env, "refresh-7", { when: Date.now() - 5000, periodInMinutes: 5 });
  const t0 = Date.now();
  await env.fire.idle("active");
  const { created } = fresh(env, mark);
  assert.deepEqual(created.map(([n]) => n), ["refresh-7"], "过期的刷新闹钟没重挂");
  const when = created[0][1].when;
  /* 重挂走完整周期 + ±15% 抖动：300 秒就是 255000~345000ms。两端都钉：
     下限证明没被"醒来立刻刷一遍"顶掉（多任务同拍就成了机器行为），
     上限证明没有干等比原周期更久的时间 */
  const delay = when - t0;
  assert.ok(delay >= 255000 * 0.99 && delay <= 345000 * 1.01, `重挂到了 ${delay}ms 之后，不在 300s±15% 里`);
  assert.ok((await scheduled(env, "refresh-7")).scheduledTime > Date.now(), "落表里还是那条已过期的");
});

test("唤醒后过期的心跳 alarm 打散在 0~60 秒重建", async () => {
  /* 钉的是"打散"这个尺度，不是"落在 0~60 秒里"：只判区间的话，把 Math.random() * 60000
     写成常量 0 照样全绿（第一版就是只判区间，对照第 2 处跑了确实不红）。
     这里喂两个确定的随机值，把 0 秒与 60 秒两个端点钉住 */
  const raw = Math.random;
  try {
    for (const [label, rand, expect] of [["0", () => 0, 0], ["1", () => 1, 60000]]) {
      const env = await bootTask7();
      const mark = await expire(env, "hb-7", { when: Date.now() - 5000, periodInMinutes: HEARTBEAT_MINUTES });
      Math.random = rand;
      const t0 = Date.now();
      await env.fire.idle("active");
      const { created } = fresh(env, mark);
      assert.deepEqual(created.map(([n]) => n), ["hb-7"], `Math.random=${label} 时心跳闹钟没重建`);
      const info = created[0][1];
      const delay = info.when - t0;
      assert.ok(Math.abs(delay - expect) <= 200, `Math.random=${label} 时重挂到了 ${delay}ms，要的是 ${expect}ms`);
      assert.equal(info.periodInMinutes, HEARTBEAT_MINUTES);
    }
  } finally {
    Math.random = raw;
  }
});

test("没有对应任务的过期 alarm 直接清掉，不留残留", async () => {
  /* 停任务与唤醒之间有窗口：alarm 处于过期态时没人清，就永远挂在 Chrome 那里空转 */
  const env = await bootTask7();
  const mark = await expire(env, "refresh-99", { when: Date.now() - 1000, periodInMinutes: 5 });
  await env.fire.idle("active");
  const { created, cleared } = fresh(env, mark);
  assert.deepEqual(cleared, ["refresh-99"]);
  assert.deepEqual(created, [], "无主的闹钟被重新挂上了");
  assert.equal(await scheduled(env, "refresh-99"), undefined);
});

test("还没到期的闹钟一个都不动", async () => {
  const env = await bootTask7();
  const t0 = Date.now();
  await env.chrome.alarms.create("refresh-7", { when: t0 + 300000, periodInMinutes: 5 });
  await env.chrome.alarms.create("hb-7", { when: t0 + 240000, periodInMinutes: HEARTBEAT_MINUTES });
  const mark = { created: env.calls.alarmsCreated.length, cleared: env.calls.alarmsCleared.length };
  await env.fire.idle("active");
  const { created, cleared } = fresh(env, mark);
  assert.deepEqual(created, [], "没过期也被重挂：等于每次唤醒都把用户的节奏打乱一遍");
  assert.deepEqual(cleared, []);
});

test("state 不是 active 时什么都不做", async () => {
  const env = await bootTask7();
  const mark = await expire(env, "refresh-7", { when: Date.now() - 5000, periodInMinutes: 5 });
  await env.fire.idle("idle");
  await env.fire.idle("locked");
  const { created, cleared } = fresh(env, mark);
  assert.deepEqual(created, [], "人离开屏幕时反而重挂闹钟");
  assert.deepEqual(cleared, []);
});

/* 红→绿对照（2026-09-19 实跑：整份插件目录复制到仓库外，在副本的 background.js 上逐处改坏，
   TAR_BG 指过去跑本文件。改动限定在 chrome.idle.onStateChanged 那一段之内）：
     1) 删掉 `if (!a.scheduledTime || a.scheduledTime >= now) continue;`
        → 红在"还没到期的闹钟一个都不动"（没过期也被重挂）
     2) 心跳的 `Math.round(Math.random() * 60000)` 改成常量 0
        → 红在"心跳 alarm 打散在 0~60 秒重建"。第一版只判"落在 0~60 秒里"时这条不红，
           是照着这个结果把断言改成喂确定的 Math.random 钉两端，才变红的
     3) `else await chrome.alarms.clear(a.name);` 换成空操作
        → 红在"没有对应任务的过期 alarm 直接清掉"
     4) `if (a.name.startsWith(HB_PREFIX)) {` 改成 `if (false) {`
        → 红在"心跳 alarm 打散在 0~60 秒重建"
     5) `} else if (a.name.startsWith(PREFIX)) {` 改成 `} else if (false) {`
        → 红两条：重走完整周期那条、以及"没有对应任务的过期 alarm 直接清掉"（无主清理也在这支里）
     6) 删掉 `if (state !== "active") return;`
        → 红在"state 不是 active 时什么都不做"
   反向事实（A6 第 2 条的账）：把桩件 getAll 回给用例的 scheduledTime 摘掉，
   本文件红三条（前三条，都要读得到"已过期"）、后两条照绿。 */
