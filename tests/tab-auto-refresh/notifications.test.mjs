/* 2.1.0 批次 3 的门禁：系统通知要能被收掉，也要能点开跳到人该去的地方。
   改之前的状态是四类通知只创建、从不清理，也没有 onClicked 监听：任务早就没了，
   "待重登""已自动暂停"还留在通知中心里，点一下也没有任何反应。README 的功能表和
   AGENTS 的手工清单都写着"自动清理通知"，代码里其实没有这条路径。

   两条容易被忽略的语义，本文件专门钉住：
   1) 不是"任务没了就把这个标签页的通知全清掉"。关键词命中那条往往正是命中即停任务的
      产物，在 stopTask 里清它等于把用户刚收到的通知立刻撤回。
   2) 创建与清理必须用同一个 ID。原先四处字符串字面量各写一份，改一处就静默对不上，
      所以这里既测行为，也扫源码确认 ID 只有 NOTIF_ID 一个出口。
   掉线通知的 ID 归一到注册域：SSO 常落在兄弟子域，不归一会为同一次掉线发出两条。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const BG_SRC = readFileSync(
  process.env.TAR_BG || new URL("../../tab-auto-refresh/background.js", import.meta.url),
  "utf8"
);

async function boot({ tasks = {}, probes = null, settings = null } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks;
  if (probes) env.store.local.sessionProbe = probes;
  if (settings) env.store.sync.settings = settings;
  await bootBackground(env);
  return env;
}

const cleared = (env) => env.calls.notifCleared;
const createdIds = (env) => env.calls.notifCreated.map(([id]) => id);

test("ID 只有 NOTIF_ID 一个出口，创建与清理不会各写一份字面量", () => {
  /* 允许出现这些字符串的区域就是常量表本身（含点击反查用的前缀清单） */
  const table = BG_SRC.slice(
    BG_SRC.indexOf("const NOTIF_ID = {"),
    BG_SRC.indexOf("function alarmName(")
  );
  assert.ok(table.includes("keyword-hit-") && table.length > 200, "没切到 ID 表，本条是空跑");
  const literals = BG_SRC.replace(table, "");
  for (const dead of ['"keyword-hit-', '"refresh-stopped-', '"task-paused-', '"session-lost-']) {
    assert.ok(
      !literals.includes(dead),
      `ID 表之外还有裸的 ${dead} 字面量，创建与清理会静默对不上`
    );
  }
});

test("重新建任务会清掉该标签页上一轮的通知", async () => {
  const env = await boot({ settings: { keepAlive: false } });
  env.putTab(7, "https://example.com/board");
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.deepEqual(cleared(env), [
    "keyword-hit-7",
    "refresh-stopped-7",
    "task-paused-7"
  ]);
});

test("停任务只回收暂停通知，不撤回刚发出的命中与停止通知", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://example.com/board" } },
    settings: { keepAlive: false }
  });
  env.putTab(7, "https://example.com/board");
  await env.send({ type: "stop", tabId: 7 });
  assert.deepEqual(cleared(env), ["task-paused-7"], "多清了：命中通知会被当场撤回");
});

test("从自动暂停恢复时收掉暂停通知", async () => {
  const env = await boot({
    tasks: {
      7: {
        intervalSec: 300,
        createdAt: 1,
        url: "https://example.com/board",
        autoPaused: { reason: "error-page", at: 1 }
      }
    },
    settings: { keepAlive: false }
  });
  env.putTab(7, "https://example.com/board");
  const res = await env.send({ type: "resume-task", tabId: 7 });
  assert.equal(res.ok, true);
  assert.ok(cleared(env).includes("task-paused-7"), "恢复了却还挂着暂停通知");
});

test("未暂停时执行恢复不该顺手清掉别人的通知", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://example.com/board" } },
    settings: { keepAlive: false }
  });
  env.putTab(7, "https://example.com/board");
  await env.send({ type: "resume-task", tabId: 7 });
  assert.deepEqual(cleared(env), [], "done 为假时也清了：会把另一因的暂停通知误撤");
});

