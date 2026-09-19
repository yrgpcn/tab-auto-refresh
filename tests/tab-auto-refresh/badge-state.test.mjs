/* 第十九轮审计（A37）：角标这本账。审的是**五态先后次序、每态给什么颜色与文字、
   说明书那一行的顺序跟它齐不齐平**。

   为什么这根轴是空的（第十八轮的探针量的、本轮 pre 列又各跑了一遍）：`updateBadge` 里那两条
   嵌套三元式此前零判据。实测（仓库外整仓副本）：把优先级换一位（自动暂停与全局暂停对调）零红、
   删掉 `pausedAll` 那一支（全局暂停不再显示 ‖）零红、把 `AGENTS.md` 那行顺序整个倒过来写零红、
   把自动暂停与数量那两态的色值对调也零红。既有覆盖只剩两处孤立的值——一处钉掉线那个角标是红的
   （`heartbeat.test.mjs` 的"角标没变红"），一处钉自动暂停那个角标文字是 ⚠（5xx 连击那条用例），
   钉的都是"这一态自己长什么样"，不是次序；另外三态（‖ 灰、计数 蓝、空）连值都没被断言过。

   本轮同时按纪律 1 把顺序决策抽成纯函数 `decideBadge`（在 `shared/logic.js`），执行器只
   取事实再写盘——所以这个文件两头都核：纯函数那一头核次序与取值，源码那一头核
   "执行器确实把四件事实递对了"，最后两条端到端核优先级真落到 `chrome.action` 上。

   形状上的一个决定：那份顺序清单**只许住在 `AGENTS.md` 一行里**，`logic.js` 的注释刻意不
   重抄（第三份抄本会掩盖前两份不一致，A33 与上一轮的 A36 都是这么翻车的）。本文件按两头
   现推再比对：从 `decideBadge` 真跑出来的两两胜负推出全序，从文档那一行抽出人读的顺序。
   测试文件里不抄第三份清单——`rank()` 与 `DOC_STATE` 一张是行为、一张是人话到态名的桥。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BADGE_COLORS, BADGE_TEXTS, decideBadge, hostOf, siteRoot } from "../../tab-auto-refresh/shared/logic.js";
import { stripComments, functionBody, spanThrough, splitTop } from "../helpers/source-tables.mjs";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const BG = read(join(repoRoot, "tab-auto-refresh", "background.js"));
const LOGIC = read(join(repoRoot, "tab-auto-refresh", "shared", "logic.js"));
const AGENTS = read(join(repoRoot, "AGENTS.md"));

/* 四个可显示态。名字一律用 decideBadge 的入参名，不再另起一套叫法；
   count 不是一个可"按下"的开关，它是"没有任何标记、但有任务"那一态 */
const STATES = ["probeLost", "autoPaused", "pausedAll", "count"];
const FLAG = { probeLost: "probeLost", autoPaused: "autoPaused", pausedAll: "pausedAll" };
const flags = (state) => (FLAG[state] ? [FLAG[state]] : []);
const input = (list, count = 3) => ({
  probeLost: list.includes("probeLost"),
  autoPaused: list.includes("autoPaused"),
  pausedAll: list.includes("pausedAll"),
  count,
});
const out = (list, count = 3) => decideBadge(input(list, count));
const soloOut = (state, count = 3) => out(flags(state), count);
const deepEq = (a, b) => a.color === b.color && a.text === b.text;

/* a 与 b 同时成立时谁露在角标上。两个 count 相碰不会出现（态表里只有一个 count），
   所以 flags 至少有一项是真的 */
function duel(a, b) {
  const r = out([FLAG[a], FLAG[b]].filter(Boolean), 3);
  return STATES.find((s) => deepEq(r, soloOut(s))) || null;
}

/* 从两两胜负现推全序：赢场数最多的排前面 */
function rank() {
  const wins = new Map(STATES.map((s) => [s, 0]));
  for (const a of STATES) {
    for (const b of STATES) {
      if (a !== b && duel(a, b) === a) wins.set(a, wins.get(a) + 1);
    }
  }
  return [...wins.entries()].sort((x, y) => y[1] - x[1]).map(([s]) => s);
}

/* ---------- 一、取值 ---------- */

