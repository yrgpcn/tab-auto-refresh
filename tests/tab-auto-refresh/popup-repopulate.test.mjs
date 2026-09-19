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
import { clampInterval, getTaskKeywords, normalizeWebhookUrl } from "../../tab-auto-refresh/shared/logic.js";

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

/* ---------- A8：webhook 状态行与"发送测试" ----------
   与上面 populateTaskFields 同一做法：切 renderWebhook() 的真实源码来跑。
   webhookLast 在 popup.js 里是模块级 let，切出来的函数体中它是自由变量，
   把它当形参注入就能逐例喂值。fmtClock 给确定性的桩：这条要钉的是"选哪个文案键、
   传的是不是 at、按钮该不该藏"，不是时刻怎么格式化（那份实现微信侧早就在用）。 */

const WH_FN_SRC = sliceFunction(POPUP_SRC, "renderWebhook");
const whClock = (ms) => "⏱" + ms;
const whMsg = (key, subs) => key + (subs && subs.length ? ":" + subs.join("|") : "");

function runWh({ raw, last }) {
  /* 初值刻意带上一次残留：全给空串，"地址清空时要抹掉旧文字/旧颜色"这一半就永远测不到
     （对照 P2 第一次跑就是绿的，原因在此） */
  const dom = {
    webhookUrlInput: { value: raw },
    webhookRow: { hidden: true },
    webhookTestBtn: { hidden: true, disabled: false, textContent: "" },
    webhookState: { textContent: "webhookErrAuth", className: "wx-state error" }
  };
  new Function(
    "$", "msg", "fmtClock", "normalizeWebhookUrl", "webhookLast",
    `${WH_FN_SRC}; return renderWebhook;`
  )((id) => dom[id], whMsg, whClock, normalizeWebhookUrl, last)();
  return dom;
}

test("空跑守卫：确实切到了 renderWebhook 源码", () => {
  assert.ok(WH_FN_SRC.length > 200, "切出来的源码过短，等于什么都没测");
  assert.match(WH_FN_SRC, /^function renderWebhook\(\)/);
});

test("没填地址：整行藏起来，状态文字清空", () => {
  for (const raw of ["", "   "]) {
    const dom = runWh({ raw, last: { ok: false, errorKey: "webhookErrAuth", at: 1 } });
    assert.equal(dom.webhookRow.hidden, true, `地址 ${JSON.stringify(raw)} 还占着一行高度`);
    assert.equal(dom.webhookState.textContent, "", "藏起来的行里还留着上一次的失败文字");
    assert.equal(dom.webhookState.className, "wx-state", "修饰类没清，下次显示时带着旧颜色");
  }
});

test("地址非法：红字提示留着，测试按钮藏掉（摆个假按钮比不摆更糟）", () => {
  const dom = runWh({ raw: "javascript:alert(1)", last: null });
  assert.equal(dom.webhookRow.hidden, false);
  assert.equal(dom.webhookState.textContent, "webhookInvalid");
  assert.match(dom.webhookState.className, /\berror\b/);
  assert.equal(dom.webhookTestBtn.hidden, true);
});

test("地址合法但从没投过：说“等待首次推送”，按钮可用", () => {
  const dom = runWh({ raw: "https://h.example/x", last: null });
  assert.equal(dom.webhookRow.hidden, false);
  assert.equal(dom.webhookState.textContent, "webhookStateIdle");
  assert.doesNotMatch(dom.webhookState.className, /ok|error/, "没投过就别上色，那是灰态");
  assert.equal(dom.webhookTestBtn.hidden, false);
});

test("最近一次投递成功：绿态并给出时刻，取的是留痕里的 at", () => {
  const dom = runWh({ raw: "https://h.example/x", last: { ok: true, status: 204, at: 1234 } });
  assert.equal(dom.webhookState.textContent, "webhookStateOk:⏱1234");
  assert.match(dom.webhookState.className, /\bok\b/);
});

test("最近一次投递失败：按 errorKey 取文案，红态", () => {
  /* 真实留痕里非网络层的失败一律带 status（webhookResultOf 给的），
     这里不省略它，"判成功看 ok 还是看 status"才有区分度（对照 P3 的教训） */
  const dom = runWh({
    raw: "https://h.example/x",
    last: { ok: false, kind: "auth", status: 403, errorKey: "webhookErrAuth", at: 1 }
  });
  assert.equal(dom.webhookState.textContent, "webhookErrAuth");
  assert.match(dom.webhookState.className, /\berror\b/);
});

test("失败留痕没带 errorKey：兜底文案，不能显示 undefined", () => {
  /* 后台留痕的字段是拼出来的，少给一个键就该落到兜底，而不是把 "undefined" 摆在弹窗里 */
  const dom = runWh({ raw: "https://h.example/x", last: { ok: false, kind: "weird", status: 418, at: 1 } });
  assert.equal(dom.webhookState.textContent, "webhookErrOther");
  assert.doesNotMatch(dom.webhookState.textContent, /undefined/);
});

