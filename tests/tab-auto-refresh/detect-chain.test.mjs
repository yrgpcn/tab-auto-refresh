/* 关键词检测链与验证墙探测的端到端用例。
   这两条分支此前一次也没被执行过：共享桩件的 executeScript 恒返回 [{result:false}]，
   也就是"注入成功、什么都没命中"，于是链子永远停在未命中那一头，命中后要做的三件事
   （发通知、停任务、回写 notifiedKeys）与墙连续命中要做的自动暂停，全都只在纯函数层
   测过（keyword-inpage.test.mjs 比的是匹配语义，不是执行器）。
   现在桩件给了 env.onScript，才第一次真的把命中造出来。

   与 alarm-gate 的分工：那边管"到点之后做什么"，这边管"页面加载完成之后检测什么"。
   A21 起这里多一层现场：链还挂在注入半路时用户点了停止。三次采样的间隔是真 setTimeout
   （3 秒 / 10 秒），用例等不到第二拍，所以唯一的造法是把首拍那一次注入挂住再停任务。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

async function bootDetect({ tasks, settings, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false, captchaGuard: true },
    settings
  );
  env.putTab(7, PAGE);
  await bootBackground(env);
  return env;
}

/* startDetectChain 是 `void` 起的，onUpdated 处理器不等它，所以断言前要让微任务队列跑完。
   首采样延迟是 0，50ms 足够；后面两次是 3s/10s，用例故意不等它们 */
const flush = () => new Promise((r) => setTimeout(r, 50));

/* 按调用形状分派注入结果：
   带 args = 关键词匹配（matchInPage），带 func 且无 args = 验证墙探测（captchaProbe），
   带 files = 保活脚本注入（结果没人读，交给桩件默认值）。
   验证墙那一支给的是顶层框架的事实对象（A3 起页内不再下判断，判定在 decideWallFromFrames），
   用例侧仍然只用 wall: true/false 表达"这是一面墙 / 这不是" */
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

const ids = (env, prefix) =>
  env.calls.notifCreated.map(([id]) => id).filter((id) => id.startsWith(prefix));

test("关键词命中：发命中通知并把任务停掉（默认行为）", async () => {
  const env = await bootDetect({ tasks: { 7: task({ keywords: ["已售罄"] }) } });
  env.onScript(inject({ hits: ["已售罄"] }));
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.deepEqual(ids(env, "keyword-hit"), ["keyword-hit-7"]);
  assert.equal(env.store.local.tasks[7], undefined, "命中后默认要停任务，抢一次场景");
  /* 停任务不该另发一条"任务已停止"——命中通知已经说明了原因 */
  assert.deepEqual(ids(env, "refresh-stopped"), []);
});

test("命中后继续盯守：任务不停，在场集回写 notifiedKeys", async () => {
  const env = await bootDetect({
    tasks: { 7: task({ keywords: ["A", "B"], onHit: "continue" }) }
  });
  env.onScript(inject({ hits: ["A"] }));
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.ok(env.store.local.tasks[7], "继续盯守模式下任务被停掉了");
  assert.deepEqual(env.store.local.tasks[7].notifiedKeys, ["A"]);
  assert.deepEqual(ids(env, "keyword-hit"), ["keyword-hit-7"]);
});

test("在场但已通知过的关键词不再发第二遍", async () => {
  const env = await bootDetect({
    tasks: { 7: task({ keywords: ["A"], onHit: "continue", notifiedKeys: ["A"] }) }
  });
  env.onScript(inject({ hits: ["A"] }));
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.deepEqual(ids(env, "keyword-hit"), [], "同一个在场关键词每次加载都要通知一遍");
  assert.ok(env.store.local.tasks[7]);
});

test("注入没拿到数组（失败/受限页）：链提前结束，既不发通知也不停任务", async () => {
  const env = await bootDetect({ tasks: { 7: task({ keywords: ["A"] }) } });
  env.onScript((opts) => (opts.args ? [{}] : undefined)); /* result 缺失 */
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.deepEqual(ids(env, "keyword-hit"), []);
  assert.ok(env.store.local.tasks[7], "注入失败被当成了命中");
});

test("非监控标签页加载完成不触发检测", async () => {
  const env = await bootDetect({ tasks: { 7: task({ keywords: ["A"] }) } });
  env.putTab(9, "https://other.test/x");
  let injected = 0;
  env.onScript((opts) => {
    if (opts.args) injected++;
    return undefined;
  });
  await env.fire.tabUpdated(9, { status: "complete" });
  await flush();
  assert.equal(injected, 0, "没监控的页面也跟着注入检测脚本");
});

/* A21：链在飞的时候任务被停掉。三次采样是 [0, 3000, 10000] 的真 setTimeout，
   用例等不到第二拍，所以唯一的造法是把第一次注入挂住——挂住的那一段正是真实现场里
   "executeScript 还在路上、用户点了停止"的那几百毫秒 */
