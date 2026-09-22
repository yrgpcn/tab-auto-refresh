/* 第二十二轮审计（`BACKLOG.md` A40）的门禁：验证墙那两条正则的清单本身有没有账。

   这之前只有正向账（A3 那几条用例：整页挑战要能暂停、挂件小框不许暂停、正文里有"验证码"不许
   暂停），没有反向账——九条标题特征与三条挑战域名里，每一条各自有没有一条用例真喂它没人管。
   立论是量出来的（`D:/Github/_tar_ctl_r20/probe21.mjs`，日志 `probe21.log`）：删掉
   `verify you are human`、`human verification`、`pardon our interruption`、`hcaptcha` 各
   全套零红；另外几条标题特征虽红，红的那条用例是"顺带路过"某份夹具、不是给它自己写的。
   把 `CHALLENGE_URL_RE` 的 `/i` 去掉也是零红。

   五条判据，两头都要走：
   1. 正向：清单里每一条备选都要有一条夹具唯一命中它（只命中这一条、不命中别的）
   2. 反向：登记表里每一条夹具都要被清单命中，而且只能命中一条备选
      —— 这两条合起来才挡得住"改成同族另一条的拼写"（`hcaptcha` 并进 `captcha` 那种）：
      被吞的那条立刻零夹具，吞人的那条同时收到两份归属
   3. 接线：每一条夹具都要经真实的 `decideWallFromFrames` 判成墙，而不是只对着正则跑——
      正则对了但没人把它接到判定链上，同样是"这条特征没人在验"。活着的通道今天有两条：
      标题那一堆走顶层，网址那一堆走过了尺寸地板的子框架。顶层那一支**不再**读资产列表
      （C1 那次修复，见 `CHANGELOG.md` 的 `[未发布]` 段），所以网址这堆只剩一条通道可接，
      另一头补一条反向见证钉住那条老通道不许回来
   4. 大小写：每条带拉丁字母的特征都要有一条"只有 `/i` 才命中"的夹具，`/i` 从装饰变成账
   5. 清单内部：一条特征的文字不许被另一条特征命中（不看夹具的独立一道，专打子串吞并）

   登记表里只有夹具、没有特征名：特征一律从 `WALL_TITLE_RE.source` / `CHALLENGE_URL_RE.source`
   现推（`alternativesOf`），所以这份文件不是清单的第二份抄本。夹具是登记面（同
   `message-gate.test.mjs` 的 `POPUP_ONLY`）——给两条正则加减一条备选，就要在这里加/删一条
   真喂它的夹具。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* 对照用：TAR_LOGIC 指另一份 logic.js（红→绿对照跑在仓库外的整仓副本上，CI 上不设） */
const HERE = fileURLToPath(import.meta.url);
const LOGIC = await import(
  process.env.TAR_LOGIC
    ? pathToFileURL(process.env.TAR_LOGIC).href
    : new URL("../../tab-auto-refresh/shared/logic.js", import.meta.url).href
);
const {
  WALL_TITLE_RE,
  CHALLENGE_URL_RE,
  decideWallFromFrames,
  WALL_FRAME_MIN_W,
  WALL_FRAME_MIN_H,
} = LOGIC;

/* tests/ 目录：第 12 条判据要扫别的测试文件里的夹具。对照跑在仓库外的整仓副本上，
   所以根目录按本文件自己的位置现推，不写死 */
const ROOT = resolve(dirname(HERE), "..", "..");
const TESTS_DIR = join(ROOT, "tests");

/* ---------- 从源码现推备选分支 ---------- */

/* 整份被一个分组包住时先剥掉：`(a|b|c)` 的顶层 `|` 在深度 1 上，不剥就一条都切不出来。
   只有当那对括号确实包住全文才剥——`(a|b)|c` 不能剥 */
function unwrapGroup(src) {
  if (src[0] !== "(") return src;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\\") { i++; continue; }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) {
      return i === src.length - 1 ? src.slice(1, -1) : src;
    }
  }
  return src;
}

/* 按顶层 `|` 切。转义（`\|`）、字符类（`[a|b]`）、嵌套分组里的 `|` 都不算分隔符。
   切完的分支原样拿去 `new RegExp` 还能用，所以转义一个都不许丢 */
