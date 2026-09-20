/* 第十八轮审计（A36）：cookie 存档这本账。审的是一份 `cookieBackup:<host>` 条目里到底有哪些
   字段、这些字段谁写的谁读的、测试夹具手抄的那一份对不对。

   为什么这根轴是空的：存档没有 schema 声明，字段名只以字面量的形式散在三个地方——
   `background.js` 的采集条目映射（写侧唯一的真相）、`shared/logic.js` 的 `applyBackupAction`
   （盖章那一层）、以及 `cookie-backup.test.mjs` 与 `logic.test.mjs` 里手写的夹具。
   三条通道之间没有一个字节是 import 过来的（存档级那一处还不止一条通道：`entry:` / `write:`
   后面的字面量，加上就地合并的 `Object.assign({}, entry, { … })`），改一边另一边一个字都不报错。
   实测（13 台变异在仓库外整仓副本各跑 pre/post 两台机器，全表记在本文件末尾）：
     - 把写侧的 `hostOnly: c.hostOnly` 改名为 `hostScope`，`validate.mjs` 与其余 541 条除了
       `doc-anchors` 那两条之外一条不红。那两条是"删掉本门禁"这个动作自己的副作用——
       本轮的说明书条目正指向本文件，所以每台 pre 都固定红它俩，与变异无关。
       而这一改的直接后果是还原时 `c.hostOnly` 恒为 undefined，每张备份都走"v1 旧备份"那一支、
       一律带 `domain` 写回浏览器——`__Host-` 票据写不进去，其余票据的作用域被扩大。
       也就是说：最要紧的那个字段改名，全套门禁全绿。之所以绿，是因为夹具自己手抄了一份
       `hostOnly: true`，读侧那条用例喂进去的字段是抄本给的，不是写侧给的。
     - 把还原侧不再读 `sameSite`（写侧照写），同样全绿：存档里从此躺着一个没人取的字段，
       而"恢复出来的 cookie 是不是 SameSite=None"这件事安静地没了。
     - 把写侧不再写 `httpOnly`（读侧照读）同样全绿：从此每次备份都丢掉登录票据最强的那道标记，
       而 `cookieTicketScore` 的排序判据跟着失效，超限截断开始切掉真正的票。

   形状：全部按文本切真实源码，不 import `background.js`（它要先造一整套 chrome 桩件），
   也不 import `shared/logic.js`（那样等于让被测字段名单从被测模块里"要"一份，而它本来没有声明处）。
   切取原语与第十七轮共用 `tests/helpers/source-tables.mjs` 那一份。
   读侧的落点是一张 `SCOPES` 表（哪个函数的哪个别名变量装着存档的哪一层）：别名是登记的，
   但每一行都要在"抽取形状"那条里现证它在源码里真有一次 `.字段` 取用——改名、函数没了、
   或它不再取用任何字段，那条先红，而不是这一路安静地少扫几个函数。

   与相邻门禁的分工：
   - `cookie-backup.test.mjs` 管执行器行为（查哪几层域、怎么写回、超限切尾、孤儿删不删），
     它的夹具是本文件要核对的对象，不是它的判据
   - `logic.test.mjs` 管 `capCookies` / `applyBackupAction` / `planBackupConvergence` 的决策结果值，
     不核字段名对不对得齐
   - `storage-map.test.mjs`（上一轮）管 `cookieBackup:<host>` 这个键名在哪个区、文档登记没有；
     本文件管键后面那份对象里有什么
   - `doc-numbers.test.mjs` 管 200 / 20 / 30 天这些数字；本文件管那条"还原三分支"的名字与分支
   - `permission-map.test.mjs` 管 `cookies` 这一项权限有没有；不碰字段 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, functionBody, spanThrough, splitTop, objectKeys } from "../helpers/source-tables.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BG_PATH = join(repoRoot, "tab-auto-refresh", "background.js");
const LOGIC_PATH = join(repoRoot, "tab-auto-refresh", "shared", "logic.js");
const AGENTS_PATH = join(repoRoot, "AGENTS.md");
const TEST_DIR = join(repoRoot, "tests", "tab-auto-refresh");

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const BG = read(BG_PATH);
const LOGIC = read(LOGIC_PATH);
const AGENTS = read(AGENTS_PATH);

/* ---------- 官方字段表：抄自 developer.chrome.com 的 cookies 参考页，仓库里不再抄第二份 ----------
   三份各有用处：Chrome 给回来的是什么（写侧取材的上限）、写回浏览器能递什么、查询能按什么筛。
   `hostOnly` 在第一份里而不在第二份里——这正是还原那三分支存在的全部理由 */
