/* 第二十四轮审计（`BACKLOG.md` A42）的门禁：**人从弹窗之外起停任务**的那几条通道上，
   名字与数字被分在五处写，此前一处都没对过账：

   1. `manifest.json` 的 `commands` 键名与 `suggested_key`
   2. `background.js` 里 `onCommand` 比对的那个字符串
   3. `buildMenus()` 里 `create({ id, parentId })` 的菜单 id（一个是字面量、一个是拼出来的前缀）
      与 `onClicked` 里比对的那几处字面量（`=== "stop"`、`startsWith("start-")`、
      `slice("start-".length)` —— 同一个前缀在源码里出现三次）
   4. README 与 `AGENTS.md` 里那句"快捷键 `Alt+Shift+R`"
   5. `popup.html` 里那个 `min="30"`（`MIN_INTERVAL_SEC` 的第三份抄本：另两份是 `logic.js`
      的常量与它自己那句注释）

   这一片的静默形状全都一样：**改一头另一头一个字都不报错，只是那条入口从此不工作**。
   命令名两边对不上时 Chrome 照样把快捷键列在 `chrome://extensions/shortcuts` 里，按下去
   分发链早退；菜单前缀改一处，另一处解析出 NaN，`startTask` 收到一个 NaN 秒数；`min` 与
   兜底地板对不上时，"能填进去却被静默改写"就重新出现了（第十三轮为设置立的那本账同一形状）。

   五处一律**从真实源码现切**（manifest 走 `JSON.parse`，其余按花括号配对切监听器与
   `buildMenus` 的函数体），测试里不抄第二份名字清单。认不出的形状一律抛而不是跳过：
   这里"少切一条"的表现是判据安静地少覆盖一条通道。
   每条判据的比较都走一个纯函数（`commandLedger` / `docLedger` / `prefixLedger` /
   `floorLedger` / `coverageLedger`），所以文件末尾那三台常驻对照能拿改过的输入叫同一段代码
   再判一遍，而不是把判据抄第二遍。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stripComments, spanThrough, functionBody, declarationBody, presetRows } from "../helpers/source-tables.mjs";

/* 对照用：TAR_LOGIC 指另一份 logic.js（红→绿对照跑在仓库外的整仓副本上，CI 上不设） */
const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const LOGIC = await import(
  process.env.TAR_LOGIC
    ? pathToFileURL(process.env.TAR_LOGIC).href
    : new URL("../../tab-auto-refresh/shared/logic.js", import.meta.url).href
);
const { clampInterval } = LOGIC;

const BG_SRC = read("tab-auto-refresh/background.js");
const CONFIG_SRC = read("tab-auto-refresh/shared/config.js");
const POPUP_HTML = read("tab-auto-refresh/popup.html");
const LOGIC_TEXT = read("tab-auto-refresh/shared/logic.js");
const MANIFEST = JSON.parse(read("tab-auto-refresh/manifest.json"));

/* ---------- 一、五处各自切出来 ---------- */

/* 一个数值常量的字面量值：只认 `export const NAME = 数字;` 这一种形状，换写法就抛。
   不 import 模块再读它：要核对的是"HTML 抄的那个数字"与"源码写的那个数字"，
   import 过来只剩一个值，看不出它是常量还是算出来的 */
function numConst(text, name) {
  const m = text.match(new RegExp("export const " + name + "\\s*=\\s*(\\d+)\\s*;"));
  if (!m) throw new Error(`切不到 \`export const ${name} = 数字;\` 这个形状`);
  return Number(m[1]);
}

function braceInner(text, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(openIdx + 1, i);
  }
  throw new Error("花括号没配平");
}

/* 事件监听器：`chrome.<api>.<event>.addListener(async (x, y) => { … })` → 形参名与函数体。
   形参个数不假定：onCommand 递一个命令名，onClicked 递 (info, tab) */
