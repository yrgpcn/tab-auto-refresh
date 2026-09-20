/* 第二十轮审计（A38）：角标那四件事实**怎么从 tasks 与 sessionProbe 里推出来**。
   上一轮（`badge-state.test.mjs`）把"取到事实之后谁赢"钉住了，这个文件钉前面那半截：
   逐条任务归约成"有没有任何一张掉线 / 有没有任何一张自动暂停"，以及探针的键取哪一段。

   为什么这根轴是空的（上一轮末尾两台探路实测）：把 `anyLost` 那个循环改成只看第一个任务，
   全套 558 条**一条都不红**；把探针键从注册域换成整串主机名，红的两条里有一条是上一轮的端到端，
   而它之所以红得出来，靠的是夹具故意挑了"注册域与主机名不相等"的 `app.a.test`——
   也就是说判据长在一条用例的夹具上，不长在判据里。既有覆盖里没有一条用例手上同时有两张任务。

   症状是用户看的那一面：第二张及以后任务掉了线或被判自动暂停，角标照旧是蓝色的数量，
   插件把"你现在得去重登一次"这件事藏起来了。它不报错、不写日志，也没有任何本地痕迹。

   形状上的一个决定：这一段按纪律 1 抽成 `shared/logic.js` 的纯函数 `aggregateBadgeFacts`，
   执行器只递存储里读回来的两份数据。于是"扫没扫完"这件事第一次能在单元层面对**三张任务、
   故障分别挂在第一/第二/第三张**这种现场直接断言，不必为每种挂法搭一遍后台桩件。
   端到端仍然留两条：归约对了但执行器没把它接到 decideBadge 上，一样是零判据。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BADGE_COLORS,
  BADGE_TEXTS,
  aggregateBadgeFacts,
  decideBadge,
  hostOf,
  siteRoot,
} from "../../tab-auto-refresh/shared/logic.js";
import { stripComments, functionBody, spanThrough, splitTop } from "../helpers/source-tables.mjs";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const BG = read(join(repoRoot, "tab-auto-refresh", "background.js"));
const LOGIC = read(join(repoRoot, "tab-auto-refresh", "shared", "logic.js"));

/* ---------- 夹具 ----------

   三张任务、三个站点，主机名一律挑**注册域与主机名不相等**的那种（`app.a.test` 的注册域是
   `a.test`）：两段主机（`a.test`）下两者相等，"探针键取错了段"这一类改法就分不出来。
   第四个网址刻意挑一个切不出可信注册域的（`co.nz` 整串就是公共后缀，`siteRoot` 回 null），
   它是"没有网址/没有根域的任务仍然是一张任务"那条用例的现场 */
const HOSTS = ["app.a.test", "srv.b.example.org", "cdn.c.test"];
const URLS = HOSTS.map((h) => `https://${h}/board`);
const ROOTS = HOSTS.map((h) => siteRoot(h));
const NULL_ROOT_URL = "https://co.nz/";

const task = (url, over) => Object.assign({ intervalSec: 300, createdAt: 1, url }, over);
/* 三张任务，故障只挂在第 k 张上（k 从 0 数） */
const tasksWithFlag = (k, over) =>
  Object.fromEntries(URLS.map((u, i) => [String(7 + i * 4), task(u, i === k ? over : {})]));
const probe = (root, over) => Object.assign({ sus: 0, lost: false, lastNotifiedAt: 0 }, over);

/* 只有第 k 张任务掉线时取到的事实 */
const lostAt = (k) =>
  aggregateBadgeFacts({ tasks: tasksWithFlag(k, {}), probes: { [ROOTS[k]]: probe(ROOTS[k], { lost: true, sus: 2 }) } });
const pausedAt = (k) =>
  aggregateBadgeFacts({ tasks: tasksWithFlag(k, { autoPaused: { reason: "captcha", at: 1 } }), probes: {} });

/* decideBadge 的入参名从源码现推（与 `badge-state.test.mjs` 同一套抽取原语、同一份真身，
   这里不抄第二份清单）：聚合函数出口少一个键、多一个键、或者改了名，都会在这里撞上 */
