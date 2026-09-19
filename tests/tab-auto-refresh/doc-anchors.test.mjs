/* 第六轮审计（`BACKLOG.md` A24）的门禁：审的是**项目记忆与用户说明书对源码的漂移**。
   `AGENTS.md` 是给下一个协作者和下一轮审计读的那份账，里面写满了源码里的名字（函数、常量、
   存储键、消息类型）与文件路径；`README.md` 面向用户，同样列文件与截图。这一面原来零门禁：
   没有任何测试读过这两份文档，所以"产品代码改了名、记忆还写着旧名"不会让任何东西变红，
   只能靠每轮审计人肉重扫（本轮就扫出一处已经对不上的：`logic.test.mjs` 那条抖动断言
   曾被某段文字按行号引用，行号早已挪走）。

   三条判据，每条都配正反两面：
   1. 反引号里的**符号名**必须在仓库源码/测试/脚本里还存在（改名、删函数会立刻红）
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

function unresolvedIdents(idents, corpus) {
  return idents.filter((t) => !corpus.includes(t));
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
    assert.ok(CORPUS.includes(name), `${name} 在源码语料里找不到，语料没拼对`);
  }
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
   - 符号名判据是**子串匹配**：`getSettings` 出现在任何地方都算存在，包括注释与别的名字的前缀
     （`rt` 这类两三个字母的 token 基本必然命中）。它挡的是"整个仓库一个字都不剩"的改名与删除，
     挡不了"名字还在、语义已经变了"。AGENTS.md 里的默认值、阈值、权限清单本轮是人核的，
     不在这条判据的射程里
   - 语料含测试与脚本，所以"只改产品代码、测试里那个字符串还在"不会红。这一条是从判据机制
     （只问仓库里还有没有这个字面量）推出来的，没单独跑对照——C7/C9 两处都是连同测试一起改的
   - 只扫反引号里的 token：正文里裸写的英文标识符不看，`_code-review/...` 与 tag 模板整条豁免
   - 判据 2 认裸文件名，所以"文件还在但挪了目录"只有写成完整路径的那几处会红
   - 已发布的 CHANGELOG 段落不设行号判据：那是当时的事实，回头改它等于篡改账 */
