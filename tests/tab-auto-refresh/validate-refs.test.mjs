/* scripts/validate-refs.mjs 的门禁。它钉的是正则，而 validate.mjs 从前一条门禁都没有：
   正则写坏一处，"仓库级校验"会从报错静默退化成"什么都没引用、什么都没缺"，CI 照绿。
   五条引用通道各钉正反两面：抽得出该抽的，不误抽不该抽的。
   最后几节把真实仓库的插件目录再扫一遍，只为证明"这套正则不是对着空串自嗨"。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  htmlI18nKeys,
  htmlLocalRefs,
  i18nAliases,
  jsMessageKeys,
  manifestMsgKeys,
  stringLiterals,
} from "../../scripts/validate-refs.mjs";

/* ---------- 一、manifest 的 __MSG_key__ ---------- */

const MANIFEST = {
  manifest_version: 3,
  name: "__MSG_extName__",
  version: "2.1.0",
  description: "__MSG_extDesc__",
  action: { default_title: "__MSG_extName__", default_popup: "popup.html" },
  commands: { "toggle-refresh": { description: "__MSG_cmdToggle__" } },
  icons: { "16": "icons/icon16.png" }
};

test("manifest 四处 __MSG_ 全收：不只 name 与 description", () => {
  /* 少收一处就等于那一处永久不校验。Chrome 解析 manifest 里任意位置的 __MSG_，
     default_title 与 commands.*.description 拼错键名不报错，只在悬停文字与快捷键说明
     里留一块空白 */
  assert.deepEqual(manifestMsgKeys(MANIFEST).map((r) => r.key), ["extName", "extDesc", "extName", "cmdToggle"]);
});

test("__MSG_ 落在哪一层都认得出来（数组、嵌套对象、同一个值里两处引用）", () => {
  const refs = manifestMsgKeys({
    a: ["__MSG_k1__"],
    b: { c: { d: "__MSG_k2__" } },
    e: "前缀 __MSG_k3__ 中缀 __MSG_k4__"
  });
  assert.deepEqual(refs.map((r) => r.key), ["k1", "k2", "k3", "k4"]);
  /* path 是给报账用的：只说"manifest 里有个键不存在"没人找得动，得说清哪一层 */
  assert.deepEqual(refs.map((r) => r.path), ["a[0]", "b.c.d", "e", "e"]);
});

/* ---------- 二、HTML 的本地文件引用 ---------- */

test("HTML 只收本地 src/href：外链、协议相对、锚点、mailto 都跳过", () => {
  assert.deepEqual(
    htmlLocalRefs(
      `<link rel="stylesheet" href="popup.css">
       <a href="https://github.com/x/y">仓库</a>
       <a href="//cdn.test/a.css">协议相对</a>
       <a href="#top">页内锚点</a>
       <img src="wechat-guide-1.png">
       <script src="popup.js?v=2"><\/script>
       <a href="mailto:a@b.test">邮件</a>
       <a href="wechat-setup.html">教程</a>`
    ),
    ["popup.css", "wechat-guide-1.png", "popup.js", "wechat-setup.html"],
    "带 query 的要把 ? 之后剪掉再去查文件，否则真引用会被报成不存在"
  );
});

test("属性值写成单引号也认（HTML 两种都合法，漏一支等于那条引用永远不校验）", () => {
  assert.deepEqual(htmlLocalRefs("<link href='popup.css'>"), ["popup.css"]);
  assert.deepEqual(htmlI18nKeys("<span data-i18n='ttl'></span>"), ["ttl"]);
});

/* ---------- 三、data-i18n* 与 getMessage ---------- */

test("data-i18n 的三条通道都读，值里塞两个键也拆得开", () => {
  assert.deepEqual(
    htmlI18nKeys(
      `<span data-i18n="ttl" data-i18n-title="hint"></span>
       <input data-i18n-placeholder="ph">
       <i data-i18n="a b"></i>`
    ),
    ["ttl", "hint", "ph", "a", "b"]
  );
});

