/* 第十七轮审计（A35）：存储这本账。审的是**状态落在哪个区、键叫什么名字**，与项目记忆里
   `### 存储` 那三段清单两头对账。

   为什么这根轴是空的：`AGENTS.md` 把"要活过 SW 回收放 session、要活过浏览器重启才放 local"
   写成了判断标准，把每个键的名字逐个列在清单里，是这一层唯一的说明书；而全套门禁里没有一条
   问过"源码此刻到底在读写哪些键"。`permission-map` 管 API 要哪一项权限，`settings-map` 管
   `settings` 那一个键的五段，`rt-lifecycle` 管 `rtRoundKeys` 里放哪几族**以及清不清得干净**
   ——三条都从各自的切面看存储，没有一条看这本账本身。
   实测（仓库外整仓副本，下表 C1~C13 的 pre 那一列）：在 `background.js` 新增一笔
   `local.set({ auditNote: … })` 并在文档里只字不提，`validate.mjs` 与其余 534 条一条不红；
   把文档 `### 存储` 里 `webhookLastResult` 那一整项删掉，同样全绿。两个方向都是**安静的**：
   键进错区不会崩，
   只会让状态在没人预期的时刻活着或消失（`rt:` 那几族搬去 local 就是 A17 那一类"阈值被悄悄
   调低"，`settings` 搬去 session 就是 SW 一回收设置全丢），而文档少一行没有任何症状，
   直到下一个人照着它改代码。

   形状：调用点、常量表、函数体全按文本切真实源码，不 import 任何模块——键名住在
   `background.js`，import 它要先造一整套 chrome 桩件，而桩件喂进来的键集合本身就是抄本。
   唯一的执行是把**表达式体的箭头函数**（`rtTab`、`rtRoundKeys` 这类）按它自己的源码 `new Function`
   起来求值（见 `callable`），函数体形状的（`rt()` 那类）一律不碰；`background.js` 一个字节都没跑。
   调用点的实参整段从 `tests/helpers/source-tables.mjs` 的 `storageCalls` 取（第十七轮的探针
   第一版用 `[^)]*` 切实参，凡自己带括号的都少切一截，键集合因此看着比实际大）。

   与相邻门禁的分工：
   - `rt-lifecycle.test.mjs` 管"任务生命周期里这几族会不会残留"，它比的是**用例自己抄的**四个
     族名与 `rtRoundKeys` 的展开；本文件管"这一族在文档里登记了没有、整个存储面有没有盲区"，
     两边键名字面量一份都不抄
   - `settings-map.test.mjs` 管 `settings` 那一个键的值域五段；本文件只管"它存在、在哪个区"
   - `permission-map.test.mjs` 管 `chrome.storage.*` 这一项权限有没有；不数键
   - `doc-anchors` 与 `doc-numbers` 管文档里的**名字与数字**对不对得上源码；键清单不在射程内
     （实测：删掉文档里一个键名，两条判据一条都不红，因为那个名字在别处还被提及）

   动态段一律归一成 `前缀:<*>`，与文档里的 `cookieBackup:<host>` / `rt:error:<tabId>` 对齐：
   解析时把运行时值换成 `DYN` 记号，归一化只认"整段出现在冒号之后"这一种形状，别的位置出现
   就抛。实跑红→绿对照与六条边界记在文件末尾。 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, storageCalls, spanThrough, functionBody } from "../helpers/source-tables.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = join(repoRoot, "tab-auto-refresh");
const ZONES = ["local", "session", "sync"];

/* 运行时值的占位量：`COOKIE_BACKUP_PREFIX + host` 这类"前缀 + 变量"解析出来带它 */
const DYN = "\u0000dyn";

/* ---------- 一、读文件：插件里每一个 JS 文件都在账内 ---------- */

const jsFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".js")) jsFiles.push(relative(pluginRoot, p).split(sep).join("/"));
  }
})(pluginRoot);
jsFiles.sort();
assert.ok(jsFiles.length >= 5, `插件 JS 文件只数到 ${jsFiles.length} 个，遍历面不对`);

const SRC = {};
for (const f of jsFiles) {
  SRC[f] = stripComments(readFileSync(join(pluginRoot, f), "utf8").replace(/\r\n/g, "\n"));
}

/* ---------- 二、顶层符号表：常量与"表达式体函数" ----------
   全插件合并一张表：键名常量确实跨文件（`SKIP_RT_PREFIX` 住在 `shared/config.js`，
   `background.js` 与 `popup.js` 都拿它拼键）。同名而值不同直接抛，不偷偷覆盖——
   两份同名的键常量就是两根通道，本文件会只认其中一根。 */