function parkedHits(hits) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let parked = 0;
  const fn = async (opts) => {
    if (opts.args) {
      parked++;
      await gate;
      return [{ result: hits }];
    }
    return undefined;
  };
  return { fn, release, parked: () => parked };
}

test("正向见证：注入挂起期间没停任务，放开后照样发命中", async () => {
  /* 没有这条，下面两条可以靠"链压根没跑到"轻松变绿 */
  const env = await bootDetect({ tasks: { 7: task({ keywords: ["A"] }) } });
  const g = parkedHits(["A"]);
  env.onScript(g.fn);
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.equal(g.parked(), 1, "用例没把链挂在注入里，本条是空跑");
  g.release();
  await flush();
  assert.deepEqual(ids(env, "keyword-hit"), ["keyword-hit-7"]);
});

test("停任务之后，在飞的那一次采样不许再发命中通知", async () => {
  /* 链在 await 之前就把 task 读好了，token 判据一失效，它照旧按旧关键词判命中：
     用户已经在弹窗点了停止，通知中心却弹出一条"命中"（默认还会再走一遍 stopTask） */
  const env = await bootDetect({ tasks: { 7: task({ keywords: ["A"] }) } });
  const g = parkedHits(["A"]);
  env.onScript(g.fn);
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.equal(g.parked(), 1, "用例是空跑");
  await env.send({ type: "stop", tabId: 7 });
  g.release();
  await flush();
  assert.deepEqual(ids(env, "keyword-hit"), [], "任务停了，在飞的链回来还是发了命中");
});

test("在飞的链不许把上一轮的在场集写进新一轮任务", async () => {
  /* 更实在的那一半：continue 模式下链回读 tasks 再写 notifiedKeys，写的却是新任务的键。
     现场是停掉之后立刻在同一张标签页上以新关键词重开——旧链把旧关键词的在场集盖上去，
     新一轮的首次通知被静默压制（"A" 甚至已经不在监控清单里了） */
  const env = await bootDetect({
    tasks: { 7: task({ keywords: ["A", "B"], onHit: "continue", notifiedKeys: ["A", "B"] }) }
  });
  const g = parkedHits(["A"]); /* 都在旧清单里 → 不算新命中，走的正是回写那一支 */
  env.onScript(g.fn);
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.equal(g.parked(), 1, "用例是空跑");
  await env.send({ type: "stop", tabId: 7 });
  await env.send({ type: "start", tabId: 7, seconds: 300, keyword: "新词", keepWatching: true });
  assert.deepEqual(env.store.local.tasks[7].keywords, ["新词"], "重开没换成新一轮的关键词");
  g.release();
  await flush();
  assert.equal(
    env.store.local.tasks[7].notifiedKeys,
    undefined,
    "上一轮关键词的在场集被写进了新任务，首轮通知从此被压制"
  );
  assert.deepEqual(ids(env, "keyword-hit"), []);
});

/* 验证墙：阈值刻意比错误页高（页面侧误判的代价是"卡死且不自愈"），
   三这个数写在 background.js:392，模块内部常量，没有对外导出，所以这里按字面断言。
   改动那个常量必须连着改这条——正是"默认值变动要逐条列受影响路径"那条纪律要的形状 */
test("验证墙：连续三次命中才自动暂停，一到两次不算", async () => {
  const env = await bootDetect({ tasks: { 7: task() } });
  env.onScript(inject({ wall: true }));
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "一次命中就暂停，误判代价太高");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "两次就暂停，等于把阈值降到了 2");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused.reason, "captcha");
  assert.deepEqual(ids(env, "task-paused"), ["task-paused-7"]);
  /* 暂停只是跳过后续每一拍，任务与定时器都还在 */
  assert.equal(env.store.local.tasks[7].intervalSec, 300);
});

test("墙消失后自动解除暂停，暂停通知跟着收掉", async () => {
  const env = await bootDetect({
    tasks: { 7: task({ autoPaused: { reason: "captcha", at: 1 } }) },
    session: { "rt:captcha:7": 2 }
  });
  env.onScript(inject({ wall: false }));
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "墙已经不在了还挂着暂停");
  assert.ok(env.calls.notifCleared.includes("task-paused-7"), "原因已消失，通知却还留在通知中心");
  assert.equal(Number(env.store.session["rt:captcha:7"]) || 0, 0, "解除后没清连击计数");
});

