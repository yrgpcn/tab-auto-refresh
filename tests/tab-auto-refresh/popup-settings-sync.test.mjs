/* 2026-09-19 审计 A18 的门禁：另一台设备改的设置要铺回这个弹窗的控件。

   修前的形状：storage.onChanged 的 settings 分支只 refreshState() + renderAll()，
   而 renderAll 画的是任务列表与角标，15 个设置控件一个都不碰。于是弹窗开着多久，
   它就停在打开那一刻的快照上——而 saveSettings 读的是这 15 个控件、整份覆盖写回，
   所以"另一台设备刚关掉的 keepAlive"会被这个窗口的下一次保存静默翻回来。
   这不是显示滞后，是撤销别人的改动。

   两条约束（BACKLOG A18）钉在这儿，不是可选项：
   ① 五个走 settings 的文本框在获得焦点、或有去抖写盘挂在路上时一律跳过，
      而且整组一起跳——A11 的 input 去抖是为了不抹用户输入，这一条是为了不被别人的值抹输入，
      两者必须共用同一个判据，否则修好一个就弄坏另一个。
   ② saveSettings 仍发整份快照。要改成只发差异键就得连后台 patchSettings 的锁方向
      一起重新论证，所以这里用"两份控件清单必须同源"的守卫把它钉住。

   popup.js 整体跑不了（DOM + chrome.* 的混合体，仓库没有 DOM 库），沿用
   popup-repopulate / popup-save-timing 的做法：按花括号切真实源码、依赖当形参注入、真跑。
   renderWebhook / renderWechat 也切真实源码进来，所以"两行状态跟着重算"是跑出来的，
   不是数调用点数目出来的。红→绿对照实跑见文件末尾。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  clampInterval,
  normalizeWebhookUrl,
  notifyEventsOf,
  wechatConfigState
} from "../../tab-auto-refresh/shared/logic.js";

/* 红→绿对照用：TAR_POPUP_SRC 指到另一份 popup.js（只读文本，不 import）。CI 上不设 */
const POPUP_PATH = process.env.TAR_POPUP_SRC
  ? process.env.TAR_POPUP_SRC
  : new URL("../../tab-auto-refresh/popup.js", import.meta.url);
const POPUP_SRC = readFileSync(POPUP_PATH, "utf8").replace(/\r\n/g, "\n");

/* 与 popup-repopulate.test.mjs 同法。函数体里带花括号的字符串会切歪，
   那样下面的 new Function 直接抛错，是响失败不是静默假绿 */
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

/* 从 marker 之后第一个 "{" 起做花括号配对，切出一整块（含首尾花括号）。
   用于 storage.onChanged 那个箭头监听器——它不是 function 声明，sliceFunction 认不到 */
function sliceBlock(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`源码里找不到 ${marker}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${marker} 的花括号没闭合`);
}

