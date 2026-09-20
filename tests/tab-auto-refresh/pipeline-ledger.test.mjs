/* 第二十五轮审计（`BACKLOG.md` A43）的门禁：`.github/workflows/` 那两份文件是仓库里唯一
   "改了不报错、只是不干活"的一批，此前 `tests/` 与 `scripts/` 里没有任何文件提到过它们。
   要量的名字与路径一共这些处：

   1. 测试 glob：`.github/workflows/ci.yml` ↔ `release.yml` ↔ 根 `package.json` 的 test 脚本，
      三处写的是同一串，而这一串必须真匹配到仓库里的每一个 `.test.mjs`
   2. 校验命令 `node scripts/validate.mjs`：同样三处，且那个文件真存在
   3. `node-version` 与 `actions/setup-node@vN`：两份 workflow ↔ `AGENTS.md` 的两处写法
   4. 一个名字串起十一处：`release.yml` 的 tag 模式 `tab-auto-refresh/v*` 的名字段 ↔
      根 `package.json` 的 `name` ↔ 插件目录真名 ↔ 三处 `${GITHUB_REF_NAME#…/}` ↔
      清理那一步的 `matching-refs/tags/tab-auto-refresh%2F` ↔ `AGENTS.md` 与 `README.md`
      那句发布说明 ↔ `CHANGELOG.md` 每个发布标题的名字段 ↔ `git archive` 的 `--prefix` 与
      `:<目录>` ↔ 版本比对那一步 `require('./tab-auto-refresh/manifest.json')` 的目录段
   5. 版本算术：manifest 版本拼成 tag，按 workflow 里那两步参数展开剥回来还得是它
   6. 步骤次序与写权限：校验和单测排在版本比对之前、版本比对排在打包之前……
      有 `gh release create/delete` 与 `git push --delete` 的文件必须声明 `contents: write`

   为什么这一格值得单独立账（实测，见文件末尾）：glob 漂一个字母时 `node --test` 退出码 0
   并且只报 `ℹ tests 0`，CI 从此对着空集合绿过去，本轮新加的门禁一条都不会在 CI 上跑；
   tag 前缀漂了更安静——打 tag 什么都不触发，Release 不建，用户下载不到东西，仓库侧零症状。
   两处都对不上时唯一的声音是"没声音"。

   YAML 一律按行形状切，不写解析器：这里要量的是某一行的字面量，不是嵌套结构。
   认不出的形状一律抛（本文件不许安静地少切一条判据）。所有比较都走纯函数，
   所以末尾那三台常驻对照能拿改过的输入叫同一段代码再判一遍。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CI_FILE = ".github/workflows/ci.yml";
const REL_FILE = ".github/workflows/release.yml";
const CI_TEXT = read(CI_FILE);
const REL_TEXT = read(REL_FILE);
const PKG = JSON.parse(read("package.json"));
const AGENTS_TEXT = read("AGENTS.md");
const README_TEXT = read("README.md");
const CHANGELOG_TEXT = read("CHANGELOG.md");

/* ---------- 一、切取原语 ---------- */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 本文件只用这一种通配翻译：`**` 匹配零或多段目录，`*` 匹配一段内不含斜杠的任意字符。
   出现别的通配写法就抛——那时"匹配得上"这件事得重新论证，不能沿用今天这套正则 */
function globToRe(glob) {
  const segs = glob.split("/");
  let re = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      re += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    if (!seg.length) throw new Error(`glob 里有空段：${glob}`);
    if (/[{[?]/.test(seg)) throw new Error(`glob 里出现本文件不认的通配：${glob}`);
    re += esc(seg).replace(/\\\*/g, "[^/]*");
    if (!last) re += "/";
  });
  return new RegExp("^" + re + "$");
}

