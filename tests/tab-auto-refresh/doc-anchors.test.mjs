/* 第六轮审计（`BACKLOG.md` A24）的门禁：审的是**项目记忆与用户说明书对源码的漂移**。
   `AGENTS.md` 是给下一个协作者和下一轮审计读的那份账，里面写满了源码里的名字（函数、常量、
   存储键、消息类型）与文件路径；`README.md` 面向用户，同样列文件与截图。这一面原来零门禁：
   没有任何测试读过这两份文档，所以"产品代码改了名、记忆还写着旧名"不会让任何东西变红，
   只能靠每轮审计人肉重扫（本轮就扫出一处已经对不上的：`logic.test.mjs` 那条抖动断言
   曾被某段文字按行号引用，行号早已挪走）。

   三条判据，每条都配正反两面：
   1. 反引号里的**符号名**必须在仓库源码/测试/脚本里以**整词**还存在（改名、删函数会立刻红；
      第二十一轮之前这里是子串判据，把名字少写一个字母反而算"存在"，见下面判据 1 那段注释）
   2. 反引号里的**路径**必须在仓库里存在（文件或目录；插件内相对写法与裸文件名也认）
   3. **行号锚点**（`file.ext:NNN` 与"第 N 行"）不许出现在还会改动的文档里——行号是会被
      下一次插入式改动冲掉的坐标，冲掉时零症状，只会静默指到别处。文档要锚在名字上：
      名字变了判据 1 会红

   判据 3 的覆盖面刻意不对称：`第 N 行` 只禁 `BACKLOG.md` 与 `CHANGELOG.md` 的 `[未发布]` 段，
   因为 `AGENTS.md` 与 `README.md` 用这句话指弹窗 UI 的第几行（"列表封顶 108px，第 3 行露头"），
   那是版面描述不是代码坐标。`file.ext:NNN` 在四份文档里都禁，但已发布的历史段落除外——
   那些版本号当然后面不会再改，行号是当时的事实。 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* 仓库外对照副本用（与 TAR_BG / TAR_POPUP_SRC 同一套路）：指一份完整的仓库拷贝 */
const ROOT = process.env.TAR_DOC_ROOT
  ? resolve(process.env.TAR_DOC_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CODE_FILE = /\.(?:mjs|js|json|html|css|ya?ml)$/;

/* ---------- 提取器 ---------- */

/* 仓库里的文件与目录（相对路径、正斜杠）。跳过 .git / node_modules / _code-review：
   最后一项是本地审核归档，明确不入库，拿它做存在性判断必假阳 */
function repoTree(root) {
  const files = new Set();
  const dirs = new Set([""]);
  const bases = new Set();
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === "_code-review") continue;
      const p = join(dir, name);
      const rel = p.slice(root.length + 1).split("\\").join("/");
      if (statSync(p).isDirectory()) {
        dirs.add(rel);
        walk(p);
      } else {
        files.add(rel);
        bases.add(name);
      }
    }
  })(root);
  return { files, dirs, bases };
}

/* 源码语料：所有代码/配置文本拼成一份。两处刻意排除：
   - 不含 .md，否则文档自己写过的名字会被自己证明存在
   - 不含**本文件自己**（SELF）。门禁的注释与用例里写着它盯着的那些名字，留着它等于
     "判据在注释里提过一遍的名字永远算存在"。这一条不是理论问题：C1 第一次跑就是被它掩盖的
     （把 `planPrune` 改成 `planPruneV3`，一般判据照绿，只有硬编码的正向见证那条红） */
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split("\\").join("/");
function sourceCorpus(root, files) {
  return [...files]
    .filter((p) => CODE_FILE.test(p) && p !== SELF)
    .map((p) => readFileSync(join(root, p), "utf8"))
    .join("\n");
}

/* 反引号里的 token 分三堆：路径、符号名、不算代码的（跳过）。
   顺序是判据的一部分：先把"看着像路径的 git 术语与代码成语"剔掉，再谈路径形状 */