function idsOf(listConst) {
  const m = POPUP_SRC.match(new RegExp(`const ${listConst} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `popup.js 里没有 ${listConst}，切片前提已经不成立`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const TEXT_IDS = idsOf("TEXT_SETTING_INPUT_IDS");
const LABELS_M = POPUP_SRC.match(/const WECHAT_FIELD_LABEL_KEYS = \{([\s\S]*?)\};/);
assert.ok(LABELS_M, "popup.js 里没有 WECHAT_FIELD_LABEL_KEYS");
const WECHAT_FIELD_LABEL_KEYS = Object.fromEntries(
  [...LABELS_M[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])
);

/* 复选框清单从 saveSettings 的真实源码里认（约束②的那份"同源"清单），不另抄一份字面量 */
const SAVE_SRC = sliceFunction(POPUP_SRC, "saveSettings");
const SAVE_IDS = [...new Set([...SAVE_SRC.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
const CHECK_IDS = SAVE_IDS.filter((id) => !TEXT_IDS.includes(id));

const SYNC_SRC = sliceFunction(POPUP_SRC, "populateSettingsFields");
const RENDER_WH_SRC = sliceFunction(POPUP_SRC, "renderWebhook");
/* renderWechat 把判据交给 wechatStatus，只切外壳会留一个自由变量 */
const WECHAT_STATUS_SRC = sliceFunction(POPUP_SRC, "wechatStatus");
const RENDER_WX_SRC = sliceFunction(POPUP_SRC, "renderWechat");
const LISTENER_SRC = sliceBlock(
  POPUP_SRC,
  "chrome.storage.onChanged.addListener(async (changes) =>"
);

const msgStub = (key, subs) => key + (subs && subs.length ? ":" + subs.join("|") : "");
const clockStub = (ms) => "⏱" + ms;

/* 初值刻意全部取"与默认相反"的那一侧：全给空/false，"远程把值清空时要抹掉残留"
   这一半就永远测不到（popup-repopulate 处 10 的教训） */
function makeDom() {
  const dom = {};
  for (const id of CHECK_IDS) dom[id] = { checked: true };
  for (const id of TEXT_IDS) dom[id] = { value: "正在打的字" };
  dom.webhookRow = { hidden: false };
  dom.webhookTestBtn = { hidden: false };
  dom.webhookState = { textContent: "webhookErrAuth", className: "wx-state error" };
  dom.wechatRow = { hidden: false };
  dom.wechatState = { textContent: "wechatErrOther", className: "wx-state error" };
  dom.wechatViewState = { textContent: "wechatErrAuth", className: "hint error", hidden: false };
  return dom;
}

const checkedOf = (dom) =>
  Object.fromEntries(CHECK_IDS.map((id) => [id, dom[id].checked]));
const valueOf = (dom) => Object.fromEntries(TEXT_IDS.map((id) => [id, dom[id].value]));

/* 真跑一次同步：settings / saveTimer / 焦点 / 两份推送留痕全部按例喂 */
function runSync({ settings, saveTimer = null, focus = null, mode = false, wh = null, wx = null, texts = {} }) {
  const dom = makeDom();
  for (const [id, v] of Object.entries(texts)) dom[id].value = v;
  const classes = new Set(mode ? ["wx-mode"] : []);
  const document = {
    activeElement: focus ? dom[focus] : null,
    body: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      }
    }
  };
  const api = new Function(
    "$", "settings", "saveTimer", "document", "TEXT_SETTING_INPUT_IDS",
    "notifyEventsOf", "msg", "fmtClock", "normalizeWebhookUrl", "wechatConfigState",
    "WECHAT_FIELD_LABEL_KEYS", "webhookLast", "wechatLast",
    `${WECHAT_STATUS_SRC}
     ${RENDER_WH_SRC}
     ${RENDER_WX_SRC}
     ${SYNC_SRC}
     return populateSettingsFields;`
  )(
    (id) => dom[id], settings, saveTimer, document, TEXT_IDS,
    notifyEventsOf, msgStub, clockStub, normalizeWebhookUrl, wechatConfigState,
    WECHAT_FIELD_LABEL_KEYS, wh, wx
  );
  api();
  return { dom, classes: [...classes] };
}

const ALL = {
  bypassCache: true, skipDiscarded: true, cookieBackup: true, keepAlive: true,
  httpHeartbeat: true, skipOnActivity: true, keepAwake: true, captchaGuard: true,
  notifyEvents: ["session-lost", "keyword", "task-stopped", "task-paused"],
  wechatEnabled: true,
  webhookUrl: "https://ntfy.sh/topic",
  wechatAppId: "appid", wechatAppSecret: "secret", wechatOpenId: "openid",
  wechatTemplateId: "tpl"
};
/* 与 ALL 逐项相反：修前的形状下这 15 个控件会一直停在 ALL 那一侧 */
const NONE = {
  bypassCache: false, skipDiscarded: false, cookieBackup: false, keepAlive: false,
  httpHeartbeat: false, skipOnActivity: false, keepAwake: false, captchaGuard: false,
  notifyEvents: [], wechatEnabled: false,
  webhookUrl: "", wechatAppId: "", wechatAppSecret: "", wechatOpenId: "",
  wechatTemplateId: ""
};

test("空跑守卫：同步函数、判据与渲染、监听器各切到一段真源码", () => {
  assert.match(SYNC_SRC, /^function populateSettingsFields\(\)/);
  assert.ok(SYNC_SRC.length > 700, "同步函数切得太短，等于什么都没测");
  assert.ok(RENDER_WH_SRC.length > 200 && RENDER_WX_SRC.length > 150 && WECHAT_STATUS_SRC.length > 200);
  assert.ok(LISTENER_SRC.length > 300, "监听器切得太短，回流那条链没进视野");
  assert.match(LISTENER_SRC, /changes\.settings/);
  assert.ok(CHECK_IDS.length >= 13, `从 saveSettings 只认出 ${CHECK_IDS.length} 个复选框，正则失效了`);
  assert.equal(TEXT_IDS.length, 5);
});

test("定义之外恰好两处调用：init 初铺一次，settings 回流一次，且排在 refreshState 之后", () => {
  /* 一个没人调的函数等于改动没发生（A6 记的"写下即死入口"） */
  const calls = [...POPUP_SRC.matchAll(/populateSettingsFields\(\);/g)];
  assert.equal(calls.length, 2, `调用点该是 2 处（init + 回流），实到 ${calls.length} 处`);
  const initAt = POPUP_SRC.indexOf("populateSettingsFields();");
  const listenerAt = POPUP_SRC.indexOf("populateSettingsFields();", initAt + 1);
  const refresh = POPUP_SRC.lastIndexOf("await refreshState();", listenerAt);
  assert.ok(refresh > 0 && refresh < listenerAt, "回流那一次排在 refreshState 之前会读到旧 settings");
  assert.ok(
    LISTENER_SRC.includes("if (changes.settings) populateSettingsFields();"),
    "回流没挂在 settings 分支上，等于每次任务变化都重铺控件"
  );
});

test("十三个复选框按新值走：远程关掉的这里就显示关，远程打开的就显示开", () => {
  assert.ok(Object.keys(checkedOf(makeDom())).length >= 13, "复选框清单空了，下面的比较是空对空");
  const off = runSync({ settings: NONE });
  assert.deepEqual(
    checkedOf(off.dom),
    Object.fromEntries(CHECK_IDS.map((id) => [id, false])),
    "远程关掉后仍有复选框留着上一次的勾选"
  );
  const on = runSync({ settings: ALL });
  assert.deepEqual(
    checkedOf(on.dom),
    Object.fromEntries(CHECK_IDS.map((id) => [id, true])),
    "远程打开后仍有复选框没跟着勾上"
  );
});

test("只改事件的勾选也一样跟着变：notifyEvents 是共用清单，不是 webhook 专属字段", () => {
  const part = { ...ALL, notifyEvents: ["keyword", "task-paused"] };
  const { dom } = runSync({ settings: part });
  assert.equal(dom.webhookEvSession.checked, false);
  assert.equal(dom.webhookEvKeyword.checked, true);
  assert.equal(dom.webhookEvStopped.checked, false);
  assert.equal(dom.webhookEvPaused.checked, true);
});

test("缺字段的旧存盘值按默认判据走，不是留着上一次勾选", () => {
  /* bypassCache / captchaGuard 默认开，判据是 !== false；其余是 !!值。
     老用户的存盘里未必有这些键，所以 undefined 是这条函数天天遇到的输入 */
  const { dom } = runSync({ settings: { webhookUrl: "" } });
  assert.equal(dom.bypassCheck.checked, true, "默认开的开关被 undefined 抹成未勾选");
  assert.equal(dom.captchaGuardCheck.checked, true);
  assert.equal(dom.keepAliveCheck.checked, false, "默认关的开关留着上一次的勾选");
  assert.equal(dom.webhookEvSession.checked, true, "notifyEvents 缺失时应回落到默认全事件");
});

test("五个文本框按新值走（含把远程清空当成清空，而不是留着本地残留）", () => {
  const on = runSync({ settings: ALL });
  assert.deepEqual(valueOf(on.dom), {
    webhookUrlInput: "https://ntfy.sh/topic",
    wechatAppIdInput: "appid",
    wechatSecretInput: "secret",
    wechatOpenIdInput: "openid",
    wechatTplInput: "tpl"
  });
  const off = runSync({ settings: NONE });
  assert.deepEqual(
    valueOf(off.dom),
    Object.fromEntries(TEXT_IDS.map((id) => [id, ""])),
    "远程清空的框在本机留着残留文字"
  );
});

test("正在输入时一个文本框都不动：逐框聚焦都要挡住整组，复选框照同步", () => {
  /* 整组一起跳，不是逐框：凭据四项是一把钥匙的四段，填三段留一段会拼出
     一个两边都不认识的组合，而它马上被去抖那一笔写进存储。
     喂 NONE 而不是 ALL：假 DOM 的复选框初值全勾着，喂 ALL 时"复选框照同步"是 true 比 true，
     整组一起跳过的实现也能过关（对照 S9 第一次跑就只红一条，原因在此） */
  for (const focus of TEXT_IDS) {
    const { dom } = runSync({ settings: NONE, focus });
    assert.deepEqual(
      valueOf(dom),
      Object.fromEntries(TEXT_IDS.map((id) => [id, "正在打的字"])),
      `#${focus} 获得焦点时文本框被远程值盖掉`
    );
    assert.equal(dom.keepAliveCheck.checked, false, "复选框没有输入中间态，不该被一起跳过");
    assert.equal(dom.webhookEvKeyword.checked, false, "事件勾选跟着一起跳过了");
  }
});