function alternativesOf(re) {
  const src = unwrapGroup(re.source);
  const out = [];
  let depth = 0, inClass = false, cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { cur += ch + (src[i + 1] ?? ""); i++; continue; }
    if (inClass) { cur += ch; if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; cur += ch; continue; }
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (depth === 0 && ch === "|") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* ---------- 夹具登记表（只有夹具，没有特征名） ---------- */

/* 一条备选配一条：删掉某条备选时，这里对应的那一条会同时红在"夹具没人命中"与
   "这条特征零夹具"两头 */
const TITLE_FIXTURES = [
  "CAPTCHA required",              /* 全大写：顺带钉 /i */
  "Verify you are human",
  "Human Verification",
  "Just a moment...",
  "Attention Required! | Cloudflare",
  "Pardon Our Interruption",
  "安全验证",
  "人机验证",
  "请输入短信验证码",
];

const URL_FIXTURES = [
  /* 真页面上的写法（全小写） */
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/x",
  "https://www.google.com/recaptcha/api.js?render=explicit",
  "https://js.hcaptcha.com/1/api.js",
  /* 钉 /i 的那三条：要的不是"真页面一定这么写"，是"flag 一旦被摘掉必须有人说"。
     主机名大小写不敏感、页面作者手写 markup 时品牌名怎么抄都有可能 */
  "https://CHALLENGES.CLOUDFLARE.COM/cdn-cgi/challenge-platform/x",
  "https://example.test/challenge?provider=reCAPTCHA",
  "https://example.test/challenge?widget=hCaptcha",
];

/* ---------- 台账求值（纯函数：变异测试直接喂改动过的正则） ---------- */

const matches = (alt, fixture, flags) => new RegExp(alt, flags).test(fixture);

/* 一条夹具命中了哪几条备选（按下标） */
function hitsFor(alts, fixture) {
  return alts.map((a, i) => (matches(a, fixture, "i") ? i : -1)).filter((i) => i >= 0);
}

function ledger(alts, fixtures) {
  const hits = fixtures.map((fx) => hitsFor(alts, fx));
  const claimedBy = alts.map((_, i) => fixtures.filter((__, k) => hits[k].length === 1 && hits[k][0] === i));
  return {
    /* 零夹具可验的特征：清单里多出来的一条，没人喂过它 */
    unclaimed: alts.filter((_, i) => claimedBy[i].length === 0),
    /* 谁都不命中的夹具：清单里对应那条被改坏到匹配不上了 */
    unmatched: fixtures.filter((_, k) => hits[k].length === 0),
    /* 同时命中两条以上的夹具：一条特征把另一条吞了 */
    ambiguous: fixtures.filter((_, k) => hits[k].length > 1),
    claimedBy,
  };
}

const TITLE_ALTS = alternativesOf(WALL_TITLE_RE);
const URL_ALTS = alternativesOf(CHALLENGE_URL_RE);
const T_LEDGER = ledger(TITLE_ALTS, TITLE_FIXTURES);
const U_LEDGER = ledger(URL_ALTS, URL_FIXTURES);

/* 把一条夹具摆成"框架事实"喂真判据。形状与 background.js 的注入体回传一致 */
const fact = (o) => ({ top: true, title: "", url: "https://a.test/board", w: 1280, h: 900, assets: [], ...o });
const asFrames = (...results) => results.map((result, frameId) => ({ frameId, result }));

/* ---------- 一、切分器自己 ---------- */

test("切分器认外层分组、字符类与转义，切出来的分支还能单独编译", () => {
  const cases = [
    [/[a|b]|c/, ["[a|b]", "c"]],               /* 字符类里的 | 不是分隔符 */
    [/(?:x|y)z|w/, ["(?:x|y)z", "w"]],         /* 分组里的 | 不算，括号没包住全文就不剥 */
    [/(a|b)/, ["a", "b"]],                     /* 包住全文的那层要剥 */
    [/a\|b|c/, ["a\\|b", "c"]],                /* 转义的 | 不是分隔符 */
    [/solo/, ["solo"]],
  ];
  for (const [re, want] of cases) {
    assert.deepEqual(alternativesOf(re), want, `切分 ${re.source} 不对`);
  }
});

test("切分器不发明也不吞字：两条真清单的每条备选都原样住在 source 里", () => {
  for (const re of [WALL_TITLE_RE, CHALLENGE_URL_RE]) {
    for (const a of alternativesOf(re)) {
      assert.ok(a.length > 0, `切出一条空的备选（${re.source}）——切分器退化了`);
      assert.ok(re.source.includes(a), `备选 ${a} 不在 source 里：切分器改写了字面量`);
      assert.doesNotThrow(() => new RegExp(a, "i"), `备选 ${a} 单独编译不过`);
    }
  }
});

test("清单条数是下限而不是抄来的期望值：删一条备选要来这一趟", () => {
  /* 下限而不是等号：加一条特征不该红，删一条才要人来重核（本轮实测 9 / 3） */
  assert.ok(TITLE_ALTS.length >= 9, `标题特征只剩 ${TITLE_ALTS.length} 条，本轮实测是 9 条`);
  assert.ok(URL_ALTS.length >= 3, `挑战域名只剩 ${URL_ALTS.length} 条，本轮实测是 3 条`);
});

/* ---------- 二、正反两头 ---------- */

test("正向：每一条标题特征都有一条夹具唯一命中它", () => {
  assert.deepEqual(T_LEDGER.unclaimed, [], `这些标题特征没有唯一命中它的夹具：${T_LEDGER.unclaimed.join(", ")}`);
});

test("正向：每一条挑战域名特征都有一条夹具唯一命中它", () => {
  assert.deepEqual(U_LEDGER.unclaimed, [], `这些挑战域名没有唯一命中它的夹具：${U_LEDGER.unclaimed.join(", ")}`);
});

test("反向：登记表里每一条夹具都还在清单的射程内", () => {
  const orphan = [...T_LEDGER.unmatched, ...U_LEDGER.unmatched];
  assert.deepEqual(orphan, [],
    `这些夹具一条特征都不命中——清单里对应那条被改坏了（拼错、转义坏掉、整条删掉）：${orphan.join(" / ")}`);
});

test("反向：一条夹具不许同时命中两条特征（同族吞并的形状）", () => {
  const both = [...T_LEDGER.ambiguous, ...U_LEDGER.ambiguous];
  assert.deepEqual(both, [], `这些夹具同时落进两条特征，等于两条特征已经分不开了：${both.join(" / ")}`);
});

test("清单内部：一条特征的文字不许被另一条特征命中", () => {
  /* 不看夹具的独立一道：`hcaptcha` 换成 `captcha` 之后，`captcha` 会命中 `recaptcha` 的文字，
     于是"吞人"这一步当场红，不用等到归属对账才发现 */
  for (const [kind, alts] of [["标题", TITLE_ALTS], ["域名", URL_ALTS]]) {
    for (let i = 0; i < alts.length; i++) {
      for (let j = 0; j < alts.length; j++) {
        if (i === j) continue;
        assert.equal(matches(alts[i], alts[j], "i"), false,
          `${kind}清单里 ${alts[j]} 的文字被另一条特征 ${alts[i]} 命中`);
      }
    }
  }
});

/* ---------- 三、接到真判据 ---------- */

test("每一条标题夹具经 decideWallFromFrames 的顶层通道判成墙", () => {
  assert.equal(decideWallFromFrames(asFrames(fact())), false, "参照物坏了：什么特征都没有也判墙");
  for (const fx of TITLE_FIXTURES) {
    assert.equal(decideWallFromFrames(asFrames(fact({ title: fx }))), true, `标题夹具没判成墙：${fx}`);
  }
});

test("每一条网址夹具经子框架自身网址通道判成墙，顶层资产列表不再参与判定", () => {
  assert.equal(decideWallFromFrames(asFrames(fact({ assets: ["https://a.test/app.js"] }))), false,
    "参照物坏了：普通资产也判墙");
  for (const fx of URL_FIXTURES) {
    const nested = asFrames(
      fact({ title: "" }),
      fact({ top: false, url: fx, w: WALL_FRAME_MIN_W, h: WALL_FRAME_MIN_H }),
    );
    assert.equal(decideWallFromFrames(nested), true, `子框架网址通道没判成墙：${fx}`);
    /* 反向的一半与正向配成一对：只断言"不判墙"的用例证明不了这条通道被执行过，
       所以每一条夹具都先走一遍子框架那条真通道，再钉住顶层资产列表这一头 */
    assert.equal(decideWallFromFrames(asFrames(fact({ assets: [fx] }))), false,
      `顶层资产列表把页面判成了墙（C1 误暂停回来了）：${fx}`);
  }
});

/* ---------- 四、大小写这本账 ---------- */

test("/i 是账不是装饰：每条带拉丁字母的特征都要有一条靠 /i 才命中的夹具", () => {
  let casedProven = 0;
  let casedFree = 0;
  for (const [kind, re, alts, led] of [
    ["标题", WALL_TITLE_RE, TITLE_ALTS, T_LEDGER],
    ["域名", CHALLENGE_URL_RE, URL_ALTS, U_LEDGER],
  ]) {
    assert.ok(re.flags.includes("i"), `${kind}清单没有 /i（flags=${re.flags}）`);
    alts.forEach((a, i) => {
      if (!/[A-Za-z]/.test(a)) { casedFree++; return; }      /* 中文特征无大小写可言 */
      const proven = led.claimedBy[i].some((fx) => !matches(a, fx, "") && matches(a, fx, "i"));
      assert.ok(proven, `${kind}特征 ${a} 的夹具全是同一种写法——把 /i 摘掉也不会有人红`);
      casedProven++;
    });
  }
  /* 两条分支都要活着：任何一边归零就说明这一面门悄悄没了 */
  assert.ok(casedProven >= 9, `靠 /i 才命中的特征只有 ${casedProven} 条，本轮实测 9 条`);
  assert.ok(casedFree >= 3, `无大小写可言的中文特征只有 ${casedFree} 条，本轮实测 3 条`);
});

/* ---------- 五、扫别的测试文件：全仓库的墙标题都要被清单解释得掉 ---------- */

function listTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTests(p));
    else if (entry.name.endsWith(".test.mjs")) out.push(p);
  }
  return out;
}