const CONST = new Map();
const FNS = new Map();
const PENDING = []; // 顶层 `const NAME = 另一个常量;`：值要等表建起来才解得出（RT_SKIP = SKIP_RT_PREFIX）

function topLevelFns(s) {
  const out = [];
  for (const m of s.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    out.push({ name: m[1], at: m.index });
  }
  for (const m of s.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*=>\s*\{/gm)) {
    out.push({ name: m[1], at: m.index });
  }
  return out.sort((a, b) => a.at - b.at);
}

const FN_DECL = new Map(); // name → { params, expr, file }

for (const [f, s] of Object.entries(SRC)) {
  for (const m of s.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+);$/gm)) {
    const name = m[1];
    const rhs = m[2].trim();
    const arrow = rhs.match(/^(?:async\s+)?\(([^)]*)\)\s*=>\s*(.+)$/) || rhs.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*(.+)$/);
    if (arrow && !/[{;]/.test(arrow[2])) {
      FN_DECL.set(name, { params: (arrow[1] || "").split(",").map((x) => x.trim()).filter(Boolean), expr: arrow[2], file: f });
      continue;
    }
    const lit = rhs.match(/^"([^"\n]*)"$/);
    if (lit) {
      if (CONST.has(name) && CONST.get(name) !== lit[1]) {
        throw new Error(`同名常量不同值：${name}（${f}）——键名解析不许有两份真相`);
      }
      CONST.set(name, lit[1]);
      continue;
    }
    if (!/[([.]/.test(rhs[0])) PENDING.push({ name, rhs, file: f });
  }
}

/* ---------- 三、表达式解析：认得的形状一条条列出来，认不得的返回 null ----------
   返回 { value, route }；value 是字符串（可能含 DYN），route 用于"每条通道都要至少命中一次"
   那条判据——加一条通道而它一次也没命中，等于本文件多了一套没人走的解析器而照样全绿。 */

const ROUTES = new Set();
let recording = true; /* 建表阶段的命中不算「通道被走到了」 */
const hit = (r) => {
  if (recording) ROUTES.add(r);
};

function topSplit(text, isSep) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === "\\") cur += text[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth === 0 && isSep(c)) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function asLiteral(expr) {
  const m = expr.match(/^"([^"\n]*)"$/);
  return m ? m[1] : null;
}

/* 表达式里出现的自由名字：跳过属性访问、嵌套箭头自己的入参、字符串内部 */
function freeNames(expr) {
  const src = expr.replace(/\.\.\./g, " "); /* 展开写法别当成属性访问：`...rtRoundKeys(tabId)` 里的名字是自由名字 */
  const nested = new Set();
  for (const m of src.matchAll(/(\(([^()]*)\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
    for (const p of (m[1].replace(/[()]/g, "") || "").split(",")) if (p.trim()) nested.add(p.trim());
  }
  const out = new Set();
  const re = /"([^"\n]*)"|\.([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1] !== undefined || m[2] !== undefined) continue;
    if (!nested.has(m[3])) out.add(m[3]);
  }
  return [...out];
}

const BANNED = /\b(Date|Math|JSON|Object|Array|process|require|import|globalThis|chrome|window|self|eval|Function|setTimeout|setInterval|Promise|String|Number|Boolean)\b/;