test("renderWebhook 用到的控件在 popup.html 里都在，状态行默认藏着", () => {
  const ids = [...WH_FN_SRC.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, `只切出 ${ids.length} 个控件 id，本条是空跑`);
  for (const id of new Set(ids)) {
    assert.ok(POPUP_HTML.includes(`id="${id}"`), `popup.js 用 $('${id}')，HTML 里没有这个控件（运行时 $ 返回 null 直接抛）`);
  }
  assert.match(POPUP_HTML, /<div id="webhookRow"[^>]*\bhidden\b/, "状态行默认不藏着：没填地址的用户白占一行高度");
});

test("两个颜色类在 CSS 里真的存在：类挂上了却没样式等于没有反馈", () => {
  const CSS = readFileSync(
    new URL("../../tab-auto-refresh/popup.css", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  for (const cls of ["ok", "error"]) {
    assert.ok(CSS.includes(`.wx-state.${cls}`), `.wx-state.${cls} 没了，${cls} 态跟灰态长得一样`);
  }
});

test("renderWebhook 的五处调用各在各自的事件里", () => {
  /* 定义那一行也写成 renderWebhook() {，所以只数独占一句的调用。
     4 处是 A8 的形状；A11 给文本框补 input 绑定后是 5 处（初绘、input、change、点测试、留痕变化） */
  const calls = [...POPUP_SRC.matchAll(/^\s*renderWebhook\(\);$/gm)];
  assert.equal(calls.length, 5, `调用点该是 5 处（初绘、input、change、点测试、留痕变化），实到 ${calls.length} 处`);
  /* 初绘必须紧跟在地址回填之后：它读的是输入框当前值，排在前面就等于永远显示"未配置" */
  const fill = POPUP_SRC.indexOf('$("webhookUrlInput").value = settings.webhookUrl');
  assert.ok(fill > 0 && POPUP_SRC.indexOf("renderWebhook();", fill) - fill < 80, "初绘没紧跟在地址回填后面");
  /* 改了 webhookLast 的两个地方要各跟一次重绘，否则状态行停在旧值上 */
  for (const needle of ["webhookLast = res.result;", "webhookLast = changes.webhookLastResult.newValue || null;"]) {
    const at = POPUP_SRC.indexOf(needle);
    assert.ok(at > 0, `找不到 ${needle}，赋值点被改写后这条循环就空跑了`);
    assert.ok(POPUP_SRC.slice(at, at + 120).includes("renderWebhook();"), `${needle} 后面没重绘`);
  }
  /* 读盘若少了这一个键，弹窗会永远停在"等待首次推送" */
  const rs = sliceFunction(POPUP_SRC, "refreshState");
  assert.match(rs, /"webhookLastResult"/, "refreshState 不再读 webhookLastResult");
  assert.match(rs, /webhookLast = local\.webhookLastResult \|\| null/);
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

   ---------- A8（webhook 状态行）的对照，同一天实跑，脚本在仓库外 ctl-a8/ ----------
   这批变异要同时落在 popup.js / popup.html / popup.css，而"没填地址时抹掉残留文字"这一条
   光靠文本变异测不到（见处 10），所以改走整仓复制、在副本里跑本文件；
   TAR_POPUP_SRC 与 TAR_POPUP_HTML 两个入口本轮没用上，它们在处 1~8 已被跑过，不是死入口。

   处 9  P1 地址非法时不藏测试按钮          → 红 1 条：地址非法…
   处 10 P2 地址清空时不抹状态文字
        → 第一次跑是绿的：假 DOM 的 textContent 初值就是 ""，"抹掉"与"什么都不做"拿到同一个值。
          把初值换成上一轮残留（"webhookErrAuth" + error 类）之后重跑 → 红 1 条：没填地址…
          顺带让灰态那条 doesNotMatch(className, /ok|error/) 也真的有了区分度
   处 11 P3 成功/失败判据从 ok 换成 status
        → 第一次跑也是绿的：那条用例喂的失败留痕没带 status（真实留痕必带），
          于是 status 为 undefined、照旧落到失败分支。补上 status: 403 / 418 之后
          → 红 2 条：最近一次投递失败…、失败留痕没带 errorKey…
        两处"第一次绿"是同一个形状：桩件比真实输入更干净，判据退化就看不出来
   处 12 P4 读盘清单里的键写成 webhookLast  → 红 1 条：renderWebhook 的四处调用…（它兼查 refreshState）
   处 13 P5 删掉 init 那次初绘              → 红 1 条：同上一条（调用点数从 4 变 3）
   处 14 P6 留痕变化后不重绘                → 红 1 条：同上一条（needle 循环查不到紧随的重绘）
        13/14 红的是同一条用例，但红的原因不同：一处数个数、一处查相邻性，缺一个断言另一处就溜过去
   处 15 H1 状态行去掉 hidden               → 红 1 条：renderWebhook 用到的控件在 popup.html 里都在…
   处 16 H2 状态文字控件改名                → 红 1 条：同上那条（id 覆盖那半边）
   处 17 H3 删掉 CSS 里的 .wx-state.ok      → 红 1 条：两个颜色类在 CSS 里真的存在…

   处 1~8 各只红在它点名的那一条（处 3 两条），没有一处变异能同时躲过顺序守卫与早退守卫；
   处 9~17 同样各红 1~2 条，且红的全是本条点名的用例——两处绿是补了输入形状才变红的。 */
