/* scripts/validate-refs.mjs 的门禁。它钉的是正则，而 validate.mjs 从前一条门禁都没有：
   正则写坏一处，"仓库级校验"会从报错静默退化成"什么都没引用、什么都没缺"，CI 照绿。
   四条引用通道各钉正反两面：抽得出该抽的，不误抽不该抽的。
   最后三节把真实仓库的插件目录再扫一遍，只为证明"这套正则不是对着空串自嗨"。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  htmlI18nKeys,
  htmlLocalRefs,
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

test("真实插件目录：四条通道各自都扫得到东西", () => {
  /* 下限是 2026-09-19 实测值往整十方向收的（实测 manifest 4 / 文件引用 7 / 属性 83 / 字面量 21）。
     它不判对错，只保证"扫得到"：哪天正则或目录结构变了，这里先红，
     免得后面两条"全在语言包里"对着空集合绿过去 */
  assert.equal(manifestMsgKeys(manifest).length, 4, "manifest 的 __MSG_ 引用条数变了，正则或 manifest 要一起核");
  assert.ok(total((f) => f.endsWith(".html"), htmlLocalRefs) >= 7, "HTML 文件引用一条都没扫到");
  assert.ok(total((f) => f.endsWith(".html"), htmlI18nKeys) >= 80, "data-i18n 一条都没扫到");
  assert.ok(total(() => true, jsMessageKeys) >= 20, "getMessage 字面量一条都没扫到");
});

test("真实插件目录：四条通道引用的键全在语言包里，引用的文件全在", () => {
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
  }
  assert.deepEqual(bad, [], "有引用落在语言包/插件目录之外：界面会静默少一块");
});

test("真实插件目录：每条文案都有人在源码里提到", () => {
  /* 这一头补字面量通道的盲区：popup.js 与 wechat-setup.js 都写 getMessage(变量)，
     键是从 data-i18n 属性或键表里取出来的字面量。键名打错时"引用了没有的键"不会红
     （那个键压根不在语言包里，正向判据只看引用面），红的是"本来那条没人用了" */
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
        → exit 1，且只报一条："键 btnStart 在插件源码里没有一处提到"。正向判据看不见它
          （msg 是 getMessage(变量) 的别名，实参不是 getMessage 调用的字面量），
          反向判据一个人堵住这一类。O4 拿同一处破坏配改前的 validate.mjs：exit 0
     V1 popup.html 一处 data-i18n 打错 → exit 1："data-i18n 引用了语言包里没有的键 restrictHintTypo"
        （O1 同一处配改前：exit 0）
     V2 两种语言包各加一条没人提到的键 → exit 1："键 r4Orphan 在插件源码里没有一处提到"
        （O3 同一处配改前：exit 0）
     V2b 只往 zh_CN 加 → exit 1 报两条：既有的"两边键齐平"照红，加上新那条孤儿。
          记下来是为了确认新判据没把老判据挤掉
     V3 popup.html 的 href 改成 popup.csss → exit 1："引用了不存在的文件 popup.csss"
        （O2 同一处配改前：exit 0）
   已知边界（没做门禁，写在这里免得被当成已覆盖）：
     - 认不出注释：键名带引号写在注释里也算"有人提到"
     - 模板字面量与拼出来的键名（"wechatEv" + ev）静态判不了；本仓库目前零处，
       真出现时会红在"没人提到"那条上，不会静默
     - HTML 内联 style 的 url()、manifest 的 web_accessible_resources 之类不查（本仓库现在没有这两样）
     - validate.mjs 的执行器（遍历目录、拼路径、报账）没有单测：G* 与 V* 是端到端跑整条命令，
       正则那一头由本文件钉住 */