test("去抖写盘挂在路上时同样跳过整组文本框", () => {
  /* 挂着的那一笔读的就是这五个框：先铺远程值再落盘，等于把用户的输入按别人的值提交。
     与"获得焦点"是两条独立判据，各挡一种正在输入：一条看 DOM 焦点，一条看待写计时器 */
  const { dom } = runSync({ settings: NONE, saveTimer: 42 });
  assert.deepEqual(
    valueOf(dom),
    Object.fromEntries(TEXT_IDS.map((id) => [id, "正在打的字"])),
    "待写的去抖落盘会读到刚铺上的远程值"
  );
  assert.equal(dom.skipDiscardedCheck.checked, false, "复选框被一起去掉了同步");
});

test("微信被远程关掉时退出配置视图；被远程打开时不许把用户拽进配置视图", () => {
  const off = runSync({ settings: { ...ALL, wechatEnabled: false }, mode: true });
  assert.deepEqual(off.classes, [], "功能已经关了还留在只为配置它而存在的那一页");
  const on = runSync({ settings: ALL, mode: false });
  assert.deepEqual(on.classes, [], "远程打开不该把用户从当前页面上拽走");
  const stay = runSync({ settings: ALL, mode: true });
  assert.deepEqual(stay.classes, ["wx-mode"], "功能还开着就不该动用户正待着的视图");
});