test("五态各有自己的长相：四个可显示态两两不同，第五态是空字", () => {
  const shown = STATES.map((s) => soloOut(s));
  const seen = new Set(shown.map((r) => `${r.color}|${r.text}`));
  assert.equal(seen.size, 4, `四个可显示态里有两态长得一模一样：${[...seen].join(" ")}`);
  for (const [i, r] of shown.entries()) {
    assert.match(r.color, /^#[0-9a-f]{6}$/, `${STATES[i]} 的颜色不是六位十六进制：${r.color}`);
    assert.ok(r.text, `${STATES[i]} 的文字是空的：那一态在角标上根本看不见`);
  }
  /* 数量那一态的文字是数字本身，不是"有个任务"这种记号 */
  assert.equal(soloOut("count", 7).text, "7");
  assert.equal(soloOut("count", 12).text, "12");
  /* 四支颜色互不相同：两态同色等于把优先级藏起来 */
  assert.equal(new Set(Object.values(BADGE_COLORS)).size, 4, "BADGE_COLORS 里有两态共用一个色值");
  assert.equal(new Set(Object.values(BADGE_TEXTS)).size, 3, "BADGE_TEXTS 里有两态共用一个记号");
});

test("两支链的支数不对称是刻意的：暂停与零任务那一格是灰底空字", () => {
  /* 颜色那条链不看 count，文字那条链看。压成对称就会多出一态（没有任务时刷出灰底 ‖） */
  assert.deepEqual(out(["pausedAll"], 0), { color: BADGE_COLORS.PAUSED, text: "" });
  assert.deepEqual(out(["pausedAll"], 3), { color: BADGE_COLORS.PAUSED, text: BADGE_TEXTS.PAUSED });
  assert.deepEqual(out([], 0), { color: BADGE_COLORS.COUNT, text: "" });
  assert.deepEqual(soloOut("count"), { color: BADGE_COLORS.COUNT, text: "3" });
  /* 反过来：掉线与自动暂停不看 count。今天它们没有 count 为 0 的现场，
     但形状要钉住——顺手给它们也加一道 count > 0，就会在"暂停的那页掉线"时把 ! 藏掉 */
  assert.equal(out(["probeLost"], 0).text, BADGE_TEXTS.LOST);
  assert.equal(out(["autoPaused"], 0).text, BADGE_TEXTS.AUTO_PAUSED);
  assert.equal(out(["probeLost", "pausedAll"], 0).text, BADGE_TEXTS.LOST);
});

/* ---------- 二、次序 ---------- */

test("次序现推：两两对撞构成严格全序，第一名是掉线", () => {
  for (const a of STATES) {
    for (const b of STATES) {
      if (a === b) continue;
      const ab = duel(a, b);
      const ba = duel(b, a);
      assert.equal(ab, ba, `${a} 与 ${b} 对撞的赢家不稳定：${ab} / ${ba}`);
      for (const c of STATES) {
        if (c === a || c === b) continue;
        if (ab === a && duel(b, c) === b) {
          assert.equal(duel(a, c), a, `${a}>${b} 且 ${b}>${c}，但 ${a} 赢不了 ${c}：次序不传递`);
        }
      }
    }
  }
  const r = rank();
  assert.equal(r[0], "probeLost", `第一名不是掉线而是 ${r[0]}：掉线是"用户现在就得处理"那一态`);
  assert.deepEqual(r, ["probeLost", "autoPaused", "pausedAll", "count"]);
  /* 自动暂停压在人工暂停之前：那是插件判出的故障，藏进用户自己按下的暂停等于撤回故障 */
  assert.equal(duel("autoPaused", "pausedAll"), "autoPaused");
});

test("不串台：16 个组合里每个输出都必须由单一态解释", () => {
  /* 专门打"颜色取自一态、文字取自另一态"——两条链各改一半就会出现这种输出 */
  const legal = new Set();
  for (const c of [0, 3]) {
    for (const s of STATES) legal.add(JSON.stringify(soloOut(s, c)));
  }
  let examined = 0;
  for (const p of [false, true]) {
    for (const a of [false, true]) {
      for (const q of [false, true]) {
        for (const c of [0, 3]) {
          const list = [p && "probeLost", a && "autoPaused", q && "pausedAll"].filter(Boolean);
          const r = out(list, c);
          examined++;
          assert.ok(
            legal.has(JSON.stringify(r)),
            `标记 ${p}/${a}/${q}、count=${c} 的输出 ${JSON.stringify(r)} 不属于任何单一态的取值`
          );
        }
      }
    }
  }
  assert.equal(examined, 16);
});

/* ---------- 三、执行器这一头 ---------- */

test("执行器只取事实：updateBadge 不再自己排优先级，四件事实都递得对", () => {
  const body = stripComments(functionBody(BG, "updateBadge"));
  const calls = [...body.matchAll(/decideBadge\(\s*\{([\s\S]*?)\}\s*\)/g)];
  assert.equal(calls.length, 1, `updateBadge 里 decideBadge 切到 ${calls.length} 处，判据要的是恰好一处`);
  assert.equal((body.match(/#[0-9a-fA-F]{6}/g) || []).length, 0, "updateBadge 里还留着裸色值：优先级搬回去了");
  assert.equal((body.match(/\?\s*"/g) || []).length, 0, "updateBadge 里还有取值的三元式：顺序决策没抽干净");
  assert.match(body, /setBadgeBackgroundColor/, "updateBadge 不再写角标了？");
  assert.match(body, /setBadgeText/, "updateBadge 不再写角标了？");

  /* 递出去的键名与 decideBadge 的解构形参必须齐平：默认值全是 false/0，
     拼错一个名字不报错，只会把那一态悄悄判成"没发生" */
  const sigTag = "export function decideBadge({";
  const sigAt = LOGIC.indexOf(sigTag);
  assert.ok(sigAt >= 0, "logic.js 里切不到 decideBadge 的解构形参，签名形状变了");
  const declared = splitTop(spanThrough(LOGIC, sigAt + sigTag.length, "}").text, ",")
    .map((entry) => {
      const name = entry.trim().match(/^[A-Za-z_$][\w$]*/);
      assert.ok(name, `decideBadge 的形参里有一项切不出名字：${entry.trim()}`);
      return name[0];
    })
    .sort();
  assert.deepEqual(declared, [...STATES].sort(), "decideBadge 的形参与本文件的态名单不齐平");
  const passed = [...calls[0][1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    passed,
    declared,
    `调用点递的是 ${passed.join("/")}，decideBadge 收的是 ${declared.join("/")}：` +
      "少递的那一件会退回默认值，也就是把那一态判成没发生"
  );

  const imp = (BG.match(/import \{([\s\S]*?)\} from "\.\/shared\/logic\.js";/) || [])[1];
  assert.ok(imp, "background.js 里切不到那条 shared/logic.js 的 import");
  assert.ok(/\bdecideBadge\b/.test(imp), "decideBadge 没有从 shared/logic.js import 过来");
});

/* ---------- 四、文档账 ---------- */

/* 从六位十六进制现推"这算哪种颜色"（HSL 色相区间取中文名）。要它是因为色值与态名之间的
   绑定此前只钉住过掉线那一头（`heartbeat.test.mjs` 断言 "#dc2626"），把另外三态的色值两两
   对调，全套门禁全绿。光断言"四个色值互不相同"挡不住对调，而文档那一行本来就写着人话的
   颜色词——拿两边对账，测试里就不必抄第二份色名表 */
function hueName(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 32) return "灰";
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "红";
  if (h < 45) return "橙";
  if (h < 70) return "黄";
  if (h < 170) return "绿";
  if (h < 200) return "青";
  if (h < 260) return "蓝";
  return "紫";
}

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/* 文档里的态名 → 判据里的态。这张表是"人读的名字"与"函数入参"之间唯一的桥：
   新加一态而不进来改表，文档账会点名"这一段认不出"，不会静默跳过 */
const DOC_STATE = [
  [/^掉线/, "probeLost"],
  [/^自动暂停/, "autoPaused"],
  [/^(全部)?暂停/, "pausedAll"],
  [/^数量/, "count"],
];
const docOrderLines = () => AGENTS.split("\n").filter((l) => /^\s*顺序：/.test(l) && /掉线/.test(l));

test("文档账：AGENTS.md 那一行的顺序、记号与态数都跟现推的齐平", () => {
  const lines = docOrderLines();
  assert.equal(lines.length, 1, `AGENTS.md 里那条角标顺序清单命中 ${lines.length} 行，说明书成了两份`);
  const segs = lines[0].replace(/^\s*顺序：/, "").replace(/。[\s\S]*$/, "").split(">").map((s) => s.trim());
  assert.equal(segs.length, 5, `文档那行列了 ${segs.length} 段，判据要的是四个可显示态加"空"`);
  const named = segs.slice(0, 4).map((s) => {
    const hit = DOC_STATE.find(([re]) => re.test(s));
    assert.ok(hit, `文档那一段认不出态名：${s}（新加一态要连 DOC_STATE 与 decideBadge 一起改）`);
    return hit[1];
  });
  const derived = rank();
  assert.deepEqual(named, derived, `文档写的是 ${named.join(" > ")}，decideBadge 跑出来是 ${derived.join(" > ")}`);
  assert.match(segs[4], /^空/, `最后一段不是"空"而是 ${segs[4]}`);

  /* 记号从函数现推（不抄 BADGE_TEXTS 的第二份）；数量那一态显示的是数字本身，不该有记号 */
  for (const [i, s] of segs.slice(0, 4).entries()) {
    const sym = (s.match(/`([^`]+)`/) || [])[1] || "";
    const want = soloOut(derived[i]).text;
    if (derived[i] === "count") {
      assert.equal(sym, "", "数量那一态在文档里不该带反引号记号：它显示的是数字本身");
    } else {
      assert.equal(sym, want, `文档里 ${derived[i]} 写的记号是 ${sym}，函数给的是 ${want}`);
    }
  }
  const colorWords = segs.slice(0, 4).map((s) => (s.match(/([红橙灰蓝紫绿黑白])\s*$/) || [])[1] || "");
  assert.ok(colorWords.every(Boolean), "文档那行有一段没带颜色词");
  assert.equal(new Set(colorWords).size, 4, `文档里两态写了同一个颜色词：${colorWords.join("/")}`);
  for (let i = 0; i < 4; i++) {
    const color = soloOut(derived[i]).color;
    const got = hueName(color);
    assert.equal(got, colorWords[i],
      `${derived[i]}：文档那一行写的是「${colorWords[i]}」，色值 ${color} 现推是「${got}」——` +
      "色值与态名之间的绑定错了，用户看到的提醒颜色就不是说明书上那一种");
  }

  /* "角标 N 态"那个数字不许与清单不齐平——本轮之前它写着四态却列了五个 */
  const claim = AGENTS.match(/角标([一二三四五六七八九十]|\d)态/);
  assert.ok(claim, "AGENTS.md 里那句角标数量词找不到了");
  const n = claim[1] in CN_DIGITS ? CN_DIGITS[claim[1]] : Number(claim[1]);
  assert.equal(n, segs.length, `文档说角标 ${n} 态，可那一行列了 ${segs.length} 段`);
});

/* ---------- 五、端到端：优先级要穿过执行器落到 chrome.action 上 ---------- */

/* 主机名要挑一个**注册域与主机名不相等**的：`app.a.test` 的注册域是 `a.test`，于是探针键取
   整串主机名还是取注册域，这一条用例分得出来（挑 `a.test` 那种两段主机时两者相等，取错也看不出来） */
const PAGE = "https://app.a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

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

/* 最后一次写进 chrome.action 的 (color, text) 对 */
function lastBadge(env) {
  const c = env.calls.badge.filter(([k]) => k === "color").pop();
  const t = env.calls.badge.filter(([k]) => k === "text").pop();
  assert.ok(c && t, "整个用例没有往角标写过任何东西：本用例是空跑");
  return { color: c[1], text: t[1] };
}

test("端到端：全局暂停与自动暂停同时成立时，写进角标的是 ⚠ 橙", async () => {
  /* toggle-pause-all 是离 updateBadge 最近的一条真通道：它翻完 pausedAll 就刷角标，
     而这一翻正好造出"人工暂停 + 自动暂停"同时成立的现场 */
  const env = await boot({ tasks: { 7: task({ autoPaused: { reason: "captcha" } }) } });
  await env.send({ type: "toggle-pause-all" });
  assert.equal(env.store.local.pausedAll, true, "没按下全局暂停，本用例是空跑");
  assert.deepEqual(lastBadge(env), { color: BADGE_COLORS.AUTO_PAUSED, text: BADGE_TEXTS.AUTO_PAUSED });

  /* 把自动暂停撤掉，同一个现场退回 ‖ 灰。两条并在一起才叫"优先级真在跑"而不是巧合 */
  const plain = await boot({ tasks: { 7: task() } });
  await plain.send({ type: "toggle-pause-all" });
  assert.deepEqual(lastBadge(plain), { color: BADGE_COLORS.PAUSED, text: BADGE_TEXTS.PAUSED });
});

test("端到端：掉线探针压得住其余两态，角标是 ! 红", async () => {
  /* 探针的键按代码同一套算法算：siteRoot(hostOf(task.url))。手写一个键名就会两头对不上，
     而表现是"角标照旧 ⚠"——所以这里宁可 import 那两个函数 */
  const root = siteRoot(hostOf(PAGE));
  assert.ok(root, "siteRoot 认不出这个页面，本用例造不出掉线现场");
  const env = await boot({
    tasks: { 7: task({ autoPaused: { reason: "error" } }) },
    probes: { [root]: { sus: 0, lost: true, lastNotifiedAt: 1 } },
    pausedAll: true,
  });
  await env.send({ type: "toggle-pause-all" }); /* 翻回 false：这一笔只为了路过 updateBadge */
  assert.equal(env.store.local.pausedAll, false, "没翻动 pausedAll，本用例是空跑");
  assert.deepEqual(lastBadge(env), { color: BADGE_COLORS.LOST, text: BADGE_TEXTS.LOST });
});

/* ---------- 六、参照物 ---------- */

test("参照物：两头都真的说过话", () => {
  assert.equal(Object.keys(BADGE_COLORS).length, 4, "BADGE_COLORS 不再是四支");
  assert.equal(Object.keys(BADGE_TEXTS).length, 3, "BADGE_TEXTS 不再是三支记号");
  assert.equal(rank().length, 4);
  let duels = 0;
  for (const a of STATES) {
    for (const b of STATES) if (a !== b) { duel(a, b); duels++; }
  }
  assert.equal(duels, 12, "两两对撞的样本数变了，判据覆盖面不是一回事了");
  assert.equal(docOrderLines().length, 1, "文档那一行的锚在 AGENTS.md 里不唯一或已经找不到");
  assert.ok(BG.includes("decideBadge"), "background.js 里已经没有 decideBadge 字样");
});

/* ---------- 对照（改坏哪一处）与边界 ----------

   13 台变异在仓库外整仓副本上实跑（脚本 `D:/Github/_tar_ctl_r19/ctl19.mjs`，日志 `ctl19.log`），
   每台跑两遍：pre 删掉本文件（等于本轮之前的世界），post 留着。两侧 `validate.mjs` 除 C2 第一次
   （见下面"怎么读这张表"最后一条）全 OK，pristine 的 post 全绿（本文件九条不误伤）。
   "改前零红"一律按**除那条固定的 doc-anchors 路径红之外**算：说明书这一条正指着本文件，pre 把
   本文件删了，于是每台 pre 必红那一条——它是"删掉门禁"这个动作的产物，不是变异的产物。

   | 变异 | pre | post |
   | --- | --- | --- |
   | K0 pristine | 净红 0 | 全绿 |
   | B1 自动暂停让位给全局暂停（`&& !pausedAll`） | 0 | 3：次序现推 / 文档账 / 端到端 ⚠ |
   | B2 掉线让位给自动暂停（`&& !autoPaused`） | 0 | 3：次序现推 / 文档账 / 端到端 ! |
   | B3 删掉 `pausedAll` 那一支 | 0 | 4：五态长相 / 两支链 / 文档账 / 端到端 ⚠ |
   | C1 掉线↔全局暂停 的色值对调 | 既有红 1（heartbeat "角标没变红"） | 文档账 + 那一条既有红 |
   | C4 自动暂停↔数量 的色值对调 | 0 | 1：文档账 |
   | C2 文字那条链也去看 count（压成对称） | 0 | 1：两支链的支数不对称 |
   | E1 调用点把 `pausedAll:` 拼成 `pauseAll:` | 0 | 2：执行器只取事实 / 端到端 ⚠ |
   | E2 把取值三元式写回 `updateBadge`（行为等价） | 0 | 1：执行器只取事实 |
   | E3 执行器不再取"自动暂停"这件事实 | 既有红 1（5xx 连续两次那条） | 端到端 ⚠ + 那一条既有红 |
   | D1 文档那行顺序整个倒过来写 | 0 | 1：文档账 |
   | D2 文档把"角标五态"写成"角标四态" | 0 | 1：文档账 |
   | D3 文档把 `!` 与 `⚠` 两个记号对调 | 0 | 1：文档账 |
   | F1 新增一态只改 `decideBadge`（形参加一支、不登记） | 0 | 1：执行器只取事实 |
   | G1 掉线判据改成只看第一个任务 | 未跑 | **0：全套 558 条全绿** |
   | G2 探针键取整串主机名而不是注册域 | 未跑 | 2：端到端 ! + 一条既有的 A14 用例 |

   G1/G2 是给下一轮（`BACKLOG.md` A38）探路的，只跑了 post 一侧——它们不在"本轮补住了什么"的账里，
   在本轮立起来的这根轴上仍然零红/借别的文件才红，见边界 1。A38 已在第二十轮结案，
   那两台换到新那一头都红得出来了（G1 → H1、G2 → H4）。

   怎么读这张表：
   - 三类次序变异（B1/B2/B3）改前全零、改后各红 3~4 条，而且红在三个不同的地方（现推的序、
     说明书那一行、真落到 `chrome.action` 的那一笔）。这不是冗余：三处是这件事的三个真相来源，
     任何一处独自改动都该被另外两处点出来
   - C1 与 C4 是同一根轴的两半。C1 改前就红一条，因为既有测试里只有"掉线是红的"有名有姓；
     C4 那一对（橙↔蓝）改前零红，是本轮补上的一半——`hueName` 拿文档里的人话颜色词去对色值，
     两头谁都不是抄本
   - E2 行为一个字没变照样红，是刻意的：那条 guard 断的是形状（顺序决策不许住在执行器里），
     不是行为。今天等价的三元式写回执行器，明天 B1/B2 那两类改动就重新变成零判据
   - 只红一条的六类不是覆盖面小，是那台变异只动了一根轴
   - 第一次的 C2 needle 少切了一段，把 `logic.js` 改成语法不合法，`validate.mjs` 直接 FAIL、
     单测 115 条红——那是对照自身的坏样本，不算数据，表里那一行是修正 needle 之后重跑的

   边界（这一根轴挡不住的）：
   1. 本文件核"五态的序、每态的色与字、执行器递没递对"，**不核那四件事实取对不对**——那一半在
      `badge-facts.test.mjs`（第二十轮的 A38）。当时两台探路实测：把 `anyLost` 那个循环改成只看
      第一个任务全套零红；把探针键从 `siteRoot(hostOf(t.url))` 换成整串主机名红得出来，靠的是
      本文件端到端那条夹具故意挑了"注册域与主机名不相等"的 `app.a.test`——换成 `a.test` 那种
      两段主机，两者相等就红不出来。那两条现在各有自己的判据了
   2. `hueName` 认的是色相区间：挡得住两态色值对调、挡不住同区间内换色号（`#dc2626` 换成 `#e11d48`
      仍是"红"）。这根轴要防的是"绑错态"，不是色号审美
   3. 不串台那条枚举 2³ × {count=0,3} 共 16 个组合，`count` 只取两个代表值。数值的语义
      （`String(count)` 与 `count > 0`）由前两组用例钉，多取几个 count 不加覆盖面
   4. 文档账锚在"以 `顺序：` 开头且含掉线的那一行"，并要求恰好一行。把它拆成两行、或换引导词，
      会以"命中 0 行 / 说明书成了两份"红——那是催人回来重锚，不是安静跳过
   5. 新增一态那三处（分支、文档顺序、门禁态清单）里只改前两处都会红。**上一版这里记的是"一态既进了
      形参又写进文档、唯独执行器不递它，全套仍绿"**——那一半已经在第二十轮补上：`badge-facts.test.mjs`
      拿聚合函数的出口键名现推着对 `decideBadge` 的形参，调用点还要求四对 `名字: facts.同名`，
      实测"出口不递 `pausedAll`"那一台红两条
   6. 端到端两条看的是 `env.calls.badge` 里 color 与 text 各自最后一条记录，断的是"最后一次写进
      `chrome.action` 的那一对"，不是"一共写了几次"。角标被重复刷新的次数（任务每条增删路径都
      经过 `updateBadge`）不在这根轴上 */
