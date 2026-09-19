/* 2026-09-19 审计 A5 的门禁：弹窗要按当前标签页的任务回填关键词、继续盯守、实际间隔。
   形状是"数据丢失入口"而不是"少显示一行"：用户想改关键词只能先停再重开，
   而重开那次读的是空框，原来那条监控就此静默消失。

   popup.js 整体跑不了（它是 DOM + chrome.* 的混合体，仓库也没有 DOM 库），
   所以按 keyword-inpage.test.mjs 的同一做法：按花括号配对切出函数真实源码，
   把它依赖的名字当形参注入，然后真跑。PRESETS / clampInterval / getTaskKeywords
   用的是模块的真身，不另抄一份，免得门禁和被测代码各自漂移。

   红→绿对照实跑见文件末尾。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { PRESETS } from "../../tab-auto-refresh/shared/config.js";
import { clampInterval, getTaskKeywords } from "../../tab-auto-refresh/shared/logic.js";

/* 红→绿对照用：TAR_POPUP_SRC 指到另一份 popup.js（只读文本，不 import）。CI 上不设 */
const POPUP_PATH = process.env.TAR_POPUP_SRC
  ? process.env.TAR_POPUP_SRC
  : new URL("../../tab-auto-refresh/popup.js", import.meta.url);
const POPUP_SRC = readFileSync(POPUP_PATH, "utf8").replace(/\r\n/g, "\n");

/* 按花括号配对切出函数源码（与 keyword-inpage.test.mjs 同法）。
   函数体里带花括号的字符串会切歪，那样下面的 new Function 直接抛错，是响失败不是静默假绿 */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 ${name}()`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}() 的花括号没闭合`);
}

const FN_SRC = sliceFunction(POPUP_SRC, "populateTaskFields");

/* 假控件：只给这个函数真的会碰的那四个字段。init 里给它们填过的初值一并带上，
   这样"没有任务时不该动用户正在输入的东西"这条能真的断言，而不是默认为真 */
function makeDom() {
  return {
    keywordInput: { value: "" },
    keepWatchingCheck: { checked: false },
    presetSelect: { value: String(PRESETS[1] ? PRESETS[1].seconds : 300) },
    customInput: { value: "" }
  };
}

function run(dom, { task, tabId }) {
  const $ = (id) => dom[id];
  const tasks = task === null ? {} : { 7: task };
  const currentTab = tabId === null ? null : { id: 7 };
  return new Function(
    "$", "tasks", "currentTab", "PRESETS", "clampInterval", "getTaskKeywords",
    `${FN_SRC}; return populateTaskFields;`
  )($, tasks, currentTab, PRESETS, clampInterval, getTaskKeywords)();
}

test("空跑守卫：确实切到了函数源码", () => {
  assert.ok(FN_SRC.length > 120, "切出来的源码过短，等于什么都没测");
  assert.match(FN_SRC, /^function populateTaskFields\(\)/);
});

test("函数真的被 init 调用，且排在 initPresetSelect 之后", () => {
  /* 一个没人调的函数等于改动没发生。这一条就是 A6 那条教训的形状：
     桩件里的 __fixture、env.fire.installed 都是写下即死入口 */
  const calls = [...POPUP_SRC.matchAll(/populateTaskFields\(\)/g)].map((m) => m.index);
  assert.equal(calls.length, 2, "除了定义之外，init 里必须恰好有一次调用");
  const presetInit = POPUP_SRC.indexOf("initPresetSelect();");
  assert.ok(presetInit > 0 && calls[1] > presetInit, "回填排在预填之前会被它盖掉");
});

test("预设间隔：下拉选中它，秒数框清空", () => {
  const p = PRESETS[0];
  const dom = makeDom();
  dom.customInput.value = "90";
  run(dom, { task: { intervalSec: p.seconds } });
  assert.equal(dom.presetSelect.value, String(p.seconds));
  assert.equal(dom.customInput.value, "", "两个入口同时持有值，等于回到旧的显示与生效不一致");
});

test("非预设间隔：下拉走自定义，秒数框给出实际值", () => {
  const dom = makeDom();
  run(dom, { task: { intervalSec: 90 } });
  assert.equal(dom.presetSelect.value, "");
  assert.equal(dom.customInput.value, "90");
});

test("关键词与继续盯守按任务实际值回填", () => {
  const dom = makeDom();
  run(dom, { task: { intervalSec: 300, keywords: ["已售罄", "补货"], onHit: "continue" } });
  assert.equal(dom.keywordInput.value, "已售罄,补货");
  assert.equal(dom.keepWatchingCheck.checked, true);
});

test("旧单串 keyword 的任务也回得填上", () => {
  const dom = makeDom();
  run(dom, { task: { intervalSec: 300, keyword: "降价" } });
  assert.equal(dom.keywordInput.value, "降价");
});

test("继续盯守复选框只认 onHit === \"continue\"：stop 与旧数据缺字段都要落回未勾选", () => {
  /* 对照跑出来的教训：第一条变异（判据换成 !!task.onHit）本来是绿的，因为只测了
     "缺 onHit"这一种旧数据形状。真实起任务时后台一律写 onHit，默认值是 "stop"，
     所以 "stop" 才是这条判据天天遇到的输入 */
  for (const onHit of ["stop", undefined]) {
    const dom = makeDom();
    dom.keepWatchingCheck.checked = true;
    run(dom, { task: { intervalSec: 300, onHit } });
    assert.equal(
      dom.keepWatchingCheck.checked, false,
      `onHit=${onHit} 时复选框应未勾选（判据退化成"有没有 onHit"就看不出来）`
    );
  }
});

