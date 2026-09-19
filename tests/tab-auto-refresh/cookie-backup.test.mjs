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
  /* 整条被删的存档同时要从索引里摘掉，否则索引从此指着一条不存在的键 */
  assert.deepEqual(index(env), [], "存档收敛掉了，索引还认着它");
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

/* ---------- 备份索引（A12 第 2 条）---------- */

/* 桩件的 storage.set 是合并写，"少读一次盘"与"读了但没用"在落盘结果上看不出差别，
   所以这里把 local.get 包一层，记下每次问的是 null（全量扫）、键数组，还是单个键 */
function watchLocalGet(env) {
  const seen = [];
  const real = env.chrome.storage.local.get;
  env.chrome.storage.local.get = async (keys) => {
    seen.push(keys === null ? "ALL" : Array.isArray(keys) ? keys.slice() : String(keys));
    return real(keys);
  };
  return seen;
}
const INDEX = "cookieBackupHosts";
const index = (env) => env.store.local[INDEX];
const allBackups = (env) =>
  Object.keys(env.store.local)
    .filter((k) => k.startsWith("cookieBackup:"))
    .sort();

test("索引在位时清理不再全量扫盘，删掉的存档同时从索引摘掉", async () => {
  const env = await boot({
    backups: {
      [ck("shop.example.co.nz")]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: "shop.example.co.nz", path: "/" }]
      },
      [INDEX]: ["shop.example.co.nz"],
      /* 一个与备份无关的大键：全量扫的代价就是要把它一起读回来 */
      "cookieBackupWarnedOnce": true
    }
  });
  const seen = watchLocalGet(env);
  /* 停掉唯一的任务 → 该站点不再被任何任务使用 → pruneCookieBackups 收掉它 */
  await env.send({ type: "stop", tabId: 7 });
  assert.ok(!seen.includes("ALL"), `还是去全量扫了盘：${JSON.stringify(seen)}`);
  assert.equal(stored(env, "shop.example.co.nz"), undefined, "孤儿存档没删");
  assert.deepEqual(index(env), [], "存档删了索引还留着，等于索引会说谎");
});

test("索引缺失时退回一次全量读：老用户的存档一个都不丢，并顺手把索引建起来", async () => {
  const host = "shop.example.co.nz";
  const env = await boot({
    /* 刻意不写 cookieBackupHosts：2.1.x 升上来的现场就是这个样子 */
    backups: {
      [ck(host)]: {
        timestamp: Date.now() - 60 * 60 * 1000,
        cookies: [{ name: "sid", value: "v", domain: host, path: "/" }]
      }
    }
  });
  const seen = watchLocalGet(env);
  await env.fire.startup();
  assert.ok(seen.includes("ALL"), "没有索引却没去全量读，接下来的定向读会以为一家备份都没有");
  assert.deepEqual(allBackups(env), [ck(host)], "被当成无主数据清掉了");
  assert.deepEqual(index(env), [host], "扫过一遍却没把索引建起来，下次还得再扫");
  assert.deepEqual(env.calls.cookieSet.map((c) => c.name), ["sid"], "迁移路径上恢复本身也坏了");
});

test("索引里没有的存档不许被顺手删掉", async () => {
  /* 并发登记漏掉一家、或用户手动往存储里塞了一条：定向读看不见它，但它不该因此变成
     "可清理的孤儿"。删东西的判据必须是存档实况，不是索引清单——方向反了就是丢登录态 */
  const env = await boot({
    backups: {
      [ck("shop.example.co.nz")]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: "shop.example.co.nz", path: "/" }]
      },
      [ck("quiet.example.com")]: {
        timestamp: Date.now(),
        cookies: [{ name: "ghost", value: "v", domain: "quiet.example.com", path: "/" }]
      },
      [INDEX]: ["shop.example.co.nz"]
    }
  });
  await env.fire.startup();
  assert.ok(stored(env, "quiet.example.com"), "没登记进索引的存档被当成无主数据清了");
  assert.ok(!index(env).includes("quiet.example.com"), "索引凭空认下了这条：它并没有登记过");
});

test("写成一笔新备份时把主机登记进索引；索引还没建立时不登记半个", async () => {
  const host = "shop.example.co.nz";
  const cookies = [{ domain: host, name: "sid", path: "/", value: "v" }];

  /* 已有索引（哪怕是空的）：新存档要登记，否则下一次定向读不会去读它 */
  const seeded = await boot({ backups: { [INDEX]: [] } });
  seeded.setCookies(cookies);
  await seeded.fire.alarm("refresh-7");
  assert.ok(stored(seeded, host), "这次连存档都没写");
  assert.deepEqual(index(seeded), [host], "写了存档没登记索引，恢复与清理都找不到它");

  /* 索引尚未建立：只登记自己这一家会把别家的遗留明文变成定向读永远看不见的孤儿，
     完整性交给启动那次全量读去补 */
  const fresh = await boot({});
  fresh.setCookies(cookies);
  await fresh.fire.alarm("refresh-7");
  assert.ok(stored(fresh, host), "没索引就不写备份了？");
  assert.equal(index(fresh), undefined, "建了个只有一家的索引，别家遗留存档就此隐身");
});

