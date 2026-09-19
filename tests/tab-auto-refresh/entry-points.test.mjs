/* 右键菜单与快捷键这两条"人入口"（contextMenus.onClicked / commands.onCommand）。
   此前零覆盖：桩件连菜单点击的派发入口都没有（contextMenus.onClicked 挂在一个外部
   拿不到的空数组上），commands.onCommand 也没有派发口。现在 env.fire.menuClicked /
   env.fire.command / env.menuItems 三样齐了，才第一次跑到。

   与 alarm-gate 的分工：那边管到点之后做什么，这边管"用户从弹窗之外怎么起停任务"。
   startTask 里"解除全局暂停""记住上次间隔"这两件事也挂在这里测——它们只有这三条入口。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

async function boot({ tasks = {}, tabs = [{ id: 7, url: PAGE, active: true, windowId: 1 }], settings, pausedAll, focused = 1 } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks;
  if (pausedAll) env.store.local.pausedAll = true;
  env.store.sync.settings = Object.assign({ keepAlive: false, cookieBackup: false }, settings);
  for (const t of tabs) env.putTab(t.id, t.url, { active: t.active, windowId: t.windowId });
  await bootBackground(env);
  /* 排在 boot 之后：后台的 windows.onFocusChanged 是 import 时才挂的，先派发了等于没派发。
     快捷键那条链靠 tabs.query({currentWindow:true}) 找当前窗口，桩件按焦点窗口解释这个条件，
     所以"正常桌面"必须有个焦点窗口 */
  if (focused !== null) env.focusWindow(focused);
  return env;
}

const keys = (tasks) => Object.keys(tasks).map(Number).sort((a, b) => a - b);
const created = (env) => env.calls.alarmsCreated.map(([n]) => n).sort();

test("安装时建出预设菜单：根菜单 + 各间隔子项 + 停止项", async () => {
  const env = await boot();
  await env.fire.installed();
  const ids = env.menuItems.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 1), ["root"], "根菜单不是第一项");
  assert.ok(ids.includes("start-30") && ids.includes("start-3600"), "预设间隔没铺全");
  assert.ok(ids.includes("stop"));
  assert.equal(ids.length, 1 + 7 + 1, `菜单项数量 ${ids.length}，与预设条数对不上`);
  for (const m of env.menuItems) {
    assert.deepEqual(m.contexts, ["tab", "page"], `${m.id} 的 contexts 不对，标签页右键与页面右键会各缺一半`);
    if (m.id !== "root") assert.equal(m.parentId, "root");
  }
});

test("右键「开始 1 分钟」：按菜单项里的秒数建任务，并解除全局暂停", async () => {
  const env = await boot({ pausedAll: true });
  await env.fire.menuClicked({ menuItemId: "start-60" }, { id: 7, url: PAGE });
  assert.deepEqual(keys(env.store.local.tasks), [7]);
  assert.equal(env.store.local.tasks[7].intervalSec, 60);
  assert.equal(env.store.local.tasks[7].url, PAGE);
  assert.equal(env.store.local.pausedAll, false, "手动开始任务不该把人留在全局暂停里");
  assert.ok(created(env).includes("refresh-7") && created(env).includes("hb-7"), "只挂了刷新，没有心跳");
  /* 记住这次间隔，供快捷键复用 */
  assert.equal(env.store.sync.settings.lastIntervalSec, 60);
});

test("右键「停止」：删任务并清掉它的两条 alarm", async () => {
  const env = await boot({ tasks: { 7: task({ intervalSec: 60 }) } });
  await env.chrome.alarms.create("refresh-7", { when: Date.now() + 60000 });
  await env.chrome.alarms.create("hb-7", { when: Date.now() + 60000 });
  const mark = env.calls.alarmsCleared.length;
  await env.fire.menuClicked({ menuItemId: "stop" }, { id: 7, url: PAGE });
  assert.deepEqual(keys(env.store.local.tasks), []);
  assert.deepEqual(env.calls.alarmsCleared.slice(mark).sort(), ["hb-7", "refresh-7"]);
});

test("菜单点击拿不到标签页就什么都不做", async () => {
  /* Chrome 在页签已被关掉的情况下可能不带 tab。少了这道判断，startTask(undefined) 会抛，
     菜单路径没有弹窗承接，异常只能被 catch 吞掉——但任务表绝不能被动过。
     "落盘状态没变"那两条钉不住它：guard 删掉后 startTask 内部自己抛，什么都没写进去。
     数 tabs.get 才是门禁——不该拿一个不存在的 tabId 去问浏览器（对照第 1 处：全靠这两条
     断言时是绿的，补上计数才红） */
  const env = await boot({ tasks: { 7: task() } });
  let gets = 0;
  const realGet = env.chrome.tabs.get;
  env.chrome.tabs.get = async (id) => {
    gets++;
    return realGet(id);
  };
  await env.fire.menuClicked({ menuItemId: "start-60" }, undefined);
  await env.fire.menuClicked({ menuItemId: "start-60" }, { url: PAGE });
  await env.fire.menuClicked({ menuItemId: "nonsense" }, { id: 7, url: PAGE });
  assert.equal(gets, 0, "没有标签页的点击还是去问了浏览器");
  assert.deepEqual(keys(env.store.local.tasks), [7]);
  assert.deepEqual(
    env.calls.localSet.filter((k) => k.includes("tasks")),
    [],
    "一次无效的菜单点击却重写了任务表"
  );
});

