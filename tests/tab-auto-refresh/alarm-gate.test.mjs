/* 2.2.0 批次 5 的门禁：定时器到点之后怎么处理。
   这套判定原先是 onAlarm 里六段提前返回，"谁排在谁前面"只能读代码推断；现在决策
   搬进 shared/logic.js 的 decideAlarmAction，执行器只负责把事实取齐、把 verdict 落实。
   于是三条次序（全局暂停早于页面存在性、存在性早于自动暂停、活动判定只认 or）
   和"页正被看着就别重载"这条新通道都能被直接断言。

   执行器侧另管纯函数管不到的三件事：活动时间戳要真的从会话态读（放内存就等于每次
   SW 回收都清零，60 秒窗口形同虚设）、焦点窗口认不出来时必须放行刷新（宁可多刷一次，
   绝不能反过来变成永不刷新）、以及暂停期间定时器照常续跑（恢复时零重建）。 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_SKIP_MS,
  ALARM_ACT,
  decideAlarmAction
} from "../../tab-auto-refresh/shared/logic.js";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

/* ---------- 纯函数：decideAlarmAction ---------- */

const TASK = { intervalSec: 300, createdAt: 1, url: "https://a.test/board" };
const TAB = { id: 7, url: "https://a.test/board", windowId: 1, active: false };
const decide = (over) =>
  decideAlarmAction(
    Object.assign({ task: TASK, tab: TAB, pausedAll: false, skipOnActivity: true, skipDiscarded: false }, over)
  );
const is = (over, action, reason) => {
  const v = decide(over);
  assert.equal(v.action, action, reason ? `${action}/${reason} 判成了 ${v.action}/${v.reason}` : undefined);
  if (reason !== undefined) assert.equal(v.reason, reason);
  return v;
};

test("任务已经不在了：清掉 alarm，不算停止也不通知", () => {
  is({ task: null }, ALARM_ACT.CLEAR, "no-task");
  /* 没有任务就没有通知可发，误清与误发都不该有 */
});

test("全局暂停排在页面存在性之前：暂停时关掉被监控页不该收到停止通知", () => {
  is({ pausedAll: true, tab: null }, ALARM_ACT.SKIP, "paused-all");
});

test("页面存在性排在自动暂停之前：否则自动暂停的任务关页后成了僵尸", () => {
  is(
    { tab: null, task: Object.assign({}, TASK, { autoPaused: { reason: "captcha" } }) },
    ALARM_ACT.STOP,
    "tab-gone"
  );
});

test("自动暂停只跳过这一拍，任务与定时器都不动", () => {
  const v = is({ task: Object.assign({}, TASK, { autoPaused: { reason: "error" } }) }, ALARM_ACT.SKIP, "auto-paused");
  assert.equal(v.pausedReason, "error", "执行器要拿它决定通知文案，丢了就只能重写一遍判定");
});

test("该刷的照刷：默认路径一条不多不少", () => {
  is({}, ALARM_ACT.RELOAD, "");
});

test("60 秒窗口内操作过就跳过，出窗后照刷", () => {
  is({ lastActivityAgoMs: ACTIVITY_SKIP_MS - 1 }, ALARM_ACT.SKIP, "user-active");
  is({ lastActivityAgoMs: ACTIVITY_SKIP_MS }, ALARM_ACT.RELOAD);
  is({ lastActivityAgoMs: 0 }, ALARM_ACT.SKIP, "user-active");
});

test("注入没上报活动也认得出人在看：该页是焦点窗口的当前标签页", () => {
  /* 内容脚本注入失败（受限页、时序、站点权限）时永不上报时间戳，只靠时间戳就会
     在用户眼皮底下把页面重载掉 */
  is({ tabIsVisible: true, lastActivityAgoMs: Infinity }, ALARM_ACT.SKIP, "user-active");
});

test("两条活动判据是 or，关掉开关就都不认", () => {
  is({ tabIsVisible: true, lastActivityAgoMs: 1000, skipOnActivity: false }, ALARM_ACT.RELOAD);
  is({ tabIsVisible: false, lastActivityAgoMs: 1000, skipOnActivity: false }, ALARM_ACT.RELOAD);
});

test("时间戳取不到时按'没活动'处理，不能变成永不刷新", () => {
  /* 会话态读失败会给出 NaN/Infinity：Number.isFinite 挡掉 NaN，Infinity 本身出窗 */
  is({ lastActivityAgoMs: NaN }, ALARM_ACT.RELOAD);
  is({ lastActivityAgoMs: Infinity }, ALARM_ACT.RELOAD);
  is({ lastActivityAgoMs: undefined }, ALARM_ACT.RELOAD);
});

test("休眠标签页只在开关开着时跳过", () => {
  is({ tab: Object.assign({}, TAB, { discarded: true }), skipDiscarded: true }, ALARM_ACT.SKIP, "discarded");
  is({ tab: Object.assign({}, TAB, { discarded: true }), skipDiscarded: false }, ALARM_ACT.RELOAD);
});

/* ---------- 执行器：真实的 onAlarm ---------- */