test("站点重新登录成功就收掉待重登通知", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://example.com/board" } },
    probes: { "example.com": { sus: 2, lost: true, lastNotifiedAt: 1 } },
    settings: { keepAlive: false, cookieBackup: false }
  });
  env.putTab(7, "https://example.com/board");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(cleared(env), ["session-lost-example.com"]);
  const probe = env.store.local.sessionProbe["example.com"];
  assert.equal(probe.lost, false, "探针没复位");
});

test("已经正常的站点重复收到正常信号时不重复清理", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://example.com/board" } },
    probes: { "example.com": { sus: 0, lost: false, lastNotifiedAt: 0 } },
    settings: { keepAlive: false }
  });
  env.putTab(7, "https://example.com/board");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(cleared(env), [], "值没变也去清：白做存储与通知调用");
});

test("站点不再被任何任务监控时，它的待重登通知跟着探针一起收掉", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://example.com/board" } },
    probes: {
      "example.com": { sus: 0, lost: false, lastNotifiedAt: 0 },
      "gone.test": { sus: 2, lost: true, lastNotifiedAt: 1 }
    },
    settings: { keepAlive: false }
  });
  env.putTab(7, "https://example.com/board");
  await env.send({ type: "stop", tabId: 7 });
  assert.ok(
    cleared(env).includes("session-lost-gone.test"),
    "探针条目被删了，通知却留在通知中心里"
  );
});

test("掉线通知的 ID 归一到注册域，SSO 子域不会各发一条", async () => {
  const env = await boot({
    tasks: { 7: { intervalSec: 300, createdAt: 1, url: "https://www.example.com/board" } },
    settings: { keepAlive: false, captchaGuard: false }
  });
  env.putTab(7, "https://www.example.com/board");
  /* 这条测的是"登录页地址由 changeInfo.url 带、标签页本身仍停在监控目标"的形状。
     页面自己就停在 /login（真实现场，也是 A14 之前会自指的那一步）由 task-url.test.mjs 钉 */
  const atLogin = { status: "complete", url: "https://www.example.com/login" };
  await env.fire.tabUpdated(7, atLogin);
  await env.fire.tabUpdated(7, atLogin);
  assert.equal(env.store.local.sessionProbe["example.com"].lost, true, "确认窗口没走到 lost");
  assert.deepEqual(createdIds(env), ["session-lost-example.com"], "ID 没归一到注册域");
});

test("点通知跳到对应标签页并把整个窗口带到前台", async () => {
  const env = await boot({ settings: { keepAlive: false } });
  env.putTab(7, "https://example.com/board", { windowId: 42 });
  await env.fire.notifClicked("keyword-hit-7");
  assert.deepEqual(env.calls.tabsActivated, [7]);
  assert.deepEqual(env.calls.windowsFocused, [42]);
  assert.deepEqual(cleared(env), ["keyword-hit-7"], "点过就该收掉，不必用户再手动划");
});

test("点掉线通知跳到正在监控该站点的标签页", async () => {
  const env = await boot({
    tasks: { 9: { intervalSec: 300, createdAt: 1, url: "https://www.example.com/board" } },
    settings: { keepAlive: false }
  });
  env.putTab(9, "https://www.example.com/board");
  await env.fire.notifClicked("session-lost-example.com");
  assert.deepEqual(env.calls.tabsActivated, [9], "按注册域反查标签页失败");
});

test("标签页已经关掉的通知被点开时不抛错、不跳转", async () => {
  const env = await boot({ settings: { keepAlive: false } });
  await env.fire.notifClicked("refresh-stopped-7");
  assert.deepEqual(env.calls.tabsActivated, []);
  assert.deepEqual(cleared(env), ["refresh-stopped-7"]);
});

test("不认识的通知 ID 只收掉，不做跳转", async () => {
  const env = await boot({ settings: { keepAlive: false } });
  env.putTab(3, "https://example.com/x");
  await env.fire.notifClicked("some-other-thing-3");
  assert.deepEqual(env.calls.tabsActivated, []);
  assert.deepEqual(cleared(env), ["some-other-thing-3"]);
});