function declaredParams() {
  const sigTag = "export function decideBadge({";
  const sigAt = LOGIC.indexOf(sigTag);
  assert.ok(sigAt >= 0, "logic.js 里切不到 decideBadge 的解构形参，签名形状变了");
  return splitTop(spanThrough(LOGIC, sigAt + sigTag.length, "}").text, ",")
    .map((entry) => {
      const name = entry.trim().match(/^[A-Za-z_$][\w$]*/);
      assert.ok(name, `decideBadge 的形参里有一项切不出名字：${entry.trim()}`);
      return name[0];
    })
    .sort();
}

/* ---------- 一、逐条归约 ---------- */

test("任一任务掉线就是掉线：故障挂在第一/第二/第三张上都算，一张都没有就不算", () => {
  let examined = 0;
  for (const k of [0, 1, 2]) {
    const f = lostAt(k);
    examined++;
    assert.equal(f.probeLost, true, `掉线探针在第 ${k + 1} 张任务上时没认出来：角标会变回数量那一态`);
    assert.equal(f.autoPaused, false, `第 ${k + 1} 张的现场顺手把自动暂停也判成了真：两件事实串了`);
    assert.equal(f.count, 3, `三张任务数成了 ${f.count}`);
    assert.deepEqual(
      decideBadge(f),
      { color: BADGE_COLORS.LOST, text: BADGE_TEXTS.LOST },
      `第 ${k + 1} 张掉线时 decideBadge 拿到的不是 ! 红`
    );
  }
  /* 反向：一张探针都没有，就必须是数量那一态（否则上面三条绿在"恒真"上） */
  const none = aggregateBadgeFacts({ tasks: tasksWithFlag(0, {}), probes: {} });
  assert.equal(none.probeLost, false, "没有探针也被判成掉线：本文件的正向断言全部作废");
  assert.deepEqual(decideBadge(none), { color: BADGE_COLORS.COUNT, text: "3" });
  assert.equal(examined, 3, "三张任务各挂一次的样本数变了");
});

test("自动暂停同理要扫完所有任务，而且认的是任务上那个字段", () => {
  for (const k of [0, 1, 2]) {
    const f = pausedAt(k);
    assert.equal(f.autoPaused, true, `自动暂停在第 ${k + 1} 张任务上时没认出来`);
    assert.equal(f.probeLost, false, `第 ${k + 1} 张的现场顺手把掉线也判成了真`);
    assert.deepEqual(decideBadge(f), { color: BADGE_COLORS.AUTO_PAUSED, text: BADGE_TEXTS.AUTO_PAUSED });
  }
  /* 任务上另有 `paused` 这一类近名字段（弹窗读的是 autoPaused）：只有它时不该判成自动暂停 */
  const near = aggregateBadgeFacts({ tasks: tasksWithFlag(1, { paused: { reason: "captcha" } }), probes: {} });
  assert.equal(near.autoPaused, false, "把 paused 当成 autoPaused 也算真：全局与自动两态会被混成一件事实");
  assert.deepEqual(decideBadge(near), { color: BADGE_COLORS.COUNT, text: "3" });
});

test("两件事实各自独立：谁先被扫到都要报，两件不许塌成一件", () => {
  /* 归约若在"已经找到一件"之后就早退（break、或者只取第一个命中），剩下那件就丢了。
     两种挂法都要跑：探针在前、自动暂停在前——只测一种时，另一种的早退是等价变异，
     而这恰好是第一次对照实跑出来零红的地方（见末尾 H3 那一行）。
     角标输出在两件都在时都是 ! 红，所以断言必须落在**取到的事实**上而不是颜色 */
  const AUTO = { autoPaused: { reason: "error", at: 1 } };
  let examined = 0;
  for (const [i, j] of [[0, 2], [2, 0]]) {
    const tasks = {};
    URLS.forEach((u, k) => {
      tasks[String(7 + k * 4)] = task(u, k === i ? AUTO : {});
    });
    const f = aggregateBadgeFacts({ tasks, probes: { [ROOTS[j]]: probe(ROOTS[j], { lost: true }) } });
    assert.equal(f.probeLost, true, `探针在第 ${j + 1} 张任务上时掉线没认出来`);
    assert.equal(f.autoPaused, true, `自动暂停在第 ${i + 1} 张任务上时没认出来：找到另一件就早退了`);
    assert.equal(f.count, 3);
    assert.deepEqual(decideBadge(f), { color: BADGE_COLORS.LOST, text: BADGE_TEXTS.LOST }, "两件都在时该是 ! 红");
    examined++;
  }
  assert.equal(examined, 2, "两种先后挂法的样本数变了，早退那一类改法不是一回事了");
});