/* 仓库里真实的测试文件清单（相对 ROOT，正斜杠；glob 量的就是这个相对形状） */
function walk(dir, prefix = "") {
  const out = [];
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = prefix ? prefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...walk(join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}
const TEST_FILES = walk("tests").filter((f) => f.endsWith(".test.mjs")).map((f) => "tests/" + f);

/* 步骤表：`- uses:` / `- name:` 开一步，`run: |` 收块、`run: 一行` 收单行。
   只认这份仓库今天的写法，别的（`>-`、缩进不认识的块）一律抛 */
function stepsOf(text, label) {
  const lines = text.split("\n");
  const steps = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    cur.run = cur.body.length ? cur.body.join("\n").replace(/\s+$/, "") : null;
    if (cur.run === "") cur.run = null;
    delete cur.body;
    steps.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^\s*-\s+uses:\s*(\S+)\s*$/);
    if (m) {
      close();
      cur = { uses: m[1], name: null, body: [] };
      continue;
    }
    m = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (m) {
      close();
      cur = { uses: null, name: m[1].replace(/^"|"$/g, ""), body: [] };
      continue;
    }
    m = line.match(/^(\s*)(\w+):\s*(\|[+-]?|>[+-]?)?\s*(.*)$/);
    if (m && m[2] === "run") {
      if (!cur) throw new Error(`${label}：一个 run: 排在任何步骤之前`);
      const style = m[3] || "";
      if (style && style !== "|") throw new Error(`${label}：run 用了 "${style}" 这种块写法，本文件不认`);
      if (style) {
        const indent = m[1].length;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const body = lines[j];
          if (body.trim() === "") {
            cur.body.push("");
            continue;
          }
          if (body.match(/^\s*/)[0].length <= indent) break;
          cur.body.push(body);
        }
        i = j - 1;
      } else {
        if (!m[4].trim()) throw new Error(`${label}：${cur.name || "某步"} 的 run: 是空的`);
        cur.body.push(m[4].trim());
      }
      continue;
    }
  }
  close();
  if (steps.length < 2) throw new Error(`${label}：只切出 ${steps.length} 个步骤`);
  return steps;
}

const runText = (steps) => steps.map((s) => s.run || "").join("\n");

/* ${VAR#pattern} 的参数展开：本仓库这三处剥的都是字面量前缀，出现通配就抛 */
function bashStrip(value, pattern) {
  if (/[*?[\]]/.test(pattern)) throw new Error(`本文件只算字面量前缀剥离，收到 "${pattern}"`);
  return value.startsWith(pattern) ? value.slice(pattern.length) : value;
}

/* ---------- 二、判据本体（纯函数） ---------- */

/* glob 账：三处写法要一模一样，而每一处都得真吃到仓库里全部测试文件 */
function globLedger(globs, files) {
  const problems = [];
  const values = [...new Set(globs.map((g) => g.glob))];
  if (values.length !== 1) problems.push(`测试 glob 有 ${values.length} 种写法：${values.join(" / ")}`);
  for (const g of globs) {
    const re = globToRe(g.glob);
    const hit = files.filter((f) => re.test(f));
    if (!hit.length) {
      problems.push(`${g.label} 里的 "${g.glob}" 一个测试文件都匹配不到——实测 node --test 这时退出码仍是 0，` +
        `CI 会对着空集合绿过去，新加的门禁一条都不会在 CI 上跑`);
      continue;
    }
    const missed = files.filter((f) => !re.test(f));
    if (missed.length) {
      problems.push(`${g.label} 的 "${g.glob}" 漏掉 ${missed.length} 个真实测试文件（这些文件从此不进 CI）：` +
        missed.slice(0, 3).join(", ") + (missed.length > 3 ? " …" : ""));
    }
  }
  return problems;
}

/* 命令账：三处写的是同一条命令，且命令里那个文件真存在 */
function cmdLedger(cmds, exists) {
  const problems = [];
  const values = [...new Set(cmds.map((c) => c.cmd))];
  if (values.length !== 1) problems.push(`校验命令有 ${values.length} 种写法：${values.join(" / ")}`);
  const paths = [...new Set(cmds.map((c) => c.path))];
  if (paths.length !== 1) problems.push(`校验命令指向 ${paths.length} 个不同文件：${paths.join(" / ")}`);
  if (paths.length === 1 && !exists(paths[0])) problems.push(`校验命令指向的 ${paths[0]} 不存在`);
  return problems;
}

/* 名字账：从 tag 模式推出名字段，其余九处必须都是同一个。value 为 null 表示"那处根本没提到" */
function nameLedger(ns, sites) {
  const problems = [];
  for (const s of sites) {
    if (s.value === null) problems.push(`${s.label}：没认出名字段（那里改写法了，或那条东西没了）`);
    else if (s.value !== ns) problems.push(`${s.label} 写的是 "${s.value}"，而 tag 前缀的名字段是 "${ns}"`);
  }
  return problems;
}

