/* 关键词检测链与验证墙探测的端到端用例。
   这两条分支此前一次也没被执行过：共享桩件的 executeScript 恒返回 [{result:false}]，
   也就是"注入成功、什么都没命中"，于是链子永远停在未命中那一头，命中后要做的三件事
   （发通知、停任务、回写 notifiedKeys）与墙连续命中要做的自动暂停，全都只在纯函数层
   测过（keyword-inpage.test.mjs 比的是匹配语义，不是执行器）。
   现在桩件给了 env.onScript，才第一次真的把命中造出来。

   与 alarm-gate 的分工：那边管"到点之后做什么"，这边管"页面加载完成之后检测什么"。 */

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
   TAR_BG 指过去跑本文件，每次都只红在下面这几条。
   同一天 A3 之后又按当前源码重跑了一遍（第 1 条的 needle 那时已被 A3 换掉），红名单没变：
     1) startDetectChain 里把 `present = aggregateFrameHits(results).present`
        换成写死的 []（等于桩件当年的默认返回值）
        → 红 2 条："关键词命中：发命中通知并把任务停掉"与"命中后继续盯守"，其余 6 绿
     2) `s >= CAPTCHA_CONFIRM_SAMPLES` 改成 `s >= 1`
        → 红 1 条："验证墙：连续三次命中才自动暂停"，其余 7 绿
     3) `if (cur.autoPaused && … === "captcha") await resumeTaskAuto(tabId)` 删掉
        → 红 1 条："墙消失后自动解除暂停"，其余 7 绿
   另外单跑了一次"桩件默认值改了会怎样"：把 executeScript 缺省返回从 [{result:false}]
   换成 [{result:["已售罄"]}]（A3 之后那一跑，全仓 239 条），一条都不红。这是好消息不是坏消息——
   说明凡是要读注入结果的用例都自己 env.onScript 设了口径，没有一个靠那个缺省值撑着。
   （两处改的都是仓库外的副本：源码目录整份复制出去改，比对过仓库文件字节相同。）

   A3 顺带改了本文件的桩件形状：验证墙那条注入从回布尔改成回事实对象（判定搬到
   decideWallFromFrames），所以 inject 里给的是 wallFact()。用例侧的 wall: true/false
   语义没变，变的只是造出来的载荷长什么样。 */
