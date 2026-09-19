/* 2.2.0 批次 4 的门禁：启动恢复的挂接顺序。
   这套规则原先长在 prune 的 130 行命令式循环里，靠读代码推断顺序，而且只有
   _code-review/verify-prune-order.mjs 一个本地脚本守着——那个脚本是"从当时的源码切片
   生成"的冻结副本，prune 一改它就悄悄变成在测已经不存在的代码（这一批里它就真的
   全绿通过了一次，尽管被测函数整个换了写法）。所以断言搬到这里，改成直接调用活的
   planPrune 与真实的 prune 执行器。

   纯函数侧覆盖认领/避让/淘汰的次序，执行器侧覆盖两件纯函数管不到的事：
   arm 与清 alarm 的先后（必须先写盘再清，且对照写盘后的最终键集合），
   以及标签页 id 被 Chrome 复用时不能把刚 arm 的 alarm 清掉（0b04251 那个僵尸）。 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as realSetTimeout } from "node:timers";

import { planPrune } from "../../tab-auto-refresh/shared/logic.js";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

/* prune 开头要等 1.5 秒让会话恢复的标签页出现，认领不到还要再等 20 秒等待窗口。
   这两段在真机上是用来对抗"页面比事件晚到"的，逻辑上只是到点就走，测试不必真等：
   这里把全局 setTimeout 的延时压成 1/100（下限 5 毫秒），窗口与顺序都保持原样。
   node --test 按文件分进程，补丁不会漏给其它用例；用例自己要排的事件用
   node:timers 里没被压过的 realSetTimeout，以免排进错误的时段 */
const rawSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  rawSetTimeout(fn, typeof ms === "number" && ms > 50 ? Math.max(5, Math.round(ms / 100)) : ms, ...rest);

const task = (url, extra) => Object.assign({ intervalSec: 300, createdAt: 1 }, url ? { url } : {}, extra);
const keys = (tasks) => Object.keys(tasks).map(Number).sort((a, b) => a - b);

/* ---------- 纯函数：planPrune ---------- */

test("ID 被占用不等于挂接正确，网址不一致就不认领", () => {
  const p = planPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 7, url: "https://unrelated.test/other" }]
  });
  assert.deepEqual(p.keep, []);
  assert.deepEqual(keys(p.next), []);
  assert.deepEqual(p.watch.map((w) => w.from), [7], "该进延迟认领候选，而不是就地保留");
  assert.deepEqual(p.staleIds, [7]);
});

test("网址一致的活标签页原样认领，不重挂也不重开", () => {
  const p = planPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 7, url: "https://a.test/board" }]
  });
  assert.deepEqual(p.keep, [7]);
  assert.deepEqual(p.remap, []);
  assert.deepEqual(p.watch, []);
  assert.deepEqual(p.staleIds, []);
  assert.equal(p.dirty, false, "什么都没动却标了脏，会白白写一次盘");
});

test("查询串与 hash 不算换页：按 origin+pathname 认址后跟随真实地址", () => {
  const p = planPrune({
    tasks: { 7: task("https://a.test/board?id=1") },
    tabs: [{ id: 20, url: "https://a.test/board?id=2#frag" }]
  });
  assert.deepEqual(p.remap, [{ from: 7, to: 20, url: "https://a.test/board?id=2#frag" }]);
  assert.equal(p.next[20].url, "https://a.test/board?id=2#frag", "重挂后没跟到页面实际地址");
});

test("两个任务撞同一个页面时，认不到的那个走重开而不是被覆盖丢失", () => {
  const p = planPrune({
    tasks: { 7: task("https://a.test/board"), 9: task("https://a.test/board") },
    tabs: [{ id: 20, url: "https://a.test/board" }]
  });
  assert.deepEqual(p.remap, [{ from: 7, to: 20, url: "https://a.test/board" }]);
  assert.deepEqual(p.watch.map((w) => w.from), [9], "第二个任务被静默丢弃了");
  assert.deepEqual(keys(p.next), [20]);
});

test("同一网址开在多个标签页上，每个页面至多挂一个任务", () => {
  const p = planPrune({
    tasks: { 7: task("https://a.test/board"), 9: task("https://a.test/board") },
    tabs: [
      { id: 20, url: "https://a.test/board" },
      { id: 21, url: "https://a.test/board" }
    ]
  });
  assert.deepEqual(p.remap.map((r) => [r.from, r.to]), [[7, 20], [9, 21]]);
  assert.deepEqual(p.watch, []);
  assert.deepEqual(keys(p.next), [20, 21]);
});