test("getMessage 的字面量与三元分支都收，变量与表名不收", () => {
  assert.deepEqual(
    jsMessageKeys(`
      chrome.i18n.getMessage("notifTitle");
      const k = cond ? "notAKeyHere" : "neitherThis";
      chrome.i18n.getMessage(k);
      chrome.i18n.getMessage(MAP[e] || "evKeywordShort");
    `),
    ["notifTitle", "evKeywordShort"],
    "第二行那个 ternary 不在 getMessage 里，不该被收进来"
  );
});

test("只取第一个实参：subs 里的字面量是要填进文案的值，不是键", () => {
  /* 真实仓库里 `getMessage("notifKeywordHits", [label])` 这一类很多，
     分支条件里还带着 "captcha" 这种比较值（G4 那处对照就是它先冒出来的） */
  assert.deepEqual(
    jsMessageKeys(`chrome.i18n.getMessage(p.reason === "captcha" ? "pausedCaptcha" : "pausedError", ["x"])`),
    ["pausedCaptcha", "pausedError"]
  );
  assert.deepEqual(jsMessageKeys(`chrome.i18n.getMessage("t", ["host", "3"])`), ["t"]);
});

test("嵌套调用与花括号不把第一个实参截断", () => {
  assert.deepEqual(jsMessageKeys(`chrome.i18n.getMessage(pick(a, {b: 2}), list[0])`), []);
  assert.deepEqual(
    jsMessageKeys(`chrome.i18n.getMessage(keyOf(a, {b: "notAKey"}) === "z" ? "k1" : "k2")`),
    ["k1", "k2"]
  );
});

/* ---------- 三b、别名包装：把键递给 getMessage 的那个小函数 ----------
   popup.js 与 wechat-setup.js 里的文案十有八九不走 `chrome.i18n.getMessage("键")`，
   而走 `msg("键")`。上面那条正则对它是瞎的，而反向判据（"语言包里的键有没有人提到"）
   也拦不住"新增一个语言包里根本没有的键"——那个键不在语言包里，反向无账可查。
   两头都不红，就是 A26 实测到的那个洞：加一个 msg("noSuchKeyXyz") 校验 exit 0 */

const WRAP_FUNC = `
function msg(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}
document.getElementById("a").textContent = msg("btnStart");
opt.textContent = msg(p.key);
el.title = msg(cond ? "chipA" : "chipB", ["x"]);
function setMsg(text) { status.textContent = text; }
setMsg("notKey1");
function pushMsg(t) { return t; }
pushMsg("notKey2");
`;

const WRAP_ARROW = `
const msg = (key) => chrome.i18n.getMessage(key) || key;
document.title = msg("guideTitle");
for (const el of list) el.textContent = msg(el.dataset.i18n);
`;

/* background.js 里真实存在的形状：它调 getMessage，但递进去的是本地 const，不是入参 */
const NOT_A_WRAP = `
const WECHAT_BODY_KEYS = { keyword: "wechatBodyKeyword", test: "wechatTestBody" };
function buildWechatContent(event, payload) {
  const p = payload || {};
  if (event === "keyword") return chrome.i18n.getMessage("wechatBodyKeyword", [p.text]);
  const key = WECHAT_BODY_KEYS[event];
  return chrome.i18n.getMessage(key);
}
buildWechatContent("keyword");
`;

test("function 声明与箭头两种包装都认得（本仓库各存在一处）", () => {
  assert.deepEqual(i18nAliases(WRAP_FUNC), ["msg"]);
  assert.deepEqual(i18nAliases(WRAP_ARROW), ["msg"]);
});

test("别名调用点走与 getMessage 同一条抽取规则：字面量与三元分支收，变量不收", () => {
  assert.deepEqual(jsMessageKeys(WRAP_FUNC, "msg"), ["btnStart", "chipA", "chipB"]);
  assert.deepEqual(jsMessageKeys(WRAP_ARROW, "msg"), ["guideTitle"]);
  /* 反向也要成立：包装函数自己那次 getMessage 的入参是变量，直写通道不该从里面抽出键 */
  assert.deepEqual(jsMessageKeys(WRAP_FUNC), []);
  assert.deepEqual(jsMessageKeys(WRAP_ARROW), []);
});