/* 版本算术账：按 workflow 里那两步参数展开真跑一遍，再核 zip 名与 --prefix */
function versionLedger({ tagPattern, refStrips, vStrips, zipTemplates, manifestVersion }) {
  const problems = [];
  const m = tagPattern.match(/^(.*)\/(v)\*$/);
  if (!m) return [`tag 模式 "${tagPattern}" 不是 "<名字>/v*" 这个形状，本文件算不了版本号`];
  const ns = m[1];
  if ([...new Set(refStrips)].length !== 1) problems.push(`剥 tag 前缀的表达式有两种：${[...new Set(refStrips)].join(" / ")}`);
  const stripTo = refStrips[0];
  if (!stripTo) return problems.concat(["切不到 ${GITHUB_REF_NAME#…} 那一步"]);
  const tag = ns + "/v" + manifestVersion;
  let version = tag;
  for (const p of [stripTo]) version = bashStrip(version, p);
  if (version !== "v" + manifestVersion) {
    problems.push(`tag "${tag}" 按 \${GITHUB_REF_NAME#${stripTo}} 剥出来是 "${version}"，不是 "v${manifestVersion}"`);
  }
  if ([...new Set(vStrips)].length !== 1) problems.push(`剥 v 的表达式有两种：${[...new Set(vStrips)].join(" / ")}`);
  const vStrip = vStrips[0];
  let bare = version;
  if (vStrip) bare = bashStrip(version, vStrip);
  if (bare !== manifestVersion) {
    problems.push(`一路算下来的 tag 版本是 "${bare}"，而 manifest 写的是 "${manifestVersion}"：` +
      `发布 workflow 里那两步展开与 tag 的形状对不上，比对当场失败或比对到错的东西`);
  }
  for (const t of zipTemplates) {
    const want = t.tpl.replace(/\$\{VERSION\}/g, "v" + manifestVersion);
    const prefixDir = t.prefix ? t.prefix.replace(/\/$/, "") : null;
    if (prefixDir && !want.startsWith(prefixDir + "-")) {
      problems.push(`zip 名 "${want}" 与 --prefix 的目录 "${prefixDir}" 不同源：产物名与解压出来的文件夹名对不上`);
    }
    if (!/\.zip$/.test(want)) problems.push(`zip 名 "${want}" 不以 .zip 结尾，Release 那一头按文件名挑资产会挑空`);
  }
  return problems;
}

/* 步骤次序账：角色按运行内容认，不按步骤名（名字是给人看的，漂了就红在别处） */
const ROLES = [
  ["闸门（校验 + 单测）", /scripts\/validate\.mjs[\s\S]*--test|--test[\s\S]*scripts\/validate\.mjs/],
  ["比对 tag 版本与 manifest 版本", /TAG_VERSION/],
  ["打包 zip", /git\s+archive/],
  ["建 Release", /gh\s+release\s+create/],
  ["清理旧 Release 与 tag", /gh\s+release\s+delete/]
];
function orderLedger(steps) {
  const found = ROLES.map(([role, re]) => {
    const idx = steps.findIndex((s) => s.run && re.test(s.run));
    return { role, idx };
  });
  const missing = found.filter((f) => f.idx < 0).map((f) => `release.yml 里没有哪一步在干「${f.role}」这件事`);
  if (missing.length) return missing;
  const outOfOrder = [];
  for (let i = 1; i < found.length; i++) {
    if (found[i].idx <= found[i - 1].idx) {
      outOfOrder.push(`「${found[i].role}」排在「${found[i - 1].role}」之前或同一步：` +
        (i === 1 ? "未跑校验与单测就比对/打包，等于把没测过的东西发布出去" : "顺序不是语义里那个顺序"));
    }
  }
  return outOfOrder;
}

/* 写权限账：有写操作的 workflow 必须声明 contents: write，没有的不许白要 */
function permLedger(yamlLabel, steps, permBlock, writeRe) {
  const hasWrite = steps.some((s) => s.run && writeRe.test(s.run));
  const declares = /contents:\s*write/.test(permBlock);
  const problems = [];
  if (hasWrite && !declares) {
    problems.push(`${yamlLabel} 里有发布与删除动作，却没声明 contents: write：那些步骤会 403 失败，` +
      `而清理那两步都带 || true，静默什么都不清`);
  }
  if (!hasWrite && declares) problems.push(`${yamlLabel} 声明了 contents: write，可它一个写操作都没有：白给的权限`);
  return problems;
}

/* ---------- 三、真文件上的账 ---------- */

const CI_STEPS = stepsOf(CI_TEXT, CI_FILE);
const REL_STEPS = stepsOf(REL_TEXT, REL_FILE);
const ALL_RUNS = [[CI_FILE, runText(CI_STEPS)], [REL_FILE, runText(REL_STEPS)], ["package.json", Object.values(PKG.scripts || {}).join("\n")]];

