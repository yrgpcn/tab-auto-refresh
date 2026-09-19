/* 第十五轮审计（A33）：一条文案键在源码里"被取到"的那几条通道，通道的另一头没人核对。
   validate.mjs 问的是两件事：像键的字面量引用的键在不在（正向，只认调用点写死的键名），
   和语言包里每个键有没有人在源码里"提到过"（反向，把注释里手打的键名也算数）。
   两头一夹夹不住的是**间接通道**：键名住在表里、住在属性值里，取用的时候递的是变量
   （`msg(ALARM_SKIP_REASONS[reason])`、`getMessage(WECHAT_EVENT_TITLE_KEYS[event])`）。
   正向看不见它，因为实参不是字面量；反向挡得住一半，因为表值改坏时旧键往往还在别处
   被提到过。第十四轮给消息载荷记的那三本账（message-ledger）里第三本就是这个形状，
   这一轮把同一个办法用到文案键上，并且把"通道清单必须齐平语言包"做成判据。

   三处实测盲区（第十五轮在仓库外整仓副本上跑 20 个变异量出来的，表在文件末尾；
   其中 W13 那版样本本身不成立，有效对照是 19 条）：
   - 表值拼错而旧键在别处还被提到：`WECHAT_ERROR_KEYS` 里 40001 与 42001 合用
     `wechatErrToken`，把 40001 改成不存在的键，那一条键名照样"被提到过"，
     validate 与全套单测两头全绿。症状是凭证失效推给用户一张空白语义的卡片，接口照旧回 errcode=0
   - 注入器那一半：HTML 上写着 `data-i18n-alt`，页面脚本的选择器打字错成别的名字。
     键还在语言包里、还在 HTML 里，validate 的反向照旧绿，症状是插图 alt 永远是裸键名
   - 事件从表里整行删掉、语言包两份同时删干净：`session-lost` 不再出现在微信标题表里。
     正向没有孤儿、反向没有死键，两头全绿；症状是掉线推送的标题退回成"关键词"那一类

   两处量出来仍然拦不住的，写在末尾的边界里，别再当成已覆盖：数字键的表把值改到
   **同族另一个真键**上（W14），以及短标签的**字数**越过微信预算（W20）。

   分工，别把同一条判据记两遍：
   - scripts/validate.mjs 管键在不在、占位符位数、两份语言包齐不齐。它看不见表里的键名
   - skip-trace.test.mjs 管理由集合与 ALARM_SKIP_REASONS 的**并集**（真跑 decideAlarmAction）
   - wechat-copy.test.mjs 管微信那一片文案的**字面内容**（冒号、条目数、示范同源），
     它不管字数预算，这一点是 W20 实测出来的
   - message-ledger.test.mjs 管消息载荷的键名与应答字段
   - 本文件只管**键名通道这一层**：通道里的每个名字都要真存在（正向），
     语言包里的每个键都要有一条真通道（反向），表的键与值要同族（配对），
     事件要三处齐平（覆盖），HTML 用到的属性后缀注入器要真处理（通道齐平）

   为什么扫源码而不 import 常量：判据要问的是"源码里有没有人递了个变量当键名"，
   import 进来的值看不出来；而且扫源码才能在**副本**上跑红→绿对照（第十四轮同样）。
   抽取器一律借来的，本文件不另写一份通道定义：通道那一层（哪些字面量算调用点、哪些是别名、
   manifest 与 HTML 那两条）从 validate-refs.mjs import 同一套正则，切声明体与表行那一层
   （`declarationBody` / `objectPairs` / `presetRows` / `rowLastStrings` / `stripComments`）
   从 tests/helpers/source-tables.mjs import，第十六轮那台机器读的是同一份。写第二份就会漂移，
   而"扫不到"在这套判据里的表现是不报错。
   反向判据刻意**先剔注释**再取证据：注释里写着的键名不是取用路径，把它当证据等于
   允许一条通道死掉而账上照旧绿（validate 那头按"提到过"算，是它的口径，不是这条）。
*/

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  htmlI18nKeys,
  i18nAliases,
  jsMessageKeys,
  manifestMsgKeys,
} from "../../scripts/validate-refs.mjs";
import {
  declarationBody,
  objectPairs,
  presetRows,
  rowLastStrings,
  stripComments,
} from "../helpers/source-tables.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = join(repoRoot, "tab-auto-refresh");