test("认领不得踩到仍是其他未处理任务的键", () => {
  /* 页面 9 显示的是任务 7 的目标，但 9 本身还是任务 9 的键且尚未处理：
     直接写 tasks[9] 会把任务 9 整条覆盖掉，后者静默丢失 */
  const p = planPrune({
    tasks: { 7: task("https://a.test/board"), 9: task("https://b.test/own") },
    tabs: [{ id: 9, url: "https://a.test/board" }]
  });
  assert.deepEqual(p.remap, [], "页面 9 还没腾出来就被任务 7 认领了");
  assert.deepEqual(p.watch.map((w) => w.from), [7, 9], "两个任务都该走重开，一个都不能丢");
  assert.deepEqual(keys(p.next), [], "未处理完的键不该还留在结果里");
});

test("旧格式任务：安装/更新那回补记当前网址，重启那回只能淘汰", () => {
  const legacy = { 7: task("") };
  const adopted = planPrune({ tasks: legacy, tabs: [{ id: 7, url: "https://a.test/board" }], adoptLegacyUrls: true });
  assert.deepEqual(adopted.adopt, [7]);
  assert.equal(adopted.next[7].url, "https://a.test/board", "没有补记成当前网址");
  assert.deepEqual(adopted.dropped, []);

  const dropped = planPrune({ tasks: legacy, tabs: [{ id: 7, url: "https://a.test/board" }], adoptLegacyUrls: false });
  assert.deepEqual(dropped.adopt, []);
  assert.deepEqual(dropped.dropped.map((d) => d.from), [7], "浏览器重启后不该凭撞上的 ID 猜目标");
  assert.deepEqual(dropped.watch, [], "无网址也无法补记的任务不该去重开");
});

test("重开时带上的是整条任务，不只是网址和间隔", () => {
  const withKw = { 7: task("https://a.test/board", { keywords: ["补货"], onHit: "continue", notifiedKeys: ["补货"] }) };
  const p = planPrune({ tasks: withKw, tabs: [] });
  assert.equal(p.watch.length, 1);
  assert.deepEqual(p.watch[0].task.keywords, ["补货"], "恢复过程丢了关键词");
  assert.equal(p.watch[0].task.onHit, "continue");
  assert.deepEqual(p.watch[0].task.notifiedKeys, ["补货"]);
});

test("非 http(s) 的目标网址不去重开，直接淘汰", () => {
  const p = planPrune({ tasks: { 7: task("file:///C:/x/y.html") }, tabs: [] });
  assert.deepEqual(p.watch, []);
  assert.deepEqual(p.dropped.map((d) => d.from), [7]);
});

/* ---------- 执行器：真实的 prune() ---------- */

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

async function runPrune(env) {
  await env.fire.startup();
}

async function bootPrune({ tasks, tabs, settings }) {
  const env = makeEnv();
  env.store.local.tasks = tasks;
  /* 只关保活注入与 cookie 备份；httpHeartbeat 保持默认开，心跳要不要重挂正是这里要断言的 */
  env.store.sync.settings = Object.assign({ keepAlive: false, cookieBackup: false }, settings);
  for (const t of tabs) env.putTab(t.id, t.url);
  await bootBackground(env);
  return env;
}

const createdAlarms = (env) => env.calls.alarmsCreated.map(([name]) => name).sort();

test("死 ID 的任务重挂到活页面：任务与 alarm 都换到新 ID，旧 alarm 清掉", async () => {
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 20, url: "https://a.test/board" }]
  });
  const seen = stubCreates(env, []);
  const cleared = [];
  const realClear = env.chrome.alarms.clear;
  env.chrome.alarms.clear = async (name) => {
    cleared.push(name);
    return realClear(name);
  };
  await runPrune(env);

  assert.deepEqual(seen, [], "页面已经在场，不该再开新标签页");
  assert.deepEqual(keys(env.store.local.tasks), [20]);
  assert.ok(createdAlarms(env).includes("refresh-20"), "新 ID 上没挂定时器");
  assert.ok(createdAlarms(env).includes("hb-20"), "新 ID 上没挂心跳：恢复后只剩刷新，没有静默心跳");
  assert.deepEqual(cleared.sort(), ["hb-7", "refresh-7"]);
});

test("心跳关掉时重挂不要顺手建出 hb alarm", async () => {
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 20, url: "https://a.test/board" }],
    settings: { httpHeartbeat: false }
  });
  stubCreates(env, []);
  await runPrune(env);
  assert.ok(!createdAlarms(env).includes("hb-20"));
  assert.ok(createdAlarms(env).includes("refresh-20"));
});