/* ---------- 二、探针的键 ---------- */

test("探针键取注册域：整串主机名与整个网址都算查不到", () => {
  const [url, host, root] = [URLS[0], HOSTS[0], ROOTS[0]];
  /* 夹具自己先要能分辨，否则这三条断言是三条空跑 */
  assert.ok(root, "siteRoot 认不出这个主机，本用例造不出注册域");
  assert.notEqual(root, host, `夹具失效：${host} 的注册域就是它自己，换键形也分不出来`);
  assert.notEqual(root, url);
  const one = (key) => aggregateBadgeFacts({ tasks: tasksWithFlag(0, {}), probes: { [key]: probe(key, { lost: true }) } });
  assert.equal(one(root).probeLost, true, `探针键取注册域 ${root} 时没认出来`);
  assert.equal(one(host).probeLost, false, `探针键取整串主机名 ${host} 也算认出来了：写侧的键不是它`);
  assert.equal(one(url).probeLost, false, "探针键取整个网址也算认出来了：写侧的键更不是它");
});

test("sus 是「疑似」、不是掉线：只有 lost 为真那一件事实才成立", () => {
  const root = ROOTS[1];
  const at = (p) => aggregateBadgeFacts({ tasks: tasksWithFlag(1, {}), probes: { [root]: p } });
  assert.equal(at(probe(root, { sus: 5 })).probeLost, false, "sus 攒到 5 就点亮角标：2 次确认窗口白写着");
  assert.equal(at(probe(root, { sus: 5, lost: true })).probeLost, true);
  assert.equal(at({ sus: 1, lost: 1 }).probeLost, true, "lost 是 1 而不是 true 时不算掉线：判据读的是真值不是布尔");
  assert.equal(at({}).probeLost, false);
});

/* ---------- 三、任务数与取不到根域的任务 ---------- */

test("count 是任务条数：没有网址的那一张也算一张，也不炸", () => {
  const tasks = {
    7: task(URLS[0], {}),
    9: task(URLS[1], {}),
    11: { intervalSec: 300, createdAt: 1 }, /* 旧格式：v1.4.3 及更早的任务里没有 url */
  };
  const f = aggregateBadgeFacts({ tasks, probes: {} });
  assert.equal(f.count, 3, `三张任务（其中一张没有网址）数成了 ${f.count}：角标数字与任务列表不齐平`);
  assert.equal(f.probeLost, false);
  assert.deepEqual(decideBadge(f), { color: BADGE_COLORS.COUNT, text: "3" });
});

test("切不出可信注册域的任务不参与掉线判定", () => {
  assert.equal(siteRoot(hostOf(NULL_ROOT_URL)), null, "夹具变了：这个网址现在切得出注册域");
  /* 探针表里真躺着一键 "null" 时，少了 root 那道判据就会拿它当这张任务的答案。
     现实里写侧从不建 null 键，所以这台变异是等价的——用例钉的是"不许把它当掉线"，
     顺带钉住"这样的任务不抛错、仍然计数" */
  const tasks = { 7: task(NULL_ROOT_URL, {}), 9: task(URLS[0], {}) };
  const f = aggregateBadgeFacts({ tasks, probes: { null: probe("null", { lost: true }) } });
  assert.equal(f.probeLost, false, "根域取不到时去查了 probes[null]：那张任务被别人的条目判成了掉线");
  assert.equal(f.count, 2);
  const real = aggregateBadgeFacts({ tasks, probes: { [ROOTS[0]]: probe(ROOTS[0], { lost: true }) } });
  assert.equal(real.probeLost, true, "同一条探针挂在能切出根域的那张任务上时要认出来");
});

/* ---------- 四、聚合出口与执行器 ---------- */