function listener(src, apiEvent) {
  const s = stripComments(src);
  const head = apiEvent + ".addListener";
  const at = s.indexOf(head);
  if (at < 0) throw new Error(`源码里切不到 ${head}`);
  const args = spanThrough(s, s.indexOf("(", at + head.length) + 1).text;
  const m = args.match(/^\s*(?:async\s*)?\(\s*([^()]*)\)\s*=>\s*\{/);
  if (!m) throw new Error(`${apiEvent} 的监听器不是 (形参…) => {…} 这个形状：${args.slice(0, 40)}`);
  const params = m[1].split(",").map((t) => t.trim()).filter(Boolean);
  if (!params.length) throw new Error(`${apiEvent} 的监听器一个形参都没有`);
  for (const p of params) assert.match(p, /^[A-Za-z_$][\w$]*$/);
  return { params, body: braceInner(args, m[0].length - 1) };
}

/* manifest 的命令账：每条给出名字与 suggested_key */
function manifestCommands() {
  const cmds = MANIFEST.commands;
  if (!cmds || typeof cmds !== "object") throw new Error("manifest.json 里没有 commands 这一块");
  return Object.entries(cmds).map(([name, entry]) => {
    if (!entry || typeof entry.suggested_key !== "object" || entry.suggested_key === null) {
      throw new Error(`命令 ${name} 没有 suggested_key 对象——本文件要量的就是它`);
    }
    return { name, keys: entry.suggested_key };
  });
}

/* 菜单写侧：每一个 `chrome.contextMenus.create({ … })`，按源码次序带出 id / parentId */
function menuWrites(body) {
  const s = stripComments(body);
  const out = [];
  const re = /chrome\.contextMenus\.create\s*\(\s*\{/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const inner = spanThrough(s, m.index + m[0].length, "}").text;
    const cat = inner.match(/\bid:\s*"([^"\n]*)"\s*\+\s*([A-Za-z_$][\w$.[\]]*)/);
    const lit = cat ? null : inner.match(/\bid:\s*"([^"\n]*)"\s*,/);
    if (!cat && !lit) {
      throw new Error(`一个 contextMenus.create 的 id 既不是字面量也不是"前缀 + 表达式"：${inner.slice(0, 60)}`);
    }
    const parent = inner.match(/\bparentId:\s*"([^"\n]*)"/);
    out.push(cat
      ? { prefix: cat[1], expr: cat[2].trim(), parentId: parent ? parent[1] : null, at: m.index }
      : { literal: lit[1], parentId: parent ? parent[1] : null, at: m.index });
  }
  if (!out.length) throw new Error("切不到任何 contextMenus.create");
  return out;
}

/* 菜单读侧：onClicked 里对 menuItemId 做的那几处字面量比对 */
function menuReads(body, param) {
  const varM = body.match(new RegExp(
    "const\\s+(\\w+)\\s*=\\s*String\\(\\s*" + param + "\\.menuItemId\\s*\\)"));
  if (!varM) throw new Error(`读侧没把 String(${param}.menuItemId) 收进一个变量，认不出比对点`);
  const v = varM[1];
  const eq = [...body.matchAll(new RegExp(v + "\\s*===\\s*\"([^\"]*)\"", "g"))].map((m) => m[1]);
  const pfx = [...body.matchAll(new RegExp(v + "\\.startsWith\\(\\s*\"([^\"]*)\"\\s*\\)", "g"))].map((m) => m[1]);
  const cut = [...body.matchAll(new RegExp(v + "\\.slice\\(\\s*\"([^\"]*)\"\\.length\\s*\\)", "g"))].map((m) => m[1]);
  if (!eq.length && !pfx.length) throw new Error("读侧一条 id 判据都没切到");
  return {
    varName: v,
    equals: eq,
    prefixes: pfx,
    offsets: cut,
    numeric: new RegExp("Number\\(\\s*" + v + "\\.slice\\(").test(body),
  };
}

/* 弹窗那个自定义间隔框：type / min / step 三个属性一起看，min 单独存在可能根本没生效 */
function intervalInput(html) {
  const tag = html.match(/<input\b[^>]*\bid="customInput"[^>]*>/);
  if (!tag) throw new Error("popup.html 里切不到 #customInput 那个标签");
  const attr = (name) => {
    const m = tag[0].match(new RegExp("\\b" + name + "=\"([^\"]*)\""));
    return m ? m[1] : null;
  };
  return { type: attr("type"), min: attr("min"), step: attr("step") };
}