test("别名命中要整词：setMsg( 与 pushMsg( 是别的名字（收进来就是假报警）", () => {
  assert.ok(!jsMessageKeys(WRAP_FUNC, "msg").includes("notKey1"));
  assert.ok(!jsMessageKeys(WRAP_FUNC, "msg").includes("notKey2"));
});

test("调用了 getMessage 不等于别名：入参没递给 getMessage 就不算", () => {
  assert.deepEqual(i18nAliases(NOT_A_WRAP), [], "把普通函数当别名，它的每个实参字面量都会被报成键名");
  /* 而它本来该被直写通道看见的那条键不能因为这条判据而漏掉 */
  assert.deepEqual(jsMessageKeys(NOT_A_WRAP), ["wechatBodyKeyword"]);
});

test("只认自己函数体里那一次 getMessage：隔壁函数的调用不能算到头上", () => {
  const src = `
    function notAlias(key) { return key; }
    function isAlias(k) { return chrome.i18n.getMessage(k); }
    notAlias("notAKey"); isAlias("aRealKey");
  `;
  assert.deepEqual(i18nAliases(src), ["isAlias"], "函数体切早或切晚都会把两个名字一起收下");
  assert.deepEqual(jsMessageKeys(src, "isAlias"), ["aRealKey"]);
});

test("别名名是从源码现推的：改个名字判据跟着走，不靠表里抄过", () => {
  const src = `
    const lbl = k => chrome.i18n.getMessage(k);
    lbl("renamedKey");
    msg("nobodyWrapsThisAnymore");
  `;
  assert.deepEqual(i18nAliases(src), ["lbl"]);
  assert.deepEqual(jsMessageKeys(src, "lbl"), ["renamedKey"]);
});

/* ---------- 四、反向：谁提到过这个键 ---------- */

test("字符串字面量：单双引号都收，模板字面量不收", () => {
  assert.deepEqual(
    stringLiterals(`const a = "kLit"; const b = 'kSingle'; const c = \`k${"x"}Tpl\`;`),
    ["kLit", "kSingle"]
  );
  /* HTML 的属性值同样是引号包着的，所以 data-i18n / src 这些引用天然落进这个集合：
     反向判据只要一条通道，不需要再造一个"属性读取器" */
  assert.ok(stringLiterals(`<span data-i18n="ttl"></span>`).includes("ttl"));
});

/* ---------- 五、真实插件目录：扫描不是空转 ---------- */

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tab-auto-refresh");
const manifest = JSON.parse(readFileSync(join(PLUGIN, "manifest.json"), "utf8"));
const messages = JSON.parse(
  readFileSync(join(PLUGIN, "_locales", manifest.default_locale, "messages.json"), "utf8")
);
const known = new Set(Object.keys(messages));

const sources = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "_locales") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(html|js|mjs)$/.test(full)) sources.push([full, readFileSync(full, "utf8")]);
  }
})(PLUGIN);

const total = (isHtml, pick) =>
  sources.reduce((n, [f, s]) => n + (isHtml(f) ? pick(s).length : 0), 0);

/* 一个文件里所有别名通道取到的键（validate.mjs 的报账形状，这里只是把它摊平给判据用） */
const aliasKeys = (src) => i18nAliases(src).flatMap((a) => jsMessageKeys(src, a));

