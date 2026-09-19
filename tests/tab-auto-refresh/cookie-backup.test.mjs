/* cookie 备份与恢复的执行器门禁（2026-09-19 审计 A6 第 8 条的欠账，随 A2 一起交）。
   为什么之前测不出来：桩件的 cookies.getAll 恒返回 []，于是采集（backupCookies 的域链
   与冻结）、还原（restoreCookies 的 hostOnly 三分支）、200 条封顶全都在空数据上跑——
   纯函数层（capCookies / applyBackupAction / nextBackupState）由 logic.test.mjs 钉着，
   但"后台到底拿哪几层域去查、查回来怎么写、恢复时怎么回灌浏览器"这一整段是零覆盖。
   A2 的越界采集恰好只体现在查询面上：getAll({domain:"co.nz"}) 的语义是"等于或子域于它"，
   一次就把全站 .co.nz 的票据捞进明文备份。所以这里既断言写了什么，也断言查了什么。

   与 alarm-gate / heartbeat 的分工：那两处管到点之后走哪个分支，这里只管 cookie 这一条侧链。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const NOW_SEC = Math.floor(Date.now() / 1000);

/* 采集用的默认现场：keepAlive / 心跳 / 验证墙 / 活动跳过全关着，
   只留下"到点刷新 → reloadTab → backupCookies"这一条干净的路径 */
const SETTINGS = {
  cookieBackup: true,
  keepAlive: false,
  httpHeartbeat: false,
  skipOnActivity: false,
  captchaGuard: false,
  bypassCache: false
};

async function boot({ url, tabUrl, tasks, settings, probe, backups, tabs } = {}) {
  const page = url || "https://shop.example.co.nz/board";
  const env = makeEnv();
  env.store.local.tasks =
    tasks === undefined ? { 7: { intervalSec: 300, createdAt: 1, url: page } } : tasks;
  if (probe) env.store.local.sessionProbe = probe;
  for (const [k, v] of Object.entries(backups || {})) env.store.local[k] = v;
  env.store.sync.settings = Object.assign({}, SETTINGS, settings);
  /* 焦点不在浏览器里：免得任何"人在看就别重载"的判据掺进来 */
  for (const t of tabs || [{ id: 7, url: tabUrl || page }]) env.putTab(t.id, t.url, { windowId: 1, active: true });
  await bootBackground(env);
  env.focusWindow(null);
  return env;
}

const ck = (name) => "cookieBackup:" + name;
/* 备份条目的 cookie 名单，排序后比名字即可（域、路径、值各自断言） */
const names = (entry) => (entry && entry.cookies ? entry.cookies.map((c) => c.name).sort() : null);
const stored = (env, host) => env.store.local[ck(host)];
/* 本次采集问过浏览器哪几层域 */
const queried = (env) => env.calls.cookieGet;

/* ---------- 采集 ---------- */

test("采集只下探到注册域为止，绝不拿公共后缀去查 cookie", async () => {
  const env = await boot();
  env.setCookies([{ domain: "shop.example.co.nz", name: "sid", path: "/", value: "v" }]);
  await env.fire.alarm("refresh-7");
  /* 修之前这里是 ["shop.example.co.nz","example.co.nz","co.nz"]，最后那层就是越界的起点 */
  assert.deepEqual(queried(env), ["shop.example.co.nz", "example.co.nz"]);
});

test("同根域的票据都进备份，别家站点的进不来", async () => {
  const env = await boot();
  env.setCookies([
    { domain: "shop.example.co.nz", name: "own", path: "/", value: "a" },
    { domain: ".example.co.nz", name: "parent-sso", path: "/", value: "b" },
    { domain: "sso.example.co.nz", name: "sibling", path: "/", value: "c" },
    /* 与监控目标只是同后缀，不同注册域：一条都不许进备份 */
    { domain: "other.co.nz", name: "foreign", path: "/", value: "d" },
    { domain: "unrelated.com", name: "unrelated", path: "/", value: "e" }
  ]);
  await env.fire.alarm("refresh-7");
  const entry = stored(env, "shop.example.co.nz");
  assert.ok(entry, "备份根本没写盘");
  assert.deepEqual(names(entry), ["own", "parent-sso", "sibling"]);
  assert.equal(entry.schemaVersion, 2);
});