/* README / AGENTS / 源码注释里所有"组合键形状"的字符串 */
function combosIn(text) {
  return [...new Set([...text.matchAll(
    /\b(?:Ctrl|Alt|Shift|MacCtrl)(?:\+(?:Ctrl|Alt|Shift|MacCtrl|[A-Z0-9]|F(?:[1-9]|1[0-2])))+\b/g)].map((m) => m[0]))];
}

/* 命令名在分发链上被比对到的那些字面量：只认形参出现在比较位置上的，
   `console.warn("Command toggle-refresh failed")` 那种话不算判据 */
function handledCommands(body, param) {
  return [...body.matchAll(new RegExp(param + "\\s*[!=]==\\s*\"([^\"]*)\"", "g"))].map((m) => m[1]);
}

/* ---------- 二、判据本体（纯函数，常驻对照复用同一份） ---------- */

/* manifest 声明的命令名 ↔ 分发链比对的名字 */
function commandLedger(declared, handled) {
  const d = [...declared], h = [...new Set(handled)];
  return {
    notHandled: d.filter((x) => !h.includes(x)),
    notDeclared: h.filter((x) => !d.includes(x)),
    duplicated: handled.length !== h.length,
  };
}

/* 说明书与注释里写出的组合键 ↔ manifest 的 suggested_key。
   只认**提到"快捷键"那一行**里的组合键形状：README 里另有 `Ctrl+F5` 那种浏览器自带的按键
   （"忽略缓存"那一行），它不归 manifest 管，整篇扫会把正常句子判成漂移 */
function docLedger(declaredKeys, texts, proseTexts = []) {
  const problems = [];
  for (const [label, text] of texts) {
    for (const line of text.split("\n")) {
      if (!/快捷键|keyboard shortcut/i.test(line)) continue;
      for (const combo of combosIn(line)) {
        if (!declaredKeys.includes(combo)) {
          problems.push(`${label} 提到快捷键的那一行写着 "${combo}"，manifest 里没有这一条：${line.trim().slice(0, 50)}`);
        }
      }
    }
  }
  if (proseTexts.length) {
    const prose = proseTexts.join("\n");
    for (const key of new Set(declaredKeys)) {
      if (!prose.includes(key)) problems.push(`manifest 写着 "${key}"，README 与 AGENTS.md 都没提到它`);
    }
  }
  return problems;
}

/* 写侧前缀 ↔ 读侧 startsWith ↔ 读侧 slice(«前缀».length) */
function prefixLedger(built, prefixes, offsets) {
  const problems = [];
  if (prefixes.length !== 1) problems.push(`读侧的 startsWith 前缀有 ${prefixes.length} 条，本文件按一条写`);
  if (offsets.length !== 1) problems.push(`读侧切秒数的前缀有 ${offsets.length} 处，本文件按一处写`);
  if (prefixes[0] !== built) problems.push(`写侧拼 "${built}" 而读侧认 "${prefixes[0]}"`);
  if (offsets[0] !== built) problems.push(`切秒数用 "${offsets[0]}".length，与写侧的 "${built}" 不是同一个`);
  return problems;
}

/* 造出来的菜单项 ↔ 分发链认得的项 */
function coverageLedger(writes, reads) {
  const literal = writes.filter((w) => w.literal !== undefined).map((w) => w.literal);
  const prefixes = writes.filter((w) => w.prefix !== undefined).map((w) => w.prefix);
  const containers = new Set(writes.map((w) => w.parentId).filter(Boolean));
  const covered = (id) => reads.equals.includes(id) || reads.prefixes.some((p) => id.startsWith(p));
  return {
    /* 正向：读侧比对的每个字面量都要造得出来 */
    unreachable: reads.equals.filter((lit) => !literal.includes(lit)),
    deadPrefixes: reads.prefixes.filter((p) => ![...literal, ...prefixes].some((t) => t.startsWith(p))),
    /* 反向：造得出来的每个可点项都要被读侧认（父项只当容器，Chrome 不派发它） */
    uncovered: [...literal, ...prefixes].filter((id) => !covered(id) && !containers.has(id)),
    containers: [...containers],
  };
}