test("聚合的出口键名与 decideBadge 的形参齐平：少一态就是那一态恒为假", () => {
  const declared = declaredParams();
  assert.deepEqual(declared, ["autoPaused", "count", "pausedAll", "probeLost"]);
  const out = aggregateBadgeFacts({ tasks: tasksWithFlag(0, {}), probes: {}, pausedAll: true });
  assert.deepEqual(Object.keys(out).sort(), declared, `聚合函数回的是 ${Object.keys(out).join("/")}，decideBadge 收的是 ${declared.join("/")}`);
  /* 逐一键名对不上都会静默：默认值全是 false/0，等于那一件事实"没发生" */
  assert.equal(out.pausedAll, true, "pausedAll 没原样递出去：全局暂停那一态再也不会出现在角标上");
  assert.equal(out.probeLost, false);
  assert.equal(out.autoPaused, false);
  assert.equal(out.count, 3);
});

test("执行器不再自己归约：updateBadge 里没有扫描任务的循环，四件事实各取自 facts 的同名键", () => {
  const body = stripComments(functionBody(BG, "updateBadge"));
  assert.equal((body.match(/aggregateBadgeFacts\s*\(/g) || []).length, 1, "updateBadge 里 aggregateBadgeFacts 不是恰好一处");
  for (const bad of [/\bfor\s*\(/, /Object\.values/, /\.some\(/, /\.find\(/, /\bsiteRoot\(/, /\bhostOf\(/, /\.lost\b/]) {
    assert.equal(
      new RegExp(bad.source).test(body),
      false,
      `updateBadge 里出现了 ${bad.source}：逐条归约被搬回执行器，"扫没扫完"重新变成零判据`
    );
  }
  /* 调用点必须是 `名字: facts.同一个名字`：左右名字不同就是把两件事实接反，
     而四件事实里三件是布尔，接反不报错，只是角标显示成另一种颜色 */
  const calls = [...body.matchAll(/decideBadge\(\s*\{([\s\S]*?)\}\s*\)/g)];
  assert.equal(calls.length, 1, "updateBadge 里 decideBadge 切不到恰好一处");
  const pairs = [...calls[0][1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*facts\.([A-Za-z_$][\w$]*)/g)];
  assert.equal(pairs.length, 4, `调用点只切到 ${pairs.length} 对 facts.X：四件事实不是各递各的`);
  for (const [, key, src] of pairs) {
    assert.equal(key, src, `调用点把 facts.${src} 递给了 ${key}：两件事实接反了`);
  }
  const imp = (BG.match(/import \{([\s\S]*?)\} from "\.\/shared\/logic\.js";/) || [])[1];
  assert.ok(/\baggregateBadgeFacts\b/.test(imp || ""), "aggregateBadgeFacts 没有从 shared/logic.js import 过来");
});

/* ---------- 五、端到端 ---------- */

const PAGE = URLS[0];
const PAGE2 = URLS[1];

async function boot({ tasks, pausedAll, probes, settings } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  if (pausedAll) env.store.local.pausedAll = true;
  if (probes) env.store.local.sessionProbe = probes;
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false },
    settings
  );
  for (const [id, t] of Object.entries(tasks || {})) env.putTab(Number(id), t.url);
  await bootBackground(env);
  return env;
}

function lastBadge(env) {
  const c = env.calls.badge.filter(([k]) => k === "color").pop();
  const t = env.calls.badge.filter(([k]) => k === "text").pop();
  assert.ok(c && t, "整个用例没有往角标写过任何东西：本用例是空跑");
  return { color: c[1], text: t[1] };
}

/* toggle-pause-all 是离 updateBadge 最近的一条真通道：它翻完 pausedAll 就刷角标。
   两张任务按 id 升序挂（7 在前、11 在后），故障只挂在**后面那一张**上 */
const TWO = { 7: task(PAGE, {}), 11: task(PAGE2, {}) };

test("端到端：掉线探针挂在第二张任务上，角标仍然是 ! 红", async () => {
  const env = await boot({
    tasks: TWO,
    pausedAll: true,
    probes: { [ROOTS[1]]: probe(ROOTS[1], { sus: 2, lost: true }) },
  });
  await env.send({ type: "toggle-pause-all" });
  assert.equal(env.store.local.pausedAll, false, "没翻动 pausedAll，本用例是空跑");
  assert.equal(env.store.local.tasks[11].url, PAGE2, "第二张任务没建起来，本用例是空跑");
  assert.deepEqual(lastBadge(env), { color: BADGE_COLORS.LOST, text: BADGE_TEXTS.LOST });
});

test("端到端：只有第二张任务自动暂停时是 ⚠ 橙，撤掉它才退回 ‖ 灰", async () => {
  const env = await boot({ tasks: { 7: task(PAGE, {}), 11: task(PAGE2, { autoPaused: { reason: "captcha", at: 1 } }) } });
  await env.send({ type: "toggle-pause-all" }); /* 翻成 true：这一笔正好造出"人工暂停 + 第二张自动暂停" */
  assert.equal(env.store.local.pausedAll, true, "没按下全局暂停，本用例是空跑");
  assert.deepEqual(lastBadge(env), { color: BADGE_COLORS.AUTO_PAUSED, text: BADGE_TEXTS.AUTO_PAUSED });

  const plain = await boot({ tasks: TWO });
  await plain.send({ type: "toggle-pause-all" });
  assert.deepEqual(lastBadge(plain), { color: BADGE_COLORS.PAUSED, text: BADGE_TEXTS.PAUSED });
});

/* ---------- 六、参照物 ---------- */

test("参照物：夹具与判据都真的说过话", () => {
  assert.equal(HOSTS.length, 3, "任务样本不是三张");
  assert.deepEqual(ROOTS, ["a.test", "example.org", "c.test"], "夹具的注册域现推变了，键形那条轴不是一回事了");
  assert.equal(siteRoot(hostOf(NULL_ROOT_URL)), null);
  assert.equal(Object.keys(declaredParams()).length, 4);
  let samples = 0;
  for (const k of [0, 1, 2]) {
    assert.equal(lostAt(k).count, 3);
    assert.equal(pausedAt(k).count, 3);
    samples += 2;
  }
  assert.equal(samples, 6, "两种故障各挂三张的样本数变了");
  assert.ok(BG.includes("aggregateBadgeFacts"), "background.js 里已经没有 aggregateBadgeFacts 字样");
  assert.ok(LOGIC.includes("export function aggregateBadgeFacts"), "logic.js 里的聚合函数没了");
});

/* ---------- 对照（改坏哪一处）与边界 ----------

   14 台变异加一台 pristine 在仓库外整仓副本上实跑（脚本 `D:/Github/_tar_ctl_r20/ctl20.mjs`，
   日志 `ctl20.log`），每台跑两遍：pre 删掉本文件（等于本轮之前的判据覆盖面），post 留着。
   两侧 `validate.mjs` 全 OK，pristine 的 post 全绿（本文件十二条不误伤）。
   pre 那一列**留着本轮那次搬位**（`aggregateBadgeFacts` 抽出、执行器只递事实）——它行为中性，
   而判据覆盖面才是这一列要量的东西；唯一的例外是 E1，那一台就是把归约写回执行器，
   它的 pre 一侧正是本轮之前的世界本身，实测净红 0。
   "改前零红"一律按**除那条固定的 doc-anchors 路径红之外**算：说明书这一条正指着本文件，
   pre 把本文件删了，于是每台 pre 必红那一条——它是"删掉门禁"这个动作的产物，不是变异的产物。

   | 变异 | pre | post |
   | --- | --- | --- |
   | K0 pristine | 净红 0 | 全绿 |
   | H1 掉线只看第一个任务（上一轮 G1） | 0 | 5：逐条归约三台 / 两件独立 / sus 那条 / 根域那条 / 端到端 ! |
   | H2 自动暂停只看第一个任务 | 0 | 3：自动暂停那条 / 两件独立 / 端到端 ⚠ |
   | H3 找到掉线就 `break` | 0 | 1：两件独立（断的是 facts，不是颜色） |
   | H3b 找到自动暂停就 `break` | 既有红 1（上一轮端到端 !） | 两件独立 + 那一条既有红 |
   | H4 探针键取整串主机名（上一轮 G2） | 既有红 2（端到端 ! / A14 那条） | 6 + 那两条既有红 |
   | H5 探针键取整个网址 | 既有红 3（再加心跳那条） | 6 + 那三条既有红 |
   | H6 有探针条目就算掉线（不看 `lost`） | 0 | 1：sus 那条 |
   | H7 掉线读 `sus` 而不是 `lost` | 既有红 1（端到端 !） | 4 + 那一条既有红 |
   | H8 删掉 `root &&` 那道判据 | 0 | 1：根域那条（等价变异，见边界 3） |
   | H9 出口不递 `pausedAll` | 既有红 1（端到端 ⚠） | 键名齐平 + 端到端 ‖ + 那一条既有红 |
   | H10 数任务时跳过没有网址的那张 | 0 | 1：count 那条 |
   | H11 调用点把 `probeLost` 递成 `facts.autoPaused` | 既有红 4（两态端到端 / 5xx / 心跳 / A14） | 执行器形状 + 两条端到端 + 那四条既有红 |
   | E1 在 `updateBadge` 里把归约再算一遍（行为等价） | 0 | 1：执行器不再自己归约 |
   | D1 `AGENTS.md` 里 `aggregateBadgeFacts` 少写一个 `s` | 0 | **0：全套 570 条全绿** |

   怎么读这张表：
   - 改前零净红的有八台，本轮补住其中七台。第八台 D1 补不住，而且**不是本文件的轴**：
     `doc-anchors` 判"符号名在不在源码语料里"用的是 `corpus.includes(t)` 那一处子串判据，
     少写一个字母的真名字反而是"存在"的。已记进 `BACKLOG.md` A39
   - H3 是本轮**第一次实跑零红**的一台，也是唯一因此改过用例的一台：它的夹具原来只把掉线挂在
     第三张、自动暂停挂在第一张，于是"找到掉线就 break"恰好走不到丢事实那一步。改成两种先后
     顺序各跑一遍之后 H3 与 H3b 都红在"两件独立"那一条上——那一台断的是**取到的事实**，
     而两种挂法下角标输出都是 ! 红，只看颜色的用例永远分不出早退
   - H4/H5/H7/H9/H11 改前就红，是因为既有覆盖里有三条端到端各自路过角标。本轮把它们各自
     补到单元层，不是为了多几条红，是因为那三条红在"哪个夹具恰好排在前面"上：
     H4 与 H5 改前红的就是同一条端到端，而它红得出来全靠上一轮把夹具换成 `app.a.test`
   - 只红一条的五类（H3/H6/H8/H10/E1）不是覆盖面小，是那台变异只动了一根轴
   - E1 与 H8 行为一个字没变照样红，是刻意的：前者断的是形状（归约不许住回执行器，
     否则 H1~H3b 这四类重新变成零判据），后者断的是"根域取不到时不许去查 `probes[null]`"

   边界（这一根轴挡不住的）：
   1. 文档符号名的存在性判据在 `doc-anchors.test.mjs` 那一头（D1 当时是子串，第二十一轮已换成
      整词），本文件不重复那一头
   2. 本文件核"四件事实取对不对"，**不核探针这本账别的读法**：`isProbeLost`（备份写入那一头）、
      `pruneStaleProbes`（收敛那一头）、以及写侧 `reportSessionSignal` 的键形都不在这里。
      H4/H5 改前红的那两条既有端到端正落在备份与任务网址那两条轴上，说明那几处各有自己的账，
      但"三处读侧键形齐不齐平"没有一条统一的账
   3. H8 那台在真实 Chrome 里是等价变异：写侧从不建 `null` 键。那条用例的真实价值是
      "切不出可信注册域的任务不抛错、仍然计数"，早退判据那一半顺带钉住
   4. 端到端两条各造一种"故障挂在第二张任务上"的现场，靠的是 tabId 升序决定 `Object.values`
      的顺序。若哪天任务顺序改成按创建时间或网址排，这两条仍红得出来（归约必须与顺序无关），
      但"第一张/第二张"这两个说法就对不上现场了——那时候回来改的是措辞，不是判据
   5. 不核角标被刷新的**时机**：任务增删、暂停、探针写入各条路径该不该刷角标，
      上一轮的端到端与本文件的两条端到端都只看"最后一次写进去的那一对" */