test("仓库里当墙标题喂进去的字面量，凡命中清单的都唯一归因（含条数下限）", () => {
  /* 排除本文件：注释里写着被改坏的样子（`verify you are human` 这些原话都在这份文件的注释与
     对照里），留着它就等于"判据在自己注释里提过一遍的夹具永远算被验过"——上一轮 A39 的 C1
     就是这么自证的 */
  const seen = new Map();
  for (const file of listTests(TESTS_DIR)) {
    if (file === HERE) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\btitle:\s*"([^"]*)"/g)) {
      const hit = hitsFor(TITLE_ALTS, m[1]);
      if (hit.length) seen.set(m[1], hit);
    }
  }
  assert.ok(seen.size >= 6, `只扫到 ${seen.size} 条命中清单的标题夹具（本轮实测 7 条）——扫描退化了`);
  for (const [fx, hit] of seen) {
    assert.equal(hit.length, 1, `别的测试文件里的标题夹具 ${fx} 命中了 ${hit.length} 条特征，归因对不上`);
    assert.ok(T_LEDGER.claimedBy[hit[0]].length > 0,
      `别的测试文件里有一条用例喂 ${fx}，登记表却没有为特征 ${TITLE_ALTS[hit[0]]} 立夹具`);
  }
});

/* ---------- 六、判据抓得住：两台常驻变异 ---------- */