/* HTML 的 min ↔ clampInterval 的地板 */
function floorLedger(min, floor) {
  const problems = [];
  if (min === null) problems.push("#customInput 没有 min 属性");
  else if (Number(min) !== floor) {
    problems.push(Number(min) > floor
      ? `min="${min}" 比地板 ${floor} 严：代码允许的间隔填不进去`
      : `min="${min}" 比地板 ${floor} 宽：填进去会被 clampInterval 静默改写`);
  }
  return problems;
}

/* ---------- 三、真源码上的五本账 ---------- */

const COMMANDS = manifestCommands();
const CMD_HANDLED = listener(BG_SRC, "chrome.commands.onCommand");
const MENU_CLICKED = listener(BG_SRC, "chrome.contextMenus.onClicked");
const BUILDMENUS = functionBody(BG_SRC, "buildMenus");
const WRITES = menuWrites(BUILDMENUS);
const READS = menuReads(MENU_CLICKED.body, MENU_CLICKED.params[0]);
const PRESETS = presetRows(declarationBody(CONFIG_SRC, "PRESETS"));
const FLOOR = numConst(LOGIC_TEXT, "MIN_INTERVAL_SEC");
const INPUT = intervalInput(POPUP_HTML);
const DECLARED_KEYS = COMMANDS.flatMap((c) => Object.entries(c.keys).map(([p, v]) => ({ platform: p, combo: v })));

/* ---------- 四、抽取形状：每本账都得有量 ---------- */

test("抽取形状：五处各自的条数下限，且切出来的东西像个名字", () => {
  assert.ok(COMMANDS.length >= 1, "manifest 里一条命令都没切到");
  assert.equal(PRESETS.slots, PRESETS.entries.length, "PRESETS 有行没被切成条目");
  assert.ok(PRESETS.entries.length >= 5, `预设只剩 ${PRESETS.entries.length} 条，抽取退化了`);
  /* 三处 create 站点：根、预设那一族、停止。造出来的**项数**是另一本账——那一族在
     `for (const p of PRESETS)` 里，一项变 N 项。今天三处站点造出 1 + 7 + 1 = 9 项；
     出现第四处站点时本文件要回来看一遍它归谁覆盖 */
  assert.equal(WRITES.length, 3, `菜单写侧有 ${WRITES.length} 处 create，本文件按"根 + 预设那一族 + 停止"三处写`);
  assert.ok(READS.equals.length + READS.prefixes.length >= 2, "菜单读侧判据少于两条");
  assert.ok(FLOOR >= 1, "地板常量切成了 0");
  assert.ok(DECLARED_KEYS.length >= 1, "一条 suggested_key 都没切到");
  for (const c of COMMANDS) assert.match(c.name, /^[a-z][\w-]*$/, `命令名 ${c.name} 不像个命令名`);
  for (const w of WRITES) {
    if (w.prefix !== undefined) {
      assert.match(w.prefix, /^[A-Za-z][\w-]*[-_]$/, `拼接前缀 "${w.prefix}" 结尾没有分隔符，会和秒数粘在一起`);
    } else assert.ok(w.literal && /^[A-Za-z][\w-]*$/.test(w.literal), `菜单 id "${w.literal}" 不像个 id`);
  }
});