async function bootAlarm({ tasks, tabs, settings, pausedAll, session } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  if (pausedAll) env.store.local.pausedAll = true;
  Object.assign(env.store.session, session || {});
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false, captchaGuard: false },
    settings
  );
  for (const t of tabs || []) env.putTab(t.id, t.url, t);
  await bootBackground(env);
  return env;
}

const reloaded = (env) => env.calls.reloaded;
const rearmed = (env) => env.calls.alarmsCreated.map(([n]) => n);

test("到点刷新：重挂下一次定时器，再刷新页面", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url }] });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(rearmed(env), ["refresh-7"]);
  assert.deepEqual(reloaded(env), [7]);
});

test("只是同公共后缀的另一家站点：算漂移，导航回监控目标而不是原地刷新", async () => {
  /* reloadTab 的同站判断吃的是 siteRoot。多级公共后缀（co.nz 一类）以前被当成注册域，
     于是 shop.example.co.nz 与 other.co.nz 被判成同站，用户误开的外链页被原地刷新 */
  const task = { intervalSec: 300, createdAt: 1, url: "https://shop.example.co.nz/board" };
  const env = await bootAlarm({
    tasks: { 7: task },
    tabs: [{ id: 7, url: "https://other.co.nz/whatever" }]
  });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(env.calls.navigated, [[7, task.url]], "跨注册域的漂移没被认出来");
  assert.deepEqual(reloaded(env), [], "误开的无关站点被原地刷新了");
});

test("同注册域的子域跳转仍算同站：原地刷新，不改回旧地址", async () => {
  const task = { intervalSec: 300, createdAt: 1, url: "https://shop.example.co.nz/board" };
  const env = await bootAlarm({
    tasks: { 7: task },
    tabs: [{ id: 7, url: "https://sso.example.co.nz/login" }]
  });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(env.calls.navigated, [], "兄弟子域的 SSO 跳转被当成了漂移");
  assert.deepEqual(reloaded(env), [7]);
});

test("全局暂停期间不刷新，但定时器要续跑，恢复时零重建", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url }], pausedAll: true });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [], "暂停期间还在刷新");
  assert.deepEqual(rearmed(env), ["refresh-7"]);
});

test("自动暂停的任务到点只续跑定时器，不刷新也不清任务", async () => {
  const env = await bootAlarm({
    tasks: { 7: Object.assign({}, TASK, { autoPaused: { reason: "captcha" } }) },
    tabs: [{ id: 7, url: TASK.url }]
  });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), []);
  assert.deepEqual(rearmed(env), ["refresh-7"]);
  assert.ok(env.store.local.tasks[7], "自动暂停被执行器当成任务已死清掉了");
});

test("页正被用户看着时不重载：不依赖注入的那条通道", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }] });
  env.focusWindow(1);
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [], "人在看着这页，还是给重载了");
  assert.deepEqual(rearmed(env), ["refresh-7"]);
});

test("后台窗口里的标签页照刷：只有焦点窗口的当前页算看着", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }] });
  env.focusWindow(2); /* 另一个窗口在前台 */
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [7]);
});

test("浏览器退到后台但窗口还在：必须照常刷新", async () => {
  /* 真实 Chrome 的三态里最难分的一态：焦点事件给了 WINDOW_ID_NONE（人切去别的应用了），
     但窗口还在，此时 getLastFocused() 仍然返回最后聚焦的那个窗口。
     旧写法把"已知无焦点"与"还不知道焦点在哪"合成同一个 null，于是这次补查会把
     focusedWindowId 重新填成 tab.windowId → 判定"人正看着这页" → 用户走开期间的每一次
     触发都被跳过，任务从此不再刷新，正是"认不出来一律放行"那句承诺的反面。
     旧桩件在无焦点时直接让 getLastFocused 抛错，这一态在测试里压根造不出来 */
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }] });
  env.focusWindow(1); /* 人确实在这个窗口上 */
  env.focusWindow(null); /* 切去别的应用：窗口还在，getLastFocused 仍返回窗口 1 */
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [7], "浏览器一退到后台就被判成「用户一直在这页」，任务永不刷新");
  assert.deepEqual(rearmed(env), ["refresh-7"], "跳过这一拍也要续跑定时器");
});

test("冷启动且一个窗口都没有：补查失败就放行刷新", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }] });
  env.closeAllWindows(); /* 从没收到过焦点事件，且 getLastFocused 会 reject */
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [7], "问不到焦点窗口被当成了「人一直在这页」");
});

test("冷启动且有最后聚焦的窗口：补查那一次要认得出人在看", async () => {
  /* SW 被回收再唤醒时还没有任何焦点事件，这一态只能靠补查。
     补查去掉之后这条会红——它是"退到后台不刷新"那条的反向配对，两条合起来才说明
     分的是"不知道"与"知道不在前台"，而不是一律放行或一律拦下 */
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }] });
  env.chrome.windows.update(1, { focused: true }); /* 有窗口且它是最后聚焦的，但不发焦点事件 */
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [], "冷启动第一拍该认出人在看，却把页面重载了");
});