const read = (rel) => readFileSync(join(pluginRoot, rel), "utf8").replace(/\r\n/g, "\n");

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (/\.js$/.test(full)) out.push(full);
  }
  return out;
}

const jsRelPaths = walkJs(pluginRoot)
  .filter((p) => !p.includes(join("_locales")))
  .map((p) => relative(pluginRoot, p).split("\\").join("/"));

/* 逐行剔注释与表格切取五个原语一起搬到 `tests/helpers/source-tables.mjs`：
   第十六轮的预算账（`wechat-budget.test.mjs`）要从同一批表里取值，各写一份就会漂移，
   而"切少了"在这里的表现是不报错 */

const ZH = JSON.parse(read("_locales/zh_CN/messages.json"));
const EN = JSON.parse(read("_locales/en/messages.json"));
const LOCALE_KEYS = new Set([...Object.keys(ZH), ...Object.keys(EN)]);

const pascal = (s) =>
  String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/* 键名表的登记处。每一行都是"这张表里住的是文案键名"这一事实的声明：
   rel 是这张表的键与值之间**该成立**的名字关系，distinct 声明"两个槽不许用同一个值"，
   两者合起来是第 4 条判据（配对）。加一张表就要同时想清楚关系是什么——想不出来、
   或者发现关系松到什么都拦不住，就说明它不属于这里。
   完整性不靠这张表自觉：第 3 条判据要求语言包里每个键都有一条可达通道，
   新键只由一张没登记的表递出去时，它会从证据集里缺席并报红。那就是逼你回来的地方 */
const KEY_TABLES = [
  {
    file: "shared/logic.js",
    name: "ALARM_SKIP_REASONS",
    extract: objectPairs,
    distinct: true,
    rel: (label, key) => key === "skipReason" + pascal(label),
  },
  { file: "shared/logic.js", name: "ALARM_SKIP_UNKNOWN_KEY", extract: (d) => ({ entries: [{ label: "", key: d.scalar }], slots: 1 }) },
  {
    /* 唯一的 distinct 例外：40001 与 42001 是同一条提示（令牌失效，清缓存重取）。
       这张表的键是数字错误码，值与键之间没有任何命名可推，所以 rel 只能是族规则。
       代价实测过（W14）：把 40001 改成 wechatErrAppId，族规则过、反向也过——
       被弃用的 wechatErrToken 还挂在 42001 上，通道一条没少。这一类改动今天没有
       任何判据拦得住，它是本文件末尾那条边界，不是"已覆盖" */
    file: "shared/logic.js",
    name: "WECHAT_ERROR_KEYS",
    extract: objectPairs,
    rel: (label, key) => /^wechatErr/.test(key) && /^\d+$/.test(label),
  },
  {
    file: "shared/logic.js",
    name: "WEBHOOK_STATUS_BUCKETS",
    extract: rowLastStrings,
    distinct: true,
    rel: (label, key) => /^webhookErr/.test(key),
  },
  {
    file: "shared/config.js",
    name: "PRESETS",
    extract: presetRows,
    distinct: true,
    /* 预设的名字与时长必须自证：presetNN[smh] 里的数字换算成秒要等于 seconds。
       名字写成 preset1h 而 seconds 是 1800，用户按一小时建任务、实际每半小时刷一次 */
    rel: (label, key) => {
      const m = String(key).match(/^preset(\d+)([smh])$/);
      if (!m) return false;
      const unit = { s: 1, m: 60, h: 3600 }[m[2]];
      return Number(label) === Number(m[1]) * unit;
    },
  },
  {
    /* 标题表的值是短标签，中文 4~5 字、英文 6~7 字符（见 logic.js 的 20 字预算），
       所以事件名会被缩：task-stopped → wechatEvStoppedShort、session-lost → wechatEvSessionShort。
       名字关系推不出精确词干，能立住的是"同一族 + 两个事件不许共用一条标题" */
    file: "background.js",
    name: "WECHAT_EVENT_TITLE_KEYS",
    extract: objectPairs,
    distinct: true,
    rel: (label, key) => /^wechatEv/.test(key),
  },
  {
    file: "background.js",
    name: "WECHAT_BODY_KEYS",
    extract: objectPairs,
    distinct: true,
    rel: (label, key) => /^wechat(Body|Test)/.test(key),
  },
  {
    file: "popup.js",
    name: "WECHAT_FIELD_LABEL_KEYS",
    extract: objectPairs,
    distinct: true,
    rel: (label, key) => /^wechat/.test(key) && /Label$/.test(key),
  },
];