const COOKIE_RESULT_FIELDS = new Set([
  "name", "value", "domain", "hostOnly", "path", "secure", "session", "httpOnly", "expirationDate", "sameSite", "storeId",
]);
const COOKIE_SET_PARAMS = new Set([
  "url", "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expirationDate", "storeId",
]);
const COOKIE_GETALL_PARAMS = new Set([
  "url", "name", "domain", "path", "secure", "httpOnly", "session", "storeId",
]);

/* ---------- 一、读侧落点：哪一段源码里的哪个别名装着存档的哪一层 ----------
   别名是登记的，但每一行都要在"抽取形状"那条里现证它真的一次都没停下过取用字段。
   为什么按函数登记而不全文扫：logic.js 里叫 `a`、`s`、`t` 的变量有一把，任务对象、设置对象、
   网址解析结果都借这些名字，全文扫 `a.domain` 会把无关的对象也算进存档的账 */

const SCOPES = [
  { src: BG, file: "background.js", fn: "backupCookies", alias: "c", level: "chrome" },
  { src: BG, file: "background.js", fn: "restoreCookies", alias: "c", level: "item" },
  { src: BG, file: "background.js", fn: "restoreCookies", alias: "entry", level: "entry" },
  { src: BG, file: "background.js", fn: "pruneCookieBackups", alias: "value", level: "entry" },
  { src: LOGIC, file: "shared/logic.js", fn: "isSessionCookie", alias: "c", level: "item" },
  { src: LOGIC, file: "shared/logic.js", fn: "nextBackupState", alias: "prevEntry", level: "entry" },
  { src: LOGIC, file: "shared/logic.js", fn: "decideBackupWrite", alias: "prevEntry", level: "entry" },
  { src: LOGIC, file: "shared/logic.js", fn: "cookieTicketScore", alias: "c", level: "item" },
  { src: LOGIC, file: "shared/logic.js", fn: "compareCookiePriority", alias: "a", level: "item" },
  { src: LOGIC, file: "shared/logic.js", fn: "compareCookiePriority", alias: "b", level: "item" },
  { src: LOGIC, file: "shared/logic.js", fn: "planBackupConvergence", alias: "entry", level: "entry" },
  { src: LOGIC, file: "shared/logic.js", fn: "planBackupConvergence", alias: "c", level: "item" },
];

/* `alias.field` 全集：行首不能是点或标识符字符（`tab.url` 不该被当成 `b.url`） */
function readFields(body, alias) {
  const re = new RegExp("(?:^|[^\\w$.])" + alias + "\\.([A-Za-z_$][\\w$]*)", "g");
  return new Set([...body.matchAll(re)].map((m) => m[1]));
}

const BODIES = new Map(
  [...new Set(SCOPES.map((r) => r.file + "|" + r.fn))].map((k) => {
    const [file, fn] = k.split("|");
    const row = SCOPES.find((r) => r.file === file && r.fn === fn);
    return [k, stripComments(functionBody(row.src, fn))];
  })
);

const READS = SCOPES.map((row) => ({
  ...row,
  fields: [...readFields(BODIES.get(row.file + "|" + row.fn), row.alias)],
}));

