/* 源码表格的切取原语，给"键名住在表里"那一类判据共用（`i18n-indirection.test.mjs` 管通道，
   `wechat-budget.test.mjs` 管内容，`storage-map.test.mjs` 管存储调用点，
   `cookie-schema.test.mjs` 管存档对象的字段清单）。

   为什么单独一个文件而不是各写一份：这几段切取认的是本仓库常量表的**形状**
   （`const NAME = { k: "v" }` / 数组表每行最后一个字面量 / `PRESETS` 那种 `{key, seconds}`）。
   写第二份就会漂移，而"漂移"在这里的表现是不报错——切少了几条，判据安静地少覆盖几条。
   同一仓库里 `scripts/validate-refs.mjs` 是另一个方向的同一件事：引用通道那批正则也只能有一份。

   一律**只读文本、不执行函数体**，也不 import 常量表：`WECHAT_EVENT_TITLE_KEYS` 这类表住在
   `background.js`，import 它要先造一整套 chrome 桩件，而桩件喂进去的键集合本身就是抄本。
   每个切取函数都返回 `slots`（源码里的槽数），调用方拿它和条目数比对，形状一改就红。 */

/* 逐行剔注释：本仓库的注释一律整行，没有行尾注释被切一半的风险（实测如此）。
   这一条只服务于"注释里的名字不算取用路径"，不承担切分表达式的责任 */
export const stripComments = (src) =>
  src
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\*|\/\*|<!--)/.test(line) ? "" : line))
    .join("\n");

/* 声明体切取：const NAME = { … } / [ … ] / "…" */
export function declarationBody(src, name) {
  const m = src.match(new RegExp("(?:export\\s+)?const\\s+" + name + "\\s*=\\s*"));
  if (!m) throw new Error(`源码里找不到 const ${name}`);
  const rest = src.slice(m.index + m[0].length);
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const close = rest.slice(1).search(rest[0]);
    return { scalar: rest.slice(1, close + 1), body: rest.slice(0, close + 2) };
  }
  const open = rest[0];
  if (open !== "{" && open !== "[") throw new Error(`${name} 的声明形状不认识：${open}`);
  const closeChar = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let i = 0;
  for (; i < rest.length; i++) {
    const c = rest[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return { body: rest.slice(0, i + 1), closeChar };
}

/* 对象表的"值槽"个数与值本身。slots 用来证明抽取没空跑：形状一改（比如值不再
   是字符串字面量），条目数就会掉到槽数以下，那要红而不是静默少收几条。
   属性名三种写法都要认：引号包着的事件名（"task-stopped"）、裸标识符（keyword）、
   裸数字（40001）——数字这一种别省，WECHAT_ERROR_KEYS 整张表都是它 */
export function objectPairs(decl) {
  const body = decl.body;
  const entries = [];
  for (const m of body.matchAll(/(?:^|[{,\s])(?:"([^"\n]*)"|([A-Za-z0-9_$][A-Za-z0-9_$]*))\s*:\s*"([^"\n]*)"/g)) {
    entries.push({ label: m[1] === undefined ? m[2] : m[1], key: m[3] });
  }
  const slots = [...body.matchAll(/:/g)].length;
  return { entries, slots };
}

/* 数组表的"每行取最后一个字符串字面量"：WEBHOOK_STATUS_BUCKETS 一行是
   [状态码数组, kind, errorKey]，前两个字面量是 kind，不是键 */
export function rowLastStrings(decl) {
  const body = decl.body;
  const rows = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "[") {
      depth++;
      if (depth === 2) start = i;
    } else if (c === "]") {
      depth--;
      if (depth === 1) rows.push(body.slice(start, i + 1));
    }
  }
  const entries = rows.map((row) => {
    const lits = [...row.matchAll(/"([^"\n]*)"/g)];
    return { label: row, key: lits.length ? lits[lits.length - 1][1] : "" };
  });
  return { entries, slots: rows.length };
}

/* PRESETS 那种 { key, seconds } 行 */
export function presetRows(decl) {
  const body = decl.body;
  const entries = [];
  for (const m of body.matchAll(/key:\s*"([^"\n]*)"\s*,\s*seconds:\s*(\d+)/g)) {
    entries.push({ label: m[2], key: m[1] });
  }
  return { entries, slots: [...body.matchAll(/key:/g)].length };
}

/* 按花括号配对切一个函数体：认 `function 名字 (…) {`（可带 async / export）与
   `const 名字 = … => {` 两种形状。先剔注释再配对，双引号串整段跳过。
   模板字符串里的 `${}` 会把配对数错——用到的那几个函数体里没有；真出现时它抛，不会少切 */
