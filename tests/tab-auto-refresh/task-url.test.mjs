/* A14 的门禁：task.url 到底是"用户指定的监控对象"还是"这一页此刻的地址"。
   改之前两个都要，于是出现自指——站点把"会话过期"表现成**同主机**跳到 /login
   （很常见，也正因同主机，站点锁定不介入）时，第一拍 reportSessionSignal 记 sus:1，
   紧接着 refreshTaskUrl 因 sameHost 成立把 task.url 改写成 …/login；第二拍起
   `!looksLikeLoginPage(task.url)` 恒假 → 信号永远报"正常" → sus 被清零 → lost 到不了。
   行为通道自己把自己 disarm 了，而 httpHeartbeat 关着的用户只剩这一条通道。
   双重后果：监控目标从此就是那张登录页（关键词在登录页正文里找、心跳对着 /login 发、
   用户真登录成功之后也不会自动回到原页面）。

   判据抽在 shared/logic.js 的 shouldAdoptTaskUrl（纪律 1：顺序决策要能被单测直接断言）。
   本文件跑的是真实 background.js 的 tabs.onUpdated 链路，形状刻意取"事件不带 changeInfo.url、
   后台只能从 chrome.tabs.get 读到登录页"——那是真实现场，也正是 A14 之前会自指的形状。
   （notifications.test.mjs 里那条"ID 归一到注册域"用的是 changeInfo.url 带地址、
   标签页仍停在业务页的形状，恰好绕开自己把自己改写这一步，所以 A14 之前全绿。） */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import { SESSION_LOST_CONFIRM_SAMPLES } from "../../tab-auto-refresh/shared/logic.js";

const BOARD = "https://www.example.com/board";
const LOGIN = "https://www.example.com/login?next=%2Fboard";
const ROOT = "example.com";

async function bootAt(url) {
  const env = makeEnv();
  env.store.local.tasks = { 7: { intervalSec: 300, createdAt: 1, url: BOARD } };
  env.store.sync.settings = { keepAlive: false, httpHeartbeat: false, cookieBackup: false, captchaGuard: false };
  env.putTab(7, url);
  await bootBackground(env);
  return env;
}

/* 真实 Chrome 在页面自己跳走之后派发 complete，事件里常常不再带 url */
const arrived = (env) => env.fire.tabUpdated(7, { status: "complete" });

const taskUrl = (env) => env.store.local.tasks[7] && env.store.local.tasks[7].url;
const probeOf = (env) => (env.store.local.sessionProbe || {})[ROOT] || {};
const ids = (env) => env.calls.notifCreated.map(([id]) => id);
const badged = (env, key, want) => env.calls.badge.some(([k, v]) => k === key && v === want);

test("页面自己跳到同主机的登录页：监控对象不许跟着跳（A14）", async () => {
  const env = await bootAt(LOGIN);
  for (let i = 0; i < SESSION_LOST_CONFIRM_SAMPLES; i++) await arrived(env);

  assert.equal(taskUrl(env), BOARD, "任务网址被改写成了登录页：从此监控的就是那张登录页");
  assert.equal(
    probeOf(env).lost,
    true,
    "确认窗口没走到 lost：同主机跳 /login 这一常见现场下，掉线检测自己把自己 disarm 了"
  );
  assert.deepEqual(ids(env), ["session-lost-" + ROOT], "判了掉线却没发通知");
  assert.ok(badged(env, "text", "!"), "角标没切到掉线那一态");
});

test("疑似采样要留得下来：单拍不确认，但也不被清零", async () => {
  /* 只走一半确认窗口：不该通知、不该变红，但 sus 必须还在，
     否则第二拍又从头数，用户永远等不到掉线提示 */
  const env = await bootAt(LOGIN);
  await arrived(env);
  assert.equal(probeOf(env).sus, SESSION_LOST_CONFIRM_SAMPLES - 1, "单次采样没记成疑似，或被抹平了");
  assert.equal(probeOf(env).lost, false, "单次采样就确认掉线：阈值失效");
  assert.deepEqual(ids(env), []);
});

test("登录成功回到业务页：任务网址照旧跟随，这条通道的原意不能被 A14 砍掉", async () => {
  /* refreshTaskUrl 的本来目的：自动重开要打开实际页面而不是老 URL。
     从 /login 回到业务页时同站、且新地址不是登录页 → 要更新 */
  const env = await bootAt(LOGIN);
  env.store.local.tasks[7].url = LOGIN; /* 老版本已经把它改写成了登录页，也要能自解 */
  env.putTab(7, "https://www.example.com/board?id=7");
  await arrived(env);
  assert.equal(taskUrl(env), "https://www.example.com/board?id=7", "登录后不再跟随目标网址：重开永远开登录页");
});

test("同站在业务页之间移动照常跟随，跨站不覆盖", async () => {
  const env = await bootAt("https://www.example.com/board?page=2");
  await arrived(env);
  assert.equal(taskUrl(env), "https://www.example.com/board?page=2", "同站业务页跳转没跟随");
  /* 跳到别的站点：保留原始监控对象，好让自动重开回到用户填的那一家 */
  env.putTab(7, "https://other.test/checkout");
  await arrived(env);
  assert.equal(taskUrl(env), "https://www.example.com/board?page=2", "跨站漂移把监控对象换掉了");
});

/* 红→绿对照（2026-09-19 实跑。这次不搬 TAR_BG：副本 D:\Github\_tar_ctl_a14 里 tests/ 与
   tab-auto-refresh/ 同级，logic.test.mjs 与下面的 e2e 走的是同一份被改坏的源码，
   一次改坏两头都看得见。每轮从 _pristine 恢复后只改一处，跑全套 329 条，红名单是实测：）
     pristine → 329 全绿
     M1 shouldAdoptTaskUrl 去掉登录页判据（就是 A14 之前的形状）
        → 红 2：logic 的纯函数条 + 本文件「页面自己跳到同主机的登录页」。
          这条就是 A14 的针：改回旧写法，e2e 当场红
     M2 去掉同站约束 → 红 2：纯函数条 + 本文件「跨站不覆盖」
     M3 去掉「网址没变就不写盘」→ 红 1：只有纯函数条。e2e 测不到，
          因为桩件 storage.set 是 Object.assign 合并，写一份与现状相同的值前后 JSON一样
     M4 畸形网址从拒绝改成放行 → 红 1：只有纯函数条
     M5 refreshTaskUrl 永不写盘（改过头的样子）
        → 红 2：本文件「登录成功回到业务页」「同站在业务页之间移动照常跟随」。
          这两条就是"别把原通道砍了"的反向门禁，M1 时它们全绿
     M6 行为通道确认窗口降成 1 次 → 红 2：本文件「疑似采样要留得下来」+ 心跳那条
          「心跳被踢到登录页：连续确认才判掉线」（两条通道共用同一个阈值）
     R1 looksLikeLoginPage 从只看 pathname 改成看整串 href
        → 红 1：只红在既有的「looksLikeLoginPage matches login paths but ignores query
          returnURL noise」一条。本文件四条全绿：改的判据在，但不在 A14 这条路上——
          这条是"红名册不溢出"的对照 */
