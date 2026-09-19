/* 防系统休眠那把锁（chrome.power）的端到端用例。E3 之前这里什么都没有：
   共享桩件的 power 是两个空函数、没有调用日志，于是 applyKeepAwake 整段一次也没被执行过——
   "持锁标记靠会话态兜底""一个 SW 生命周期最多 request 一次""释放那一头无条件"三条判据
   只能靠读代码相信（AGENTS.md 那句"power 锁的收敛挂在 updateBadge"同样是读代码相信）。
   现在桩件记 env.calls.keepAwake 序列，才第一次断言得出来。

   与 entry-points 的分工：那边管"哪些入口能把任务加进来/拿走"，这边管"加进来之后
   系统锁跟着动了没有"——后者要求每条增删路径都经过 updateBadge，所以有用例专门走右键菜单。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const OTHER = "https://b.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);
const AWAKE = "rt:awake";

async function bootAwake({ keepAwake = true, tasks, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = {
    keepAwake,
    keepAlive: false,
    httpHeartbeat: false,
    skipOnActivity: false,
    cookieBackup: false,
    captchaGuard: false
  };
  env.putTab(7, PAGE);
  env.putTab(8, OTHER);
  await bootBackground(env);
  return env;
}

/* updateBadge 里那一笔是 `void applyKeepAwake()`，不等它；而它自己还要过
   getSettings + getTasks + 会话态读写那一串（rt 有自己的串行队列）。所以按条件轮询 */
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

const seq = (env) => env.calls.keepAwake.map(([kind]) => kind);
const held = (env) => env.store.session[AWAKE];

test("开着开关起任务：发出 requestKeepAwake(\"system\")，并把持锁标记写进会话态", async () => {
  /* 正向见证：下面五条负向/顺序用例全靠这条证明"通道真的跑到了" */
  const env = await bootAwake();
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "起任务之后一笔 power 调用都没有，本用例是空跑");
  assert.deepEqual(env.calls.keepAwake, [["request", "system"]], "申请的不是 system 级锁（display 会把屏幕也钉住）");
  assert.ok(await until(() => held(env) === true), "request 发了却没留标记：下一拍还会再申请一次");
});

test("同一轮里再开一个任务不重复申请：标记挡住了", async () => {
  const env = await bootAwake({ tasks: { 7: task() } });
  await env.send({ type: "start", tabId: 8, seconds: 300 });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "没走到 power，本用例是空跑");
  await env.send({ type: "stop", tabId: 8 });
  await env.send({ type: "start", tabId: 8, seconds: 600 });
  await settle();
  assert.deepEqual(
    seq(env).filter((k) => k === "request"),
    ["request"],
    "每一笔任务增删都重申请一次：注释说按文档是替换（无害），但高频无谓调用正是标记要挡掉的"
  );
});

test("标记要活过 SW 回收：新实例带着标记起来，一笔都不重新申请", async () => {
  /* 这条是"为什么标记不能放内存变量"的门禁：内存变量的话这个新实例读不到，就会再 request 一次。
     重复申请本身无害（替换语义），真正被这条钉住的是标记住在 storage.session 这个事实。
     断言的是"没有"，所以同一用例里要留一个看得见的落点：把任务清空，release 必须出现——
     桩件不回记 power 调用时，这一条会红在那句上，而不是跟着"零笔申请"一起假绿 */
  const env = await bootAwake({ tasks: { 7: task() }, session: { [AWAKE]: true } });
  await env.send({ type: "start", tabId: 8, seconds: 300 });
  await settle();
  assert.deepEqual(env.calls.keepAwake, [], "持锁标记没跨过 SW 回收，新实例又申请了一遍");
  assert.ok(env.store.local.tasks[8], "这次 start 根本没建成任务，那零笔申请就是空跑而不是判据生效");
  assert.equal(held(env), true, "标记被这次任务重写掉了");
  await env.send({ type: "stop", tabId: 8 });
  await env.send({ type: "stop", tabId: 7 });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "任务清空后一笔 power 调用都没有：上面那个零是桩件没记，不是判据生效");
  assert.deepEqual(seq(env), ["release"]);
});

test("任务清空即放锁，标记跟着落回 false", async () => {
  const env = await bootAwake({ tasks: { 7: task() }, session: { [AWAKE]: true } });
  await env.send({ type: "stop", tabId: 7 });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "停掉最后一张任务页却没动 power");
  assert.deepEqual(seq(env), ["release"]);
  assert.equal(await until(() => held(env) === false), true, "锁放了标记却还挂着：下一次申请会被自己挡住");
});

