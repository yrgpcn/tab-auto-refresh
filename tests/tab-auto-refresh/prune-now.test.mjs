/* A16 的门禁：弹窗打开时那条清理网（消息类型 prune-now → cleanupInvalidTasks）。
   改之前的形状是"chrome.tabs.get 一失败就 stopTask"，而浏览器重启后会话恢复晚到的那几秒里
   取不到标签页是常态——同一时刻并跑的 prune 正因为知道这件事才先等 1500 毫秒、再给未认领任务
   一个共享的认领窗口。两个函数对同一件事的假设正好相反，后果是用户没碰任何东西，任务却从清单里
   静默消失（走的是 stopTask，不是带通知的那条），连同两条 alarm 一起清掉。

   两条判据因此分开：本轮启动恢复没收尾就一条都不动（交回 prune 收尾）；真删的时候要通知，
   并且"停"排在所有"外发留痕"之前——notifyTaskStopped 里 await 的是 fetch。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE_A = "https://a.test/board";
const PAGE_B = "https://b.test/board";
const PRUNE_DONE = "rt:pruneDone";
const urlOf = (id) => (id === 7 ? PAGE_A : PAGE_B);

/* present = 标签页在场的任务 id；gone = 任务在清单里、标签页取不到。
   restoreSettled 要的是"真跑过一轮 prune"，所以不能连着任务一起种：现场有空任务时
   prune 会把认不到的那条拖进 20 秒认领窗口，测的就不是这一条网了 */
async function boot({
  restoreSettled = false,
  present = [9],
  gone = [7],
  extraTabs = [],
  fetchHangs = false,
  reboot = false
} = {}) {
  const env = makeEnv();
  env.store.sync.settings = {
    keepAlive: false,
    httpHeartbeat: false,
    cookieBackup: false,
    captchaGuard: false,
    skipOnActivity: false,
    webhookUrl: "https://hook.test/board"
  };
  await bootBackground(env);
  env.hung = 0;
  if (fetchHangs) {
    /* 覆盖必须在 bootBackground 之后：装桩件时它会把 globalThis.fetch 换成自己的那一个 */
    globalThis.fetch = () => {
      env.hung += 1;
      return new Promise(() => {});
    };
  }
  if (restoreSettled) {
    await env.fire.startup();
    assert.equal(typeof env.store.session[PRUNE_DONE], "number", "prune 跑完却没写收尾标记");
  }
  const tasks = {};
  for (const id of present) {
    tasks[id] = { intervalSec: 300, createdAt: 1, url: urlOf(id) };
    env.putTab(id, urlOf(id));
  }
  for (const id of gone) tasks[id] = { intervalSec: 300, createdAt: 1, url: urlOf(id) };
  env.store.local.tasks = tasks;
  /* 没有任务的在场标签页：给 prune 一个按网址重挂的落点，免得它进 20 秒认领窗口 */
  for (const [id, url] of extraTabs) env.putTab(id, url);
  if (reboot) {
    /* 同一套桩件、同一份 storage.session，再 import 一个全新的 background 实例：
       这就是"SW 被回收之后重新起来"。收尾标记必须活过这一步，否则弹窗只要开得晚一点
       就又退回"未收尾"，这条网在这个浏览器会话里永远轮不到动手 */
    await bootBackground(env);
  }
  return env;
}

const tasksOf = (env) => env.store.local.tasks || {};
const notifIds = (env) => env.calls.notifCreated.map(([id]) => id);
const cleared = (env) => env.calls.alarmsCleared;

async function until(fn, ms = 1500) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

test("启动恢复没收尾时，取不到标签页的任务一条都不动（A16）", async () => {
  const env = await boot();
  const badgesBefore = env.calls.badge.length;
  const res = await env.send({ type: "prune-now" });
  assert.equal(res.ok, true, "prune-now 被拒了，后面的断言在为假原因通过");
  assert.ok(env.calls.badge.length > badgesBefore, "清理网没跑到收尾那一拍，本用例是空跑");

  assert.ok(tasksOf(env)[7], "会话恢复晚到的标签页被当成失效任务停掉了");
  assert.deepEqual(cleared(env), [], "连带把两条 alarm 也清了：恢复回来后没人再挂表");
  assert.deepEqual(notifIds(env), [], "未收尾的这一拍不该有任何动静");
});

test("prune 正在跑的时候打开弹窗，这一拍仍然不动手（钉收尾标记写在哪）", async () => {
  /* 现场：任务 7 的旧 tabId 取不到，但会话恢复已经把同一网址开在了 tab 11 上。
     prune 会把它重挂过去——所以"停掉 7 并发通知"在这个现场是错的，
     而 1500 毫秒那一等还没结束就先把收尾标记写上，出的就是这个错 */
  const env = await boot({ gone: [7], present: [9], extraTabs: [[11, PAGE_A]] });
  const startup = env.fire.startup();
  await new Promise((r) => setTimeout(r, 300));
  const badgesBefore = env.calls.badge.length;
  await env.send({ type: "prune-now" });

  assert.ok(env.calls.badge.length > badgesBefore, "清理网没跑完，本用例是空跑");
  assert.ok(tasksOf(env)[7], "prune 还在认领就把任务停掉了");
  assert.deepEqual(notifIds(env), [], "重挂被当成了停止：用户收到一条'已停止'");
  assert.deepEqual(cleared(env), [], "两条 alarm 被清理网抢先停了");

  await startup;
  assert.equal(typeof env.store.session[PRUNE_DONE], "number", "prune 跑完没写收尾标记");
  assert.equal(tasksOf(env)[7], undefined, "prune 自己没把这轮收尾：任务 7 该被重挂走");
  assert.ok(tasksOf(env)[11], "同一网址的恢复页没被认领，任务没搬过去");
  assert.deepEqual(notifIds(env), [], "重挂不是停止，不该有通知");
});

