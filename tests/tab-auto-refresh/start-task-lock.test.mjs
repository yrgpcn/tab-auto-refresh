/* A15 的门禁：任务锁不许压在网络上，写盘与挂表之间不许插任何可失败的等待。
   改之前的形状是 startTask 在 withTaskLock 里 await backupCookies，而这一拍一旦确认掉线
   就一路走到 notifyOut 的两笔 fetch（15 秒超时，微信还要先取一次令牌，最坏几十秒）。
   于是开了"cookie 备份 + webhook/微信"、又正好这一拍确认掉线的用户点「开始」之后：
   `tasks` 里已经有这条任务，`refresh-<id>` 与 `hb-<id>` 一条都没建（arm 排在备份后面），
   而**其它标签页的起停全排在同一把锁后面**。MV3 的 SW 若在等待中被回收，
   留下的就是 AGENTS.md 里那句"任务在、永不刷新"的僵尸。

   为什么之前测不出来：桩件的 fetch 从不当场返回，也不认 promise 型应答（见 BACKLOG E3），
   所以"锁压在网络上面"这件事在门禁里结构上看不见。A15 结案时是靠每条用例在 boot 之后
   自己覆写 globalThis.fetch 绕过去的——那是局部的、一次性的绕法，E3 已经把"挂住"收进桩件
   （应答给一个用例握着的 promise），本文件现在用的就是那条一等形状。
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

async function boot({ hangs = false, cookies = [], backups = { [BACKUP_KEY]: PREV_LOSING } } = {}) {
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
  /* 挂起 = 应答给一个永不放开的 promise（桩件会 await 它，见 BACKLOG E3）。
     真实那一头是 15 秒之后 abort，测试里不打算等那么久，所以也不放开它，
     改用例自己收尾：hangUp() 把它打断，免得 15 秒计时器把整个文件拖住 */
  if (hangs) env.reply(new Promise(() => {}));
  return env;
}

/* 收尾用：把还挂在外发上的请求一律打断。必须放在断言之后 */
const hangUp = (env) => env.pendingFetch().forEach((h) => h.abort());

const alarmsOf = (env) => env.calls.alarmsCreated.map(([name]) => name);
const notifIds = (env) => env.calls.notifCreated.map(([id]) => id);
/* 那笔外发是否**已经发出且仍未回来**：calls.fetch 只说明发过，
   pendingFetch 才说明锁正压着它——A15 的现场要的是后者 */
const hungCount = (env) => env.calls.fetch.length;
const hungNow = (env) => env.pendingFetch().length;

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
  const env = await boot({ hangs: true });
  const first = env.send({ type: "start", tabId: 7, seconds: 300 });
  first.catch(() => {}); /* 那笔永不放开的外发：它挂住是现场本身，不是本用例的失败 */
  /* 空跑哨兵：这一拍必须真的走到那笔外发、而且正挂在那里。没走到就等于锁是空的，
     下面的断言全在为假原因通过 */
  assert.ok(await until(() => hungNow(env) > 0), "start 没有把外发挂起来，本用例是空跑");

  const second = await Promise.race([
    env.send({ type: "start", tabId: 9, seconds: 300 }).then(() => "done"),
    new Promise((r) => setTimeout(() => r("stuck"), 1500))
  ]);

  assert.equal(second, "done", "另一家站点的「开始」排在同一把任务锁后面：锁被网络压住了");
  assert.ok(alarmsOf(env).includes("refresh-9"), "第二个任务没挂上刷新闹钟");
  hangUp(env);
});

test("任务落盘之后紧接着就有两条闹钟，中间不夹任何可失败的等待（A15）", async () => {
  const env = await boot({ hangs: true });
  const first = env.send({ type: "start", tabId: 7, seconds: 300 });
  first.catch(() => {});
  assert.ok(await until(() => hungNow(env) > 0), "没走到外发，本用例是空跑");

  const tasks = env.store.local.tasks || {};
  assert.ok(tasks[7], "任务没落盘");
  assert.deepEqual(
    ["refresh-7", "hb-7"].filter((n) => !alarmsOf(env).includes(n)),
    [],
    "任务已经在清单里、两条闹钟却还没建：SW 这时被回收就留下永不刷新的僵尸任务"
  );
  hangUp(env);
});