test("认不出来的形状要抛，不许静默少切一条", () => {
  assert.throws(() => listener("chrome.commands.onCommand.addListener(function (c) {});", "chrome.commands.onCommand"),
    /形参…/);
  assert.throws(() => listener("chrome.commands.onCommand.nothing();", "chrome.commands.onCommand"), /切不到/);
  assert.throws(() => menuWrites('chrome.contextMenus.create({ id: someVar, contexts: ["tab"] });'), /既不是字面量/);
  assert.throws(() => menuWrites('chrome.contextMenus.create({ title: "x" });'), /既不是字面量/);
  assert.throws(() => menuReads('const id = info.menuItemId; if (id === "stop") {}', "info"), /String\(/);
  assert.throws(() => numConst("const MIN_INTERVAL_SEC = 30;", "MIN_INTERVAL_SEC"), /切不到/);
  assert.throws(() => intervalInput("<input id=\"other\" type=\"number\">"), /customInput/);
});

/* ---------- 五、两头判据 ---------- */

test("命令名两头齐平：manifest 每条都要被比对，比对的每条都要在 manifest 里", () => {
  const ledger = commandLedger(COMMANDS.map((c) => c.name), handledCommands(CMD_HANDLED.body, CMD_HANDLED.params[0]));
  assert.ok(!ledger.duplicated, "同一个命令名在分发链上被比对多次：大概有两处在抢同一条命令");
  assert.deepEqual(ledger, { notHandled: [], notDeclared: [], duplicated: false },
    "manifest 的 commands 与 onCommand 里比对的字面量不齐平——对不上的那一头按下去什么都不发生，" +
    "而 Chrome 的快捷键设置页照样把这条列出来");
});

test("suggested_key 的形状：平台后缀合法、修饰键齐、主键只有一个", () => {
  /* Chrome 认的平台后缀与"修饰键 + 一个主键"的形状，抄自官方 commands 文档；
     仓库里不再抄第二份清单，所以这张小表是本文件唯一的外部事实 */
  const PLATFORMS = new Set(["default", "_linux", "_mac", "_windows"]);
  const MODS = new Set(["Ctrl", "Alt", "Shift", "MacCtrl"]);
  for (const c of COMMANDS) {
    const entries = Object.entries(c.keys);
    assert.ok(entries.length >= 1, `${c.name} 的 suggested_key 是空的`);
    assert.ok(entries.some(([p]) => p === "default"), `${c.name} 没有 default，说明书就没有可对齐的那一头`);
    for (const [platform, combo] of entries) {
      assert.ok(PLATFORMS.has(platform), `${c.name} 的 suggested_key 出现了不认得的后缀 ${platform}`);
      const parts = String(combo).split("+");
      assert.ok(parts.length >= 2, `${c.name} 的 ${platform} 只有 "${combo}"：没有修饰键的组合会吃掉用户打字`);
      assert.match(parts[parts.length - 1], /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/,
        `${c.name} 的 ${platform} 主键不像一个键：${parts[parts.length - 1]}`);
      for (const mod of parts.slice(0, -1)) {
        assert.ok(MODS.has(mod), `${c.name} 的 ${platform} 里 "${mod}" 不是修饰键`);
      }
    }
  }
});

test("说明书与注释里的组合键就是 manifest 那一条，manifest 那一条也被写了出来", () => {
  const keys = DECLARED_KEYS.map((k) => k.combo);
  const problems = docLedger(keys,
    [["README.md", read("README.md")], ["AGENTS.md", read("AGENTS.md")], ["background.js 的注释", BG_SRC]],
    [read("README.md"), read("AGENTS.md")]);
  assert.deepEqual(problems, [], "快捷键这个名字漂了：用户照说明书按，按到的是别的功能或什么都没有");
  /* 反面：README"忽略缓存"那一行写的是浏览器自带的 Ctrl+F5，不归 manifest 管。
     整篇扫会把这句正常的话判成漂移——这是本判据按"提到快捷键的那一行"收窄的理由（实测过一遍） */
  assert.deepEqual(docLedger(["Alt+Shift+R"], [["README.md", "- 忽略缓存：可选 Ctrl+F5 强制刷新（默认开启）"]]), [],
    "浏览器自带按键被当成了本插件的快捷键");
});

test("菜单 id 两头：读侧比对的都造得出来，造得出的可点项读侧都认", () => {
  const ledger = coverageLedger(WRITES, READS);
  assert.deepEqual(ledger.unreachable, [],
    "onClicked 比对着一个 buildMenus 造不出来的 id：那条分支永远走不到，菜单点了没反应");
  assert.deepEqual(ledger.deadPrefixes, [],
    "onClicked 用 startsWith 认一个写侧不存在的前缀：整族菜单项落空");
  assert.deepEqual(ledger.uncovered, [],
    "这些菜单项造得出来、点下去分发链一条都不认（父项只当容器，不算在这里）");
  assert.deepEqual(ledger.containers.sort(), ["root"], "容器项的集合变了要回来看这条判据");
});

test("前缀字面量三处齐平：拼的那一处、startsWith 那一处、slice(«前缀».length) 那一处", () => {
  const built = WRITES.filter((w) => w.prefix !== undefined);
  assert.equal(built.length, 1, `拼出来的菜单 id 有 ${built.length} 处，本文件按一处写`);
  assert.deepEqual(prefixLedger(built[0].prefix, READS.prefixes, READS.offsets), [],
    "同一个前缀在源码里三处各写一份，改一漏两之后菜单项与解析就不认识彼此了");
  assert.equal(READS.numeric, true,
    `${READS.varName}.slice(...) 没被 Number() 包着：字符串秒数会一路传到 startTask`);
});

test("parentId 引用的 id 必须真被建出来，而且建在子项之前", () => {
  for (const w of WRITES) {
    if (w.parentId === null) continue;
    const parent = WRITES.find((o) => o.literal === w.parentId);
    assert.ok(parent, `一个菜单项挂在 "${w.parentId}" 之下，而这个名字从没被 create 过`);
    assert.ok(parent.at < w.at, `"${w.parentId}" 要排在它的子项之前建出来，Chrome 才认这个父子关系`);
  }
});

/* ---------- 六、一整趟往返：预设 → 菜单 id → 反解 → 兜底 ---------- */

test("每条预设都真变成一个菜单项，点它拿到的秒数就是它写的那个秒数", () => {
  const [prefixed] = WRITES.filter((w) => w.prefix !== undefined);
  assert.match(prefixed.expr, /^p\.seconds$/, `id 拼的是 ${prefixed.expr}，不是预设的秒数`);
  const loop = BUILDMENUS.match(/for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\s*\)/);
  assert.ok(loop, "buildMenus 里没有 `for (const p of …)` 这一形");
  assert.equal(loop[2], "PRESETS", `菜单遍历的是 ${loop[2]}，不是共享的 PRESETS 表`);
  assert.equal(loop[1], prefixed.expr.split(".")[0], "循环变量与 id 拼接用的变量不是同一个");

  for (const row of PRESETS.entries) {
    const seconds = Number(row.label);
    const id = prefixed.prefix + seconds;
    const back = Number(id.slice(READS.offsets[0].length));
    assert.equal(back, seconds, `菜单 id "${id}" 反解出 ${back}`);
    assert.deepEqual(clampInterval(back), { seconds, clamped: false },
      `预设 ${seconds} 秒过一遍兜底变成别的数：菜单上写的与真挂上的不是同一个间隔`);
  }
});