test("取不到可信注册域的站点宁可不备份", async () => {
  /* 主机整串就是公共后缀（siteRoot 返回 null）：备份键会退化成"等于或子域于它"的查询，
     捞到的全是别人的登录态。这条路径的正确行为是一笔都不查、一个字都不写 */
  const env = await boot({ url: "https://co.nz/board", tabUrl: "https://co.nz/board" });
  env.setCookies([{ domain: "other.co.nz", name: "foreign", path: "/", value: "v" }]);
  await env.fire.alarm("refresh-7");
  assert.deepEqual(queried(env), [], "拿不出可信注册域却还是去查了 cookie");
  assert.deepEqual(
    Object.keys(env.store.local).filter((k) => k.startsWith("cookieBackup:")),
    [],
    "公共后缀站点被写进了备份"
  );
});

test("关掉备份开关时一笔查询都不发", async () => {
  const env = await boot({ settings: { cookieBackup: false } });
  env.setCookies([{ domain: "shop.example.co.nz", name: "sid", path: "/", value: "v" }]);
  await env.fire.alarm("refresh-7");
  assert.deepEqual(queried(env), []);
  assert.equal(stored(env, "shop.example.co.nz"), undefined);
});

test("外链漂移之后不把无关站点的登录态写进备份", async () => {
  /* 任务盯的是 A 站，标签页被用户点去了 B 站：reloadTab 会先把现场交给 backupCookies */
  const env = await boot({ tabUrl: "https://elsewhere.test/page" });
  env.setCookies([
    { domain: "elsewhere.test", name: "their-ticket", path: "/", value: "v" },
    { domain: "shop.example.co.nz", name: "mine", path: "/", value: "v" }
  ]);
  await env.fire.alarm("refresh-7");
  assert.deepEqual(
    Object.keys(env.store.local).filter((k) => k.startsWith("cookieBackup:")),
    [],
    "同根域判断被绕过，无关站点的票据进了备份"
  );
});

test("行为通道已确认掉线时不再写备份，但采集确实跑到了", async () => {
  /* 先钉"链路跑到了"（查询发了），再钉"这条路径不该写"——只断言不写永远证不了执行过 */
  const env = await boot({
    probe: { "example.co.nz": { sus: 2, lost: true, lastNotifiedAt: Date.now() } }
  });
  env.setCookies([{ domain: "shop.example.co.nz", name: "sid", path: "/", value: "v" }]);
  await env.fire.alarm("refresh-7");
  assert.deepEqual(queried(env), ["shop.example.co.nz", "example.co.nz"]);
  assert.equal(stored(env, "shop.example.co.nz"), undefined, "掉线期间把坏样本写进了备份");
  assert.deepEqual(
    env.calls.localSet.filter((k) => k.some((x) => x.startsWith("cookieBackup:"))),
    []
  );
});

test("疑似掉线只并计数，不许覆盖上一次的好备份", async () => {
  const env = await boot();
  /* 第一份备份：一条持久票据 + 一条会话票据（无 expirationDate 才是会话票） */
  env.setCookies([
    {
      domain: "shop.example.co.nz",
      name: "old-ticket",
      path: "/",
      value: "v",
      expirationDate: NOW_SEC + 3600
    },
    { domain: "shop.example.co.nz", name: "old-session", path: "/", value: "w" }
  ]);
  await env.fire.alarm("refresh-7");
  const first = stored(env, "shop.example.co.nz");
  assert.deepEqual(names(first), ["old-session", "old-ticket"]);
  /* 第二拍：会话票据不见了（可能只是站点换票节奏）——旧 cookies 必须原样留着 */
  env.setCookies([
    {
      domain: "shop.example.co.nz",
      name: "old-ticket",
      path: "/",
      value: "v",
      expirationDate: NOW_SEC + 3600
    }
  ]);
  await env.fire.alarm("refresh-7");
  const second = stored(env, "shop.example.co.nz");
  assert.deepEqual(names(second), ["old-session", "old-ticket"], "坏样本覆盖了最后一次在线备份");
  assert.equal(second.sessionLostStreak, 1);
  assert.equal(second.timestamp, first.timestamp, "疑似采样把备份时间戳刷成新值了");
  /* 第三拍连续缺失才确认掉线，此时也只补状态字段、不动 cookies */
  await env.fire.alarm("refresh-7");
  const third = stored(env, "shop.example.co.nz");
  assert.equal(typeof third.sessionLostAt, "number", "连续缺失没有确认掉线");
  assert.deepEqual(names(third), ["old-session", "old-ticket"]);
  assert.equal(third.timestamp, first.timestamp);
});