test("备份那一拍没有因为挪出锁而丢掉：坏样本不覆盖、通知照发", async () => {
  const env = await boot({ cookies: [] }); /* fetch 用桩件默认：当场 resolve */
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(hungNow(env), 0);
  assert.equal(hungCount(env), 1, "start 之后没有发出那一笔 webhook");
  const entry = env.store.local[BACKUP_KEY];
  assert.ok(entry.sessionLostAt, "确认掉线却没冻结备份：下一次好样本会被坏样本覆盖");
  assert.deepEqual(entry.cookies.map((c) => c.name), ["sid"], "坏样本覆盖了最后一次有效备份");
  assert.ok(notifIds(env).includes("session-lost-example.co.nz"), "掉线通知没发");
});

test("建任务失败时不备份、不外发", async () => {
  /* 新形状是"锁的结果 await 完再备份"。若有人把它改成锁外无条件执行（或 try/finally 收尾），
     拿不到标签页的那次点击就会对着一个不存在的任务采一遍 cookie、还可能发外发 */
  const env = await boot({ hangs: true });
  env.dropTab(7);
  const res = await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(res.ok, false, "拿不到标签页却报成功");
  assert.match(String(res.error), /errTabGone/, "抛的不是「标签页不可用」那条：弹窗里显示的是莫名的一句");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hungCount(env), 0, "任务没建成本来该直接报错，却还去发了一笔外发");
  assert.deepEqual(alarmsOf(env), [], "抛错路径上闹钟建出来了");
});

/* 红→绿对照（首轮 2026-09-19 实跑，副本 D:\Github\_tar_ctl_a15 里 tests/ 与 tab-auto-refresh/ 同级；
   一轮只改坏一处，跑全套）：
     pristine → 333 全绿（那是当时的全套规模；E3 之后全套 405 条，仍然全绿）
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
        → 全套**一条都不红**（当时 333 条）。这不是本文件的失败，是另一处覆盖缺口：
          "停任务要让页面内的保活脚本自停"至今没有门禁，已记进 `BACKLOG.md` A20（后来由 A20 补上）。
          留在这里而不是抹掉，是因为它同时说明本文件四条用例没有被"任何改动都红"的噪声牵着走

   ---------- E3（挂起收进桩件）对本文件的影响，同一天实跑，脚本 D:/Github/_tar_ctl_e3/run.mjs ----------
   那笔永不返回的外发原本是每条用例自己 `globalThis.fetch = () => new Promise(() => {})`
   覆写出来的——桩件因此看不见它：不进 calls.fetch、拿不到 init.signal、也没法问"还挂着吗"。
   现在挂起是桩件的一种应答形状（env.reply(new Promise(() => {}))），于是本文件的现场变清楚了：
   哨兵从"我自己的计数器"换成 hungNow(env) = env.pendingFetch().length，
   即"发出去了且**还压着**"；"发过几笔"另有 hungCount(env) = calls.fetch.length。
   两者分开是有意的：A15 的病因是锁压在网络等待上，只有 pendingFetch 能表示"正压着"，
   而 calls.fetch 只说明"发过"。
     H3 桩件不 await promise 型应答 → 红 2：正是那两条挂起用例，且红在哨兵那句上
        （"start 没有把外发挂起来，本用例是空跑"）。桩件退回不 await 就等于 A15 的现场
        不可表示，用例不会"退回旧的绿"，而是当场报空跑——这是期望的形状
     H5 桩件句柄的 abort() 变空函数 → 本文件只多花时长、不红：这里的 hangUp() 是收尾
        （免得那两笔 15 秒计时器把文件拖住），不是任何一条断言的依据。写清楚免得下一个人
        把它当成缺门禁
   时长：改之前本文件约 15 秒（两条用例各被 15 秒计时器拖住），现在约 1.6 秒。
   那 15 秒不是卡住，但也不该留着——桩件能叫停之后就没有理由再等它。 */