const EXTS = new Set(["js", "mjs", "json", "html", "css", "md", "yml", "yaml", "png", "txt"]);
const NOT_A_SYMBOL = new Set([
  "winget", "choco", "scoop", "nvm", "ls-remote", "git-credential-manager.exe",
  "origin/main", "chrome-extensions",
  "changes.newValue", "permissions.onAdded", "http.proxy", "viewport.width",
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
  "try/finally",
  /* `node:` 是 import 说明符的前缀，不是谁的名字——源码里它后面永远接着 `fs`、`path`
     这一串，按整词判据必然认不出（第二十一轮的实测：全部 312 个符号名里只有它一个误伤） */
  "node:",
]);
const NOT_A_PATH = new Set(["tab-auto-refresh/vX.Y.Z", "node-vX.Y.Z-win-x64.zip"]);

function classifyToken(raw) {
  const t = raw.trim().replace(/\(\)$/, "");
  if (!/^[A-Za-z][A-Za-z0-9_.$:/-]*$/.test(t)) return null;
  if (/[<> ]/.test(t)) return null;
  if (t.includes("://")) return null;
  const key = t.replace(/\/$/, "");
  if (NOT_A_SYMBOL.has(t) || NOT_A_PATH.has(key)) return null;
  if (t.includes("/")) return { kind: "path", value: key };
  const ext = (t.match(/\.([a-z]{1,5})$/) || [])[1];
  if (ext && EXTS.has(ext)) return { kind: "path", value: key };
  return { kind: "ident", value: t };
}

function docTokens(md) {
  const paths = new Set();
  const idents = new Set();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const t = classifyToken(m[1]);
    if (!t) continue;
    (t.kind === "path" ? paths : idents).add(t.value);
  }
  return { paths: [...paths], idents: [...idents] };
}

/* 路径认三种写法：仓库根相对、插件目录相对、裸文件名（文档里常只写 `logic.js`，README 里
   也常只写 `popup.png`）。目录也算存在；`_code-review/` 前缀整条豁免，理由见 repoTree */
function unresolvedPaths(paths, tree) {
  return paths.filter((p) => {
    const rel = p.replace(/^\.\//, "");
    if (rel.startsWith("_code-review")) return false;
    const base = rel.split("/").pop();
    const hit = (q) => tree.files.has(q) || tree.dirs.has(q);
    return !(hit(rel) || hit(`tab-auto-refresh/${rel}`) || tree.bases.has(base));
  });
}

/* 判据 1 的强弱全在"整词"这两个字上（第二十一轮，`BACKLOG.md` A39）。原先是
   `corpus.includes(t)`——子串判据是**单向**的：少写一个字母、多写一个字母，只要结果仍落在
   某个真名字之内，就一律算"存在"。实测：`AGENTS.md` 把 `aggregateBadgeFacts` 写成
   `aggregateBadgeFact`，全套 570 条全绿。而这条门禁立起来的理由正是"名字变了要有人追"，
   改名之后文档留着旧名（或反过来）就是它要抓的那一类，偏偏子串判据对它最没辙：
   改名叫 `X` → `XV2` 之后，文档里的 `X` 仍是 `XV2` 的前缀，一个字都不红。
   现在要求 token 前后不许再接标识符字符（`A-Za-z0-9_$`）。点、连字符、冒号**算**分隔符，
   所以 `paused-all`、`rt:awake`、`settings.lastIntervalSec` 这些在源码里以字面量出现的
   键名照旧整串比对，不拆段——拆段等于把判据放宽回"每一段各自在别处出现过也算数"。
   21 轮实跑：AGENTS.md 与 README.md 那 312 个符号名在整词判据下全部命中（`node:` 除外，
   它是 import 前缀，见上面那张豁免表），逐段兜底一条都不需要 */
const WORD_CHAR = /[A-Za-z0-9_$]/;

function hasWholeWord(text, token) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = at + token.length >= text.length ? "" : text[at + token.length];
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/* 红的时候点名"最接近的真名字是哪个"：这一条判据抓的是手滑与改名，两种情况都期望有个
   几乎一样的真名。候选从语料现推（同一份标识符词表），测试里不抄第二份名单 */
function identVocabulary(text) {
  const words = new Set();
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) words.add(m[0]);
  return [...words];
}
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function closestTo(token, words) {
  const scored = [];
  for (const w of words) {
    const p = commonPrefix(token, w);
    if (p < 4) continue;
    scored.push([w, p * 2 - Math.abs(w.length - token.length)]);
  }
  scored.sort((x, y) => y[1] - x[1] || x[0].length - y[0].length);
  return scored.slice(0, 2).map(([w]) => w);
}