test("单站点 200 条封顶在执行器层生效：留票据、切杂项", async () => {
  const env = await boot();
  const jar = [{ domain: "shop.example.co.nz", name: "keep-me", path: "/", value: "v", httpOnly: true }];
  for (let i = 0; i < 205; i++) {
    jar.push({
      domain: "shop.example.co.nz",
      name: "junk-" + i,
      path: "/x",
      value: "v",
      expirationDate: NOW_SEC + 3600
    });
  }
  env.setCookies(jar);
  await env.fire.alarm("refresh-7");
  const entry = stored(env, "shop.example.co.nz");
  assert.equal(entry.cookies.length, 200, "封顶条数没生效");
  assert.ok(
    entry.cookies.some((c) => c.name === "keep-me"),
    "会话票据被按返回顺序切在尾上了"
  );
});

/* ---------- 还原（启动恢复） ---------- */

test("hostOnly 三种取值各走各路：专属票省略 domain，域票照写，v1 旧备份保守沿用", async () => {
  const host = "shop.example.com";
  const entry = {
    timestamp: Date.now(),
    schemaVersion: 2,
    cookies: [
      { name: "hostonly", value: "1", domain: host, path: "/", secure: true, hostOnly: true },
      { name: "domain-scope", value: "2", domain: "." + host, path: "/", hostOnly: false },
      { name: "v1-unknown", value: "3", domain: "." + host, path: "/" },
      { name: "expired", value: "4", domain: host, path: "/", expirationDate: NOW_SEC - 10 }
    ]
  };
  const env = await boot({
    url: "https://shop.example.com/board",
    backups: { [ck(host)]: entry }
  });
  await env.fire.startup();
  const byName = Object.fromEntries(env.calls.cookieSet.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["domain-scope", "hostonly", "v1-unknown"]);
  /* __Host- 这类专属票据带 domain 写入会失败或扩大作用域，必须靠 url 推导 */
  assert.equal("domain" in byName.hostonly, false, "hostOnly 的票据被带着 domain 写回去了");
  assert.equal(byName.hostonly.url, "https://shop.example.com/");
  assert.equal(byName["domain-scope"].domain, "." + host);
  assert.equal(byName["v1-unknown"].domain, "." + host, "缺 hostOnly 字段的 v1 条目应沿用旧行为");
  assert.equal(byName.expired, undefined, "已过期的 cookie 也被写回去了");
});

test("历史越界备份先收敛再恢复：别家站点的票据一次都不回灌", async () => {
  const host = "shop.example.co.nz";
  /* 时间戳必须是没出 30 天 TTL 的，否则先被 pruneCookieBackups 整条删掉，测不到收敛 */
  const stamp = Date.now() - 60 * 60 * 1000;
  const env = await boot({
    backups: {
      [ck(host)]: {
        timestamp: stamp,
        schemaVersion: 2,
        cookies: [
          { name: "mine", value: "1", domain: host, path: "/", hostOnly: true },
          { name: "theirs", value: "2", domain: "other.co.nz", path: "/", hostOnly: false }
        ]
      }
    }
  });
  await env.fire.startup();
  assert.deepEqual(
    env.calls.cookieSet.map((c) => c.name),
    ["mine"],
    "越界条目被恢复了，等于替 other.co.nz 复活登录态"
  );
  const after = stored(env, host);
  assert.deepEqual(names(after), ["mine"]);
  /* 收敛不是重新备份：时间戳不动，30 天 TTL 照原样起效 */
  assert.equal(after.timestamp, stamp);
});