test("Chrome 复用 id 重开时，不得把刚 arm 的 alarm 当成残留清掉", async () => {
  /* 任务 7 与任务 9 的页面都没了。重开时 Chrome 把 9 这个号发给了第二个新页面：
     陈旧 alarm 清单里有 refresh-9，而最终键集合里也有 9 —— 清它就是"任务在、永不刷新" */
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/one"), 9: task("https://b.test/two") },
    tabs: [{ id: 7, url: "https://unrelated.test/other" }]
  });
  stubCreates(env, [11, 9]);
  const cleared = [];
  const realClear = env.chrome.alarms.clear;
  env.chrome.alarms.clear = async (name) => {
    cleared.push(name);
    return realClear(name);
  };
  await runPrune(env);

  assert.deepEqual(keys(env.store.local.tasks), [9, 11]);
  assert.ok(!cleared.includes("refresh-9"), "把本轮刚 arm 的定时器清掉了：僵尸任务");
  assert.ok(!cleared.includes("hb-9"), "心跳同理");
  assert.ok(cleared.includes("refresh-7"), "真正该清的旧 alarm 没清");
});

test("重开出来的任务保留关键词配置并挂上定时器", async () => {
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/board", { keywords: ["补货"], onHit: "continue" }) },
    tabs: []
  });
  stubCreates(env, [42]);
  await runPrune(env);
  assert.deepEqual(keys(env.store.local.tasks), [42]);
  assert.deepEqual(env.store.local.tasks[42].keywords, ["补货"]);
  assert.equal(env.store.local.tasks[42].onHit, "continue");
  assert.ok(createdAlarms(env).includes("refresh-42"));
});

/* 旧格式任务（v1.4.3 及更早：只有间隔和创建时间、没有网址）在两条恢复入口上走向相反，
   差别全在 prune(adoptLegacyUrls) 那一个实参上。纯函数侧早测过，执行器侧这里是第一次，
   也是 env.fire.installed 第一次被用起来（它此前是个没人调用的死入口） */

test("安装/更新那回给旧格式任务补记当前网址", async () => {
  const env = await bootPrune({ tasks: { 7: task("") }, tabs: [{ id: 7, url: "https://a.test/board" }] });
  const seen = stubCreates(env, []);
  await env.fire.installed();
  assert.equal(env.store.local.tasks[7].url, "https://a.test/board", "onInstalled 没补记当前网址");
  assert.deepEqual(seen, [], "补记完之后任务页还在，不该重开");
});

test("浏览器重启那回不补记，只能淘汰", async () => {
  /* 这时 tabId 已重新分配，7 这个号撞上谁纯看运气，凭它猜目标页面会把任务挂到无关页上 */
  const env = await bootPrune({ tasks: { 7: task("") }, tabs: [{ id: 7, url: "https://a.test/board" }] });
  const seen = stubCreates(env, []);
  await runPrune(env);
  assert.equal(env.store.local.tasks[7], undefined, "重启后还在给旧格式任务补记网址");
  assert.deepEqual(seen, [], "没有网址也无从重开");
});

test("认领不到的页面在等待窗口里到位后不再重开", async () => {
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 3, url: "https://nothing.test/" }]
  });
  let created = 0;
  env.chrome.tabs.create = async (props) => {
    created++;
    env.putTab(99, props.url);
    return { id: 99 };
  };
  /* 恢复过程开头有等待（本文件把它压到 15 毫秒），页面随后在等待窗口里导航到位：
     prune 会重跑一遍计划并直接认领，不该再开一个新标签页。
     排事件用未压缩的 realSetTimeout，确保落在窗口之内而不是窗口之前 */
  realSetTimeout(() => {
    env.putTab(3, "https://a.test/board");
    void env.fire.tabUpdated(3, { status: "complete" }, { id: 3, url: "https://a.test/board" });
  }, 100);
  await runPrune(env);
  assert.equal(created, 0, "页面已经在了还重开，等于凭空多一个标签页");
  assert.deepEqual(keys(env.store.local.tasks), [3]);
});

test("什么都没要改时不写盘", async () => {
  const env = await bootPrune({
    tasks: { 7: task("https://a.test/board") },
    tabs: [{ id: 7, url: "https://a.test/board" }]
  });
  await runPrune(env);
  /* 只比前后 JSON 是比不出"没写"的：set 是 Object.assign 合并，写一份一模一样的值
     照样通过。所以这里正面数写入，而不是看落盘后的形状 */
  const taskWrites = env.calls.localSet.filter((keys) => keys.includes("tasks"));
  assert.deepEqual(taskWrites, [], "计划什么都没改，却还是写了 tasks 一笔");
  assert.deepEqual(keys(env.store.local.tasks), [7], "不写盘的前提是任务确实还在原处");
});