test("右键对受限页面开始：不建任务也不炸出来", async () => {
  const env = await boot({ tabs: [{ id: 7, url: "chrome://extensions", active: true, windowId: 1 }] });
  await env.fire.menuClicked({ menuItemId: "start-60" }, { id: 7, url: "chrome://extensions" });
  assert.deepEqual(keys(env.store.local.tasks), []);
});

test("快捷键用上次间隔；没有记录时回退 5 分钟", async () => {
  const remembered = await boot({ settings: { lastIntervalSec: 120 } });
  await remembered.fire.command("toggle-refresh");
  assert.equal(remembered.store.local.tasks[7].intervalSec, 120, "没复用上次间隔");

  const firstTime = await boot();
  await firstTime.fire.command("toggle-refresh");
  assert.equal(firstTime.store.local.tasks[7].intervalSec, 300, "回退值不是 5 分钟");
});

test("快捷键再按一次停掉任务（同一个入口两种走向）", async () => {
  const env = await boot({ tasks: { 7: task() } });
  await env.fire.command("toggle-refresh");
  assert.deepEqual(keys(env.store.local.tasks), []);
});

test("快捷键认的是焦点窗口里的活动页", async () => {
  /* 两个窗口各有一张活动页。query({active:true, currentWindow:true}) 的语义是"当前窗口"，
     桩件原先忽略过滤条件、把所有活动页都返回，于是这条一直没被测过：
     挑错窗口就等于给用户另一扇窗口的页面挂了任务 */
  const env = await boot({
    tasks: {},
    tabs: [
      { id: 7, url: PAGE, active: true, windowId: 1 },
      { id: 8, url: "https://b.test/x", active: true, windowId: 2 }
    ]
  });
  env.focusWindow(2);
  await env.fire.command("toggle-refresh");
  assert.deepEqual(keys(env.store.local.tasks), [8], "焦点在窗口 2，任务却挂到了窗口 1 的页面");
});

test("陌生命令名不动任何东西", async () => {
  const env = await boot();
  await env.fire.command("other-command");
  assert.deepEqual(keys(env.store.local.tasks), []);
  assert.deepEqual(env.calls.localSet, []);
});

/* 红→绿对照（2026-09-19 实跑，两轮循环结果一致：整份插件目录复制到仓库外，在副本的
   background.js 上逐处改坏——改动严格限定在 onClicked / onCommand 两段之内且每处断言
   needle 只命中一次——TAR_BG 指过去跑本文件）：
     1) 菜单点击的 `if (!tab || typeof tab.id !== "number") return;` 删掉
        → 红在"菜单点击拿不到标签页就什么都不做"，红的是数 tabs.get 那条（1 !== 0）。
           老实说：这道 guard 只靠"落盘状态没变"是钉不住的——guard 删掉后 startTask 自己在
           tabs.get(undefined) 之后抛掉，异常被菜单的 catch 吞了，存储一个字节都不差。
           第一轮对照就是这样全绿的，补上计数断言才红。
     2) `} else if (id.startsWith("start-")) {` 改成 `} else {`（陌生 id 也拿去当秒数解析）
        → 同一条红，同样是计数那条："nonsense" 那次点击带着合法 tab，穿过 guard 进了
           startTask，于是真去问了浏览器。任务表被改写那条断言本来也会红，但排在后面
     3) onCommand 的 `if (command !== "toggle-refresh") return;` 删掉
        → 红在"陌生命令名不动任何东西"
     4) 删掉 `const settings = await getSettings();` 并把 `settings.lastIntervalSec` 换成 300
        → 红在"快捷键用上次间隔；没有记录时回退 5 分钟"（300 !== 120），回退那一段照旧绿
     5) `if (tasks[tab.id])` 改成 `if (!tasks[tab.id])`
        → 红三条：快捷键的"用上次间隔"（改成先停后开，键集合空）、"再按一次停掉任务"、
           "认的是焦点窗口里的活动页"（起点就没了）。这一处不是只红一条，写注释时别美化
     6) `chrome.tabs.query({ active: true, currentWindow: true })` 改成 `{}`
        → 红在"快捷键认的是焦点窗口里的活动页"
   第 6 处顺带证明了 A6 第 6 条（tabs.query 过滤）修的价值：那一改改坏之前不红，
   因为桩件原先无条件返回全部标签页，两张 active 页里挑哪张都对。 */