function callable(name, seen = new Set()) {
  const decl = FNS.get(name);
  if (!decl) return null;
  if (seen.has(name)) throw new Error(`函数 ${name} 自引用，解析不了`);
  if (decl.built) return decl.built;
  const { params, expr } = decl;
  if (BANNED.test(expr) || /`/.test(expr) || /[{};]/.test(expr) || /=(?![>=])/.test(expr.replace(/=>/g, ""))) return null;
  const bound = [];
  const vals = [];
  for (const n of freeNames(expr)) {
    if (params.includes(n) || bound.includes(n)) continue;
    if (CONST.has(n)) { bound.push(n); vals.push(CONST.get(n)); continue; }
    if (FNS.has(n)) {
      const inner = callable(n, new Set([...seen, name]));
      if (!inner) return null;
      bound.push(n);
      vals.push(inner);
      continue;
    }
    return null; /* 有名字供不上：交给 new Function 抛 ReferenceError，由调用方收回 */
  }
  const fn = new Function(...params, ...bound, "return (" + expr + ");");
  const wrapped = (...args) => fn(...args.slice(0, params.length), ...vals);
  decl.built = wrapped;
  return wrapped;
}

const normalizeDecl = () => {
  for (const [name, decl] of FN_DECL) if (!FNS.has(name)) FNS.set(name, decl);
  /* 别名常量要等表建起来才解得出（RT_SKIP = SKIP_RT_PREFIX，值在另一个文件）。
     一轮只推进一层。解不出来的（数字、时长、乘积式）本来就一辈子解不出来，安静留下——
     真键名的别名解不出来时，用它的调用点会变成"未定且没登记"，由第一条判据点名 */
  let left = PENDING.slice();
  recording = false;
  for (let pass = 0; left.length; pass++) {
    const still = [];
    for (const p of left) {
      const r = resolve(p.rhs, null);
      if (r && r.values) CONST.set(p.name, r.values[0]);
      else if (r && typeof r.value === "string") {
        if (CONST.has(p.name) && CONST.get(p.name) !== r.value) {
          throw new Error(`同名常量不同值：${p.name}（${p.file}）——键名解析不许有两份真相`);
        }
        CONST.set(p.name, r.value);
      } else still.push(p);
    }
    if (still.length === left.length) break;
    left = still;
  }
  recording = true;
};

/* 求值到"字符串 / 字符串数组"层面：拿不到就 null */
function resolve(rawExpr, scope) {
  const expr = (rawExpr || "").trim();
  if (!expr) return null;
  const lit = asLiteral(expr);
  if (lit !== null) { hit("字面量"); return { value: lit }; }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const n = expr;
    if (scope && scope.has(n)) { hit("同函数内的 const"); return { value: scope.get(n) }; }
    if (CONST.has(n)) {
      /* 这张表里只可能进字符串常量：数字、时长、乘积式一辈子解不出来，也就一辈子不在这条通道上 */
      hit("顶层常量");
      return { value: CONST.get(n) };
    }
    if (FNS.has(n)) {
      const decl = FNS.get(n);
      if (decl.params.length !== 1) return null; /* 入参不是一个的裸函数名不当键名用 */
      const fn = callable(n);
      if (fn) {
        try {
          const got = fn(DYN);
          if (typeof got === "string") { hit("表达式体函数"); return { value: got }; }
        } catch (e) { /* 落到未定 */ }
      }
    }
    return null;
  }
  if (expr.startsWith("[") && expr.endsWith("]")) {
    const inner = spanThrough(expr, 1, "]").text;
    const items = topSplit(inner, (c) => c === ",").map((x) => x.trim()).filter(Boolean);
    if (!items.length) return null;
    const vals = [];
    for (const it of items) {
      const r = resolve(it, scope);
      if (!r) return null; /* 一项解析不了就整条算未定：静默少收一族键是这里最坏的失败 */
      if (r.values) vals.push(...r.values);
      else vals.push(r.value);
    }
    hit("数组字面量");
    return { values: vals };
  }
  if (expr.startsWith("{") && expr.endsWith("}")) {
    const inner = spanThrough(expr, 1, "}").text;
    const vals = [];
    for (const entry of topSplit(inner, (c) => c === ",")) {
      const t = entry.trim();
      if (!t) continue;
      if (t.startsWith("...")) return null;
      const computed = t.match(/^\[([\s\S]*)\]\s*:/);
      if (computed) {
        const r = resolve(computed[1], scope);
        if (!r) return null;
        vals.push(...(r.values || [r.value]));
        continue;
      }
      const named = t.match(/^([A-Za-z_$][\w$]*)\s*:/) || t.match(/^([A-Za-z_$][\w$]*)$/);
      if (named) { vals.push(named[1]); continue; }
      const quoted = t.match(/^"([^"\n]*)"\s*:/);
      if (quoted) { vals.push(quoted[1]); continue; }
      return null; /* 值里带函数调用、三元、嵌套对象……取不出键名，整条算未定 */
    }
    if (vals.length) hit("对象字面量");
    return vals.length ? { values: vals } : null;
  }
  const concat = topSplit(expr, (c) => c === "+");
  if (concat.length > 1) {
    let out = "";
    let known = 0;
    for (const part of concat) {
      const r = resolve(part, scope);
      if (r) known++;
      out += r ? (r.values ? r.values.join("") : r.value) : DYN;
    }
    /* 一段都不认得的拼接（`a + b`）不是"键名待定"，是彻底看不见：算未定，交给登记那条点名。
       当成前缀族收下来就会凭 DYN 拼出一个假键名，反而把看不见说成看得见 */
    if (!known) return null;
    if (!out.includes(DYN)) return { value: out };
    hit("前缀拼接");
    return { value: out };
  }
  const call = expr.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (call) {
    const name = call[1];
    if (!FNS.has(name)) return null;
    const fn = callable(name);
    if (!fn) return null;
    const argStart = expr.indexOf("(", call.index) + 1;
    const argText = spanThrough(expr, argStart, ")").text;
    const args = topSplit(argText, (c) => c === ",").map((a) => {
      const r = resolve(a, scope);
      return r ? (r.values ? r.values[0] : r.value) : DYN;
    });
    try {
      const got = fn(...args);
      if (typeof got === "string") { hit("表达式体函数"); return { value: got }; }
      if (Array.isArray(got) && got.every((x) => typeof x === "string")) {
        hit("表达式体函数");
        return { values: got };
      }
    } catch (e) { /* 未定 */ }
  }
  return null;
}

/* DYN 只许作为"冒号之后的整段"出现：`cookieBackup:` + DYN、rtTab(base, DYN) 都是这一种。
   别的位置说明出现了 `x${host}y` 那种中间量写法，归一化规则要连它一起改，先抛 */
function normKey(value) {
  let v = String(value).replace(/<[^<>]*>/g, "<*>"); /* 文档里写 `<host>` 还是 `<tabId>` 是叙述，不算差异 */
  if (/^[A-Za-z0-9_]+:$/.test(v)) v += "<*>"; /* 纯前缀常量自己就是一个族的开头 */
  const i = v.indexOf(DYN);
  if (i < 0) return v;
  if (v.split(DYN).length > 2 || !v.endsWith(DYN) || v[i - 1] !== ":") {
    throw new Error(`键里的动态量不是"冒号之后的整段"：${JSON.stringify(v.replace(/\u0000/g, "∅"))}，归一化规则要改`);
  }
  return v.slice(0, i) + "<*>";
}

/* ---------- 四、每个调用点： enclosing 函数、作用域常量、解析结果 ---------- */

function enclosingFn(s, at) {
  let name = "(模块顶层)";
  for (const d of topLevelFns(s)) if (d.at < at) name = d.name; else break;
  return name;
}

const scopeCache = new Map();
function scopeOf(file, fn) {
  const id = file + "#" + fn;
  if (scopeCache.has(id)) return scopeCache.get(id);
  const scope = new Map();
  let body = null;
  try {
    body = functionBody(SRC[file], fn);
  } catch (e) {
    body = null; /* 模块顶层与箭头回调切不出体：只少了"同函数内的 const"这一条通道 */
  }
  if (body) {
    for (let pass = 0; pass < 3; pass++) {
      for (const m of body.matchAll(/(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+);/g)) {
        const name = m[1];
        const rhs = m[2].trim();
        if (asLiteral(rhs) !== null) { scope.set(name, asLiteral(rhs)); continue; }
        const r = resolve(rhs, scope);
        if (r && !r.values) scope.set(name, r.value);
        else if (r && r.values) scope.set(name, r.values[0]);
      }
    }
  }
  scopeCache.set(id, scope);
  return scope;
}

/* 全量读：get(null) 不按键名取，任何按名字的判据都看不见它 */
const fullReads = [];
/* 未定：解析不出键名的调用点，必须逐条登记 */
const unbound = [];
/* 区 → 键 → 出处 */
const keyed = { local: new Map(), session: new Map(), sync: new Map() };

function remember(zone, value, where) {
  const k = normKey(value);
  if (!keyed[zone].has(k)) keyed[zone].set(k, []);
  keyed[zone].get(k).push(where);
  return k;
}

normalizeDecl();

const sites = [];
for (const [f, s] of Object.entries(SRC)) {
  for (const c of storageCalls(s)) {
    const fn = enclosingFn(s, c.at);
    const args = c.args.trim();
    sites.push({ file: f, fn, zone: c.zone, op: c.op, args, at: c.at });
    if (args === "null") { fullReads.push({ file: f, fn, zone: c.zone, op: c.op }); continue; }
    const scope = scopeOf(f, fn);
    const r = resolve(args, scope);
    if (!r) { unbound.push({ file: f, fn, zone: c.zone, op: c.op, args: args.replace(/\s+/g, " ") }); continue; }
    for (const v of r.values || [r.value]) remember(c.zone, v, `${f}:${fn}`);
  }
}

/* ---------- 五、包装函数：调用点在函数外面递键名，那一头的区由函数体自己说 ---------- */

const wrappers = [];
for (const [f, s] of Object.entries(SRC)) {
  for (const d of topLevelFns(s)) {
    let body;
    try {
      body = functionBody(s, d.name);
    } catch (e) {
      continue;
    }
    const inner = storageCalls(body);
    if (!inner.length) continue;
    const zones = [...new Set(inner.map((c) => c.zone))];
    if (zones.length !== 1) continue; /* 一个函数跨两区读写：那是另一件事，交给按键名的判据 */
    const params = (s.slice(d.at, d.at + 200).match(/\(([^)]*)\)/) || [, ""])[1].split(",").map((x) => x.trim());
    /* 只有"体内的调用点拿入参当键名"的才算包装函数 */
    const viaParam = inner.filter((c) => {
      const a = c.args.trim();
      const bare = a.match(/^\{\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:/) || a.match(/^([A-Za-z_$][\w$]*)$/);
      return bare && params.includes(bare[1]);
    });
    if (!viaParam.length) continue;
    wrappers.push({ file: f, name: d.name, zone: zones[0], ops: [...new Set(viaParam.map((c) => c.op))].sort() });
  }
}

const callersOf = (name) => {
  const out = [];
  const re = new RegExp("\\b" + name + "\\s*\\(", "g");
  for (const [f, s] of Object.entries(SRC)) {
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (new RegExp("(?:function\\s+|const\\s+|let\\s+)" + name + "\\s*[=(]").test(s.slice(Math.max(0, m.index - 40), m.index + name.length + 2))) continue;
      const argStart = m.index + m[0].length;
      const text = spanThrough(s, argStart, ")").text;
      const first = topSplit(text, (c) => c === ",")[0].trim();
      out.push({ file: f, fn: enclosingFn(s, m.index), expr: first.replace(/\s+/g, " ") });
    }
  }
  return out;
};

/* ---------- 五点五、包装函数递出去的键并回同一本账 ----------
   区由包装函数自己的那一行说：`rtSet` 体内的调用点写的是 session，调用方递的键就算 session 的键。
   哪天把 session 改成 local，同一批键立刻变成"local 区没登记"，由正向那条点名 */
for (const w of wrappers) {
  for (const c of callersOf(w.name)) {
    const r = resolve(c.expr, scopeOf(c.file, c.fn));
    if (!r) continue; /* 解析不出的由「包装函数」那条判据点名，这里不悄悄少收一个键 */
    for (const v of r.values || [r.value]) remember(w.zone, v, `${w.name}←${c.fn}`);
  }
}

/* ---------- 六、文档侧：`### 存储` 里那三行清单 ----------
   取到第一个 `。` 为止、去掉全角括号里的旁注，剩下的反引号里符合键形状的即键名。
   为什么要先砍旁注：`tasks` 那一项的解释里写着 `keyword` 与 `getTaskKeywords`，
   它们是任务对象的字段名和兼容读的函数名，不是存储键；不砍旁注就会把字段名当键去源码里找。 */

const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z0-9_<>-]+)*$/;