/* 属性值通道：属性名就叫 errorKey 的地方，值是一个文案键（可能裹在三元里）。
   投递回执的错误键从这里出发，弹窗只递变量（msg(webhookLast.errorKey)），
   所以 validate 的正向看不见它们 */
const PROP_CHANNELS = [{ prop: "errorKey", files: jsRelPaths }];

function tableContexts() {
  const out = [];
  for (const t of KEY_TABLES) {
    const src = stripComments(read(t.file));
    const decl = declarationBody(src, t.name);
    const { entries, slots } = t.extract(decl);
    for (const e of entries) out.push({ table: t.name, file: t.file, ...e });
    out.__slots = out.__slots || {};
    out.__slots[t.name] = { entries: entries.length, slots, rel: t.rel || null };
  }
  return out;
}

function propContexts() {
  const out = [];
  for (const ch of PROP_CHANNELS) {
    const re = new RegExp("\\b" + ch.prop + "\\s*:\\s*([^,\\n]*)", "g");
    for (const file of ch.files) {
      const src = stripComments(read(file));
      for (const m of src.matchAll(re)) {
        for (const lit of m[1].matchAll(/"([^"\n]*)"/g)) {
          out.push({ table: `${ch.prop}()`, file, key: lit[1] });
        }
      }
    }
  }
  return out;
}

function callSiteKeys() {
  const out = new Set();
  for (const file of jsRelPaths) {
    const src = stripComments(read(file));
    for (const key of jsMessageKeys(src)) out.add(key);
    for (const alias of i18nAliases(src)) for (const key of jsMessageKeys(src, alias)) out.add(key);
  }
  return out;
}

function htmlKeys() {
  const out = new Set();
  for (const name of ["popup.html", "wechat-setup.html"]) {
    for (const key of htmlI18nKeys(read(name))) out.add(key);
  }
  return out;
}

function manifestKeys() {
  const out = new Set();
  for (const { key } of manifestMsgKeys(JSON.parse(read("manifest.json")))) out.add(key);
  return out;
}

const TABLES = tableContexts();
const CONTEXTS = [...TABLES, ...propContexts()];
const CONTEXT_KEYS = new Set(CONTEXTS.map((c) => c.key));
const CALL_SITE = callSiteKeys();
const HTML = htmlKeys();
const MANIFEST = manifestKeys();
const EVIDENCE = new Set([...CALL_SITE, ...HTML, ...MANIFEST, ...CONTEXT_KEYS]);

/* ---------- 1. 抽取形状 ---------- */

test("每张登记的键名表都真的被抽到了东西，槽数与条目数一致", () => {
  const meta = TABLES.__slots;
  for (const t of KEY_TABLES) {
    const m = meta[t.name];
    assert.ok(m, `${t.name} 没被抽到`);
    assert.ok(m.entries > 0, `${t.name} 抽出 0 条 —— 抽取器空跑，本文件所有判据都会假绿`);
    assert.equal(
      m.entries,
      m.slots,
      `${t.name} 有 ${m.slots} 个值槽却只抽出 ${m.entries} 条：形状改了（值不再是字符串字面量？），` +
        `抽取器要跟着改，否则这条通道静默失守`
    );
  }
  assert.ok(CONTEXT_KEYS.size >= 30, `键名语境只认出 ${CONTEXT_KEYS.size} 个键，实测 41 个`);
});