test("当前标签页没有任务：一个字都不动", () => {
  const dom = makeDom();
  dom.keywordInput.value = "用户正在打";
  dom.customInput.value = "120";
  dom.presetSelect.value = "";
  run(dom, { task: null });
  assert.equal(dom.keywordInput.value, "用户正在打");
  assert.equal(dom.customInput.value, "120");
  assert.equal(dom.presetSelect.value, "");
  const before = structuredClone(dom);
  run(dom, { task: null });
  assert.deepEqual(dom, before, "无任务时不得改任何控件");
});

test("弹窗拿不到当前标签页时不炸", () => {
  const dom = makeDom();
  dom.keywordInput.value = "留着";
  run(dom, { task: { intervalSec: 300 }, tabId: null });
  assert.equal(dom.keywordInput.value, "留着");
});

test("缺 intervalSec 的任务不会把 undefined 写进数字框", () => {
  const dom = makeDom();
  run(dom, { task: { keywords: ["x"] } });
  assert.doesNotMatch(dom.customInput.value, /undefined|NaN/);
  assert.match(dom.customInput.value, /^\d*$/);
});

/* ---------- popup.html 的源码扫描 ----------
   上面那些用例靠切 popup.js 的函数源码来跑，控件本身（HTML 上那几个 input）从来没进过视野，
   而"密钥框回显不回显"这件事恰好只写在 HTML 里。与 message-gate 扫 keepalive.js 同一形状：
   读不来的行为就扫源码，别因为"没法执行"干脆不守。 */

/* 红→绿对照用：TAR_POPUP_HTML 指到另一份 popup.html（只读文本）。CI 上不设 */
const POPUP_HTML_PATH = process.env.TAR_POPUP_HTML
  ? process.env.TAR_POPUP_HTML
  : new URL("../../tab-auto-refresh/popup.html", import.meta.url);
const POPUP_HTML = readFileSync(POPUP_HTML_PATH, "utf8").replace(/\r\n/g, "\n");

test("密钥输入框是 type=\"password\"：旁边有人时读不到用户粘进去的凭据", () => {
  /* appsecret 是一把能以该公众号名义发消息的钥匙，且随 sync 明文存；
     输入框回显等于把最后一个只靠屏幕位置的防线也拿掉 */
  const tag = POPUP_HTML.match(/<input[^>]*id="wechatSecretInput"[^>]*>/);
  assert.ok(tag, "弹窗里找不到密钥输入框，控件改了名要先同步这条用例");
  assert.match(tag[0], /\btype="password"/, "密钥框回退成明文回显");
});

/* ---------- 红→绿对照（2026-09-19 实跑，node v24.21.0） ----------

   做法：只把 popup.js 复制到仓库外一份、逐处改坏，TAR_POPUP_SRC 指给本文件跑。
   与 A2 那批要整仓复制不同——A2 的 logic.test.mjs import 的是真模块、变异落在 shared/logic.js，
   TAR_BG 换不动它；本文件的变异全在 popup.js 的源码文本里，import 进来的 config/logic 一个字没改。

   处 1 删掉 init 里那次调用（定义留着）    → 红 1 条：函数真的被 init 调用…
   处 2 把调用挪到 initPresetSelect() 之前  → 红 1 条：同上一条（它测的就是顺序）
   处 3 去掉无任务时的早退                  → 红 2 条：当前标签页没有任务…、拿不到当前标签页时不炸
   处 4 onHit === "continue" 换成 !!task.onHit
        → 第一次跑是绿的。补了 "stop" 这条输入之后才红 1 条：继续盯守复选框只认…
          原用例只喂了"缺 onHit"的旧数据形状，而后台起任务一律写 onHit、默认值是 "stop"，
          判据退化最常遇到的那个输入根本没进过断言
   处 5 关键词连接符 "," 换成空格           → 红 1 条：关键词与继续盯守…
        （"旧单串 keyword…"那条不红，因为它只有一条关键词，换什么分隔符都得到同一个字面——
          那条用例钉的是兼容读取，钉不了分隔符，两处各管一件事）
   处 6 间隔不过 clampInterval，直接取存盘值 → 红 1 条：缺 intervalSec 的任务不会把 undefined…
   处 7 绕开 getTaskKeywords 直接读 task.keywords → 红 1 条：旧单串 keyword 的任务也回得填上
   处 8（2026-09-19，A4）popup.html 里密钥框的 type="password" 改回 "text"
        → 红 1 条：密钥输入框是 type="password"…
        这一处先按"整仓复制、在副本里跑"验过一遍，又用 TAR_POPUP_HTML 指着一份临时改坏的
        popup.html 再跑一遍——新增的重定向入口本身也要跑一次，否则它就是 A6 记的那种死入口

   八处各只红在它点名的那一条（处 3 两条），没有一条变异能同时躲过顺序守卫与早退守卫。 */