function unresolvedIdents(idents, corpus, words = identVocabulary(corpus)) {
  return idents.filter((t) => !hasWholeWord(corpus, t)).map((t) => {
    const near = closestTo(t, words);
    return near.length ? `${t}（最接近的是 ${near.join(" / ")}）` : t;
  });
}

/* `file.ext:NNN`，含 `:1234-1250` 这种区间。冒号前必须是"点 + 字母"，所以
   `127.0.0.1:51734`、`2.1.0` 这类地址与版本号不会被误伤（判据被误伤的下场是整体关掉） */
const LINE_ANCHOR = /[A-Za-z0-9_./-]+\.[A-Za-z]{1,5}:\d+(?:\s*[-–]\s*\d+)?/g;
const CN_LINE_ANCHOR = /第\s*\d+\s*行/g;

function lineAnchors(md) {
  return md.match(LINE_ANCHOR) || [];
}
function cnLineAnchors(md) {
  return md.match(CN_LINE_ANCHOR) || [];
}

/* CHANGELOG 的 `[未发布]` 段：从那一行标题起，到下一个二级标题止 */
function unreleasedSection(changelog) {
  const start = changelog.indexOf("## [未发布]");
  if (start < 0) return "";
  const rest = changelog.slice(start);
  const next = rest.indexOf("\n## [", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

/* ---------- 一、正向见证：先证明提取器在真文档上吃到了东西 ---------- */

const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
const README = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
const TREE = repoTree(ROOT);
const CORPUS = sourceCorpus(ROOT, TREE.files);
const AG = docTokens(AGENTS);
const RD = docTokens(README);

test("提取器不是对着空集合绿过去的：AGENTS.md 两堆 token 都有量", () => {
  /* 判据 1/2 都是"集合为空即绿"。提取正则坏一处、或文档改了反引号写法，全套会静默变空 */
  assert.ok(AG.idents.length >= 250, `AGENTS.md 只认出 ${AG.idents.length} 个符号名，提取器或文档写法变了`);
  assert.ok(AG.paths.length >= 45, `AGENTS.md 只认出 ${AG.paths.length} 条路径`);
  assert.ok(TREE.files.size >= 60, `仓库只认出 ${TREE.files.size} 个文件，遍历没跑起来`);
  assert.ok(CORPUS.length >= 500000, `源码语料只有 ${CORPUS.length} 字，等于没拼到东西`);
});

test("README 同样吃到路径与符号（这一面也要有覆盖面）", () => {
  assert.ok(RD.paths.length >= 10, `README.md 只认出 ${RD.paths.length} 条路径`);
  assert.ok(RD.idents.length >= 5, `README.md 只认出 ${RD.idents.length} 个符号名`);
});

test("判据不是把所有 token 都当缺失：真在用的那批逐个认得", () => {
  /* 与下一条反向。少这一条，unresolvedIdents 写成恒返回全表也能"绿"着把所有名字报缺失 */
  for (const name of ["planPrune", "decideAlarmAction", "patchSettings", "rtRoundKeys", "outboundUrl"]) {
    assert.ok(AG.idents.includes(name), `AGENTS.md 该列出 ${name}，认出的是另一批`);
    assert.ok(hasWholeWord(CORPUS, name), `${name} 在源码语料里不是整词，语料没拼对`);
  }
  /* 整词判据比子串严，所以这一条要拿**真语料**验一面：文档里少写一个字母的那种写法，
     在真语料上也必须认不出。只有正面无这一句，判据哪天退回 `includes` 也照样全绿 */
  assert.equal(
    unresolvedIdents(["aggregateBadgeFact"], CORPUS).length, 1,
    "`aggregateBadgeFact`（真名少写一个 s）在真语料上被认成了存在——整词判据退化成子串了"
  );
  assert.ok(AG.idents.length + RD.idents.length >= 300, "两堆符号名的总量掉下来了，提取器或文档写法变了");
});

/* ---------- 二、判据 1：符号名必须还在 ---------- */

test("AGENTS.md 提到的每个符号名在仓库里都还存在", () => {
  const missing = unresolvedIdents(AG.idents, CORPUS);
  assert.deepEqual(missing, [], "项目记忆写着仓库里已经不存在的名字（改过名或已删）");
});

test("README.md 提到的每个符号名在仓库里都还存在", () => {
  assert.deepEqual(unresolvedIdents(RD.idents, CORPUS), []);
});

/* ---------- 三、判据 2：路径必须还在 ---------- */

test("AGENTS.md 提到的每条路径在仓库里都存在", () => {
  const bad = unresolvedPaths(AG.paths, TREE);
  assert.deepEqual(bad, [], "项目记忆指向了不存在的路径（文件被移动或删掉）");
});

test("README.md 提到的每条路径在仓库里都存在", () => {
  assert.deepEqual(unresolvedPaths(RD.paths, TREE), []);
});

test("路径判据认插件目录内的相对写法，也认裸文件名", () => {
  /* 不认这两种写法的话，`shared/logic.js`、`popup.js` 会全报缺失，判据只能被放宽成空判 */
  const tree = {
    files: new Set(["tab-auto-refresh/shared/logic.js", "tab-auto-refresh/popup.js"]),
    dirs: new Set([""]),
    bases: new Set(["logic.js", "popup.js"]),
  };
  assert.deepEqual(unresolvedPaths(["shared/logic.js", "popup.js", "tab-auto-refresh/popup.js"], tree), []);
  assert.deepEqual(unresolvedPaths(["shared/other.js", "nope.js"], tree), ["shared/other.js", "nope.js"]);
});

test("分类器不把 git 术语和代码成语当成路径", () => {
  /* 这两条是写判据时真踩过的：origin/main 与 try/finally 都含斜杠，进了路径堆就永远"不存在"，
     判据 2 变成常驻红，然后被人整体关掉 */
  for (const s of ["origin/main", "try/finally", "winget", "viewport.width", "ls-remote"]) {
    assert.equal(classifyToken(s), null, `${s} 不该被收进任何一堆`);
  }
  assert.equal(classifyToken("tab-auto-refresh/vX.Y.Z"), null, "tag 模板不是仓库里存在的对象");
  assert.deepEqual(docTokens("见 `tab-auto-refresh/manifest.json` 与 `tests/`").paths.sort(),
    ["tab-auto-refresh/manifest.json", "tests"]);
});

/* ---------- 四、判据 3：行号锚点 ---------- */

const BACKLOG = readFileSync(join(ROOT, "BACKLOG.md"), "utf8").replace(/\r\n/g, "\n");
const UNRELEASED = unreleasedSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n"));

test("CHANGELOG 的 [未发布] 段取到的是正文，不是空串也不是整份文件", () => {
  /* 下面两条判据只吃这一段，段取空就等于永不触发 */
  assert.ok(UNRELEASED.length >= 8000, `[未发布] 段只取到 ${UNRELEASED.length} 字`);
  assert.ok(UNRELEASED.startsWith("## [未发布]"));
  assert.ok(!/\n## \[tab-auto-refresh/.test(UNRELEASED), "越界吃进了已发布版本段落");
});

test("活文档里不许有 file.ext:NNN 行号锚点", () => {
  const where = {
    "AGENTS.md": lineAnchors(AGENTS),
    "README.md": lineAnchors(README),
    "BACKLOG.md": lineAnchors(BACKLOG),
    "CHANGELOG [未发布]": lineAnchors(UNRELEASED),
  };
  for (const [name, hits] of Object.entries(where)) {
    assert.deepEqual(hits, [], `${name} 里有行号锚点：改成按名字锚，改名才追得上（判据 1）`);
  }
});

test("BACKLOG 与 [未发布] 段也不许有「第 N 行」式锚点", () => {
  /* AGENTS.md 与 README.md 里这句话是弹窗版面（"第 3 行露头"），刻意不在禁区内。
     写成一条独立 test 而不是并进上一条，免得这个不对称被读成漏了一处 */
  assert.deepEqual(cnLineAnchors(BACKLOG), [], "BACKLOG 通篇是还会改的账");
  assert.deepEqual(cnLineAnchors(UNRELEASED), []);
});

test("行号判据抓得住：注入一条就得报一条", () => {
  assert.deepEqual(lineAnchors("见 `logic.test.mjs:294` 与 `background.js:1817-1819`"),
    ["logic.test.mjs:294", "background.js:1817-1819"]);
  assert.deepEqual(cnLineAnchors("另有第 792 行同名判据"), ["第 792 行"]);
  /* 反向：代理地址、版本号、端口都不是锚点 */
  assert.deepEqual(lineAnchors("走本机 10808 的 SOCKS，127.0.0.1:51734 与 2.1.0"), []);
});

test("符号名判据抓得住：改了名的记忆会红", () => {
  const { idents } = docTokens("`planPrune` 与 `decidePlanPruning` 都要看");
  assert.deepEqual(unresolvedIdents(idents, "function planPrune() {}"), ["decidePlanPruning"]);
});

test("整词才是存在：子串不算（第二十一轮补的那一半）", () => {
  /* 这一条是本轮的立论本身。子串判据漏报的方向是**文档写短了**：真名在语料里，
     文档那个 token 是它的一段，于是"存在"。下面两种写法都是这一类 */
  const corpus = "export function aggregateBadgeFacts({ tasks }) { return Object.keys(tasks); }";
  const words = identVocabulary(corpus);
  for (const typo of ["aggregateBadgeFact", "aggregateBadge"]) {
    assert.ok(corpus.includes(typo), `${typo} 在子串判据下本该"存在"，本用例的前提是它确实存在`);
    assert.deepEqual(
      unresolvedIdents([typo], corpus, words),
      [`${typo}（最接近的是 aggregateBadgeFacts）`],
      `${typo} 不是整词，判据却说它存在`
    );
  }
  /* 反方向子串判据本来就抓得住：文档写长了不是语料的子串。记在这里是为了说清这一条
     补的是**单向**的洞，不是"原来什么都不红" */
  assert.ok(!corpus.includes("aggregateBadgeFactsEs"), "前提变了：长写在这一台里不是子串");
  assert.deepEqual(unresolvedIdents(["aggregateBadgeFactsEs"], corpus, words),
    ["aggregateBadgeFactsEs（最接近的是 aggregateBadgeFacts）"]);
  /* 真名自己必须命中；而反向那种"代码改名成文档名的超集"（`X` → `XV2`、文档不动）
     正是子串判据最没辙的一种，现在红 */
  assert.deepEqual(unresolvedIdents(["aggregateBadgeFacts"], corpus, words), []);
  assert.ok(!hasWholeWord("const badgeFactsV2 = 1;", "badgeFacts"));
  /* 分隔符那一头：点、连字符、冒号都不接标识符字符，所以以字面量存在的键名整串认得 */
  for (const [key, text] of [
    ["paused-all", 'const r = "paused-all";'],
    ["rt:awake", 'await rtSet("rt:awake", true);'],
    ["settings.lastIntervalSec", "settings.lastIntervalSec = n;"],
  ]) {
    assert.ok(hasWholeWord(text, key), `${key} 在源码里就是那一串字面量，整词判据必须认`);
  }
});

test("红的时候点名最接近的真名字（让人不用回头 grep）", () => {
  const corpus = "function pruneStaleProbes() {} function prunePlan() {} const PRUNE_DONE = 1;";
  const [msg] = unresolvedIdents(["pruneStaleProbe"], corpus);
  assert.match(msg, /^pruneStaleProbe（最接近的是 /);
  assert.match(msg, /pruneStaleProbes/, `提示里没有那个只差一个字母的真名：${msg}`);
  /* 没有相近候选时要如实说"没有"，不许硬凑一个不相干的（凑出来的提示比没有更费时间） */
  assert.deepEqual(unresolvedIdents(["zzzzNope"], corpus), ["zzzzNope"]);
});

test("`node:` 不成堆：import 前缀后面永远接着模块名，按整词必然认不出", () => {
  assert.equal(classifyToken("node:"), null, "`node:` 被当成符号名了，正则会红在真文档那两条上");
  assert.ok(!AG.idents.includes("node:"));
});

/* ---------- 五、对照与已知边界（实跑记录） ----------

   对照在仓库外**整仓**副本上跑（`_tar_ctl_r6/run.mjs`，判据吃 `TAR_DOC_ROOT`）。
   整仓而不是只拷文档：三条判据两头都吃仓库（文档给 token，代码给语料与路径表）。
   base 先跑一遍 14 条全绿，再逐处改坏，红名单实测：

   C1 AGENTS.md 里 `planPrune` → `planPruneV3`（记忆写了不存在的名字）…… 红 2：一般判据
      「AGENTS.md 提到的每个符号名在仓库里都还存在」加硬编码正向见证那条
   C2 AGENTS.md 里 `tests/tab-auto-refresh/skip-trace.test.mjs` 打错一个字母 …… 红 1（路径）
   C3 删掉副本里的 `tests/tab-auto-refresh/skip-trace.test.mjs` 整个文件 …… 红 1（路径）
      —— C2 与 C3 落同一处，是刻意的：路径判据管的既是"抄错"也是"文件没了"
   C4 AGENTS.md 末尾塞一行「对照见 `background.js:1817-1819`」…… 红 2：行号判据，外加
      符号名判据——这条 token 不含斜杠、结尾不是已知扩展名，所以进了符号名堆。两头一起红不是
      判据重叠失效，是行号锚本来就同时是"文档里出现的一个代码坐标字面量"
   C5 BACKLOG 末尾塞「另有第 792 行同名判据兜着」…… 红 1（中文锚点）
   C6 `[未发布]` 段里塞回 `logic.test.mjs:294` …… 红 1（行号判据）
   C7 把 `RECLAIM_WATCH_MS` 在副本的所有代码文本里改成 `RECLAIM_WATCH_LIMIT`（改名提交落了地、
      测试跟着改了，只有项目记忆没改）…… 红 1，正是本轮要防的那一类
   C8 README.md 里 `scripts/screenshot-popup.mjs` → `scripts/shot-popup.mjs` …… 红 1（README 路径）
   C9 同 C7 但换 `decideWallFromFrames`（这名字 AGENTS.md 提两遍、且测试文件里到处是）…… 红 1

   **一条自我纠正**：C1 第一次跑只红正向见证那一条，一般判据照绿——因为语料把**本文件自己**
   也算进去了，而它的注释里正写着 `planPruneV3`（对照清单）。判据在注释里提过一遍的名字
   从此永远算存在，这一面看着有门禁、实际是自证。排除自身（SELF）之后 C1 才红到一般判据。
   同一次还顺手量出路径正则的扩展名分支要长名在前：`js|json` 这种次序会把
   `manifest.json` 截成 `manifest.js`，判据立刻指错文件

   已知边界（写在这里，免得被当成已覆盖）：
   - ~~符号名判据是子串匹配~~ —— 这一条在第二十一轮被换掉了，见下面那一节。现在的边界是
     "整词"这一层：它挡的是"名字在语料里不再以整词出现"，挡不了"名字还在、语义已经变了"。
     AGENTS.md 里的默认值、阈值、权限清单由 `doc-numbers.test.mjs` 与人核，不在这条判据的射程里
   - 语料含测试与脚本，所以"只改产品代码、测试里那个字符串还在"不会红。**这一条本轮实测过**
     （T6），不再是推出来的
   - 只扫反引号里的 token：正文里裸写的英文标识符不看，`_code-review/...` 与 tag 模板整条豁免
   - 判据 2 认裸文件名，所以"文件还在但挪了目录"只有写成完整路径的那几处会红
   - 已发布的 CHANGELOG 段落不设行号判据：那是当时的事实，回头改它等于篡改账

   ---------- 第二十一轮（`BACKLOG.md` A39）：判据 1 从子串换成整词 ----------

   立论是上一轮顺手量出来的：`AGENTS.md` 把 `aggregateBadgeFacts` 少写一个 `s`，全套 570 条全绿。
   那一处红不出来不是覆盖面小，是**判据方向**的问题——`corpus.includes(t)` 只问"文档那个 token
   在语料里是不是某处的一段"，于是两个方向一起漏：文档写短了（是某个真名的一段）算存在，
   代码改名成文档名的超集（`X` → `XV2`、文档不动）也算存在。而后者正是这条门禁立起来要抓的那一类。

   7 台在仓库外**整仓**副本上跑 pre/post（脚本 `D:/Github/_tar_ctl_r21/ctl21.mjs`，日志
   `ctl21.log`）。**这一轮的 pre 不是删掉门禁文件**——本文件本轮之前就存在，删掉它会把路径与行号
   两条判据一起摘掉，pre 就成了"三条判据全瞎"而不是"判据 1 是子串"。所以 pre 换回上一版
   （`doc-anchors.old.mjs`，`git show HEAD:` 取来的那份），post 留着本版；两侧 `validate.mjs` 全 OK，
   两侧都恰好 17 条用例，pre 那一列的零红是**旧判据在同样的仓库上真的什么都不红**：

   | 变异 | pre | post |
   | --- | --- | --- |
   | K0 pristine | 全绿 | 全绿（本文件不误伤） |
   | T1 文档少写尾字母（`aggregateBadgeFacts` → `aggregateBadgeFact`） | 0 | 1：AGENTS 符号名，消息点名真名 |
   | T2 文档写长名字**中间**那一段（→ `BadgeFacts`） | 0 | 1：同上，无提示（没有共享前缀的候选） |
   | T3 代码改名成文档名的超集，**产品码与测试注释一起改**、只有记忆不动 | 0 | 1：同上，消息原文 `pruneStaleProbes（最接近的是 pruneStaleProbesV2 / pruneCookieBackups）` |
   | T4 同一次改名连文档一起改（完整改名） | 0 | 0（不误伤的反面） |
   | T5 拿掉本轮自己加的 `node:` 豁免 | 0 | 2：AGENTS 符号名 + 那条豁免自己的用例 |
   | T6 改名只落产品码、测试注释里旧名还在 | 0 | 0（已知边界，见上） |

   怎么读这张表：
   - **pre 那一列六个"0"是本轮的账目本身**。T1/T2/T3 三台在旧判据下一个都不红，而它们是同一条
     判据要抓的三种写法：抄短了、截中间、代码改了名文档没改
   - T3 与 T6 是同一台改名的两种落地程度，落点相反：改到"整个仓库不再以整词出现"就红，
     只改产品码就不红。差的那一步是测试文件注释里还留着旧名字——语料含测试，这是上面那条边界，
     不是本轮新暴露的。两台一起跑是为了把这条边界的**形状**记下来（它以前只是推出来的）
   - T2 没有提示：候选要求与文档那个 token 共享至少四个字符的前缀，`BadgeFacts` 与
     `aggregateBadgeFacts` 前缀对不上（大小写敏感）。这是刻意的——凑一个不相干的名字进消息
     比留空更费时间，规则写在"红的时候点名最接近的真名字"那条用例里
   - T5 是本轮**自己加的那处豁免**的对照：`node:` 是 import 说明符前缀，源码里后面永远接着
     `fs`、`test` 这些字，整词判据必然认不出。旧判据下它侥幸不红（`corpus.includes("node:")`
     因为 `"node:test"` 而成立），所以那一列的 0 不是"旧判据更好"，是同一处侥幸
   - 本轮把正向见证那一条改成拿真语料验反面（`aggregateBadgeFact` 在真语料上必须认不出）。
     第一版把它写成"整份 AGENTS.md 全命中"，于是 T1 与 T3 各红两条——两条红的是同一件事。
     现在一般判据管文档，见证管机制，任何一台都只红一条

   改完判据之后重跑本文件：14 → **17** 条；全套 570 → **573** 条全绿。
   312 个符号名（AGENTS.md 与 README.md 去重）在整词判据下全部命中，只有 `node:` 一处需要豁免 */