const GLOBS = ALL_RUNS.flatMap(([label, text]) => [...text.matchAll(/--test\s+"([^"]+)"/g)].map((m) => ({ label, glob: m[1] })));
const VAL_CMDS = ALL_RUNS.flatMap(([label, text]) => [...text.matchAll(/node\s+(scripts\/validate\.mjs)/g)].map((m) => ({ label, cmd: "node " + m[1], path: m[1] })));
const NODE_VERSIONS = [[CI_FILE, CI_TEXT], [REL_FILE, REL_TEXT], ["AGENTS.md（那两行）", AGENTS_TEXT]]
  .map(([label, text]) => {
    const all = [...text.matchAll(/node-version:\s*(\d+)/g)].map((m) => m[1]);
    const prose = [...text.matchAll(/用 Node (\d+)/g)].map((m) => m[1]);
    return { label, values: [...new Set(all.concat(prose))] };
  });
const SETUP_NODES = [[CI_FILE, CI_TEXT], [REL_FILE, REL_TEXT], ["AGENTS.md", AGENTS_TEXT]].map(([label, text]) => ({
  label, values: [...new Set([...text.matchAll(/setup-node@v(\d+)/g)].map((m) => m[1]))]
}));

/* tag 模式与那一串名字段 */
function tagPatternOf(text) {
  const at = text.search(/^\s*tags:\s*$/m);
  if (at < 0) throw new Error(`${REL_FILE} 里没有 on.push.tags 这一块`);
  const items = [...text.slice(at).matchAll(/^\s*-\s+"([^"\n]+)"/gm)];
  if (items.length !== 1) throw new Error(`${REL_FILE} 的 tags 清单有 ${items.length} 条，本文件按一条写`);
  return items[0][1];
}
const TAG_PATTERN = tagPatternOf(REL_TEXT);
const NS = TAG_PATTERN.replace(/\/v\*$/, "");
if (NS === TAG_PATTERN) throw new Error(`tag 模式 "${TAG_PATTERN}" 不是 "<名字>/v*" 这个形状`);

const REF_STRIPS = [...REL_TEXT.matchAll(/\$\{GITHUB_REF_NAME#([^}]*)\}/g)].map((m) => m[1]);
const V_STRIPS = [...REL_TEXT.matchAll(/\$\{VERSION#([^}]*)\}/g)].map((m) => m[1]);
const PRUNE_ENCODED = (REL_TEXT.match(/matching-refs\/tags\/([A-Za-z0-9_%-]+)/) || [])[1] || null;
const ARCHIVE_PREFIX = (REL_TEXT.match(/--prefix="([^"]*)"/) || [])[1] || null;
const ARCHIVE_REF = (REL_TEXT.match(/"\$\{GITHUB_REF_NAME\}:([^"\s]+)"/) || [])[1] || null;
const REQUIRE_PATH = (REL_TEXT.match(/require\('([^']*manifest\.json)'\)/) || [])[1] || null;
const ZIP_TPLS = [...REL_TEXT.matchAll(/-o\s+"([^"]*\.zip)"/g)].map((m) => ({ tpl: m[1], prefix: ARCHIVE_PREFIX }));
const RELEASE_HEADINGS = [...CHANGELOG_TEXT.matchAll(/^## \[([^\] ]+) [^\]]*\]/gm)].map((m) => m[1]);
const DOC_MENTIONS = [["AGENTS.md", AGENTS_TEXT], ["README.md", README_TEXT]].map(([label, text]) => {
  const m = text.match(new RegExp("([A-Za-z0-9_-]+)/v(?:X|\\d)"));
  return { label, value: m ? m[1] : null };
});
const PLUGIN_DIRS = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, e.name, "manifest.json")))
  .map((e) => e.name);
if (PLUGIN_DIRS.length !== 1) throw new Error(`仓库里有 ${PLUGIN_DIRS.length} 个含 manifest.json 的目录，认不出插件目录`);

const MANIFEST_VERSION = JSON.parse(read(PLUGIN_DIRS[0] + "/manifest.json")).version;
const NAME_SITES = [
  { label: `${REL_FILE} 的 on.push.tags 模式`, value: NS },
  { label: "根 package.json 的 name", value: PKG.name ?? null },
  { label: "插件目录真名（含 manifest.json 的那一个）", value: PLUGIN_DIRS[0] },
  { label: `${REL_FILE} 的 \${GITHUB_REF_NAME#…/}（共 ${REF_STRIPS.length} 处）`,
    value: [...new Set(REF_STRIPS)].length === 1 ? REF_STRIPS[0].replace(/\/$/, "") : "多种写法" },
  { label: `${REL_FILE} 清理那一步的 URL 编码前缀`, value: PRUNE_ENCODED && decodeURIComponent(PRUNE_ENCODED).replace(/\/$/, "") },
  ...DOC_MENTIONS,
  { label: `CHANGELOG.md 的发布标题名字段（共 ${RELEASE_HEADINGS.length} 个）`,
    value: [...new Set(RELEASE_HEADINGS)].length === 1 ? RELEASE_HEADINGS[0] : "多种写法" },
  { label: `${REL_FILE} 的 git archive --prefix`, value: ARCHIVE_PREFIX && ARCHIVE_PREFIX.replace(/\/$/, "") },
  { label: `${REL_FILE} 的 git archive 引用路径`, value: ARCHIVE_REF },
  { label: `${REL_FILE} 的 require('…/manifest.json') 目录段`,
    value: REQUIRE_PATH && REQUIRE_PATH.replace(/^\.\//, "").replace(/\/manifest\.json$/, "") }
];

const PERMS = [[REL_FILE, REL_STEPS, /(^|\n)permissions:\n(?:\s+\w+: \w+\n)*/.exec(REL_TEXT)?.[0] || "", /gh\s+release\s+(create|delete)|git\s+push[^\n]*--delete/],
              [CI_FILE, CI_STEPS, /(^|\n)permissions:\n(?:\s+\w+: \w+\n)*/.exec(CI_TEXT)?.[0] || "", /gh\s+release\s+(create|delete)|git\s+push[^\n]*--delete/]];

/* 同一行 markdown 里图片地址与链接目标各出现一次，所以按去重后的"指向几种 workflow"计数 */
const BADGES = [...new Set([...README_TEXT.matchAll(/actions\/workflows\/([^/\s"]+\.yml)/g)].map((m) => m[1]))];

/* ---------- 四、抽取形状 ---------- */

test("抽取形状：两份 workflow 各自的步骤、命令、版本与名字都有量", () => {
  assert.ok(CI_STEPS.length >= 3, `ci.yml 只切出 ${CI_STEPS.length} 个步骤`);
  assert.ok(REL_STEPS.length >= 5, `release.yml 只切出 ${REL_STEPS.length} 个步骤`);
  assert.equal(GLOBS.length, 3, `测试 glob 切出 ${GLOBS.length} 处，本文件按三处写（两份 workflow + package.json）`);
  assert.equal(VAL_CMDS.length, 3, `校验命令切出 ${VAL_CMDS.length} 处，本文件按三处写`);
  assert.ok(TEST_FILES.length >= 40, `仓库里只认出 ${TEST_FILES.length} 个测试文件，遍历退化了`);
  assert.ok(REF_STRIPS.length >= 2, `只切出 ${REF_STRIPS.length} 处 \${GITHUB_REF_NAME#…}，本文件按"三处都写同一个前缀"的量判`);
  assert.ok(NS.length >= 3 && MANIFEST_VERSION.length >= 3, "tag 名字段或 manifest 版本切成空串");
  assert.ok(RELEASE_HEADINGS.length >= 1, "CHANGELOG 一个发布标题都没切到，名字账少一头");
  assert.equal(BADGES.length, 1, `README 的 badge 指到 ${BADGES.length} 个 workflow 文件，本文件按一条写`);
});

test("认不出的形状要抛，不许静默少切一条判据", () => {
  assert.throws(() => stepsOf("name: x\non:\n  push:\n", "坏样本"), /只切出 \d+ 个步骤/);
  assert.throws(() => stepsOf("jobs:\n  t:\n    steps:\n      - uses: a@b\n", "坏样本"), /只切出 \d+ 个步骤/);
  assert.throws(() => stepsOf('jobs:\n  t:\n    steps:\n      - name: 空\n        run:\n', "坏样本"), /run: 是空的/);
  assert.throws(() => stepsOf('jobs:\n  t:\n    steps:\n      - name: 折叠\n        run: >-\n          echo hi\n', "坏样本"), /块写法/);
  assert.throws(() => tagPatternOf("on:\n  push:\n    branches: [main]\n"), /没有 on\.push\.tags/);
  assert.throws(() => tagPatternOf('on:\n  push:\n    tags:\n      - "a/v*"\n      - "b/v*"\n'), /tags 清单有 2 条/);
  assert.throws(() => globToRe("tests/{a,b}/**/*.test.mjs"), /不认的通配/);
  assert.throws(() => bashStrip("v1.0.0", "v*"), /字面量前缀/);
});

/* ---------- 五、两头判据 ---------- */

test("测试 glob 三处齐平，而且每一处都真吃到仓库里全部测试文件", () => {
  assert.deepEqual(globLedger(GLOBS, TEST_FILES), [],
    "CI 与发布跑的测试集合不是一份：glob 漂了的这一头会安静地少跑（或一条不跑）");
  const anyGlob = globToRe(GLOBS[0].glob);
  assert.ok(TEST_FILES.every((f) => anyGlob.test(f)) && TEST_FILES.length >= 40,
    "参照物没了：现推的测试清单与 glob 之间今天应当是全覆盖关系");
});

test("校验命令三处齐平，且它指向的文件真存在", () => {
  assert.deepEqual(cmdLedger(VAL_CMDS, (p) => existsSync(join(ROOT, p))), [],
    "闸门命令分家了：CI 绿着校验过的东西不等于发布前校验过的东西");
});

test("node-version 与 setup-node 版本：两份 workflow 与 AGENTS.md 写的是同一个", () => {
  const drift = [];
  for (const g of NODE_VERSIONS) {
    if (!g.values.length) drift.push(`${g.label} 里认不出 node-version 数字`);
    else if (g.values.length > 1) drift.push(`${g.label} 自己就有两种 Node 版本写法：${g.values.join(" / ")}`);
  }
  for (const g of SETUP_NODES) {
    if (!g.values.length) drift.push(`${g.label} 里认不出 setup-node 的版本`);
    else if (g.values.length > 1) drift.push(`${g.label} 里 setup-node 有两种版本写法：${g.values.join(" / ")}`);
  }
  assert.deepEqual(drift, [], "同一份 CI 配置在文档与 workflow 里写成了两样");
  const wanted = NODE_VERSIONS[0].values[0];
  assert.ok(NODE_VERSIONS.every((g) => g.values[0] === wanted) && SETUP_NODES.every((g) => g.values[0] === SETUP_NODES[0].values[0]),
    "两份 workflow 与文档的 Node 版本不一致：一边绿不等于另一边绿");
});

test("一个名字十一处齐平：tag 前缀 ↔ package.json ↔ 插件目录 ↔ 剥前缀 ↔ 清理的编码前缀 ↔ 两份说明书 ↔ CHANGELOG ↔ archive 的 --prefix 与引用路径 ↔ require 的目录段", () => {
  assert.deepEqual(nameLedger(NS, NAME_SITES), [],
    "这个名字漂了的地方不会报错，只会让那一步安静地不做事：tag 不触发发布、旧 Release 不清、产物目录名与文档不符");
  assert.equal(NAME_SITES.length, 11, `名字账的站点数是 ${NAME_SITES.length}，本文件按十一处写`);
});

test("版本算术真跑一遍：manifest 版本拼成 tag，按 workflow 那两步剥回来还得是它", () => {
  assert.deepEqual(versionLedger({ tagPattern: TAG_PATTERN, refStrips: REF_STRIPS, vStrips: V_STRIPS, zipTemplates: ZIP_TPLS, manifestVersion: MANIFEST_VERSION }),
    [], "发布 workflow 算出来的版本与 manifest 对不上：要么不发布，要么发到错的版本号上");
  assert.ok(ZIP_TPLS.length >= 1, "切不到 zip 产物名，产物名与 --prefix 那本账就空跑了");
});

test("release.yml 的步骤次序：闸门 → 版本比对 → 打包 → 建 Release → 清理，说明书那句同序", () => {
  assert.deepEqual(orderLedger(REL_STEPS), [],
    "次序就是语义：校验排在打包后面等于把没测过的东西发出去，清理排在建 Release 前面等于先把上一版删了");
  const line = /workflow.*发布|发布.*workflow|打 tag[^\n]*/.exec(AGENTS_TEXT)?.[0] || "";
  const a = line.indexOf("校验");
  const b = line.indexOf("比对");
  assert.ok(a >= 0 && b >= 0 && a < b,
    "AGENTS.md 那句发布说明里「先跑校验与单测」与「再比对 tag 版本」的顺序反了或找不到：文档说的次序与 workflow 做的不是一回事");
});

test("写操作与 contents: write 成对：要写的必须声明，不写的不许白要", () => {
  const problems = PERMS.flatMap(([label, steps, block, re]) => permLedger(label, steps, block, re));
  assert.deepEqual(problems, [], "权限与动作不配对：缺的那头让发布步骤 403，多的那头白给写权限");
});

test("README 的 CI badge 指向的 workflow 文件真存在", () => {
  for (const name of BADGES) {
    assert.ok(existsSync(join(ROOT, ".github", "workflows", name)),
      `README 的 badge 指向 ${name}，而 .github/workflows/ 里没有这个文件：badge 会永远显示 not found`);
  }
});

/* ---------- 六、常驻对照：判据自己红得出来 ---------- */

test("对照常驻：glob 的目录名漂一个字母，红的必须是那句「匹配到 0 个文件」", () => {
  /* 实测过：这种 glob 下 node --test 退出码仍是 0，只报 `ℹ tests 0`。
     所以这一条判据红不红，是 CI 有没有可能对着空集合绿过去的唯一分界 */
  const drifted = [{ label: "ci.yml", glob: "test/**/*.test.mjs" }, ...GLOBS.slice(1)];
  const problems = globLedger(drifted, TEST_FILES);
  assert.equal(problems.length, 2, `只改一处 glob 时红出 ${problems.length} 处（要 2 处：写法不齐平 + 那一处匹配不到）`);
  assert.match(problems[0], /种写法/);
  assert.match(problems[1], /匹配不到/);
  assert.deepEqual(globLedger(GLOBS, TEST_FILES), [], "对照恒红：真值本身被判坏了");
  /* 一半对一半错的形状：测试目录整个改名而 glob 不动 */
  const renamed = TEST_FILES.map((f) => f.replace(/^tests\//, "spec/"));
  assert.match(globLedger([{ label: "x", glob: "tests/**/*.test.mjs" }], renamed)[0], /匹配不到/);
  /* 只漏掉一部分的形状：新增一个子目录不在 glob 射程内 */
  const grown = [...TEST_FILES, "tests/other-deep/y.test.mjs"];
  assert.match(globLedger([{ label: "x", glob: "tests/tab-auto-refresh/*.test.mjs" }], grown)[0], /漏掉/);
});

test("对照常驻：tag 前缀只改 release.yml 那一处，名字账必须点名每一个落点", () => {
  const moved = NAME_SITES.map((s) => (s.label.includes("on.push.tags") ? { label: s.label, value: "other-name" } : s));
  const problems = nameLedger("other-name", moved);
  assert.equal(problems.length, NAME_SITES.length - 1, `只改 tag 模式时名字账红出 ${problems.length} 处（要 ${NAME_SITES.length - 1} 处）`);
  assert.match(problems[0], /other-name|tag 前缀的名字段/);
  assert.deepEqual(nameLedger(NS, NAME_SITES), [], "对照恒红");
});

test("对照常驻：把闸门挪到打包之后，次序那条必须红而且红得说出后果", () => {
  const gateIdx = REL_STEPS.findIndex((s) => s.run && /scripts\/validate\.mjs/.test(s.run));
  const packIdx = REL_STEPS.findIndex((s) => s.run && /git\s+archive/.test(s.run));
  const swapped = REL_STEPS.map((s, i) => (i === gateIdx ? REL_STEPS[packIdx] : i === packIdx ? REL_STEPS[gateIdx] : s));
  const problems = orderLedger(swapped);
  assert.ok(problems.length >= 1, "闸门排到打包后面也不红：那这条次序判据是空跑");
  assert.match(problems[0], /未跑校验与单测|顺序/);
  assert.deepEqual(orderLedger(REL_STEPS), [], "对照恒红");
});

/* ---------- 七、实测：改坏了到底谁红（红→绿对照表） ----------

   跑法：仓库外整仓副本（脚本与日志在 `D:/Github/_tar_ctl_r25/ctl25.mjs` / `ctl25.log`）。
   pre = 副本里删掉本文件（这本账是本轮新建的），post = 带着本文件；两侧都跑 validate + 全套。
   每台变异开跑前先逐台量 needle 在 pristine 里恰好命中一次。

   | 台 | 改法 | pre | post | 红的条目 |
   | --- | --- | --- | --- | --- |
   | K0 | 不改（pristine） | 1 | 0 | —— |
   | B1 | ci.yml 的测试 glob 目录名漂一个字母 | 1 | 2 | glob 三处齐平、常驻对照 |
   | B2 | release.yml 的 glob 扩展名漂一个字母 | 1 | 2 | 同上 |
   | B3 | package.json 的 glob 去掉那一层目录通配（只剩顶层） | 1 | 2 | 同上 |
   | B4 | ci.yml 的 `node-version` 改成 20 | 1 | 1 | node-version 与 setup-node |
   | B5 | release.yml 的 tag 模式名字段改掉 | 1 | 3 | 名字十一处、版本算术、常驻对照 |
   | B6 | 清理那一步的 URL 编码前缀改掉 | 1 | 2 | 名字十一处、常驻对照 |
   | B7 | 三处剥前缀里的第一处改掉 | 1 | 3 | 名字十一处、版本算术、常驻对照 |
   | B8 | `git archive --prefix` 改掉 | 1 | 3 | 名字十一处、版本算术、常驻对照 |
   | B9 | 版本比对那一步 `require` 的目录段改掉 | 1 | 2 | 名字十一处、常驻对照 |
   | B10 | release.yml 删掉 `contents: write` | 1 | 1 | 写操作与权限成对 |
   | B11 | ci.yml 白加一块 `contents: write` | 1 | 1 | 同上（反向那一半） |
   | B12 | 闸门整块搬到打包之后 | 1 | 2 | 步骤次序、常驻对照 |
   | B13 | README badge 指到一个不存在的 workflow | 1 | 2 | 抽取形状（badge 条数）、badge 文件存在 |
   | B14 | CHANGELOG 某个发布标题的名字段改掉 | 1 | 2 | 名字十一处、常驻对照 |
   | B15 | zip 产物名的模板改掉 | 1 | 1 | 版本算术 |

   怎么读这张表：

   - 十五台全部"改前零红"，这与第二十四轮（十二台里六台零红）不同。pre 那一列每台都是 1，
     而那一条 `AGENTS.md 提到的每条路径在仓库里都存在` 是"删掉本文件指向的门禁"这个动作自己的副作用
     （本轮把 AGENTS.md 的引用与对照跑在同一个时间窗里，所以每台 pre 都带着它），与改法无关。
     也就是说：这一整个面在补上门禁之前，没有任何一条判据对着它，`validate.mjs` 不吃 `.github/`，
     `tests/` 与 `scripts/` 里改动之前也没有一个文件提到过那两份 workflow。
   - B1~B3 是本轮真正的收获：三台 pre 侧除了上面说的那一条固有副作用，validate 与其余 599 条全绿，
     而 CI 在这种 glob 下退出码仍是 0、只报 `ℹ tests 0`（第一次实测是把上面 B1 那一台的 glob
     直接喂给 `node --test` 跑出来的）。改完之后每一台都同时红"三处不齐平"与"这一处匹配到 0 个文件"两句。
   - 每台 post 多带的那条常驻对照红是预期的：那三条对照的参照物就是被改的那处真值本身，
     它们跟着红恰好证明对照不是空跑。
   - B15 只红一条不红名字账，因为 zip 产物名不在名字账的十一个落点里（它由版本算术那本账管：
     `--prefix` 与产物名模板齐不平）。B13 先红"抽取形状"再红判据，因为改写只动了图片地址没动同一行的
     链接目标，badge 因此指向两种文件——这一条恰好证明形状那本账不是装饰。
   - 名字账的十一个落点里，实测真各改过其中一处的只有六个（tag 模式、清理前缀、剥前缀、`--prefix`、
     `require` 的目录段、CHANGELOG 标题）。另外五个落点没单独做变异：`package.json` 的 `name`、
     插件目录真名、`AGENTS.md` 与 `README.md` 那句发布说明、archive 的引用路径。理由是它们走的是
     同一段 `nameLedger`（B5/B6/B7/B8/B9/B14 六台里每一台都让它从"参考值是 tag 那一头"点名到
     "另一头不是同一个名字"，方向已经两面都验过），而插件目录那一处要真改一次目录名，
     整仓每一条路径都要跟着动，不像一台变异而像一次发布。这一句写在这里而不是藏在表下面：
     没测的就是没测的。
   - 还有一处本文件自己的坑记在这里：这张表写在块注释里，而 glob 那种写法是"两个星号紧跟一个斜杠"，
     连起来正好是块注释的终止符——把那一串原样抄进表格，本文件的注释当场被截断，
     `scripts/validate.mjs` 的语法检查红一条（本轮第一次跑到就是这个症状）。所以 B3 那一格写中文描述。

   边界（刻意不覆盖的）：

   1. 只核 workflow 与文档写的字面量，不核 GitHub 那个托管服务怎么做：`actions/checkout@v4`
      将来换大版本、`ubuntu-latest` 换 runner 名，都不在这根轴上；`permissions` 那块也只认
      `contents: write` 这一个形状，写成 `permissions: { contents: write }` 的行内形状本文件认不出、会抛。
   2. 名字账的十一个落点是这一份 workflow 今天有的落点。新增一处（比如再加一步按名字找产物）
      不会自动进账——它表现为"那一处没人比对"，与其余各本账同一个边界。
   3. 版本算术只验"manifest 版本 → tag → 剥回来还是它"这一趟往返，不验 tag 是不是真按这个模式打的
      （那是 push 之后的事，仓库里没有任何东西能看见）。
   4. 测试 glob 只要求"三处齐平且每一处吃到现遍历出来的全部 `.test.mjs`"。glob 命中过宽判不了：
      把 glob 收窄成斜杠结尾的那种"整棵目录树"写法（末段只剩两个星号）会连非测试文件一起吃进去，
      本文件仍然绿（那会跑挂 CI，但挂的是 CI 而不是这道门禁）。
   5. 步骤次序认的是五件事的相对顺序（闸门 → 版本比对 → 打包 → 建 Release → 清理），
      不认步骤总数，也不认 `uses:` 那两步的位置。
   6. 权限那本账按"有没有写动作"倒推该不该有 `contents: write`。真要收紧成只给 `pull_requests: write`
      这类更细的权限，本文件会说"白要"——那是刻意的方向：这本账站在"别多要"这一头。 */