test("弹窗自定义间隔框的 min 就是代码的地板，不多不少", () => {
  assert.equal(INPUT.type, "number", `#customInput 是 type="${INPUT.type}"，min 属性对它没意义`);
  assert.equal(INPUT.step, "1", `#customInput 的 step 是 "${INPUT.step}"：秒数不该按别的步长跳`);
  assert.deepEqual(floorLedger(INPUT.min, FLOOR), [],
    "HTML 的 min 与 clampInterval 的地板对不上（第三份抄本与源码那份分家了）");
  assert.ok(PRESETS.entries.every((r) => Number(r.label) >= FLOOR),
    "有预设的秒数低于地板：那一条菜单项的标签与实际间隔不一样");
});

/* ---------- 七、常驻对照：判据自己红得出来 ---------- */

test("对照常驻：只改 manifest 那一头，命令名与说明书两条都红", () => {
  const renamed = "toggleRefresh";
  const handled = handledCommands(CMD_HANDLED.body, CMD_HANDLED.params[0]);
  const ledger = commandLedger([renamed], handled);
  assert.deepEqual(ledger.notHandled, [renamed], "只改 manifest 时正向没红");
  assert.deepEqual(ledger.notDeclared, ["toggle-refresh"], "只改 manifest 时反向没红");
  assert.deepEqual(commandLedger(["toggle-refresh"], handled),
    { notHandled: [], notDeclared: [], duplicated: false }, "判据恒红了");
  /* 组合键那一头：换成说明书里没有的写法 */
  assert.ok(docLedger(["Ctrl+Alt+Q"], [["README.md", read("README.md")]], [read("README.md")]).length >= 1,
    "manifest 改了组合键而说明书没跟上时，那条判据没红");
  assert.deepEqual(docLedger(["Alt+Shift+R"], [["README.md", read("README.md")]], [read("README.md")]), [],
    "对照恒红：说明书那条判据认不出真值");
});