test("键本身是公共后缀的遗留备份整条删掉，不留空壳", async () => {
  const env = await boot({
    backups: {
      [ck("co.nz")]: {
        timestamp: Date.now(),
        cookies: [{ name: "theirs", value: "v", domain: "other.co.nz", path: "/" }]
      }
    }
  });
  await env.fire.startup();
  assert.equal(env.store.local[ck("co.nz")], undefined, "整条都属于别人的备份还留着");
  assert.deepEqual(env.calls.cookieSet, [], "后缀键里的条目被恢复了");
});

test("备份开关关着时，遗留备份在启动恢复里被清空", async () => {
  const env = await boot({
    settings: { cookieBackup: false },
    backups: {
      [ck("shop.example.co.nz")]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: "shop.example.co.nz", path: "/" }]
      }
    }
  });
  await env.fire.startup();
  assert.equal(stored(env, "shop.example.co.nz"), undefined, "关着开关还留着明文票据");
  assert.deepEqual(env.calls.cookieSet, []);
});

test("恢复只碰被监控的注册域，不替别的站点回灌 cookie", async () => {
  const env = await boot({
    backups: {
      [ck("quiet.example.com")]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: "quiet.example.com", path: "/" }]
      }
    }
  });
  await env.fire.startup();
  assert.deepEqual(env.calls.cookieSet, []);
  /* 没被任何任务使用的备份由 pruneCookieBackups 收掉 */
  assert.equal(env.store.local[ck("quiet.example.com")], undefined);
});

/* 红→绿对照（2026-09-19 本机实跑，A2 那五处）
   跑法与以往不同：siteRoot / domainChain / planBackupConvergence 住在 shared/logic.js，
   而 logic.test.mjs 是**直接 import 真源码**的，TAR_BG 只换 background.js、够不着那条路。
   所以这次复制的是整仓（不含 .git 与 _code-review）到仓库外，在副本里分别改坏
   tab-auto-refresh/shared/logic.js 与 background.js，再在副本里跑
   logic.test.mjs + cookie-backup.test.mjs + alarm-gate.test.mjs（60 + 13 + 24 条）。

     1) domainChain 去掉注册域地板，回到"一路切到只剩两段"
        → 实跑红 4 条：本文件"采集只下探到注册域为止""同根域的票据都进备份"
          "行为通道已确认掉线时…"，以及 logic.test 的 domainChain 不变式那条。
          漂移与恢复用例全绿——地板只管查询面，不碰同站判断，红名单正好对上分工。
     2) siteRoot 去掉"整串就是公共后缀 → null"的守卫
        → 实跑红 4 条：本文件"取不到可信注册域的站点宁可不备份"，logic.test 的
          siteRoot / domainChain 不变式 / planBackupConvergence 三条。
     3) 形状规则退回 2.1.0 那份手写完整后缀清单（里面没有 co.nz、com.ua、co.id…）
        → 实跑红 10 条：本文件 6 条、logic.test 3 条、alarm-gate 的
          "只是同公共后缀的另一家站点"1 条。
          本文件那 6 条里最有价值的是"键本身是公共后缀的遗留备份整条删掉"：旧清单下
          co.nz 自己被当成注册域，于是它 ∈taskRoots，恢复环节真的把 other.co.nz 的票据
          回灌进浏览器——A2 描述的现场复活，就是这样一次一次发生的。
     4) prune 里次序调换：先按注册域恢复、后收敛
        → 实跑只红 1 条（"历史越界备份先收敛再恢复"）。
           这一处是那条次序注释的唯一证据：反过来的话收敛只是删存档，
           别家站点的票据已经写回浏览器了。
     5) planBackupConvergence 去掉"键不可信就整条删"分支
        → 第一次跑是绿的：后缀键里只要混着别家 cookie，过滤分支的结果也是整条删，
           两条分支同结果。给 logic.test 补了一条"后缀键 + cookies 为空"的条目之后
           实跑红 1 条（planBackupConvergence 那条纯函数用例）。
   另记一条：本文件的"键本身是公共后缀的遗留备份整条删掉"在 1、2、4 三处都不红——
   pruneCookieBackups 的 roots 判断在下游也会把它删掉。这条用例钉的是"不留死数据"这个
   结果，不是"谁删的"；真正区分得开的是 patch 3（它会连带把别家票据回灌）。 */