test("收尾之后真删时要发通知，不再静默消失（A16）", async () => {
  const env = await boot({ restoreSettled: true });
  await env.send({ type: "prune-now" });

  assert.equal(tasksOf(env)[7], undefined, "收尾之后仍然留着指向已消失标签页的任务");
  assert.deepEqual(cleared(env).sort(), ["hb-7", "refresh-7"], "该清的两条 alarm 没清干净");
  assert.ok(notifIds(env).includes("refresh-stopped-7"), "任务停了却没有通知：静默消失最难被用户报告");
  assert.ok(tasksOf(env)[9], "顺手把标签页在场的任务也停了");
});

test("随通知外发的仍是任务里记的那个网址", async () => {
  const env = await boot({ restoreSettled: true });
  await env.send({ type: "prune-now" });

  assert.equal(env.calls.fetch.length, 1, "task-stopped 那一笔 webhook 没发出去");
  const body = JSON.parse(env.calls.fetch[0].init.body);
  assert.equal(body.type, "task-stopped");
  assert.equal(body.url, PAGE_A, "外发载荷里的网址不是任务记的那一个");
  assert.equal(body.reason, "tab-gone", "理由没带上：用户只看得到'停了'，不知道是谁停的");
});

test("外发挂住时，全部该停的任务照样当场停完（A16 的两半之二）", async () => {
  /* 若把"停一条、发一条"串起来，第一条任务的 notifyTaskStopped 挂在网络上，
     后面几条任务的停止就被一起堵在外面——弹窗早关了，清单却还留着幽灵任务 */
  const env = await boot({ restoreSettled: true, present: [], gone: [7, 9], fetchHangs: true });
  const sent = env.send({ type: "prune-now" });
  sent.catch(() => {});
  assert.ok(await until(() => env.hung > 0), "没走到外发，本用例是空跑");

  assert.deepEqual(Object.keys(tasksOf(env)), [], "网络挂住时第二条任务的停止被堵住了");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(env.hung, 1, "停完之前不该有第二条外发");
});

test("收尾标记活过 SW 回收：弹窗晚点开也轮得到这条网", async () => {
  /* 后台的 SW 回收判据（AGENTS.md：要活过 SW 回收才放会话态）在这条网上的落地形状：
     prune 是在上一个实例里跑完的，新实例什么都不知道，只能从 storage.session 里读回来 */
  const env = await boot({ restoreSettled: true, reboot: true });
  await env.send({ type: "prune-now" });

  assert.equal(tasksOf(env)[7], undefined, "换了个 SW 实例就退回'未收尾'，这条网整轮会话都没机会动手");
  assert.ok(notifIds(env).includes("refresh-stopped-7"), "停了任务却没通知");
});

test("标签页都在场时一条都不停（反向守卫）", async () => {
  const env = await boot({ restoreSettled: true, present: [7, 9], gone: [] });
  await env.send({ type: "prune-now" });

  assert.deepEqual(Object.keys(tasksOf(env)).sort(), ["7", "9"], "清理网变成每次开弹窗都停一遍");
  assert.deepEqual(cleared(env), [], "没停任何东西却清了 alarm");
  assert.deepEqual(notifIds(env), [], "好好在跑的任务被告知'已停止'");
  assert.deepEqual(env.calls.fetch, [], "没有任务消失却发了外发");
});

/* 红→绿对照（2026-09-19 实跑，副本 D:\Github\_tar_ctl_a16 里 tests/ 与 tab-auto-refresh/ 同级；
   一轮只改坏一处，跑全套）：
     pristine → 340 全绿
     C1 去掉收尾判据（回到"tabs.get 一失败就停"）
        → 红 2：「启动恢复没收尾时…」「prune 正在跑的时候打开弹窗…」
     C2 真删时不发通知（静默消失留着）
        → 红 4：「收尾之后真删时要发通知」「随通知外发的仍是…」「外发挂住时…」「收尾标记活过 SW 回收」。
          其中第三条是被哨兵红下来的：没有外发，until 等不到 hung>0，用例直接报"本用例是空跑"
     C3 停一条发一条（把通知插回停止之间）→ 红 1：只红在「外发挂住时，全部该停的任务照样当场停完」
     C4 通知不带网址 → 红 1：只红在「随通知外发的仍是任务里记的那个网址」
     C5 收尾标记挪到 prune 开头（1500 毫秒那一等还没结束就算已收尾）
        → 红 1：只红在「prune 正在跑的时候打开弹窗」——那条用例就是为这个位置写的
     C6 收尾标记改成内存变量（活不过 SW 回收）→ 红 6：boot() 里"prune 跑完却没写收尾标记"那句
        见证先红，五条走 restoreSettled 的用例一起倒下，「prune 正在跑的时候…」也在其中
     S1 对照：删掉清理网末尾那句 updateBadge → 红 2：两处"本用例是空跑"哨兵各红一处。
        它证明哨兵不是装饰——prune-now 这一拍既不写盘也不清 alarm，没有哨兵就只能为假原因变绿
   这批没有零红项。 */