const doc = readFileSync(join(repoRoot, "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
const docKeys = {};
for (const z of ZONES) {
  const m = doc.match(new RegExp("^- `chrome\\.storage\\." + z + "`[：:](.+)$", "m"));
  if (!m) throw new Error(`AGENTS.md 的 ### 存储 里找不到 ${z} 那一行，判据切不到东西了`);
  const head = m[1].split("。")[0].replace(/（[^）]*）/g, "");
  const toks = [...head.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const keys = toks.filter((t) => KEY_SHAPE.test(t));
  docKeys[z] = { keys, rejected: toks.filter((t) => !KEY_SHAPE.test(t)) };
}

const documented = new Map(ZONES.map((z) => [z, new Set(docKeys[z].keys.map(normKey))]));
/* 文档侧的 `x:<host>` / `x:<tabId>` 与源码侧的 `x:<*>` 是同一个族，占位符名字不进比较 */

/* ============================ 判据 ============================ */

test("抽取形状：每个存储调用点都要有归宿，每条解析通道都要至少命中一次", () => {
  assert.ok(
    sites.length >= 40,
    `插件里的 chrome.storage 调用点只数到 ${sites.length} 个（实测 45）——遍历面或提取正则变了，对着空集合绿过去比红更糟`
  );
  /* 未定的每一条都要登记在册：登记的是"哪个文件的哪个函数里有几笔"，
     新增一笔没登记就红，登记过的那一处少了一笔也红（n 参与比对） */
  const registered = new Map([
    ["background.js#rtGet", { n: 1, why: "键名是它自己的入参：调用方递的键由「包装函数」那条判据回查" }],
    ["background.js#rtSet", { n: 1, why: "同上" }],
    ["background.js#rtRemove", { n: 1, why: "同上" }],
    ["background.js#rtBump", { n: 2, why: "同上，体内一读一写两笔" }],
    ["background.js#pruneCookieBackups", { n: 2, why: "要删哪些键由淘汰三条件现算（entries.map / stale），存档实况是唯一来源（A13）" }],
    ["background.js#prune", { n: 2, why: "remove(conv.remove) 与 set(Object.fromEntries(…))：键清单由 planBackupConvergence 给" }],
    ["popup.js#syncSkipTraces", { n: 1, why: "get(ids.map(…))：按在场任务的 tabId 现拼，弹窗不 import 后台常量" }]
  ]);
  const seen = new Map();
  for (const u of unbound) {
    const id = `${u.file}#${u.fn}`;
    if (!registered.has(id)) {
      throw new Error(`未定的调用点没有登记：${id} ${u.zone}.${u.op}(${u.args.slice(0, 60)})\n新增一笔读写就得进上面那张表，写明它凭什么解析不出来`);
    }
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  for (const [id, rec] of registered) {
    assert.equal(
      seen.get(id) || 0,
      rec.n,
      `登记表里 ${id} 记的是 ${rec.n} 笔"未定"，实际 ${seen.get(id) || 0} 笔（${rec.why}）——那一处的写法变了，登记要跟着改，别留着空跑`
    );
  }
  const missing = ["字面量", "顶层常量", "同函数内的 const", "数组字面量", "对象字面量", "前缀拼接", "表达式体函数"].filter((r) => !ROUTES.has(r));
  assert.deepEqual(missing, [], `这些解析通道一次也没命中：${missing.join("、")} —— 通道还在但现场已经没了，判据覆盖面比看起来小`);
});

test("正向：源码里出现的每一个键，都要在文档对应那一段列名", () => {
  const bad = [];
  for (const z of ZONES) {
    for (const k of keyed[z].keys()) if (!documented.get(z).has(k)) bad.push(`${z} 区的 ${k}（出自 ${[...new Set(keyed[z].get(k))].join(" / ")}）`);
  }
  assert.deepEqual(bad, [], `这些键在插件源码里被真读写，而 AGENTS.md 的 ### 存储 没列它：\n  ${bad.join("\n  ")}\n新增一个存储键要同时进文档那一行；写进新的区更要进来——区的语义就是"活过什么"的标准`);
});

test("反向：文档列出的每一个键，源码要在那个区真碰它一次", () => {
  const bad = [];
  for (const z of ZONES) {
    for (const k of documented.get(z)) if (!keyed[z].has(k)) bad.push(`${z} 区文档里的 ${k}`);
  }
  assert.deepEqual(bad, [], `文档说要往这个区放这个键，插件源码却一个字都没碰过：\n  ${bad.join("\n  ")}\n要么键改名了、要么功能删了没同步文档；写进另一个区要改的那一段也在这里点名`);
});

test("包装函数这一头：调用方递出去的键都要解析得出来", () => {
  assert.ok(wrappers.length >= 4, `只认出 ${wrappers.length} 个包装函数（实测 4：rtGet/rtSet/rtRemove/rtBump）——识别形状改了`);
  const callerTotal = wrappers.reduce((n, w) => n + callersOf(w.name).length, 0);
  assert.ok(callerTotal >= 10, `包装函数的调用点只数到 ${callerTotal} 个（实测 17）——这条通道空了`);
  const blind = [];
  for (const w of wrappers) {
    for (const c of callersOf(w.name)) {
      const r = resolve(c.expr, scopeOf(c.file, c.fn));
      if (!r) blind.push(`${w.name} ← ${c.file}:${c.fn} 递的是 ${JSON.stringify(c.expr.slice(0, 50))}，解析不出键名`);
    }
  }
  assert.deepEqual(blind, [], `会话态读写全走 rtGet/rtSet/rtRemove/rtBump，调用点递的是变量而不是字面量：\n  ${blind.join("\n  ")}\n这一头看不见时，键名拼错与"这一族根本没人清理"表现一模一样`);
});

test("全量读 get(null) 是唯一的一招，而且每一处都按登记过的前缀过滤", () => {
  const registered = [
    { file: "background.js", fn: "readBackupEntries", token: "COOKIE_BACKUP_PREFIX" }
  ];
  const got = fullReads.map((r) => `${r.file}#${r.fn}`);
  const want = registered.map((r) => `${r.file}#${r.fn}`);
  assert.deepEqual(got, want, `全量读的位置与登记不等：源码 ${got.join(",") || "无"} ↔ 登记 ${want.join(",")}\nget(null) 绕过键名，多一处就多一处没人核对的整区扫描（配额与内存都算它）`);
  for (const r of registered) {
    assert.ok(SRC[r.file].includes(r.token), `${r.file} 里找不到 ${r.token}，登记的过滤前缀已经改名`);
    const body = functionBody(SRC[r.file], r.fn);
    assert.ok(body.includes(r.token), `${r.fn} 的函数体里没有 ${r.token}：全量读回来却不按前缀过滤，等于把整个区的键都当成自己那一族`);
  }
});

test("文档那三行的形状与数量下限，防对着空集合绿过去", () => {
  const floors = { local: 9, session: 7, sync: 1 };
  for (const z of ZONES) {
    assert.ok(
      docKeys[z].keys.length >= floors[z],
      `AGENTS.md 的 ${z} 那一行只解析出 ${docKeys[z].keys.length} 个键名（下限 ${floors[z]}）——那一行的写法变了，正向判据就会把每个键都报成没登记`
    );
    assert.ok(docKeys[z].rejected.length < 8, `${z} 那一行有 ${docKeys[z].rejected.length} 个反引号里的东西被形状规则挡掉：${docKeys[z].rejected.join(" , ")}——多半是新增的解释性提及，键名要写成裸的反引号而不是带点的名字`);
  }
  assert.ok(
    docKeys.local.keys.includes("settings") && docKeys.local.keys.includes("cookieBackup"),
    "local 那一行没列 legacy 的两个键：`settings`（旧版本设置留在 local，迁移读到即删）与 `cookieBackup`（v1.4.1 及之前的单一对象格式备份，prune 里整条删）都在源码里被真实读写过，是这一层唯一的说明书要写的东西"
  );
});

test("参照物：只有间接通道才进得了账的键，实测还剩这些", () => {
  /* 直接抄得出来的键：调用点第一个实参位置上就写着字面量（含对象字面量里的裸名）。
     剩下那些要经过顶层常量、同函数内的拼接、函数清单或包装函数才进账 */
  const direct = new Map(ZONES.map((z) => [z, new Set()]));
  for (const [f, s] of Object.entries(SRC)) {
    for (const c of storageCalls(s)) {
      const args = c.args.trim();
      for (const m of args.matchAll(/"([^"\n]*)"/g)) direct.get(c.zone).add(normKey(m[1]));
      for (const m of args.matchAll(/^\{\s*([A-Za-z_$][\w$]*)\s*[:}]/gm)) direct.get(c.zone).add(normKey(m[1]));
    }
  }
  const onlyIndirect = [];
  let directCount = 0;
  for (const z of ZONES) {
    directCount += direct.get(z).size;
    for (const k of keyed[z].keys()) if (!direct.get(z).has(k)) onlyIndirect.push(`${z}:${k}`);
  }
  assert.equal(
    onlyIndirect.length,
    10,
    `只有间接通道能取到的键实测 ${onlyIndirect.length} 个（${onlyIndirect.join(" ")}）。涨上去说明又添了一族按变量拼的键、\`AGENTS.md\` 那一行更要写清楚；掉到 0 说明这根轴已经没什么可审的了，本文件的解析器可以删一半`
  );
  assert.ok(directCount >= 8, `字面量直达的键只剩 ${directCount} 个：正向判据已经退化到只需要扫字符串了，本文件的重型解析没人在用`);
});

/* ============================ 实跑红→绿对照 ============================

   跑法：仓库外整仓副本 `D:/Github/_tar_ctl_r17/run17.mjs`（2026-09-20 实跑，日志 ctl17.log）。
   每台变异在副本上跑两台机器：`node scripts/validate.mjs` 与全套 541 条。
   pre = 删掉本文件（等于本轮之前的世界），post = 留着本文件。"其它红"那一列按函数名去重后
   条数，是本轮之前就有人拦的。28 个副本（14 台变异 × 两种模式）上 validate 一律 OK——
   这本账从头到尾没有机器问过。
   C11 单独重跑过一次：分类用的 `GATE_RE` 里 `get\(null\)` 的反斜杠被写脚本时的字符串字面量
   吃掉了，那条红被记成"其它红"。是分类错，不是判据没响。

   | 变异 | 改法 | pre | post | 本门禁红在哪一条 |
   |---|---|---|---|---|
   | C0 | 基线，一个字不改 | fail=0 | fail=0 | —（七条判据不误伤） |
   | C1 | `background.js` 新增 `local.set({ auditNote: … })`，文档只字不提 | fail=0 | fail=1 | 正向 |
   | C2 | 微信令牌 `wechatToken` 的 get 与 set 从 session 搬到 local | fail=3 | fail=5 | 正向 + 反向 |
   | C3 | 文档 local 那一行删掉 `webhookLastResult` 整项 | fail=0 | fail=2 | 正向 + 数量下限 |
   | C4 | `PROBE_KEY` 改成 `"sessionProb"` | fail=8 | fail=10 | 正向 + 反向 |
   | C5 | `tasks` 整族改名 `taskList`（后台三处 + 弹窗两处） | fail=107 | fail=109 | 正向 + 反向 |
   | C6 | `SKIP_RT_PREFIX` 改成 `"rt:skips"` | fail=11 | fail=13 | 正向 + 反向 |
   | C7 | `COOKIE_BACKUP_PREFIX` 改成 `"cookieBackups:"` | fail=14 | fail=16 | 正向 + 反向 |
   | C8 | `RT_ERROR` 改成 `"rt:erro"` | fail=6 | fail=8 | 正向 + 反向 |
   | C9 | 新增一笔解析不出的读写 `local.remove(legacyAuditKeys)` | fail=0 | fail=1 | 抽取形状 |
   | C10 | 文档 session 那一行多列一个源码没有的 `rt:foo:<tabId>` | fail=0 | fail=1 | 反向 |
   | C11 | 新增第二处 `local.get(null)` 全量读 | fail=0 | fail=1 | 全量读 |
   | C12 | `rtSet(auditKeyOf(tabId), 1)`：包装函数调用方递解析不出的键 | fail=0 | fail=1 | 包装函数这一头 |
   | C13 | `rtSet` 体内 `session.set` 改 `local.set`（四族会话态一夜落盘） | fail=19 | fail=21 | 正向 + 参照物 |

   从数字读出来的四件事：
   1. **六类 pre 全绿**（C1/C3/C9/C10/C11/C12）——本轮净新增的面。它们共同的形状是"代码与测试
      自洽，只有跨文件那本账漂移"：新增一个键没进文档（C1）、新增一笔解析不出的读写没进登记表（C9）、
      文档少一行（C3）、文档多一行（C10）、全量读多一处（C11）、包装函数这一头看不见（C12）。
      这六类改法没有任何行为症状，删掉本门禁后其余 534 条原样绿。
   2. **八类 pre 已经红一片**（C2/C4~C8/C13）——键名拼错与换区改的是行为本身，早有一批用例钉着。
      本轮在它们之上各加 2 条，但这不是独家面：把同类改法做全套（源码、测试、文档一起改齐），
      行为用例就全绿，只剩反向那一条还会问"文档这个键源码怎么不碰"。真正的独家面是上面第 1 条。
   3. **C5 一个键名能红 107 条**——`tasks` 的行为面钉得极死，反过来说明"存储这本账"此前只在
      行为那一头有账，说明书那一头零判据；本轮补的正是零判据的那一半。
   4. **C3 一次红两条**（正向 + 数量下限）——下限是"那一行被删空或写法变了"的粗粒度哨兵，
      删单项时它会与正向一起响。刻意留的冗余：宁可重复报，也不要正向因为文档解析退化而看不见。

   六条边界（红不到哪里，说清楚）：
   1. 文档侧只认 `### 存储` 那三行里**反引号裸键名**的形状，取到第一个句号为止，括号旁注整段剔掉。
      把键名写进行文从句、或那一行改成表格/拆成两行，判据就看不见它——表现是正向点名"这个键没登记"，
      不是静默（C3 就是这一类的另一端）。
   2. 未定的调用点靠登记表兜：登记表带 `n`，所以"那一笔变得能解析了"会红（少一笔）；
      但"仍然解析不出、只是换了个解析不出的原因"红不出来，`why` 那句说明本身没有判据核对。
   3. 只管**键名与区**，不管值。键放对了区、值存错了形状（该存对象存成 JSON 串）不在这根轴上；
      `settings-map` 管 `settings` 一个键的值域，其余键的值域没有账。
   4. 一次改动报几条是按**集合差**算的，不按调用点算：C2 那种 get 与 set 各改一处，本门禁报 2 条
      而不是 4 条。条数不是严重度信号，哪几条红才是。
   5. 只扫 `tab-auto-refresh` 目录下的 `.js`。`scripts/` 与 `tests/` 里的 `chrome.storage` 字样
      （桩件、截图渲染脚本、`source-tables.mjs` 自己那条提取正则）都不算调用点。
   6. 会话态键"要不要进 `rtRoundKeys`、生命周期里清得干净不干净"是 `rt-lifecycle` 的账。
      本文件绿不等于那一头绿，反之亦然——两条都要过才叫这本账齐。 */

