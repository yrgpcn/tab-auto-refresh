/* A15 的门禁：任务锁不许压在网络上，写盘与挂表之间不许插任何可失败的等待。
   改之前的形状是 startTask 在 withTaskLock 里 await backupCookies，而这一拍一旦确认掉线
   就一路走到 notifyOut 的两笔 fetch（15 秒超时，微信还要先取一次令牌，最坏几十秒）。
   于是开了"cookie 备份 + webhook/微信"、又正好这一拍确认掉线的用户点「开始」之后：
   `tasks` 里已经有这条任务，`refresh-<id>` 与 `hb-<id>` 一条都没建（arm 排在备份后面），
   而**其它标签页的起停全排在同一把锁后面**。MV3 的 SW 若在等待中被回收，
   留下的就是 AGENTS.md 里那句"任务在、永不刷新"的僵尸。

   为什么之前测不出来：桩件的 fetch 从不当场返回（见 BACKLOG E3，它没有 Promise 形态的应答），
   所以"锁压在网络上面"这件事在门禁里结构上看不见。这里刻意在 boot 之后把 globalThis.fetch
   换成永不 resolve 的桩——那是真实站点挂起时的形状，也是这条 bug 唯一能被跑出来的形状。
   顺带一提：把 await notifyOut 改成裸甩不是修法，那笔外发丢的正是"会话掉线"这条通知。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://shop.example.co.nz/board";
const BACKUP_KEY = "cookieBackup:shop.example.co.nz";
/* 上一份备份里有一张会话票（无 expirationDate），且已经攒了一次疑似：
   这一拍再采到"没有会话票"就凑满 2 次确认，applyBackupAction 判 FREEZE + notify */
const PREV_LOSING = {
  schemaVersion: 2,
  timestamp: Date.now() - 60 * 1000,
  sessionLostStreak: 1,
  cookies: [{ name: "sid", value: "v", domain: "shop.example.co.nz", path: "/", httpOnly: true }]
};

async function boot({ fetchHangs = false, cookies = [], backups = { [BACKUP_KEY]: PREV_LOSING } } = {}) {
  const env = makeEnv();
  env.store.sync.settings = {
    cookieBackup: true,
    keepAlive: false,
    httpHeartbeat: true,
    skipOnActivity: false,
    captchaGuard: false,
    webhookUrl: "https://hook.test/board"
  };
  for (const [k, v] of Object.entries(backups)) env.store.local[k] = v;
  env.putTab(7, PAGE);
  env.putTab(9, "https://other.test/board");
  env.setCookies(cookies);
  await bootBackground(env);
  env.hung = 0;
  /* 覆盖必须在 bootBackground 之后：装桩件时它会把 globalThis.fetch 换成自己的那一个。
     永不 resolve = 站点挂起；真实超时是 15 秒，测试里不打算等那么久 */
  if (fetchHangs) {
    globalThis.fetch = () => {
      env.hung += 1;
      return new Promise(() => {});
    };
  }
  return env;
}

const alarmsOf = (env) => env.calls.alarmsCreated.map(([name]) => name);
const notifIds = (env) => env.calls.notifCreated.map(([id]) => id);

/* 等某个条件成立（后台那一串 await 全是已 resolve 的桩，几十毫秒内必然走到该走的地方）。
   等不到就返回 false：调用方拿它当"这条用例是不是空跑"的哨兵，而不是让测试默默超时 */
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

test("外发把网络挂住时，另一个标签页的「开始」照旧完成（A15）", async () => {
  const env = await boot({ fetchHangs: true });
  const first = env.send({ type: "start", tabId: 7, seconds: 300 });
  first.catch(() => {}); /* 那笔永不 resolve 的外发：它挂住是现场本身，不是本用例的失败 */
  /* 空跑哨兵：这一拍必须真的走到那笔外发。没走到就等于锁是空的，下面的断言全在为假原因通过 */
  assert.ok(await until(() => env.hung > 0), "start 没有发出任何外发请求，本用例是空跑");

  const second = await Promise.race([
    env.send({ type: "start", tabId: 9, seconds: 300 }).then(() => "done"),
    new Promise((r) => setTimeout(() => r("stuck"), 1500))
  ]);

  assert.equal(second, "done", "另一家站点的「开始」排在同一把任务锁后面：锁被网络压住了");
  assert.ok(alarmsOf(env).includes("refresh-9"), "第二个任务没挂上刷新闹钟");
});