test("对照常驻：读侧前缀改一个字，前缀与覆盖两条都红", () => {
  const problems = prefixLedger("start-", ["start_"], ["start_"]);
  assert.equal(problems.length, 2, `只改读侧前缀时齐平那条只红出 ${problems.length} 处`);
  const moved = { ...READS, prefixes: ["start_"], offsets: ["start_"] };
  const ledger = coverageLedger(WRITES, moved);
  assert.deepEqual(ledger.deadPrefixes, ["start_"], "改完前缀仍说这个前缀有货");
  assert.deepEqual(ledger.uncovered, ["start-"], "改完前缀仍说这一族菜单项被覆盖着");
  assert.deepEqual(coverageLedger(WRITES, READS).deadPrefixes, [], "对照恒红");
});

test("对照常驻：min 改宽改窄都要红，且红的是一句说得出后果的话", () => {
  assert.deepEqual(floorLedger(String(FLOOR), FLOOR), [], "对照恒红：真值本身被判坏了");
  assert.equal(floorLedger("60", FLOOR).length, 1, "min 改宽没红：代码允许的间隔填不进去也没人管");
  assert.match(floorLedger("60", FLOOR)[0], /填不进去/);
  assert.equal(floorLedger("10", FLOOR).length, 1, "min 改窄没红：填进去会被静默改写也没人管");
  assert.match(floorLedger("10", FLOOR)[0], /静默改写/);
  assert.equal(floorLedger(null, FLOOR).length, 1, "min 整个没了也不红");
});

