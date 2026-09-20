/* 标签页被关闭之后任务怎么办（tabs.onRemoved → reopenTaskTab）。
   这条路径此前零覆盖：桩件的 fire.tabRemoved 从来没被调用过，而后台在关掉一个被监控的
   标签页时会自动开一张新页并把任务搬到新 id 上——搬错了就是"任务还在、页面没了"或者
   凭空多一个标签页，用户在弹窗里只能看到编号变了。

   与 prune-plan 的分工：那边管浏览器重启后的挂接，这边管会话中途关页。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

/* onRemoved 的监听器是同步函数里裸调 reopenTaskTab，没有把 promise 交回去，
   所以派发完必须让宏任务队列跑一轮才能看到结果 */
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot({ tasks, tabs, settings } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  /* httpHeartbeat 保持默认开：重挂之后有没有心跳正是这里要断言的 */
  env.store.sync.settings = Object.assign({ keepAlive: false, cookieBackup: false }, settings);
  for (const t of tabs || []) env.putTab(t.id, t.url, { active: t.active });
  await bootBackground(env);
  return env;
}

/* 让重开出来的 id 可预期，并记下真的开了哪几个网址 */
function stubCreates(env, ids) {
  const seen = [];
  let i = 0;
  env.chrome.tabs.create = async (props) => {
    seen.push(props.url);
    const id = ids[i++];
    if (id === undefined) throw new Error("tabs.create 调用次数超出预期: " + props.url);
    env.putTab(id, props.url);
    return { id, url: props.url };
  };
  return seen;
}

const keys = (tasks) => Object.keys(tasks).map(Number).sort((a, b) => a - b);
const cleared = (env) => env.calls.alarmsCleared.slice().sort();

test("关掉被监控的标签页：按记录的网址重开一张，任务搬到新 id，旧 alarm 清掉", async () => {
  const env = await boot({ tasks: { 7: task({ keywords: ["补货"], onHit: "continue" }) }, tabs: [{ id: 7, url: PAGE }] });
  const seen = stubCreates(env, [42]);
  /* 记下挂 alarm 那一刻落盘的键集合：先挂后写会让 ensureHeartbeat 读到"这个 id 没任务"
     而把心跳清掉，恢复后的任务只剩刷新、没有静默心跳（2.1.0 修过的同一个形状） */
  const atArm = [];
  const realCreate = env.chrome.alarms.create;
  env.chrome.alarms.create = async (name, info) => {
    atArm.push([name, keys(env.store.local.tasks || {}).join(",")]);
    return realCreate(name, info);
  };
  await env.fire.tabRemoved(7, false);
  await flush();

  assert.deepEqual(seen, [PAGE], "没按记录的重开，或凭空多开");
  assert.deepEqual(keys(env.store.local.tasks), [42]);
  assert.deepEqual(env.store.local.tasks[42].keywords, ["补货"], "搬运过程丢了关键词");
  assert.equal(env.store.local.tasks[42].onHit, "continue");
  assert.deepEqual(cleared(env), ["hb-7", "refresh-7"], "旧 id 上的 alarm 成了无人清的残留");
  assert.ok(atArm.some(([n, k]) => n === "refresh-42" && k === "42"), "refresh-42 挂在写盘之前");
  assert.ok(atArm.some(([n, k]) => n === "hb-42" && k === "42"), "hb-42 挂在写盘之前");
});

test("窗口整体关闭时不重开：由启动恢复兜底", async () => {
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }] });
  const seen = stubCreates(env, []);
  await env.fire.tabRemoved(7, true);
  await flush();
  assert.deepEqual(seen, [], "关整个窗口的时候每张页各开一张，等于重启时炸出一堆标签页");
  assert.deepEqual(keys(env.store.local.tasks), [7]);
  assert.deepEqual(cleared(env), [], "任务还没搬走就把定时器清了");
});

test("非监控标签页关闭：不开页、不写盘、不清 alarm", async () => {
  const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }, { id: 9, url: "https://b.test/x" }] });
  const seen = stubCreates(env, []);
  await env.fire.tabRemoved(9, false);
  await flush();
  assert.deepEqual(seen, []);
  assert.deepEqual(keys(env.store.local.tasks), [7]);
  assert.deepEqual(
    env.calls.localSet.filter((k) => k.includes("tasks")),
    [],
    "关掉一张无关页面却重写了一遍任务表"
  );
});