test("真实插件目录：五条通道各自都扫得到东西", () => {
  /* 下限是 2026-09-19 实测值往整十方向收的（实测 manifest 4 / 文件引用 7 / 属性 83 / 字面量 21 /
     别名键 48）。它不判对错，只保证"扫得到"：哪天正则或目录结构变了，这里先红，
     免得后面两条"全在语言包里"对着空集合绿过去。
     别名那一条的下限最要紧：抽不出别名时它是零条，而"零条"在正向判据那里的表现是**不报错**，
     整套对账会静默退回 A26 之前的覆盖面 */
  assert.equal(manifestMsgKeys(manifest).length, 4, "manifest 的 __MSG_ 引用条数变了，正则或 manifest 要一起核");
  assert.ok(total((f) => f.endsWith(".html"), htmlLocalRefs) >= 7, "HTML 文件引用一条都没扫到");
  assert.ok(total((f) => f.endsWith(".html"), htmlI18nKeys) >= 80, "data-i18n 一条都没扫到");
  assert.ok(total(() => true, jsMessageKeys) >= 20, "getMessage 字面量一条都没扫到");
  assert.ok(total(() => true, aliasKeys) >= 40, "别名通道一条都没扫到，包装函数改名或写法换了");
});

test("真实插件目录：别名是从两个页面脚本里现推出来的，别处一个都没有", () => {
  const found = sources
    .filter(([f]) => /\.(js|mjs)$/.test(f))
    .flatMap(([f, s]) => i18nAliases(s).map((a) => `${relative(PLUGIN, f).replace(/\\/g, "/")}:${a}`))
    .sort();
  assert.deepEqual(found, ["popup.js:msg", "wechat-setup.js:msg"],
    "别名面变了：多出来说明又有页面抄了包装（判据跟着走，但要回来核这条正向见证的下限），" +
    "少了说明推导瞎了——而推导瞎掉时正向判据不会红，只有这条会");
});

test("真实插件目录：五条通道引用的键全在语言包里，引用的文件全在", () => {
  const bad = [];
  for (const { path, key } of manifestMsgKeys(manifest)) {
    if (!known.has(key)) bad.push(`manifest ${path} -> ${key}`);
  }
  for (const [f, s] of sources) {
    const html = f.endsWith(".html");
    if (html) {
      for (const ref of htmlLocalRefs(s)) {
        if (!existsSync(join(dirname(f), ref))) bad.push(`${f} -> 文件 ${ref}`);
      }
      for (const key of htmlI18nKeys(s)) if (!known.has(key)) bad.push(`${f} -> 键 ${key}`);
    }
    for (const key of jsMessageKeys(s)) if (!known.has(key)) bad.push(`${f} -> 键 ${key}`);
    for (const key of aliasKeys(s)) if (!known.has(key)) bad.push(`${f} -> 别名键 ${key}`);
  }
  assert.deepEqual(bad, [], "有引用落在语言包/插件目录之外：界面会静默少一块");
});

test("真实插件目录：每条文案都有人在源码里提到", () => {
  /* 这一头补"键从变量里取出来"那一类的盲区：popup.js 与 wechat-setup.js 都写
     getMessage(key)，键是从 data-i18n 属性或键表里取出来的字面量。这种引用正向判据本来就
     看不见（实参不是字面量），红的是"本来那条没人用了"。
     A26 之后别名调用 `msg("字面量")` 两头都红了，这条判据对它们成了冗余——留着不亏：
     哪天包装换成 `msg(键表[k])`，正向又瞎了，只有这一条还认得 */
  const referenced = new Set(manifestMsgKeys(manifest).map((r) => r.key));
  for (const [, s] of sources) for (const k of stringLiterals(s)) referenced.add(k);
  const orphans = Object.keys(messages).filter((k) => !referenced.has(k));
  assert.deepEqual(orphans, [], "语言包里有键没人提到：要么它是死文案，要么引用处键名打错了");
});