test("对照常驻：把 hcaptcha 并进 captcha 会红在归属上", () => {
  const src = CHALLENGE_URL_RE.source.replace("hcaptcha", "captcha");
  assert.notEqual(src, CHALLENGE_URL_RE.source, "needle 没命中，这台变异等于没跑");
  const led = ledger(alternativesOf(new RegExp(src, CHALLENGE_URL_RE.flags)), URL_FIXTURES);
  assert.ok(led.unclaimed.length > 0, "吞并没被抓住：没有一条特征变成零夹具");
  assert.ok(led.ambiguous.length > 0, "吞并没被抓住：没有一条夹具变成多归属");
});

test("对照常驻：整条删掉一条标题特征会红在夹具上", () => {
  const src = WALL_TITLE_RE.source.replace("pardon our interruption|", "");
  assert.notEqual(src, WALL_TITLE_RE.source, "needle 没命中，这台变异等于没跑");
  const led = ledger(alternativesOf(new RegExp(src, "i")), TITLE_FIXTURES);
  assert.deepEqual(led.unmatched, ["Pardon Our Interruption"], "删掉一条特征之后，它的夹具没变成孤儿");
});

/* ---------- 九、实跑记录（改坏哪一处 → 红几条） ----------

   10 台在仓库外整仓副本上跑 pre/post（脚本 `D:/Github/_tar_ctl_r22/ctl22.mjs`，日志
   `ctl22.log`）。这一轮的账是新建的，所以 pre = 把本文件从副本里删掉（不像 A39 那一轮有
   上一版可换）。两侧都跑 `scripts/validate.mjs` 与全套，两侧 validate 全 OK。
   "本门禁"按用例标题归类，"其它"是既有覆盖里红的条数。

   | 变异 | pre | post 本门禁 / 其它 |
   | --- | --- | --- |
   | K0 pristine | 0 | 0 / 0（十四条不误伤） |
   | A1 整条删标题特征 `verify you are human` | 0 | 5 / 0 |
   | A2 整条删 `captcha`（探针没量过的那一条） | 0 | 5 / 0 |
   | A3 把 `pardon our interruption` 改一个字母（条数不变） | 0 | 5 / 0 |
   | A4 整条删挑战域名 `hcaptcha` | 0 | 5 / 0 |
   | A5 `hcaptcha` 并进 `captcha`（同族吞并） | 0 | 5 / 0 |
   | A6 摘掉 `CHALLENGE_URL_RE` 的 `/i` | 0 | 2 / 0 |
   | A7 新增一条没登记夹具的特征 `access denied` | 0 | 2 / 0 |
   | A8 整条删 `attention required` | 1 | 5 / 1 |
   | A9 摘掉 `WALL_TITLE_RE` 的 `/i` | 4 | 2 / 4 |

   怎么读这张表：
   - 七类改前零红（A1~A7），本轮全部补住。其中 A6/A7 各只红两条，是这一轮真正的新增面：
     一条 flag 有没有人验、一条特征进清单时有没有人喂它。A2 是探针那趟没量的一条，本轮补测：
     它在旧世界同样零红（`reCAPTCHA` 那份夹具是负向用例，删掉特征之后它照旧判"不是墙"）
   - 整条删一台为什么红五条而不是互相重叠：下限、孤儿夹具、接线、`/i` 的数量下限、常驻对照——
     同一件事（清单少了一条）的五个面。要分"删一条"与"改坏一条"看正向那一条：改坏（A3）会红在
     "这条特征零夹具"，整条删（A1/A2/A4）不会红在正向，因为那条特征自己也不在清单里了。
     两台一起跑就是为了把这两种红法分开
   - A5 的红法最该记：它不动条数（还是三条），但正向、多归属、清单内部互吞三头一起红——
     这正是"改到同族另一条的拼写上、行为看着还是能命中"那一类
   - A8/A9 的 pre 不是零，是既有覆盖里真有一条路过 `attention required` 的夹具（`frame-scan` 的
     "顶层框架判据与 A3 之前逐条一致"）和四条真吃标题 `/i` 的用例。本轮在它们之上加的是按条归因，
     不是从零到有；上一趟探针（`_tar_ctl_r20/probe21.log`）量的 P3/P7 与这两台一致
   - 探针日志里 P8 那一行（摘掉网址 `/i`）写的是 `validate=FAIL fail=116`：那是第一版 needle
     少切一段、把正则的收尾斜杠一起删掉的坏样本，不算数据。本轮 A6 用正确 needle 重测，改前零红、
     改后本门禁红 2 条，这个数取代那一行
   - "对照常驻"那两条不依赖仓库外副本，它们把变异喂进 `ledger()` 与 `alternativesOf()` 在门禁内部跑——
     判据函数本身坏掉时会当场红，不用等到下一轮人肉对照

   边界（这一根轴挡不住的）：
   1. 登记表管的是"每条特征有没有人喂"，喂的形状真不真不在这一头：真实挑战页的标题写法仓库里没有
      一份真机样本可对，夹具是人按品牌写法造的。网址那三条钉 `/i` 的夹具（全大写主机名、品牌大小写
      写进查询串）要的是 flag 本身在不在，不是宣称真页面一定这么写
   2. 切分器认顶层 `|`、字符类、转义与"整份被一个分组包住"那一种；写成 `(?:...)` 的非捕获组会当成
      不可分的一整块（今天没有，真要加会红在条数下限那一条，那时候回来改切分器）
   3. 只管这两条正则的清单。视口地板、连击次数、`captchaGuard` 那条链在 `frame-scan.test.mjs`
      与自动暂停那几条用例上，本文件刻意不重复
   4. 全仓库那一条反向只扫 `title:` 字面量，且只审"命中清单的那批"：一份假标题写成变量、
      或落在别的属性名上就看不见
   5. 夹具与特征是一对一登记的，但判据只要求"每条特征至少一条"：给一条特征堆十条夹具不红，
      少一条才红——这一头要的是下限，不是配额 */

/* ---------- 十、接线那条通道换过一次（2026-09-22） ----------

   产品那一侧把顶层分支的资产判据整条删掉（C1 的误暂停：页面只是引了挑战域的脚本就被判成墙，
   连续三次加载之后卡在暂停态），本文件的接线那一条当时没跟着改，于是它按旧形状要求"顶层资产
   通道判成墙"，从那天起一直红着——CI 跑的正是同一条命令，红到有人来看为止。修法不是把产品那
   一支改回去（那等于把 C1 放回来），是让这条判据跟着判定链走。

   红→绿实测（`TAR_LOGIC` 指仓库外的一份 logic.js，仓库源码一个字不动）：
     - 把资产判据加回顶层那一支（`assets.some(isChallengeUrl)`）当对照
       → 红 1 条，就是本文件这条接线判据，消息点名 `顶层资产列表把页面判成了墙（C1 误暂停回来了）`
     - 仓库现状（顶层只看标题）
       → 全绿

   这条经验记在 `AGENTS.md` 的跨文件账那张表里：这两条正则的清单是一头，判定链上"哪几条通道
   读它们"是另一头，改通道与改清单一样要回来。 */