test("重开失败时旧任务与旧 alarm 原样留着", async () => {
  /* 两种失败形状都要挡：create 抛错（站点策略、会话恢复抢败是常态），以及 create 回来一个
     没有 id 的对象。只测前者的话 `typeof newTab.id !== "number"` 那道判断没有门禁守着——
     把它删掉，用例照样绿（因为紧接着的 tasks[newTab.id] 自己抛 TypeError，写盘从没发生，
     落盘状态看不出任何异常）。最坏的结果不是"没开成页"，而是任务键被删、alarm 被清，
     留下一条谁也管不着的孤儿 */
  for (const failing of [
    { name: "抛错", impl: async () => { throw new Error("Tabs cannot be edited"); } },
    { name: "返回无 id 的对象", impl: async () => ({ url: PAGE }) }
  ]) {
    const env = await boot({ tasks: { 7: task() }, tabs: [{ id: 7, url: PAGE }] });
    env.chrome.tabs.create = failing.impl;
    await env.fire.tabRemoved(7, false);
    await flush();
    assert.deepEqual(keys(env.store.local.tasks), [7], `${failing.name}：开页失败却把任务删了`);
    assert.deepEqual(cleared(env), [], `${failing.name}：页面没开成却先清了定时器`);
  }
});

test("没有网址的旧任务不去重开", async () => {
  const env = await boot({ tasks: { 7: { intervalSec: 300, createdAt: 1 } }, tabs: [{ id: 7, url: PAGE }] });
  const seen = stubCreates(env, []);
  await env.fire.tabRemoved(7, false);
  await flush();
  assert.deepEqual(seen, [], "没有网址就重开，等于开一张 about:blank 的幽灵任务页");
  assert.deepEqual(keys(env.store.local.tasks), [7]);
});

/* 红→绿对照（照本仓库方法学：没见过红的门禁不算门禁）。
   整份插件目录复制到仓库外，在副本的 background.js 上逐处改坏，用 TAR_BG 指过去跑本文件。
   五处对照 2026-09-19 实跑，每处都只红在下面点名的那一条、其余四条全绿：
     1) 删掉 onRemoved 里的 `if (removeInfo && removeInfo.isWindowClosing) return;`
        → 红在"窗口整体关闭时不重开"
     2) `if (!task || !task.url) return false;` 改成 `if (!task) return false;`
        → 红在"没有网址的旧任务不去重开"
     3) 删掉 `if (!newTab || typeof newTab.id !== "number") return false;`
        → 红在"重开失败时旧任务与旧 alarm 原样留着"，但只红在第二轮那个"返回无 id 的对象"上。
           只留抛错那一轮的话这道 guard 删掉也不红：紧接着的 tasks[newTab.id] 自己抛
           TypeError，写盘从没执行，落盘状态看不出任何异常——这就是那条用例跑两种失败形状的原因
     4) 把 `await setTasks(tasks)` 挪到 armRefresh / ensureHeartbeat 之后
        → 红在第一条（"挂在写盘之前"那两条快照断言，refresh-42 与 hb-42 同时红）
     5) 删掉两条 `chrome.alarms.clear(旧 id)`
        → 红在第一条的"旧 id 上的 alarm 成了无人清的残留"
   三个坑记下来别再来一遍，前两个是第一轮实跑踩的：
   - 本机 core.autocrlf=true，工作区里的 background.js 是 CRLF，跨行 needle 要先归一化成 LF，
     否则会出现"没改到却以为改到了"的假对照
   - `await setTasks(tasks);` 在 background.js 里出现几十次。改动必须圈定在
     reopenTaskTab / onRemoved 那两段之内，并断言 needle 在那一段里正好命中一次。
     第一轮没圈范围，删掉的是别处的一句，本文件全绿，差点被记成"这条 guard 没有门禁"
   - 反过来，桩件里 `fire.tabRemoved` 先 `tabs.delete` 再派发那一步（照真实 Chrome 的时序）
     没有对照：去掉它本文件五条全绿，因为 reopenTaskTab 根本不回查旧页。
     留着它是因为建模对了，不是因为有人靠它变红；写"关掉又重开"的链式用例时才用得上 */