test("任务落盘之后紧接着就有两条闹钟，中间不夹任何可失败的等待（A15）", async () => {
  const env = await boot({ fetchHangs: true });
  const first = env.send({ type: "start", tabId: 7, seconds: 300 });
  first.catch(() => {});
  assert.ok(await until(() => env.hung > 0), "没走到外发，本用例是空跑");

  const tasks = env.store.local.tasks || {};
  assert.ok(tasks[7], "任务没落盘");
  assert.deepEqual(
    ["refresh-7", "hb-7"].filter((n) => !alarmsOf(env).includes(n)),
    [],
    "任务已经在清单里、两条闹钟却还没建：SW 这时被回收就留下永不刷新的僵尸任务"
  );
});

test("备份那一拍没有因为挪出锁而丢掉：坏样本不覆盖、通知照发", async () => {
  const env = await boot({ cookies: [] }); /* fetch 用桩件默认：当场 resolve */
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(env.hung, 0);
  assert.equal(env.calls.fetch.length, 1, "start 之后没有发出那一笔 webhook");
  const entry = env.store.local[BACKUP_KEY];
  assert.ok(entry.sessionLostAt, "确认掉线却没冻结备份：下一次好样本会被坏样本覆盖");
  assert.deepEqual(entry.cookies.map((c) => c.name), ["sid"], "坏样本覆盖了最后一次有效备份");
  assert.ok(notifIds(env).includes("session-lost-example.co.nz"), "掉线通知没发");
});

test("建任务失败时不备份、不外发", async () => {
  /* 新形状是"锁的结果 await 完再备份"。若有人把它改成锁外无条件执行（或 try/finally 收尾），
     拿不到标签页的那次点击就会对着一个不存在的任务采一遍 cookie、还可能发外发 */
  const env = await boot({ fetchHangs: true });
  env.dropTab(7);
  const res = await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(res.ok, false, "拿不到标签页却报成功");
  assert.match(String(res.error), /errTabGone/, "抛的不是「标签页不可用」那条：弹窗里显示的是莫名的一句");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(env.hung, 0, "任务没建成本来该直接报错，却还去发了一笔外发");
  assert.deepEqual(alarmsOf(env), [], "抛错路径上闹钟建出来了");
});

/* 红→绿对照（2026-09-19 实跑，副本 D:\Github\_tar_ctl_a15 里 tests/ 与 tab-auto-refresh/ 同级；
   一轮只改坏一处，跑全套。有两条用例会让那笔外发永不返回，后台为它上的 15 秒 AbortController
   计时器会把事件循环拖到最后，所以本文件整体约 15 秒，不是卡住）：
     pristine → 333 全绿
     N1 A15 原样退回（备份挪回锁内、且排在 arm 之前）
        → 红 2：「外发把网络挂住时…」+「任务落盘之后紧接着就有两条闹钟…」。
          前者是锁被网络压住，后者是 arm 排在等待之后——A15 的两半各红一处
     N2 备份搬到锁之前无条件执行
        → 红 3：上面两条 + 「备份那一拍没有因为挪出锁而丢掉」。
          注意它没红在「建任务失败时不备份」上：那一拍标签页不存在，backupCookies 自己早退了，
          给那条用例下针的是 N5
     N3 锁外的备份改成裸甩（不 await）→ 红 1：只红在「备份那一拍…丢掉」那条。
          这就是"别顺手把 await 改成 void"的门禁
     N4 心跳排到写盘之前 → 红 2：本文件「任务落盘之后紧接着就有两条闹钟」+
          既有的「右键开始 1 分钟」（ensureHeartbeat 读不到任务，把 hb- 清掉了）
     N5 先挂表再验现场（拿不到标签页也照样建闹钟）→ 红 1：只红在「建任务失败时不备份、不外发」
     R1 对照：删掉 stopTask 里的 stopKeepAlive(tabId)
        → 全套 333 条**一条都不红**。这不是本文件的失败，是另一处覆盖缺口：
          "停任务要让页面内的保活脚本自停"至今没有门禁，已记进 `BACKLOG.md` A20。
          留在这里而不是抹掉，是因为它同时说明本文件四条用例没有被"任何改动都红"的噪声牵着走 */