/* ---------- 八、实测：改坏了到底谁红（红→绿对照表） ----------

   跑法：仓库外整仓副本（脚本与日志在 `D:/Github/_tar_ctl_r24/ctl24.mjs` / `ctl24.log`）。
   pre = 副本里删掉本文件（这本账是本轮新建的），post = 带着本文件；两侧都跑 validate + 全套。
   每台变异开跑前先逐台量 needle 在 pristine 里恰好命中一次。

   表在下面。K0 是 pristine，两侧都零红——这一行不等于"什么都没改"，它证明的是那三条
   常驻对照不在真源码上恒红。

   | 台 | 改法（只改一处） | pre（没有本门禁） | post 本门禁红 |
   | --- | --- | --- | --- |
   | K0 | 不改 | 全套零红 | 零（判据不恒红） |
   | B1 | manifest 的 `commands` 键名改成 `toggleRefresh` | **全套零红** | 命令名两头齐平 |
   | B2 | `background.js` 比对的那个字符串改成 `toggleRefresh` | 红 3 条：快捷键那三条行为用例 | 命令名两头齐平、对照常驻：只改 manifest |
   | B3 | manifest 的 `suggested_key.default` 改成 `Ctrl+Alt+Q` | **全套零红** | 说明书与注释里的组合键 |
   | B4 | 读侧 `id.startsWith("start-")` 改成 `"start_"` | 红 2 条：右键「开始 1 分钟」、持锁必经点 | 菜单 id 两头、前缀三处齐平、对照常驻：读侧前缀 |
   | B5 | 写侧 `"start-" + p.seconds` 改成 `"start_"` | 红 1 条：安装时建出预设菜单 | 菜单 id 两头、前缀三处齐平、对照常驻：读侧前缀 |
   | B6 | 只改第三份抄本：`id.slice("start-".length)` → `slice("start".length)` | 红 1 条：右键「开始 1 分钟」（秒数成了 NaN） | 前缀三处齐平、每条预设往返 |
   | B7 | 根项 `id: "root"` 改成 `"roots"`（子项的 `parentId` 悬空） | 红 1 条：安装时建出预设菜单 | 菜单 id 两头、parentId 悬空、对照常驻：读侧前缀 |
   | B8 | `popup.html` 的 `min="30"` 改成 `"60"` | **全套零红** | 弹窗 min 那条（红在"填不进去"那句） |
   | B9 | 同上改成 `"10"` | **全套零红** | 同一条（红在"静默改写"那句） |
   | B10 | 同上把 `type="number"` 改成 `"text"`（min 从此不生效） | **全套零红** | 同一条（红在 `INPUT.type` 那句） |
   | B11 | 只有 README 那一行改成 `Ctrl+Alt+Q`（manifest 不动） | **全套零红** | 说明书与注释里的组合键、对照常驻：只改 manifest |
   | B12 | 预设表里 30 秒那一档改成 10 | 红 5 条（README 档位序列、菜单条数、i18n 名字关系、config 顺序与地板、弹窗下拉） | 每条预设往返、弹窗 min 那条 |

   怎么读这张表：**六台改前全套零红**（B1、B3、B8、B9、B10、B11），六台改前已有行为用例先撞上
   （B2、B4、B5、B6、B7、B12）。前六台就是本轮的净账：改完之后菜单照常建出来、快捷键照常列在
   `chrome://extensions/shortcuts` 里、弹窗照常能填数，只是那一条入口从此不工作或静默改写用户填的值。
   后六台不是"本轮白做"：行为用例红的是"这条链路跑不通"，本门禁红的是"这几处写的不是同一个名字"——
   后者点名点到那一处字面量，而前者只会说"任务没建出来"。B6 是这一层差别最干净的一台：
   三处抄本里只改第三处，链路上只留下一个 NaN。

   两处要说明，别当成噪声：
   - B2、B4、B7、B11 各带一条**常驻对照**的红。那三条对照的参照物是真源码现切的那份现场
     （`assert.deepEqual(coverageLedger(WRITES, READS).deadPrefixes, [], "对照恒红")` 那一类），
     所以改到它参照的那处真值时对照自己会跟着红。这恰好证明三条对照不是空跑：K0 那一行两侧零红
     是它们成立的时候，这几行红是它们不成立的时候
   - B12 一台改前就红 5 条：预设表这一头是全仓库覆盖最厚的一片（README 的档位序列由 `doc-numbers` 钉、
     顺序与地板由 config 自己的用例钉）。本门禁在这台上的增量只有"低于地板的那一档要红"这半句

   刻意留下的边界：
   1. 命令名那本账只认 `onCommand` 里**比对形参**的字面量（`command !== "…"` 这种形状）。
      `chrome.commands.getAll()` 读到的运行时值、以及真机上用户自己把组合键改掉，都不在这根账上——
      这里量的是"仓库里这几处写的是不是同一个"
   2. 组合键只扫**提到"快捷键"的那一行**。README"忽略缓存"那一行写的是浏览器自带的 `Ctrl+F5`，
      整篇扫会把那句正常的话判成漂移（这条实测过，写法就收窄在这里）。因此别处提一句
      "按 Ctrl+Shift+X"之类不归 manifest 管的话，本文件看不见
   3. `suggested_key` 的平台后缀表与"修饰键 + 一个主键"的形状抄自官方 commands 文档，
      是本文件唯一的外部事实；Chrome 加新后缀要回来改那张小表。真机上这个组合键会不会与浏览器
      或系统撞键，是 V1 那一头的事
   4. 菜单写侧按**三处 create 站点**记账，不是按"今天造出 9 个项"。预设那一族在 `for` 循环里，
      一项变 N 项不影响站点数；出现第四处站点时条数下限那条会红，红完要回来判它归谁覆盖
   5. HTML 那一头只认 `#customInput` 一个标签的 `type`/`min`/`step`。别的控件是 `settings-map`
      与 `popup-repopulate` 的账，版面尺寸是 `screenshot-popup.mjs --measure` 的账
   6. 预设 → 菜单 id → 反解 → 兜底这一趟跑的是真 `clampInterval`，量的是"菜单上写的秒数与真挂上的
      是不是同一个"；这七档**该不该是这七档**不在账上 */