export function functionBody(src, name) {
  const stripped = stripComments(src);
  const heads = [
    new RegExp("(?:(?:async|export)\\s+)*function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{"),
    new RegExp("(?:const|let|var)\\s+" + name + "\\s*=[^;{]*=>\\s*\\{"),
  ];
  let open = -1;
  for (const re of heads) {
    const m = stripped.match(re);
    if (m) {
      open = m.index + m[0].length - 1;
      break;
    }
  }
  if (open < 0) throw new Error(`源码里切不到函数 ${name}`);
  let depth = 0;
  let inStr = false;
  for (let i = open; i < stripped.length; i++) {
    const c = stripped[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return stripped.slice(open + 1, i);
    }
  }
  throw new Error(`函数 ${name} 的花括号没配平`);
}

/* 取出每一处 `getMessage(` 的实参源码（括号配平到右括号为止，双引号串整段跳过）。
   与 `scripts/validate-refs.mjs` 的 `jsMessageKeys` 不是同一件事的第二份定义：
   那个只认"整个第一个实参是字面量"的调用（三元里的比较值会被切成假键），
   这里要的是**实参位置上出现过哪些字面量**，所以 `a ? "x" : "y"` 与 `tbl[e] || "z"`
   都算数——预算账要覆盖的正是这些"值从哪儿来"的分支 */
export function getMessageArgs(src) {
  const stripped = stripComments(src);
  const out = [];
  const re = /getMessage\s*\(/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const start = m.index + m[0].length;
    out.push(spanThrough(stripped, start).text);
  }
  return out;
}

/* 从"开括号之后的第一个字符"走到与它配对的那个闭括号，返回括号里的原文与闭括号下标。
   双引号串整段跳过（里面有括号也不算数）。调用方给的 src 应当已经剔过注释。
   配不平时抛，不回一个截断的片段——切一半在这里的表现是"安静地少看几个键" */
export function spanThrough(src, start, closeChar = ")") {
  const openChar = { ")": "(", "]": "[", "}": "{" }[closeChar];
  let depth = 1;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return { text: src.slice(start, i), end: i };
  }
  throw new Error(`${openChar}…${closeChar} 没配平（从 ${start} 起）`);
}

/* 插件源码里每一个 `chrome.storage.<区>.<动作>(…)` 调用点，实参整段取回（括号配平）。
   第十七轮的探针在第一版上用 `[^)]*` 切实参，凡是自己带括号的都少切一截
   （`session.remove(rtRoundKeys(tabId))` 只剩到 `rtRoundKeys(tabId`），键集合因此看着比实际大。
   这一条认的是"调用点写了什么"，键名的解析留给调用方 */
export function storageCalls(src) {
  const stripped = stripComments(src);
  const out = [];
  const re = /chrome\.storage\.(local|session|sync)\.(get|set|remove)\s*\(/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const start = m.index + m[0].length;
    const { text, end } = spanThrough(stripped, start);
    out.push({ zone: m[1], op: m[2], args: text, at: m.index, end });
  }
  return out;
}

/* 顶层分隔：只在深度 0（括号之外）且不在字符串里时切开。第十七轮那份 `topSplit` 住在
   `storage-map.test.mjs` 里，本轮同一件事第二次要用——搬到这儿来共用一份，理由与本文件顶部
   那句一样：切分类的东西写第二份必然漂移，而漂移在这里不报错，只是安静地少切几条 */
export function splitTop(text, sep) {
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
    if (depth === 0 && c === sep) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/* 一个对象字面量**内部**的键名清单（调用方负责先按配对把外层花括号切掉，传进来的是不含
   `{}` 的原文）。返回四样东西，够判据分清"这个键叫什么"与"这里没法知道键叫什么"：
     keys      —— 裸标识符与引号名，以及简写（`{ tasks }` 的键就是 tasks）
     computed  —— `[expr]:` 形式的计算键，把 expr 原文交回调用方自己解析
     spread    —— `...expr`，它带进来的键在这次切取里看不见
     认不出的条目形状一律抛，不回一个截断的清单：这里"少一条"的表现是判据安静地少覆盖 */
export function objectKeys(inner) {
  const out = { keys: [], computed: [], spread: [] };
  for (const part of splitTop(inner, ",")) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith("...")) { out.spread.push(t.slice(3).trim()); continue; }
    const computed = t.match(/^\[([\s\S]*?)\]\s*:/);
    if (computed) { out.computed.push(computed[1].trim()); continue; }
    const named = t.match(/^(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_$][\w$]*))\s*:/);
    if (named) { out.keys.push(named[1] ?? named[2] ?? named[3]); continue; }
    const shorthand = t.match(/^([A-Za-z_$][\w$]*)$/);
    if (shorthand) { out.keys.push(shorthand[1]); continue; }
    throw new Error(`对象条目形状认不出来：${t.slice(0, 60)}`);
  }
  return out;
}