test("索引里躺着但存档已经不在了的条目在对账时被摘掉", async () => {
  const host = "shop.example.co.nz";
  const env = await boot({
    backups: {
      [ck(host)]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: host, path: "/" }]
      },
      [INDEX]: [host, "gone.example.com"]
    }
  });
  await env.fire.startup();
  assert.deepEqual(index(env), [host], "幽灵条目一直留着，定向读每次多问一个不存在的键");
});

test("关掉备份开关时按索引清空，并把索引归零", async () => {
  const env = await boot({
    settings: { cookieBackup: false },
    backups: {
      [ck("shop.example.co.nz")]: {
        timestamp: Date.now(),
        cookies: [{ name: "sid", value: "v", domain: "shop.example.co.nz", path: "/" }]
      },
      [INDEX]: ["shop.example.co.nz"]
    }
  });
  await env.fire.startup();
  assert.deepEqual(allBackups(env), [], "关着开关还留着明文票据");
  assert.deepEqual(index(env), [], "清完存档索引还认着那一家");
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

/* 红→绿对照（2026-09-19 本机实跑，A12 第 2 条"备份索引"）
   跑法与上一段相同：整仓复制到仓库外，一次只改坏一处，在副本里跑
   logic.test.mjs + cookie-backup.test.mjs（90 条）。下面记的是实跑红名单，不是预测。

     P1 planBackupFetch 把"索引没写过"当成"索引是空的"
        → 实跑红 7 条：本文件"hostOnly 三种取值各走各路""历史越界备份先收敛再恢复"
          "键本身是公共后缀的遗留备份整条删掉""备份开关关着时…被清空""恢复只碰被监控的
          注册域""索引缺失时退回一次全量读"，加 logic.test 的 planBackupFetch 那条。
          红得比预期宽：定向读拿到空清单等于恢复与清理同时失去全部存档。这条对照就是
          注释里"缺索引不等于没备份"那句话的证据——错的方向是丢登录态，不是慢一点。
     P2a changed 恒为假（索引永不写回） → 实跑红 5 条：迁移、对账摘幽灵、后缀键整条删掉，
          加 logic.test 两条纯函数用例。
     P2b changed 恒为真（每次都落盘） → 只红 logic.test 的"只在真的要改时才让执行器落盘"。
          这一处红不到执行器：多一笔内容相同的写盘在落盘结果上没有症状，
          正是纪律 1 把判据抽成纯函数的理由。
     P3 对账丢 append 半句（新出现的存档不补登） → 实跑红 4 条。
     P4a 对账整体按实况重排、不认索引次序 → 只红 changed 那条（次序差异不外溢，
          但每次启动都会白落一笔盘）。
     P4b 对账丢 trim 半句（幽灵条目一直留着） → 实跑红 3 条，含本文件
          "索引里躺着但存档已经不在了的条目在对账时被摘掉"。
     P5 索引未建立时抢先登记半份 → 红 1 条（本文件那条两用例的第二半）。
     P6 写成存档后不登记 → 红同一条的第一半。P5/P6 共用一个见证是有意的：那条 test 把
          "该登记"与"不该抢先登记"写在一起，两种反法各打中一半。
     P7 pruneCookieBackups 删存档不摘索引 → 红 1 条（"索引在位时清理不再全量扫盘…"）。
     P9 有索引也照旧 get(null) 全量扫 → 红 2 条："索引在位时清理不再全量扫盘"（那条盯的正是
          读法），以及"索引里没有的存档不许被顺手删掉"——全量扫会把没登记的存档读回来，
          对账便顺手把它补进索引，撞的是那句"索引凭空认下了这条"。
     P10 定向读忘了拼 cookieBackup: 前缀 → 红 5 条（一个键都读不回来）。

   反向对照三处，实跑全绿，证明这批门禁没有把无关的次序与阈值钉死：
     R1 关闭开关时先归零索引、再删存档
     R2 先登记索引、再写存档
     R3 COOKIE_BACKUP_MAX_KEYS 20 → 21
   R3 绿得有信息量：20 站封顶的"计数"这两个文件里没有任何断言，改阈值不会红。
   本次不动那个常量，将来要改得先补一条按站点数淘汰的用例。

   P8 已撤回：prune() 收敛处原本跟着一句 dropBackupIndexHosts(conv.remove)，实跑零红——
   同一次启动末尾的 pruneCookieBackups 必然再对一次账，索引跟着存档实况被修正，那句改坏
   也看不出来。按"没有本地症状的行不留"删掉了，源码注释里记着这段来处。 */