const archiveReads = (level) =>
  new Set(READS.filter((r) => r.level === level).flatMap((r) => r.fields));

const ITEM_READS = archiveReads("item");
const ENTRY_READS = archiveReads("entry");

/* ---------- 二、写侧：存档里到底有哪些字段，从源码现推 ---------- */

/* 条目级：`backupCookies` 里那张 `(c) => ({ … })` 映射表，全仓库唯一一处 */
function producedItemLiteral() {
  const body = BODIES.get("background.js|backupCookies");
  const hits = [...body.matchAll(/\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\(\s*\{/g)];
  assert.equal(
    hits.length,
    1,
    `backupCookies 里采集映射切到 ${hits.length} 处（判据要的是恰好一处，多一处就是第二条写侧通道）`
  );
  const { keys, computed, spread } = objectKeys(spanThrough(body, hits[0].index + hits[0][0].length, "}").text);
  return { alias: hits[0][1], keys, computed, spread };
}

/* 存档级有两条通道，都要收：
   ① `logic.js` 里跟在 `write:` / `entry:` 后面的对象字面量——新建一份备份时盖的那三个字段，
      以及冻结/合并时并进旧条目的那几个状态字段；
   ② `Object.assign({}, <存档别名>, { … })` 这种就地合并——`planBackupConvergence` 收敛
      越界备份时走的就是这条路，它写进存档的名字不出现在任何 `entry:` 后面。
   漏掉第②条的后果与漏掉字段清单一样：新加一个名字写进明文条目，两头账都对不上而全套照绿。
   只在登记过的函数体里找合并点，就是为了撞到陌生别名时可以直接抛 */
function producedEntryLiterals() {
  const out = [];
  const src = stripComments(LOGIC);
  for (const m of src.matchAll(/(?:^|[^.\w$])(?:entry|write)\s*:\s*\{/g)) {
    out.push(objectKeys(spanThrough(src, m.index + m[0].length, "}").text));
  }
  for (const [key, body] of BODIES) {
    const re = /Object\.assign\(\s*\{\s*\}\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*\{/g;
    for (const m of body.matchAll(re)) {
      const [file, fn] = key.split("|");
      const level = READS.find((r) => `${r.file}|${r.fn}|${r.alias}` === `${file}|${fn}|${m[1]}`)?.level;
      assert.ok(
        level === "entry",
        `${file} 的 ${fn} 里有一个合并写入点，目标 ${m[1]} 没有登记成存档条目（登记之外的写侧通道本文件判不了）`
      );
      out.push(objectKeys(spanThrough(body, m.index + m[0].length, "}").text));
    }
  }
  return out;
}

const ITEM = producedItemLiteral();
const ITEM_FIELDS = new Set(ITEM.keys);
const ENTRY_LITERALS = producedEntryLiterals();
const ENTRY_FIELDS = new Set(ENTRY_LITERALS.flatMap((o) => o.keys));

const LEVELS = {
  item: ITEM_FIELDS,
  entry: ENTRY_FIELDS,
  chrome: COOKIE_RESULT_FIELDS,
};

/* 只写不读的字段要在这里点名。`schemaVersion` 就是这一类：它是写给"将来要做迁移的那个人"的，
   今天还原侧靠 hostOnly 的真假三分支兼容 v1，没人读它。登记的意义是反向判据不许因为它而红，
   同时它必须仍留在写侧字段清单里——"不读"不等于"可以改名" */
const WRITE_ONLY = new Map([
  ["schemaVersion", "版本标记：写侧盖章，读侧靠 hostOnly 三分支兼容旧备份；将来加迁移才有人读它"],
]);

/* ---------- 三、夹具：测试里手写的 cookie 条目与存档条目 ---------- */

/* 一段源码里所有最外层对象字面量的内部原文（嵌套的按配对跳过去，不重复收） */
function outerLiterals(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const r = spanThrough(text, i + 1, "}");
    out.push(r.text);
    i = r.end;
  }
  return out;
}

function enclosingBrace(text, pos) {
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{" && --depth < 0) return i;
  }
  return -1;
}

const FIXTURES = [];
for (const name of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort()) {
  const src = stripComments(read(join(TEST_DIR, name)));
  for (const m of src.matchAll(/\bcookies\s*:\s*\[/g)) {
    const arr = spanThrough(src, m.index + m[0].length, "]").text;
    for (const inner of outerLiterals(arr)) {
      FIXTURES.push({ file: name, level: "item", keys: objectKeys(inner).keys });
    }
    /* 带着一个数组形状的 cookies 的那一层就是存档对象本身。按"值是不是数组"认，
       是因为 permission-map 的权限表里也有一行键名叫 cookies，那是 API 名不是存档 */
    const open = enclosingBrace(src, m.index);
    if (open < 0) continue;
    const keys = objectKeys(spanThrough(src, open + 1, "}").text).keys;
    if (keys.includes("cookies")) FIXTURES.push({ file: name, level: "entry", keys });
  }
}

/* ---------- 判据 ---------- */

test("抽取形状：写侧字段抽得出来，登记到的读侧别名每个都还在取用字段", () => {
  assert.equal(ITEM.computed.length, 0, "采集条目里出现计算键，字段名单判不了了");
  assert.equal(ITEM.spread.length, 0, "采集条目里出现展开，字段名单会少几条而不会报错");
  assert.ok(ITEM_FIELDS.size >= 8, `写侧条目只切到 ${ITEM_FIELDS.size} 个字段，采集映射的形状变了`);
  assert.ok(ENTRY_FIELDS.size >= 5, `写侧存档对象只切到 ${ENTRY_FIELDS.size} 个字段`);
  assert.ok(ENTRY_LITERALS.length >= 3, `entry:/write: 字面量只切到 ${ENTRY_LITERALS.length} 处`);
  /* 存档能装的字段以 Chrome 给回来的为上限：多一个名字就是备份里躺着一个永远 undefined 的键 */
  for (const f of ITEM_FIELDS) {
    assert.ok(COOKIE_RESULT_FIELDS.has(f), `采集条目写了 ${f}，Chrome 的 Cookie 对象里没有这一项`);
  }
  /* 采集映射的形参名与 SCOPES 那一行必须是同一个别名：改了形参名，两侧不能各说各话 */
  const chromeRow = READS.find((r) => r.fn === "backupCookies");
  assert.equal(chromeRow.alias, ITEM.alias, `采集映射的形参是 ${ITEM.alias}，读侧登记的却是 ${chromeRow.alias}`);
  for (const row of READS) {
    assert.ok(
      row.fields.length >= 1,
      `${row.file} 的 ${row.fn} 里别名 ${row.alias} 一次都没取用字段：它已经不是存档对象，或这个别名被改名了`
    );
  }
});

test("正向：读侧读到的每一个字段，存档那一层必须有它（改名与漏写的字段在这里现形）", () => {
  for (const row of READS) {
    const known = LEVELS[row.level];
    for (const f of row.fields) {
      assert.ok(
        known.has(f),
        `${row.file} 的 ${row.fn} 读了 ${row.alias}.${f}，而 ${row.level} 层没有这个字段` +
          `（${row.level === "chrome" ? "Chrome 的 Cookie 对象给不出它" : "写侧没人盖章它"}）`
      );
    }
  }
});

test("反向：写侧盖章的每一个字段必须有人读，只写不读的要登记", () => {
  for (const f of ITEM_FIELDS) {
    assert.ok(ITEM_READS.has(f), `采集条目写了 ${f}，还原与判据两侧没有一个地方读它`);
  }
  for (const f of ENTRY_FIELDS) {
    assert.ok(
      ENTRY_READS.has(f) || WRITE_ONLY.has(f),
      `存档写了 ${f} 而没人读它。要么补读侧，要么进 WRITE_ONLY 登记并写明它凭什么只写不读`
    );
  }
});

test("往返回路：还原用到的字段恰好等于存档字段，去重键也在其中", () => {
  const restore = readFields(stripComments(functionBody(BG, "restoreCookies")), "c");
  assert.deepEqual(
    [...restore].sort(),
    [...ITEM_FIELDS].sort(),
    "restoreCookies 读的字段集合与采集写的字段集合不齐平：多一项等于读一个存档里根本没有的名字" +
      "（undefined 在这些参数上全是合法值，一条都不报错），少一项等于那个字段从此只是躺在明文里的负担"
  );
  /* 采集时的去重键决定"同一张 cookie 的两份样本算不算一张"，它用的名字必须能跟着存档走完全程 */
  const dedupe = stripComments(functionBody(BG, "backupCookies")).match(/seen\.set\(([^,]*?),\s*c\)/);
  assert.ok(dedupe, "backupCookies 里切不到 seen.set(…) 那笔去重，采集的键形状变了");
  for (const m of dedupe[1].matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    assert.ok(
      ITEM_FIELDS.has(m[2]),
      `去重键用了 ${m[1]}.${m[2]}，而它不在采集条目里：这个键在存档里对不上任何字段`
    );
  }
});

/* cookies API 的实参解析：字面量 / 同段源码里的 const 对象 / Object.assign 套娃，
   认不出来一律抛——判不了要响亮，不许回一个截断的键集合 */
function argKeys(arg, ctx) {
  const t = arg.trim();
  if (t.startsWith("{")) return objectKeys(spanThrough(t, 1, "}").text);
  const asg = t.match(/^Object\.assign\(([\s\S]*)\)$/);
  if (asg) {
    const out = { keys: [], computed: [], spread: [] };
    for (const part of splitTop(asg[1], ",")) {
      const k = argKeys(part, ctx);
      out.keys.push(...k.keys);
      out.computed.push(...k.computed);
      out.spread.push(...k.spread);
    }
    return out;
  }
  const id = t.match(/^([A-Za-z_$][\w$]*)$/);
  if (id) {
    const m = ctx.match(new RegExp("(?:const|let|var)\\s+" + id[1] + "\\s*=\\s*\\{"));
    if (!m) throw new Error(`cookies 调用的实参 ${id[1]} 在同一段源码里切不到对象字面量声明`);
    return argKeys(ctx.slice(m.index + m[0].length - 1), ctx);
  }
  throw new Error(`cookies 调用的实参形状不认识：${t.slice(0, 60)}`);
}

function cookieApiCalls() {
  const src = stripComments(BG);
  const out = [];
  for (const method of ["set", "getAll"]) {
    const re = new RegExp("chrome\\.cookies\\." + method + "\\s*\\(", "g");
    for (const m of src.matchAll(re)) {
      const args = spanThrough(src, m.index + m[0].length, ")").text;
      const table = method === "set" ? COOKIE_SET_PARAMS : COOKIE_GETALL_PARAMS;
      const keys = new Set();
      for (const part of splitTop(args, ",")) for (const k of argKeys(part, src).keys) keys.add(k);
      out.push({ method, keys });
    }
  }
  return out;
}

test("Chrome 参数账：递给的每一项都是官方 details 里的名字，存档专有的一项都不许递", () => {
  const calls = cookieApiCalls();
  assert.ok(calls.length >= 3, `cookies API 的调用点只切到 ${calls.length} 处，判据要覆盖面`);
  const sent = new Set(calls.flatMap((c) => [...c.keys]));
  assert.ok(sent.size >= 8, `cookies 调用参数只数到 ${sent.size} 个名字，多半是切取跑空了`);
  for (const c of calls) {
    for (const k of c.keys) {
      const table = c.method === "set" ? COOKIE_SET_PARAMS : COOKIE_GETALL_PARAMS;
      assert.ok(
        table.has(k),
        `chrome.cookies.${c.method} 递了 ${k}：它不在官方 details 里，Chrome 不报错、只是不理它`
      );
    }
  }
  /* 存档专有 = Chrome 的 Cookie 对象有它、而写回接口不认它。这一类字段只能拿去决定别的参数
     （hostOnly 决定递不递 domain），原样递进去就是 Chrome 不理它、而人以为生效了 */
  const ARCHIVE_ONLY = [...ITEM_FIELDS].filter((f) => !COOKIE_SET_PARAMS.has(f));
  assert.ok(ARCHIVE_ONLY.length >= 1, "存档专有字段一个都数不出来，下面那一条判据是空的");
  for (const c of calls.filter((x) => x.method === "set")) {
    for (const k of c.keys) {
      assert.ok(
        !ARCHIVE_ONLY.includes(k),
        `chrome.cookies.set 递了 ${k}：写回接口不认这一项，它只能用来决定 url 与 domain 怎么给`
      );
    }
  }
});

test("夹具账：测试里手写的 cookie 条目与存档条目不许发明字段名", () => {
  assert.ok(
    FIXTURES.filter((f) => f.level === "item").length >= 8,
    `只切到 ${FIXTURES.filter((f) => f.level === "item").length} 个夹具条目，形状与预期不符`
  );
  assert.ok(
    FIXTURES.filter((f) => f.level === "entry").length >= 4,
    `只切到 ${FIXTURES.filter((f) => f.level === "entry").length} 个夹具存档对象`
  );
  for (const f of FIXTURES) {
    const known = f.level === "item" ? ITEM_FIELDS : ENTRY_FIELDS;
    for (const k of f.keys) {
      if (k === "cookies") continue;
      assert.ok(
        known.has(k),
        `${f.file} 的夹具在 ${f.level} 层写了 ${k}，而写侧根本不产出它：` +
          "夹具自己发明字段，读侧那条用例喂进去的就是抄本而不是存档的形状（这正是 A36 的立论）"
      );
    }
  }
});

test("文档账：AGENTS.md 那条还原三分支的说明要有源码落点", () => {
  /* 按"带版本号的那一行"锚，而不是"提到 schemaVersion 的那一行"：本文件写好后，`## 仓库`
     里讲本轮的那一条也提了这个字段名，用后者锚会挑到说明书之外的地方（实测撞过一次） */
  const hits = AGENTS.split("\n").filter((l) => /`schemaVersion:\s*\d+`/.test(l));
  assert.equal(hits.length, 1, `AGENTS.md 里带版本号的 \`schemaVersion: N\` 有 ${hits.length} 处，说明书成了两份`);
  const line = hits[0];
  const docN = Number(line.match(/`schemaVersion:\s*(\d+)`/)[1]);
  const srcN = Number((stripComments(LOGIC).match(/schemaVersion:\s*(\d+)/) || [])[1]);
  assert.ok(Number.isInteger(srcN), "logic.js 里的 schemaVersion 不再是数字字面量，版本号判不了");
  assert.equal(docN, srcN, `AGENTS.md 写的是 schemaVersion: ${docN}，源码盖章的是 ${srcN}`);
  assert.ok(ITEM_FIELDS.has("hostOnly"), "文档讲 hostOnly 的三种取值，可采集条目里没有它，那三种无从谈起");
  assert.ok(line.includes("hostOnly === true"), "文档不再写 `hostOnly === true`，而还原侧的分支判据就是这句话");
  const body = stripComments(functionBody(BG, "restoreCookies"));
  assert.match(body, /hostOnly\s*===\s*true/, "还原侧不再是 `=== true` 的严格比较，文档那三分支的说法要改");
  assert.match(body, /domain:\s*c\.domain/, "还原侧的 else 分支不再按备份的 domain 写回，文档那句传 domain 失效了");
});

test("参照物：每一条通道都要有非空跑的下限", () => {
  assert.ok(READS.length >= 10, `读侧作用域只登记了 ${READS.length} 行`);
  const total = READS.reduce((n, r) => n + r.fields.length, 0);
  assert.ok(total >= 25, `读侧一共只数到 ${total} 次字段取用，切取面不可能这么小`);
  assert.ok(ITEM_READS.size >= 8, `存档条目层面的读侧只有 ${ITEM_READS.size} 个不同字段`);
  assert.ok(ENTRY_READS.size >= 3, `存档层面的读侧只有 ${ENTRY_READS.size} 个不同字段`);
  /* 夹具与源码两侧都要真的说过话：只切到源码一侧、或只切到夹具一侧，都说明有一根通道断了 */
  const fixtureFields = new Set(FIXTURES.flatMap((f) => f.keys));
  assert.ok(fixtureFields.size >= 8, `夹具里一共只出现 ${fixtureFields.size} 个字段名`);
  const overlap = [...ITEM_FIELDS].filter((f) => fixtureFields.has(f)).length;
  assert.ok(overlap >= 6, `夹具与存档字段只重合 ${overlap} 项，那本账对的是两份不相干的东西`);
});

/* ---------- 对照（改坏哪一处）与边界 ----------

   13 台变异跑在仓库外的整仓副本（脚本 `D:/Github/_tar_ctl_r18/ctl18.mjs`，日志 `ctl18.log`），
   每台两遍：pre 删掉本门禁（等于本轮之前的世界），post 留着。26 个副本 `validate.mjs` 全 OK。
   pre 那一列每台固定红 2 条 `doc-anchors`——本轮的说明书条目正指向本文件，pre 把它删了，
   路径与符号名自然查无此人。那两条每台都有、与变异无关，下表不重复记，只记"本门禁红"。

   | 变异 | 改法 | pre | post | 本门禁红在哪几条 |
   |---|---|---|---|---|
   | K0 | 基线，一个字不改 | fail=0 | fail=0 | —（八条判据不误伤） |
   | K1 | 采集映射 `hostOnly: c.hostOnly` 改名 `hostScope` | 净新增 | fail=6 | 抽取形状+正向+反向+往返回路+夹具账+文档账 |
   | K2 | 还原侧 `c.expirationDate` 改读 `c.expires` | 既有红 1 | fail=3 | 正向+往返回路 |
   | K3 | 还原侧删掉 `sameSite: c.sameSite,` | 净新增 | fail=2 | 反向+往返回路 |
   | K4 | 采集侧删掉 `httpOnly: c.httpOnly,` | 净新增 | fail=3 | 正向+往返回路+夹具账 |
   | K5 | 盖章字面量 `schemaVersion: 2` 改名 `schemaVer` | 既有红 1 | fail=4 | 反向+夹具账+文档账 |
   | K6 | 同一处字面量里 `timestamp: now` 改名 `ts` | 净新增 | fail=3 | 正向+反向+夹具账 |
   | M1 | 就地合并那个对象多塞一个 `archivedAt: 1` | 净新增 | fail=1 | 反向 |
   | P1 | 写回浏览器的 `base` 里塞 `hostOnly: !!c.hostOnly,` | 净新增 | fail=1 | Chrome 参数账 |
   | S1 | `nextBackupState` 的形参 `prevEntry` 改名 `prevRec`（行为不变） | 净新增 | fail=2 | 抽取形状+反向 |
   | F1 | 夹具条目里加一个源码根本不产出的 `partitionKey: "x"` | 净新增 | fail=1 | 夹具账 |
   | D1 | 文档 `schemaVersion: 2` 改成 `3` | 净新增 | fail=1 | 文档账 |
   | D2 | 文档那句 `hostOnly === true` 换成"为真就省略"的自然语言 | 净新增 | fail=1 | 文档账 |

   从这张表读出来的四件事：
   1. 十类净新增（K1/K3/K4/K6/M1/P1/S1/F1/D1/D2），共同形状是"每一头各自自洽，
      只有跨文件那份字段账漂移"。K1 是这一轮立论的那一台：存档里最要紧的字段改名，
      删掉本门禁之后全套零红，而后果（每张备份一律带 `domain` 写回，`__Host-` 票据写不进去）
      是这一层最贵的一类静默失败。
   2. K5 与 K6 改的是同一个字面量、两个相邻字段，一个改前就有账、一个没有。
      差别不在字段谁重要，在那一批既有行为用例的夹具恰好抄没抄过这个名字——
      这就是"靠行为用例兜字段名"不可靠的直接证据，也是本轮不把账建在它们之上的理由。
   3. P1 只红一条（Chrome 参数账），其余七条一个都不响：往 `set` 的 details 里塞一个
      Cookie 对象专有、写回接口不认的名字，是纯参数形状的问题，读侧写侧两头的清单照旧齐平。
      这条面此前没有任何用例看得见。
   4. S1 是刻意的等价变异：函数行为一个字没变，只改登记的形参名。它红 2 条不是误报——
      `SCOPES` 那张表是判据的入口，别名改了名判据就查无此人，整个函数从此不在账上。
      宁可红一条"表要跟着更新"，也不要安静地少扫一个函数。

   六条边界（红不到哪里，说清楚）：
   1. 只核字段名在不在，不核值。`sameSite` 递的是 `"no_restriction"` 还是 `undefined`、
      `expirationDate` 用秒还是毫秒，都不在这根轴上——那是 `logic.test.mjs` 与
      `cookie-backup.test.mjs` 拿真数据跑出来的账。
   2. `SCOPES` 是登记的：新增一个读存档的函数不进来登记，本文件不会自动看见它。
      挡得住"登记的那个别名没了 / 不再取用任何字段"（抽取形状红），挡不住"多一个读侧没人登记"。
   3. 官方那三份字段表（Cookie 对象 / `set` 的 details / `getAll` 的查询条件）是手抄的，
      仓库里没有第二份可核对，本轮也没能连上 developer.chrome.com 复核（网络被拦），
      其中 `httpOnly` 那一按是照仓库内既有事实定的（`restoreCookies` 递它、`cookieTicketScore` 读它）。
      Chrome 将来加字段，本文件不会自己知道；表现是正向点名"读侧读了个写侧没写的名字"，不是静默。
   4. 写侧只认 `backupCookies` 里的一处采集映射：`producedItemLiteral` 要求那段函数体里
      `.map((x) => ({` 恰好命中一次。真多出一处时它会红，不会退化成"取第一处"——
      而第二处采集若长在别的函数里，本文件看不见，那是"多一个读侧/写侧没人登记"的同一类边界。
   5. 夹具账认的是 "cookies 后面跟一个左方括号" 这个形状。夹具改叫别的键名就不在账上了，
      表现是参照物那几条下限红，不是静默。顺带一条自咬的面：夹具扫描走的是 `tests/tab-auto-refresh`
      下全部 `.test.mjs`，含本文件，而共用的 `stripComments` 只按行认出注释的起始行
      （`/*`、`*`、`//`），所以本文件自己的说明里写下那个形状就会变成一条夹具（实测撞过一次：
      边界这一段初稿照抄了那个写法，夹具扫描当场抛"没配平"）。改文档时避开那个字面形状即可
   6. 旧备份缺字段这一事实按"读侧不许依赖它一定在"判（就是 `hostOnly` 那三分支），
      不按清单齐不齐判：v1 存档永远不会有本轮之后新增的字段，所以正向那一条对旧数据不适用。
   键名住在哪个区、文档登记没有，是 `storage-map.test.mjs`（上一轮）的账；本文件只管键
   后面那份对象。两头都绿才叫这份存档齐。 */