test("两行状态跟着新值重算：跑的是真实 renderWebhook / renderWechat", () => {
  /* 合法地址 + 一次成功留痕 → ok 行；远程清空地址 → 整行藏起来、文字清空。
     这两条都依赖文本框先铺好，所以顺序错了也会红 */
  const ok = runSync({
    settings: ALL,
    wh: { ok: true, status: 200, at: 123 },
    wx: { ok: true, status: 200, at: 456 }
  });
  assert.equal(ok.dom.webhookState.textContent, "webhookStateOk:⏱123");
  assert.doesNotMatch(ok.dom.webhookState.className, /error/);
  assert.equal(ok.dom.wechatState.textContent, "wechatStateOk:⏱456");
  assert.equal(ok.dom.wechatViewState.textContent, "wechatStateOk:⏱456");

  const cleared = runSync({ settings: NONE, wh: { ok: true, status: 200, at: 1 } });
  assert.equal(cleared.dom.webhookRow.hidden, true, "地址被远程清空后状态行还占着");
  assert.equal(cleared.dom.webhookState.textContent, "", "残留的错误文字没抹掉");
  assert.equal(cleared.dom.wechatViewState.hidden, true);
});

test("正在输入时状态行仍按本地框里的字算：跳过文本框不能把两行留在远程值上", () => {
  /* 跳过之后如果渲染读的是刚铺上的远程地址，红字与"最近一次投递"就跟框里显示的字对不上。
     两个方向各钉一半：本地半个坏地址、远程那个是好的；反过来也一样 */
  const local = runSync({
    settings: { ...ALL, webhookUrl: "https://ntfy.sh/other" },
    focus: "webhookUrlInput",
    wh: { ok: false, status: 500, errorKey: "webhookErrTimeout", at: 9 }
  });
  assert.equal(local.dom.webhookUrlInput.value, "正在打的字", "文本框被远程值盖掉了");
  assert.equal(local.dom.webhookState.textContent, "webhookInvalid", "红字跟的是远程那个合法地址");
  assert.equal(local.dom.webhookTestBtn.hidden, true, "非法地址上还摆着测试按钮");

  const remote = runSync({
    settings: { ...ALL, webhookUrl: "not-a-url" },
    focus: "webhookUrlInput",
    texts: { webhookUrlInput: "https://ntfy.sh/mine" },
    wh: { ok: false, status: 500, errorKey: "webhookErrTimeout", at: 9 }
  });
  assert.equal(remote.dom.webhookUrlInput.value, "https://ntfy.sh/mine");
  assert.equal(remote.dom.webhookState.textContent, "webhookErrTimeout", "红字跟的是远程那个坏地址");
});