/* ---------- 2. 正向 ---------- */

test("键名语境里的每个字面量都是两份语言包都有的键", () => {
  for (const c of CONTEXTS) {
    assert.ok(
      LOCALE_KEYS.has(c.key),
      `${c.file} 的 ${c.table} 把 "${c.key}" 当文案键用，但语言包里没有这个键` +
        `${/[^A-Za-z]/.test(c.key) ? "" : "（拼错或删漏：这个键名再没有别的地方递出去时反向判据也会红）"}`
    );
    assert.ok(
      c.key in ZH && c.key in EN,
      `${c.file} 的 ${c.table} 用的 ${c.key} 只在一份语言包里有`
    );
  }
});

/* ---------- 3. 反向 ---------- */

test("语言包里每个键都要有一条真通道：调用点字面量 / data-i18n / manifest / 登记的键名语境", () => {
  const missed = [...LOCALE_KEYS].filter((k) => !EVIDENCE.has(k));
  assert.deepEqual(
    missed,
    [],
    `${missed.length} 个键只被注释或裸字面量提到过，没有任何一条可达通道：` +
      `要么补登记（新通道就加进 KEY_TABLES / PROP_CHANNELS），要么删掉这条文案`
  );
  assert.ok(CALL_SITE.size >= 60, `调用点通道只认出 ${CALL_SITE.size} 个键，validate 那套抽取器可能没接上`);
  assert.ok(HTML.size >= 80, `data-i18n 通道只认出 ${HTML.size} 个键，实测 83 个`);
});

/* ---------- 4. 表键 ↔ 表值 ---------- */

test("每张表里键名与值之间的名字关系成立，登记了 distinct 的表不许两个槽共用一个值", () => {
  for (const t of KEY_TABLES) {
    const rows = TABLES.filter((x) => x.table === t.name);
    if (t.rel) {
      for (const c of rows) {
        assert.ok(
          t.rel(c.label, c.key),
          `${t.name} 里 "${c.label}" 对应的值 ${c.key} 不满足这张表的名字关系：` +
            `值改到另一个真键上时，拼写与存在性两头都拦不住，只有这条关系拦得住`
        );
      }
    }
    if (t.distinct) {
      const seen = new Map();
      for (const c of rows) {
        assert.ok(
          !seen.has(c.key),
          `${t.name} 的 "${seen.get(c.key)}" 与 "${c.label}" 共用 ${c.key}：` +
            `两件事显示同一句话，通常是其中一个的键名被改到了别家那一条上`
        );
        seen.set(c.key, c.label);
      }
    }
  }
  /* wechatErr 一族：每个错误码提示都要真的被某个码指到，否则那条文案永远发不出去 */
  const errReach = new Set([
    ...TABLES.filter((x) => x.table === "WECHAT_ERROR_KEYS").map((x) => x.key),
    ...propContexts().filter((x) => /^wechatErr/.test(x.key)).map((x) => x.key),
    ...CALL_SITE,
  ]);
  for (const k of LOCALE_KEYS) {
    if (!/^wechatErr/.test(k)) continue;
    assert.ok(errReach.has(k), `文案键 ${k} 属于微信错误码一族，但没有任何错误码指向它：发不出去的提示`);
  }
});

/* ---------- 5. 事件覆盖齐平 ---------- */