test("关闭验证墙保护立即恢复已因 captcha 暂停的任务", async () => {
  /* 自动暂停后 alarm 只会 SKIP，页面不再加载；若只把开关关掉而不走设置回流收敛，
     probeCaptcha 永远没有机会看到“墙消失”，任务会卡在暂停态。 */
  const env = await bootDetect({
    tasks: { 7: task({ autoPaused: { reason: "captcha", at: 1 } }) },
    session: { "rt:captcha:7": 2 }
  });
  env.store.sync.settings = Object.assign({}, env.store.sync.settings, { captchaGuard: false });
  await env.fire.onChanged(
    { settings: { oldValue: { captchaGuard: true }, newValue: { captchaGuard: false } } },
    "sync"
  );
  await flush();
  assert.equal(env.store.local.tasks[7].autoPaused, undefined, "关掉守卫后 captcha 暂停仍卡住");
  assert.ok(env.calls.notifCleared.includes("task-paused-7"), "任务恢复了，旧暂停通知却还留着");
  assert.equal(Number(env.store.session["rt:captcha:7"]) || 0, 0, "恢复后没清验证码连击计数");
});

test("关闭验证墙保护不解除错误页暂停", async () => {
  const env = await bootDetect({
    tasks: { 7: task({ autoPaused: { reason: "error-page", at: 1 } }) }
  });
  env.store.sync.settings = Object.assign({}, env.store.sync.settings, { captchaGuard: false });
  await env.fire.onChanged(
    { settings: { oldValue: { captchaGuard: true }, newValue: { captchaGuard: false } } },
    "sync"
  );
  await flush();
  assert.equal(env.store.local.tasks[7].autoPaused.reason, "error-page", "关 captchaGuard 误恢复了错误页暂停");
});

test("关掉验证墙守卫时根本不注入探测脚本", async () => {
  const env = await bootDetect({
    tasks: { 7: task() },
    settings: { captchaGuard: false }
  });
  let probed = 0;
  env.onScript((opts) => {
    if (opts.func && !opts.args) probed++;
    return undefined;
  });
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(probed, 0, "开关关着还在每个加载周期注入探测脚本");
  assert.equal(env.store.local.tasks[7].autoPaused, undefined);
});

/* 红→绿对照（做法见 alarm-gate.test.mjs 末尾）：2026-09-19 本机实跑，副本改源码、
   TAR_BG 指过去跑本文件，每次都只红在下面这几条。下面这组计数是 A21 补完三条用例之后
   整批重跑的（本文件 11 条，基线——未改动的副本指过去——11/11 全绿；先前两跑分别记在
   8 条与 9 条的时候，计数已作废）：
     1) startDetectChain 里把 `present = aggregateFrameHits(results).present`
        换成写死的 []（等于桩件当年的默认返回值）
        → 红 3 条："关键词命中：发命中通知并把任务停掉""命中后继续盯守"，加上 A21 的
          "正向见证"（它读的是同一个聚合结果，链一断它第一个响，正是它该有的行为），
          其余 8 绿
     2) `s >= CAPTCHA_CONFIRM_SAMPLES` 改成 `s >= 1`
        → 红 1 条："验证墙：连续三次命中才自动暂停"，其余 10 绿
     3) `if (cur.autoPaused && … === "captcha") await resumeTaskAuto(tabId)` 删掉
        → 红 1 条："墙消失后自动解除暂停"，其余 10 绿
   另外单跑了一次"桩件默认值改了会怎样"：把 executeScript 缺省返回从 [{result:false}]
   换成 [{result:["已售罄"]}]（A3 之后那一跑，全仓 239 条），一条都不红。这是好消息不是坏消息——
   说明凡是要读注入结果的用例都自己 env.onScript 设了口径，没有一个靠那个缺省值撑着。
   （改的都是仓库外的副本：源码目录整份复制出去改，比对过仓库文件字节相同。）

   A3 顺带改了本文件的桩件形状：验证墙那条注入从回布尔改成回事实对象（判定搬到
   decideWallFromFrames），所以 inject 里给的是 wallFact()。用例侧的 wall: true/false
   语义没变，变的只是造出来的载荷长什么样。

   A21 那三条（正向见证 + 停任务后不许发命中 + 不许把上一轮在场集写进新任务）的对照，
   2026-09-19 在同一套仓库外副本上实跑，四处全部按预期落点：
     C1 删掉 stopTask 的 `detectChains.delete(tabId);`（A21 报的缺口本身）
        → 红 2/11，正好是那两条负向用例，正向见证照旧绿（它本来就该绿）
     C2 删掉注入回来之后那道 `if (detectChains.get(tabId) !== token) return;`
        → 红 1/11（只红"不许再发命中通知"那一条）。第二条不红不是漏了，是它防的写入支路
           另有第 792 行那道同名判据兜着：两条判据是同一条纪律的两个位置，各挡一半现场
     C3 把首拍的 `0` 从 [0, 3000, 10000] 里去掉（链压根不跑第一拍）
        → 红 5/11，含新写的"正向见证"那一条。这一处是给正向见证本身做的对照：
           链没跑到时它必须响，不然那三条可以靠"谁也没跑到"一起变绿
     R1 反向：删掉 stopTask 的 `stopKeepAlive(tabId);` → 本文件 0 红（不归它管），
        同一份变体跑 keepalive-channel.test.mjs 红 2/18。两头的分工是断出来的，不是猜的 */