test("监听器：只有 settings 回流才重铺控件，tasks 与推送留痕回流都不重铺", async () => {
  const log = [];
  const run = new Function(
    "refreshState", "renderAll", "populateSettingsFields", "renderWebhook", "renderWechat",
    `let wechatLast = null; let webhookLast = null;
     return async (changes) => ${LISTENER_SRC};`
  )(
    async () => { log.push("refreshState"); },
    async () => { log.push("renderAll"); },
    () => { log.push("populateSettingsFields"); },
    () => { log.push("renderWebhook"); },
    () => { log.push("renderWechat"); }
  );
  await run({ settings: { newValue: {} } });
  assert.deepEqual(log, ["refreshState", "populateSettingsFields", "renderAll"]);

  log.length = 0;
  await run({ tasks: { newValue: {} } });
  assert.deepEqual(log, ["refreshState", "renderAll"], "任务回流也重铺控件 = 随时可能抹掉输入");

  log.length = 0;
  await run({ webhookLastResult: { newValue: { ok: true, at: 1 } } });
  assert.deepEqual(log, ["renderWebhook"], "推送留痕回流不该触发全量重绘");

  log.length = 0;
  await run({});
  assert.deepEqual(log, [], "无关键（cookie 备份）写入也必须直接返回");
});

test("控件清单同源：saveSettings 读到的控件，同步函数一个都不能漏", () => {
  /* 约束②：saveSettings 仍发整份快照。这条守卫防的是"以后加一个设置项只写进一头"——
     漏在同步那一头，A18 的 bug 就对那一个控件原样复活；漏在保存那一头，它就是死同步 */
  const synced = new Set([...SYNC_SRC.matchAll(/\$\("([^"]+)"\)\.(?:checked|value)\s*=/g)].map((m) => m[1]));
  assert.ok(synced.size >= 18, `同步函数只写了 ${synced.size} 个控件，正则失效了（这条在空跑）`);
  for (const id of SAVE_IDS) {
    assert.ok(synced.has(id), `#${id} 被 saveSettings 写进 settings，却从不被回流同步`);
  }
  for (const id of synced) {
    assert.ok(SAVE_IDS.includes(id), `#${id} 被同步，但 saveSettings 根本不读它`);
  }
  /* 整份覆盖这件事本身：15 个键全在字面量里，不是挑差异发 */
  const keys = [...SAVE_SRC.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
  assert.equal(keys.length, 15, `save-settings 的键数从 15 变成 ${keys.length}`);
});

test("同步函数不写存储：只铺控件，落盘仍由 change / 去抖那两条路负责", () => {
  /* 铺控件若顺手 saveSettings()，回流→写盘→回流就成了循环，而且每次任务变化都会白写一次 sync */
  for (const bad of ["saveSettings(", "saveNow(", "scheduleSave(", "send("]) {
    assert.ok(!SYNC_SRC.includes(bad), `同步函数里有 ${bad}，回流链上多了一笔写盘`);
  }
});

/* ------------------------------------------------------------------
   红→绿对照（2026-09-19 实跑，node v24.21.0，脚本与逐条变体在仓库外 D:\Github\_tar_ctl_a18）。
   本轮变异全落在 popup.js 的源码文本里，所以不必整份复制仓库：改坏的 popup.js 写成变体文件，
   TAR_POPUP_SRC 指过去、只跑本文件（跑点名的文件才谈得上归因）。15 条 needle 每条预检
   "恰好命中 1 次"，命中多处或找不到直接抛错。
   pristine 14/14 全绿，**没有零红项**：

   S1  删掉 init 里那一次调用（回流还留着）      → 红 1 条：调用点计数
   S2  删掉回流里那一次（回到修前形状）          → 红 2 条：调用点计数、监听器
   S3  回流那一次挪到 refreshState 之前          → 红 1 条：监听器（日志顺序里它排在前面）
   S4  复选框整块不同步                          → 红 7 条：十三个复选框、事件勾选、缺字段默认、
       两行状态、清单同源、逐框聚焦、去抖（后两条新加的复选框半边也被迫跟着塌）
   S5  文本框整块不同步                          → 红 3 条：五个文本框、两行状态、清单同源
   S6  判据只看待写盘、不认焦点                  → 红 2 条：逐框聚焦、状态行按本地值
   S7  判据只看焦点、不认待写盘                  → 红 1 条：去抖
   S8  逐框判断（只有 webhook 框的焦点算数）     → 红 1 条：逐框聚焦（凭据四个框那四轮红）
   S9  正在输入时整组 return（连复选框也不动）   → 红 3 条：逐框聚焦、去抖、状态行
   S10 不退出配置视图                            → 红 1 条：wx-mode
   S11 无条件退出配置视图                        → 红 1 条：wx-mode（"用户正待着的那页不该动"）
   S12 远程打开就自动跳进配置视图                → 红 1 条：wx-mode（反向那一半）
   S13 两个渲染挪到回填之前                      → 红 1 条：两行状态
   S14 回流不分键（任务变化也重铺）              → 红 2 条：调用点计数、监听器
   S15 同步函数末尾补一句 saveSettings()         → 红 10 条：绿的那 4 条是不执行同步函数本体的
       那几条（三条源码扫描 + 监听器用例里的桩件同步）。saveSettings 没注入进切片作用域，
       调用即抛，所以红得宽是预期的：这条钉的是"回流链上不许有写盘"，
       与"不许形成写盘→回流→写盘的循环"是同一件事

   两处实跑出来的教训：
   1) S9 第一次只红 1 条。原因在桩件：假 DOM 的复选框初值全勾着，而那条用例喂的是 ALL，
      "复选框照同步"就成了 true 比 true——整组一起跳过的实现照样过关。改成喂 NONE 之后
      S9 红 3 条。与 popup-repopulate 处 10、处 11 记的是同一类：桩件比真实输入更干净，
      判据退化就看不出来
   2) 重定向入口本身跑过一遍：整套 364 条在 TAR_POPUP_SRC 指向一份未改动的 popup.js 副本时
      全绿，说明门禁读的是那份文件而不是仓库里那一份
------------------------------------------------------------------ */