test("微信的标题表与正文表都要覆盖 NOTIFY_EVENTS，标题表另带 test", () => {
  const logic = stripComments(read("shared/logic.js"));
  const events = [...logic.matchAll(/export const NOTIFY_EVENTS = \[([^\]]*)\]/g)][0][1];
  const list = [...events.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
  assert.ok(list.length >= 4, "NOTIFY_EVENTS 没被抽到，本条判据空跑");
  const titleKeys = TABLES.filter((x) => x.table === "WECHAT_EVENT_TITLE_KEYS").map((x) => x.label);
  const bodyKeys = TABLES.filter((x) => x.table === "WECHAT_BODY_KEYS").map((x) => x.label);
  /* 正文那侧容许"在 buildWechatContent 里就地分支"的写法：keyword 与 task-paused 就是 */
  const inline = [...stripComments(read("background.js")).matchAll(/if\s*\(\s*event\s*===\s*"([^"\n]*)"\s*\)/g)].map((m) => m[1]);
  const covered = new Set([...bodyKeys, ...inline]);
  for (const ev of list) {
    assert.ok(titleKeys.includes(ev), `事件 ${ev} 在微信标题表里没有条目：推送标题会退回别的事件的文案`);
    assert.ok(covered.has(ev), `事件 ${ev} 在正文侧既没有表条目也没有就地分支：卡片会只有标题、正文空着`);
  }
  assert.deepEqual(
    titleKeys.filter((k) => !list.includes(k) && k !== "test").sort(),
    [],
    "标题表里出现了 NOTIFY_EVENTS 之外的事件名（且不是 test）"
  );
});

/* ---------- 6. 通道齐平 ---------- */

test("HTML 用到的 data-i18n* 属性后缀，页面脚本要有对应的注入器；反过来也不许留空选择器", () => {
  const pages = [
    ["popup.html", "popup.js"],
    ["wechat-setup.html", "wechat-setup.js"],
  ];
  for (const [html, js] of pages) {
    const used = new Set(
      [...read(html).matchAll(/data-i18n([a-z-]*)\s*=/g)].map((m) => "data-i18n" + m[1])
    );
    const handled = new Set(
      [...read(js).matchAll(/querySelectorAll\(\s*"\[(data-i18n[a-z-]*)\]"/g)].map((m) => m[1])
    );
    assert.ok(used.size >= 2, `${html} 只认出 ${used.size} 种属性后缀，抽取空跑`);
    assert.ok(handled.size >= 2, `${js} 只认出 ${handled.size} 个选择器，抽取空跑`);
    const unhandled = [...used].filter((a) => !handled.has(a));
    assert.deepEqual(
      unhandled,
      [],
      `${html} 用了 ${unhandled.join("、")} 却没有注入器处理：界面会露出裸键名或空 alt`
    );
    const unused = [...handled].filter((a) => !used.has(a));
    assert.deepEqual(
      unused,
      [],
      `${js} 的选择器 ${unused.join("、")} 在本页 HTML 里一个都没有：属性名两头写岔了一个字`
    );
  }
});

/* ---------- 7. 参照物：本文件说的就是 validate 看不见的那一半 ---------- */

test("对照 validate 的口径：调用点通道与语境通道各自只覆盖一部分，合起来才齐", () => {
  assert.ok(
    CONTEXT_KEYS.size >= 30,
    "登记的键名语境太少，说明本轮要堵的那个面没有真被记下来"
  );
  for (const k of CONTEXT_KEYS) assert.ok(LOCALE_KEYS.has(k));
  /* 语境通道里至少有一批键是调用点看不见的——这正是 validate 的正向盲区，
     如果哪天它们全被调用点覆盖了，这条判据红，提示这个文件可以删一半 */
  const onlyContext = [...CONTEXT_KEYS].filter((k) => !CALL_SITE.has(k) && !HTML.has(k) && !MANIFEST.has(k));
  assert.ok(
    onlyContext.length >= 25,
    `只有语境通道能取到的键只剩 ${onlyContext.length} 个（实测 35）：这条轴已经没什么可审的了`
  );
});

/* ================= 实测红→绿对照（第十五轮，仓库外整仓副本 D:/Github/_tar_ctl_r15） =================

   每个变异都在副本上跑两台机器：`node scripts/validate.mjs` 与仓库根那条全套单测命令。
   pre = 删掉本文件（等于本轮之前的世界），post = 留着本文件。基线 pristine：
   pre 518 全绿、post 525 全绿（W20 那次的 pre 另外红了 1 条 doc-anchors，是控制脚本的产物：
   那一遍跑的时候 AGENTS.md 已经在引用本文件，而 pre 把本文件删了，跟覆盖面无关）。
   判据编号 V1~V7 就是本文件七条 test 的次序。"看不见"= pre validate=OK 且 pre fail=0。

   变异                        pre                 post fail   本文件红在哪条
   W1  归桶表值拼错            红(孤儿) + 3 条       6           V2 V3 V7
   W2  理由表值拼错            红(孤儿) + 4 条       8           V2 V3 V4 V7
   W3  预设键拼错              红(孤儿) + 1 条       5           V2 V3 V4 V7
   W4  标题表值拼错            红(孤儿) + 1 条       4           V2 V3 V7
   W5  正文表值拼错            红(孤儿) + 1 条       4           V2 V3 V7
   W6  错误码表值拼错          看不见                2           V2 V7        ← 本轮净新增之一
   W7  兜底常量拼错            红(孤儿) + 4 条       7           V2 V3 V7
   W8  三元里的字面量拼错      红(孤儿) + 2 条       6           V2 V3 V4 V7
   W9  删掉一档预设            红(孤儿) + 3 条       4           V3
   W10 删掉标题表一行          红(孤儿) + 1 条       3           V3 V5
   W11 删掉 HTML 上的 alt      红(孤儿) + 1 条       2           V3
   W12 调用点字面量拼错        红(正向) + 2 条       3           V3
   W13 短标题改成 14 字        看不见                0           ——（样本没越过 20 字，不算对照）
   W14 错误码改到同族真键      看不见                0           —— 仍然拦不住，见下面边界第 1 条
   W15 预设改到另一档真键      红(孤儿) + 1 条       3           V3 V4
   W16 理由改到另一个真键      红(孤儿) + 4 条       6           V3 V4
   W17 标题改到另一个真键      红(孤儿) + 1 条       3           V3 V4
   W18 注入器选择器打字错      看不见                1           V6 两个方向各红一次  ← 净新增之二
   W19 事件整行删+语言包同删   看不见                1           V5        ← 净新增之三
   W20 短标题真越过 20 字      看不见                0           —— 仍然拦不住，见下面边界第 2 条

   三点从数字里读出来的话：
   - 净新增只有 W6 / W18 / W19 三条，其余十四条 pre 就被 validate 那句"这个键没有一处提到"
     挡住了。拼错的键名多半会让旧键成为孤儿，那是反向判据的射程；本文件真正多出来的，
     是"旧键不成为孤儿"的那三种现场
   - 十四条 overlap 全部保留，不是凑数：pre 挡住它们靠的是"旧键成孤儿"这一件事，
     而 W14 与 W20 恰恰证明"没有孤儿"时那一头就没了。同一条轴上两条判据各挡一半现场
   - W14 与 W20 都是先设想"这条一定拦得住"、实跑才发现拦不住。W13 最初那版样本
     只有 14 字，压根没越过预算，它的"看不见"是无效结论，重做的 W20 才算数

   四条边界，写清楚免得后来人以为这一层什么都管：
   1. 数字键的表（`WECHAT_ERROR_KEYS`）拦不住"值改到同族另一个真键上"：40001 与
      wechatErrAppId 之间没有任何命名可推，而被弃用的 wechatErrToken 还挂在 42001 上，
      反向也过。同一个形状在 PRESETS 上就拦得住（W15），因为那里键与值有名字关系可查
   2. 只管**名字**，不管**内容**：语言包那条文案本身长什么样、超没超微信那 20 字，
      本文件一个字都不看（W20）。第十六轮的账在 `wechat-budget.test.mjs`，它从本文件那批表里
      取键、去语言包取值，跑的是真 `wechatTitleOf`
   3. 值槽里放模板字符串、或把键拼出来（"skipReason" + pascal(reason)）的写法，抽取器
      会因槽数与条目数不等而红（V1），不会静默少收——但要记得这种写法本身等于新增一条
      通道，本文件不认它，改那种形状要连抽取器一起改
   4. 剔注释是逐行的，行尾注释不在射程内。本仓库没有"代码 + 行尾注释里带键名"的写法，
      出现时表现是把注释里的键名当证据（偏松），与 validate 反向判据同向
*/