/* 红→绿对照（2026-09-19 实跑，脚本 D:/Github/_tar_ctl_r4/run.mjs：整仓复制到仓库外的 copy、
   删掉 .git（validate.mjs 的"未跟踪文件"那一圈因此跳过，基线才是干净的 exit 0），
   一轮只在副本里改坏一处，needle 必须正好命中一次否则该处作废并打印。
   基线：本文件 12 条全绿，副本的 validate.mjs exit 0。
   G* 改副本里的 scripts/validate-refs.mjs，跑本文件；V* 改副本里的真实插件源码或语言包，
   跑副本里的 scripts/validate.mjs；O* 把副本里的 validate.mjs 换回 HEAD 那份（也就是改前）再跑同一处破坏。
     G1 manifestMsgKeys 退回只看 name 与 description（正是改前的覆盖面）
        → 红 4：两条单测 + "四条通道都扫得到东西"(4→2) + "每条文案都有人提到"。
          最后那条不是冗余：commandToggleRefresh 只有 manifest 这一条通道能救，退回就成孤儿——
          正向少收一处、反向立刻跟着红，这就是"两头一夹"的意思
     G2 htmlLocalRefs 不剥 ? 与 # → 红 1：只红在"只收本地 src/href"（popup.js?v=2 原样进集合）
     G3 jsMessageKeys 不切第一个实参 → 红 2：subs 那条 + 真实仓库那条。真实源码里
          getMessage 的第二实参带着不是键的字面量，多收就假报警
     G4 branchesOf 不切三元条件（这就是本文件第一版的真实写法）
        → 红 3：subs 那条 + "嵌套调用"那条 + 真实仓库那条。G4 抓出来的正是当场撞到的那个 bug：
          第一版对真实 background.js 报"getMessage 引用了语言包里没有的键 captcha"——
          `p.reason === "captcha"` 里那个字面量是拿去比值的，不是键
     G5 stringLiterals 只认双引号 → 红 1："字符串字面量：单双引号都收"
     V4 把 popup.js 的 msg("btnStart") 打成 msg("btnStartt")
        → exit 1，且只报一条："键 btnStart 在插件源码里没有一处提到"。当时正向判据看不见它
          （msg 是 getMessage(变量) 的别名，实参不是 getMessage 调用的字面量），
          反向判据一个人堵住这一类。O4 拿同一处破坏配改前的 validate.mjs：exit 0
          ——**A26 之后这一条变了**：正向也看得见了，同一处破坏现在红两条，见下面 B4
     V1 popup.html 一处 data-i18n 打错 → exit 1："data-i18n 引用了语言包里没有的键 restrictHintTypo"
        （O1 同一处配改前：exit 0）
     V2 两种语言包各加一条没人提到的键 → exit 1："键 r4Orphan 在插件源码里没有一处提到"
        （O3 同一处配改前：exit 0）
     V2b 只往 zh_CN 加 → exit 1 报两条：既有的"两边键齐平"照红，加上新那条孤儿。
          记下来是为了确认新判据没把老判据挤掉
     V3 popup.html 的 href 改成 popup.csss → exit 1："引用了不存在的文件 popup.csss"
        （O2 同一处配改前：exit 0）

   A26（第八轮，2026-09-19 同日）补的就是 V4 那条备注里"正向判据看不见它"的那一半——
   那一半不是冗余覆盖面，是**零**：语言包里根本没有的键，反向无账可查，正向又不看别名。
   同一套打法再跑一遍（脚本 D:/Github/_tar_ctl_r8/run.mjs，整仓复制到仓库外、不带 .git，
   每个变体跑两样：副本的 scripts/validate.mjs 看 exit 码，副本的本文件看抽取器的正向见证；
   O* 那两组先把副本的 scripts 换回改前那一份再破坏，此时本文件跑不了——改前没有 i18nAliases
   这个导出，import 就炸，所以那两组只取 exit 码）。基线：本文件 19 条全绿，副本 validate exit 0
     B1 popup.js 末尾加一句 msg("noSuchKeyXyz") → exit 1："popup.js: msg() 引用了语言包里没有的键
          noSuchKeyXyz"，本文件红 1
     B1o 同一处破坏配改前的两份 scripts → **exit 0，一条都不报**。这就是这一轮要修的洞，
          也是它值得记的地方：改前的判据面对一个界面上会露出原始键名的错，CI 是全绿的
     B2 wechat-setup.js 加同样一句 → exit 1，报的是 wechat-setup.js（箭头形式那个包装也认得了）
     B2a 只废掉箭头那一支推导 + B2 那一处破坏 → exit 0，本文件红 3
          ——证明两种写法不是顺手多支持一下：只认 function 声明会把整个教程页留在射程外
     B3 把 popup.js 的 msg 整词改名成 lbl（setMsg( 与 pushMsg( 那些不能跟着动）再加假键
          → exit 1 且报的是 "lbl() 引用了…noSuchKeyXyz3"，本文件红 2
          ——别名名是现推的，不是表里抄的；红的那两条是"别名面恰好是 popup.js:msg 与
          wechat-setup.js:msg"那条正向见证，它钉的是今天的形状，改名要回来一起改，这是刻意的成本
     B4 已存在的键打错一个字母（msg("btnStart") → msg("btnStartt")）→ exit 1 两条：
          正向点名 btnStartt（因），反向报 btnStart 成了孤儿（果）；本文件红 2
     B4o 同一处配改前 → exit 1 一条，只剩那条果。改前也拦得住，但用户看到的是一句"某条文案没人用"，
          不是"你把键名拼错了"
     B5 废掉推导条件（永假）→ 本文件红 5（含那条 ≥40 的下限见证），而 validate **exit 0**
     B5b 同上再叠加 B1 那一处假键 → validate 仍然 exit 0。也就是说抽取器写坏时，现场哪怕真有一个
          错键，CI 照绿——本文件那两条数量下限是这一类唯一的拦网，所以它必须比判据本身更严
     B6 把下面那处"过滤器写坏"的账原样装回副本 → 本文件 19 条照样全绿、validate exit 0。
          这一处不是改坏产品代码，是改坏**见证自己**：跑它是为了确认下面那段账是真的
   一批门禁自己的账：第一次写"别名面"那条见证时，过滤器写成 .filter(([, s]) => … /\.test("") …)，
   对空串求值等于恒真、压根没过滤，副本跑出来照样全绿（就是上面 B6 那一处）——因为本仓库两个 HTML
   里没有内联脚本，i18nAliases 在它们身上回空集。判据恰好落在一份空洞语料上，坏味道和绿长得一样，
   改成按文件名筛 JS 之后再跑一遍才确认这一条真的有覆盖面
   已知边界（没做门禁，写在这里免得被当成已覆盖）：
     - 认不出注释：键名带引号写在注释里也算"有人提到"
     - 模板字面量与拼出来的键名（"wechatEv" + ev）静态判不了；本仓库目前零处，
       真出现时会红在"没人提到"那条上，不会静默
     - HTML 内联 style 的 url()、manifest 的 web_accessible_resources 之类不查（本仓库现在没有这两样）
     - validate.mjs 的执行器（遍历目录、拼路径、报账）没有单测：G* 与 V* 是端到端跑整条命令，
       正则那一头由本文件钉住
     - 别名只在本文件内推导：包装函数定义在 shared/*.js 里、别的页面 import 过来用，这一条看不见
       （本仓库现有两处都是"同文件定义、同文件调用"）。真出现跨文件时要么把它做成显式约定并补判据，
       要么它会红在"这个键没人提到"那条上——不会静默
     - 函数体靠花括号配对切。字符串或注释里落单的 '{' 会让切点跑偏；跑偏刻意选成"多扫一段"而不是
       "少扫一段"：多扫会把不相干字面量算进引用面，而反向判据本来把"提到过"当全集，多算不红；
       少扫是漏别名，等于静默退回零覆盖，只有那条数量下限认得
     - obj.msg("x") 这种同名方法调用会被当成别名调用（命中判据只看前一个字符是不是标识符字符，
       点号放行是因为 chrome.i18n.getMessage( 要收）。本仓库零处；真出现时表现是假报警，看得见
     - 打错的键**恰好也是**语言包里的另一个键（btnStart → btnStop）时两条判据都不红：引用存在、
       被引用者也有人用，集合层面完全自洽。静态检查到这就是天花板，剩下的是语义 */