test("没持过锁也要 release 一次：开关关着、任务还在", async () => {
  /* 注释写得很硬："锁挂在扩展上、跨 SW 回收存活，而持锁标记只在会话态"。
     靠标记判断该不该释放，就会漏掉回收之后的这一次——系统一直不睡，且没有任何本地症状 */
  const env = await bootAwake({ keepAwake: false, tasks: { 7: task() } });
  await env.send({ type: "start", tabId: 8, seconds: 300 });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "没走到 power，本用例是空跑");
  assert.deepEqual(env.calls.keepAwake, [["release"]], "没持过就不释放：那是上一实例（或开关开着那阵子）留下的锁");
  assert.ok(!held(env), "这条路径上根本没申请过，却把标记写成了 true");
});

test("关掉开关那一刻就放锁，不等任务清空", async () => {
  /* 走的是设置回流那条收敛通道（reconcileKeepAlive 末尾），不是 updateBadge：
     开关变了不会有任何任务增删，只等任务路径的话用户关了开关还得再停一个任务才放锁 */
  const env = await bootAwake({ tasks: { 7: task() }, session: { [AWAKE]: true } });
  env.store.sync.settings = Object.assign({}, env.store.sync.settings, { keepAwake: false });
  await env.fire.onChanged(
    { settings: { oldValue: { keepAwake: true }, newValue: { keepAwake: false } } },
    "sync"
  );
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "改了开关没惊动 power");
  assert.deepEqual(seq(env), ["release"]);
  assert.equal(await until(() => held(env) === false), true);
  assert.equal(env.store.local.tasks[7] !== undefined, true, "放锁不该顺手把任务停掉");
});

test("持锁走的是任务增删的必经点：右键菜单起任务也一样", async () => {
  /* 若有人把 applyKeepAwake 从 updateBadge 挪进弹窗那条起停分支，这里第一个红 */
  const env = await bootAwake();
  await env.fire.menuClicked({ menuItemId: "start-60" }, { id: 7, url: PAGE });
  assert.ok(await until(() => env.calls.keepAwake.length > 0), "右键起的任务没有申请锁");
  assert.deepEqual(seq(env), ["request"]);
  assert.ok(env.store.local.tasks[7], "右键那次根本没建成任务");
});

/* 红→绿对照（2026-09-19 本机实跑，脚本 D:/Github/_tar_ctl_e3/run.mjs）：这一轮改的有一半是
   桩件本身，而用例按相对路径 import 桩件、没有 TAR_* 重定向入口可用，所以把整个仓库（除 .git）
   复制到仓库外，一轮只在副本里改坏一处，然后在副本里跑点名的门禁文件。
   基线（副本一字未改）7 条全绿，同一份副本里 heartbeat/outbound/start-task-lock 也 0 红。

   桩件那一头：
     H1 power 退回两个空函数（就是 E3 之前的原样）
        → 红 7/7，每一条都红在自己那句"没走到 power，本用例是空跑"或 release 的落点上。
          这正是 AGENTS.md 那条纪律的形状：applyKeepAwake 整段此前一次也没被执行过，
          "标记靠会话态兜底""一个生命周期最多申请一次""释放无条件"三条只能靠读代码相信。
          这一处第一次跑出来是 6/7：漏掉的是"标记要活过 SW 回收"——它断言的全是"没有"
          （零笔申请），桩件不记调用时它跟着假绿。给它补了 release 落点（把任务清空，
          release 必须出现）之后才是 7/7。教训本身比数字值钱：见 tests/ 各文件末尾的同一句话
     H2 只记 request、release 那半边不记
        → 红 4/7：标记活过 SW 回收、任务清空即放锁、没持过锁也要 release、关掉开关那一刻。
          正是断言 release 的那四条；三条只管 request 的照样绿，符合预期
   产品代码那一头（改的是副本里那份 tab-auto-refresh/background.js，副本的桩件按相对路径就是 import 它）：
     B1 删掉 `if (!(await rtGet(RT_AWAKE)))` 那道守卫
        → 红 2/7：只红在"不重复申请"与"标记要活过 SW 回收"（守卫的两半现场），其余 5 绿
     B2 把 else 分支的 release 挪进 `if (await rtGet(RT_AWAKE))` 里面
        → 红 1/7："没持过锁也要 release 一次"，其余 6 绿。这一处就是注释里那句
          "靠标记判断会漏掉 SW 回收后的这次释放"的门禁
     B3 删掉 updateBadge 里的 `void applyKeepAwake();`
        → 红 6/7：除"关掉开关那一刻"外全红——那条走的是 reconcileKeepAlive 末尾那一笔，
          正好证明收敛有两条入口、任务增删是其中一条而不是唯一一条
   反向（确认本文件不被"任何改动都红"的噪声牵着走）：
     R1 删掉 stopTask 里的 detectChains.delete(tabId) → 本文件 0 红，同一变体 detect-chain 红 2/11
     R2 删掉 stopTask 里的 stopKeepAlive(tabId)      → 本文件 0 红，同一变体 keepalive-channel 红 2/18 */