test("三个认领不到的任务共享一个等待窗口，不是各等一遍", async () => {
  /* 这是批次 4 的标题性收益：原先每个未认领任务在 for 循环里各 await 一次 watchForUrl
     （上限 20 秒）且全程持锁，三个任务就是 60 秒弹窗卡住；现在所有候选共用一个窗口。
     数的是"开了几轮窗口"而不是墙钟：等待窗口的唯一痕迹就是那次临时的
     tabs.onUpdated.addListener（模块常驻的那个在 boot 时已经注册过了，不计），
     比时间断言稳定，也不会因为 CI 机器抖动误判 */
  const env = await bootPrune({
    tasks: {
      7: task("https://a.test/one"),
      9: task("https://b.test/two"),
      11: task("https://c.test/three")
    },
    tabs: []
  });
  const seen = stubCreates(env, [21, 22, 23]);
  let windows = 0;
  const sink = env.chrome.tabs.onUpdated;
  const realAdd = sink.addListener;
  sink.addListener = (f) => {
    windows++;
    return realAdd(f);
  };
  await runPrune(env);
  assert.equal(seen.length, 3, "三个都该重开");
  assert.deepEqual(keys(env.store.local.tasks), [21, 22, 23]);
  assert.equal(windows, 1, `开了 ${windows} 轮等待窗口：按任务各等一遍就是 N×20 秒持锁`);
  /* 窗口用完要摘掉，否则下一轮恢复会带着上一个窗口的监听器 */
  assert.equal(env.listeners.updated.length, 1, "临时监听器没摘");
});

/* 红→绿对照（本仓库的方法学红线：断言必须被证明非空跑）。对照要改的是源码本身，
   所以整份复制到仓库外，直接在副本上跑——副本自包含，不需要 TAR_BG：
     V=$TMPDIR/tar-ctrl/V && rm -rf $V && mkdir -p $V
     cp -r tab-auto-refresh tests "$V"/
     # 对副本里的 background.js / shared/logic.js 做一处"故意改坏"的替换，然后：
     node --test "$(cygpath -w "$V")\\tests\\tab-auto-refresh\\prune-plan.test.mjs"
   四处对照与期望结果（2026-09-18 实跑，每次都只红在对应那一条、其余全绿）：
     1) 把 `if (plan.dirty) await setTasks(tasks)` 挪回重挂循环之后（改成先挂再写）
        → 红在"死 ID 的任务重挂到活页面"（hb-20 建不出来）
     2) `if (liveIds.has(String(id))) continue;` 改成 `if (false) continue;`
        → 红在"Chrome 复用 id 重开时…"
     3) 删掉 `if (first.watch.length) await waitForUrls(...)`
        → 红在"认领不到的页面在等待窗口里到位后不再重开"与"三个…共享一个等待窗口"
           （后者数的是本轮开过几回临时监听，去掉共享窗口就回不到 1）
     4) shared/logic.js 里 `if (claims.has(t.id) || pending.has(t.id))` 去掉 `|| pending.has(t.id)`
        → 红在"认领不得踩到仍是其他未处理任务的键"
   2026-09-19 为那两条旧格式任务的执行器用例又补了两处，同样每处只红一条、其余全绿：
     5) onInstalled 的注册实参 `prune(true)` 改成 `prune(false)`
        → 红在"安装/更新那回给旧格式任务补记当前网址"
     6) onStartup 的注册实参 `prune(false)` 改成 `prune(true)`
        → 红在"浏览器重启那回不补记，只能淘汰"
   （5、6 改的是 background.js，用 TAR_BG 指副本，不需要把整棵 tests/ 也拷出去）
   另外三条被本文件依赖的机制也各自红过：桩件 tabs.onUpdated 少了 removeListener 时，
   三条走等待窗口的用例整条红（这正是 removeListener 补进共用桩件的原因）。
   行尾这件事别凭印象：本机 core.autocrlf=true，工作区里所有 .js（含 background.js，
   2026-09-19 数过 CRLF 对确认）都是 CRLF，索引里存的才是 LF。跨行 needle 一律先归一化再匹配，
   否则会出现"没改到却以为改到了"的假对照。 */