test("内容脚本上报的活动时间戳走会话态，跨 SW 回收仍然算数", async () => {
  const env = await bootAlarm({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url }],
    session: { "rt:activity:7": Date.now() - 5000 }
  });
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), []);
  /* 同一个键换成 60 秒之前：出窗就照刷，证明读的是这个键而不是别的什么默认值 */
  const stale = await bootAlarm({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url }],
    session: { "rt:activity:7": Date.now() - (ACTIVITY_SKIP_MS + 1000) }
  });
  await stale.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(stale), [7]);
});

test("标签页已不存在：停任务并发停止通知", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [] });
  await env.fire.alarm("refresh-7");
  assert.equal(env.store.local.tasks[7], undefined, "页面没了任务还留着");
  assert.deepEqual(
    env.calls.notifCreated.map(([id]) => id),
    ["refresh-stopped-7"]
  );
  /* 停止之后这条 alarm 不该再留在系统里 */
  assert.equal(await env.chrome.alarms.getAll().then((l) => l.some((a) => a.name === "refresh-7")), false);
});

test("非监控标签页的 alarm：清掉即可，不动任何任务", async () => {
  const env = await bootAlarm({ tasks: { 7: TASK }, tabs: [{ id: 7, url: TASK.url }] });
  await env.fire.alarm("refresh-99");
  assert.deepEqual(reloaded(env), []);
  assert.ok(env.store.local.tasks[7]);
  assert.deepEqual(env.calls.notifCreated.map(([id]) => id), []);
});

test("关掉'有活动时跳过'后不再去问窗口焦点", async () => {
  const env = await bootAlarm({
    tasks: { 7: TASK },
    tabs: [{ id: 7, url: TASK.url, active: true, windowId: 1 }],
    settings: { skipOnActivity: false }
  });
  /* 故意不发焦点事件：缓存里没有焦点窗口 id 时 isTabOnScreen 才会去问 getLastFocused，
     这一问就是要数住的那一笔（先 focusWindow(1) 会让它走缓存，断言变成空跑） */
  let asked = 0;
  const real = env.chrome.windows.getLastFocused;
  env.chrome.windows.getLastFocused = async () => {
    asked++;
    return real();
  };
  await env.fire.alarm("refresh-7");
  assert.deepEqual(reloaded(env), [7], "开关关着却被跳过了");
  assert.equal(asked, 0, "每次触发都白问一遍焦点窗口：30 秒任务下每分钟多出 40 次调用");
});

/* 红→绿对照（整份复制到仓库外，在副本上改源码后跑本文件；做法见 prune-plan.test.mjs 末尾）
   1~3、5 于 2026-09-18 实跑过，每次都只红在对应那一条、其余全绿：
     1) decideAlarmAction 里把 pausedAll 与 !tab 两段调换
        → 红在"全局暂停排在页面存在性之前"
     2) 把 task.autoPaused 那段提到 !tab 之前
        → 红在"页面存在性排在自动暂停之前"
     3) `skipOnActivity && (tabIsVisible || recentlyUsed)` 去掉 tabIsVisible
        → 红在"注入没上报活动也认得出人在看"与"页正被用户看着时不重载"（纯函数与执行器各一条）
     5) 去掉 `settings.skipOnActivity ? await isTabOnScreen(tab) : false` 的条件
        → 红在"关掉'有活动时跳过'后不再去问窗口焦点"
   第 4、6 处于 2026-09-19 本机实跑（本机 node 装回来后门禁恢复；跑法见 harness 头部：
   整份复制到仓库外，在副本上改源码，再用 TAR_BG 指过去跑本文件）：
     6) 把 focusedWindowId 的三态压回两态：声明成 `= null`，并让 `focusedWindowId === null`
        时又去回退问一次 getLastFocused（2.1.0 及以前的写法）
        → 实跑只红在"浏览器退到后台但窗口还在"一条，其余 21 条全绿。
           这一态要新桩件才造得出来（见 harness 的 focusWindow(null) 与 closeAllWindows 之分），
           旧桩件下这条用例根本不存在，所以"有对照"和"对照得动"是两件事，
           桩件建模反了的时候两者都白搭。
     4) isTabOnScreen 里认不出焦点窗口时 return true（两处认不出都要改：已知无焦点、补查也问不到）
        → 实跑红在"浏览器退到后台但窗口还在"与"冷启动且一个窗口都没有"两条。
           只改前一处时第二条仍是绿的——两条合起来才盖住"认不出来一律放行"的两个入口。
   第 5 处第一次跑对照时是绿的：用例自己先 focusWindow(1) 把窗口 id 灌进了模块缓存，
   isTabOnScreen 走缓存就不再去问 getLastFocused，被数的调用一次也没发生。去掉那次
   focusWindow 之后才红。断言看着有、实际空跑，只有对照能抓出来。
   2026-09-19 追加的两条同站判据用例（"只是同公共后缀的另一家站点"与"同注册域的子域跳转"）
   不在本文件的对照清单里：改坏的是 shared/logic.js 的注册域判据而不是 background.js，
   TAR_BG 够不着，做法与红名单见 cookie-backup.test.mjs 末尾第 3 处。 */
