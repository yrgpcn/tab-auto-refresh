/* 2026-09-19 审计 A11 的门禁：弹窗文本框的保存时机。

   修前的形状：五个走 settings 的文本框只绑 change。而 Chrome 弹窗一失去焦点就整体销毁，
   "打完字直接点弹窗外"这条最常见的收尾路径上 change 永远不触发，这一笔输入连一次保存
   都没发生过，重开弹窗是空的。反面也不能走：改成逐字符立即写就会撞 chrome.storage.sync
   的每分钟写次数上限，而且弹窗里没人看得见那个报错。
   所以现在是 input 去抖 + change 即时 + 关窗补一次 + 测试按钮先写再测。

   popup.js 整体跑不了（DOM + chrome.* 的混合体，仓库没有 DOM 库），沿用
   populateTaskFields / renderWebhook 那两处的做法：按花括号配对切出真实源码，
   依赖的名字当形参注入，然后真跑。计时器是假时钟，写盘是一笔笔记数，
   所以"打五个字只写一次""saveNow 之后到点不再写第二笔"这类顺序与次数断言是实跑出来的，
   不是读代码读出来的。剩下的（谁绑了什么、按钮里的 await 排在谁前面）没法切片，
   按源码形状钉住。

   红→绿对照实跑见文件末尾。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/* 红→绿对照用：TAR_POPUP_SRC 指到另一份 popup.js（只读文本，不 import）。CI 上不设 */
const POPUP_PATH = process.env.TAR_POPUP_SRC
  ? process.env.TAR_POPUP_SRC
  : new URL("../../tab-auto-refresh/popup.js", import.meta.url);
const POPUP_SRC = readFileSync(POPUP_PATH, "utf8").replace(/\r\n/g, "\n");

const HTML_SRC = readFileSync(
  new URL("../../tab-auto-refresh/popup.html", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

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

/* sliceFunction 从 "function 名字(" 起切，会把 async 关键字落在身后，
   于是函数体里的 await 变成语法错误。这里按真身把 async 补回来 */
function slice(src, name) {
  const body = sliceFunction(src, name);
  const isAsync = new RegExp(`^async function ${name}\\(`, "m").test(src);
  return (isAsync ? "async " : "") + body;
}

/* 从 marker 之后第一个 "{" 起做花括号配对，切出一整块（含首尾花括号）。
   用于 init 里的箭头函数监听器——它们不是 function 声明，sliceFunction 认不到 */
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

/* 去抖时长按真身取，不抄字面量：改成 0 就等于退回"逐字符写盘"，
   那正是本条刻意不要的那一侧，必须由门禁变红 */
const DEBOUNCE_M = POPUP_SRC.match(/^const SAVE_DEBOUNCE_MS = (\d+);$/m);
assert.ok(DEBOUNCE_M, "popup.js 里没有 SAVE_DEBOUNCE_MS 常量，切片前提已经不成立");
const DEBOUNCE_MS = Number(DEBOUNCE_M[1]);

const IDS_M = POPUP_SRC.match(/const TEXT_SETTING_INPUT_IDS = \[([\s\S]*?)\];/);
assert.ok(IDS_M, "popup.js 里没有 TEXT_SETTING_INPUT_IDS，切片前提已经不成立");
const TEXT_IDS = [...IDS_M[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const SRCS = {
  cancelScheduledSave: slice(POPUP_SRC, "cancelScheduledSave"),
  scheduleSave: slice(POPUP_SRC, "scheduleSave"),
  saveNow: slice(POPUP_SRC, "saveNow"),
  flushPendingSave: slice(POPUP_SRC, "flushPendingSave")
};

/* 假时钟 + 写盘计数。saveSettings 返回一笔真 promise，
   所以 scheduleSave 那个"裸甩异步"的计时器回调也能被 drain() 追到 */
function build() {
  const clock = { now: 0 };
  const timers = new Map();
  const pending = [];
  const writes = [];
  let seq = 0;

  function setTimeoutFake(fn, ms) {
    const id = ++seq;
    timers.set(id, { at: clock.now + ms, fn });
    return id;
  }
  function clearTimeoutFake(id) {
    timers.delete(id);
  }
  function saveSettingsFake() {
    const p = Promise.resolve().then(() => {
      writes.push(clock.now);
    });
    pending.push(p);
    return p;
  }

  const api = new Function(
    "setTimeout", "clearTimeout", "saveSettings", "SAVE_DEBOUNCE_MS",
    `let saveTimer = null;
     ${SRCS.cancelScheduledSave}
     ${SRCS.scheduleSave}
     ${SRCS.saveNow}
     ${SRCS.flushPendingSave}
     return {
       scheduleSave, saveNow, flushPendingSave, cancelScheduledSave,
       timer: () => saveTimer
     };`
  )(setTimeoutFake, clearTimeoutFake, saveSettingsFake, DEBOUNCE_MS);

  async function drain() {
    while (pending.length) await pending.shift();
  }

  /* 时间往前走 ms，到点的计时器按先后全部跑完（含它们甩出去的写盘） */
  async function advance(ms) {
    clock.now += ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= clock.now)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      const [id, t] = due[0];
      timers.delete(id);
      t.fn();
      await drain();
    }
  }

  return {
    api,
    clock,
    writes,
    advance,
    armed: () => timers.size,
    timer: () => api.timer()
  };
}

test("空跑守卫：四个函数确实各切到一段真源码，去抖时长非零", () => {
  for (const [name, src] of Object.entries(SRCS)) {
    assert.ok(src.length > 40, `${name} 切出来的源码过短，等于什么都没测`);
    assert.match(src, new RegExp(`^(?:async )?function ${name}\\(`), `${name} 的切法不对`);
  }
  assert.ok(DEBOUNCE_MS > 0, "去抖时长为 0 等于退回逐字符写盘（sync 配额那一侧）");
  assert.ok(DEBOUNCE_MS <= 2000, "去抖超过 2 秒会让「打完字马上关窗」变成常态丢数据");
  assert.ok(TEXT_IDS.length >= 5, "走 settings 的文本框应不少于 5 个，少了说明常量被改坏");
});

test("input 那一拍：只挂计时器，一个字节都不写", () => {
  const c = build();
  c.api.scheduleSave();
  assert.deepEqual(c.writes, [], "scheduleSave 当场写盘 = 逐字符写盘，正是要避开的那一侧");
  assert.equal(c.armed(), 1);
  assert.notEqual(c.timer(), null, "计时器句柄没存下来，cancelScheduledSave 就无从取消");
});

test("到点恰好写一次，并且把句柄清空", async () => {
  const c = build();
  c.api.scheduleSave();
  await c.advance(DEBOUNCE_MS - 1);
  assert.deepEqual(c.writes, [], "没到点就写了，去抖是假的");
  assert.equal(c.armed(), 1);
  await c.advance(1);
  assert.deepEqual(c.writes, [DEBOUNCE_MS]);
  assert.equal(c.timer(), null, "写完之后句柄必须清掉，否则 flushPendingSave 会再白写一笔");
});

test("连打五个字只写一次，且计时器跟着最后一次敲", async () => {
  const c = build();
  for (let i = 0; i < 5; i++) {
    c.api.scheduleSave();
    await c.advance(DEBOUNCE_MS - 1); /* 每次都在到点前又敲一下 */
  }
  assert.deepEqual(c.writes, [], "每敲一下都到点了，等于没有合并");
  assert.equal(c.armed(), 1, "旧计时器没被取消，会攒出多笔重复写");
  await c.advance(1); /* 正好走到"最后一次敲 + 去抖"那一刻 */
  const lastKey = 4 * (DEBOUNCE_MS - 1);
  assert.deepEqual(c.writes, [lastKey + DEBOUNCE_MS], "落盘时刻对应的是第一次敲，说明没重新计时");
  await c.advance(DEBOUNCE_MS);
  assert.deepEqual(c.writes, [lastKey + DEBOUNCE_MS], "五笔敲攒出两笔写");
});

test("saveNow：没有待写也必写这一笔（测试按钮靠它）", async () => {
  const c = build();
  await c.api.saveNow();
  assert.deepEqual(c.writes, [0]);
});

test("saveNow：有待写时立刻写，并且摘掉计时器——到点不再写第二笔", async () => {
  const c = build();
  c.api.scheduleSave();
  await c.advance(100);
  await c.api.saveNow();
  assert.deepEqual(c.writes, [100]);
  assert.equal(c.armed(), 0, "计时器还挂着，稍后会再写一笔一样的");
  await c.advance(DEBOUNCE_MS * 2);
  assert.deepEqual(c.writes, [100], "同一笔输入落盘两次");
});

test("flushPendingSave：有待写补一次，没有就一笔都不写", async () => {
  const c = build();
  await c.api.flushPendingSave();
  assert.deepEqual(c.writes, [], "没有待写也写 = 每次点开点外都白刷一次 sync 配额");
  c.api.scheduleSave();
  await c.api.flushPendingSave();
  assert.deepEqual(c.writes, [0]);
  assert.equal(c.armed(), 0);
  await c.advance(DEBOUNCE_MS * 2);
  assert.deepEqual(c.writes, [0], "补写之后计时器还在，等于写了两次");
});

test("cancelScheduledSave：待写作废，空着调用也不炸", async () => {
  const c = build();
  c.api.cancelScheduledSave();
  assert.deepEqual(c.writes, []);
  c.api.scheduleSave();
  c.api.cancelScheduledSave();
  c.api.cancelScheduledSave();
  assert.equal(c.armed(), 0);
  assert.equal(c.timer(), null);
  await c.advance(DEBOUNCE_MS * 2);
  assert.deepEqual(c.writes, []);
});

test("清单里的 id 在 popup.html 里都真实存在", () => {
  /* 表里有、页里没有的话 init 里 $(id) 拿到 null，addEventListener 直接抛错，
     整个弹窗白屏——比"少绑一个事件"严重得多，先单独钉住 */
  for (const id of TEXT_IDS) {
    assert.match(HTML_SRC, new RegExp(`id="${id}"`), `popup.html 里没有 #${id}`);
  }
});

test("清单里的 id 都是文本框，不是复选框", () => {
  for (const id of TEXT_IDS) {
    const tag = HTML_SRC.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `popup.html 里 #${id} 不是 <input>`);
    assert.doesNotMatch(tag[0], /type="checkbox"/, `#${id} 是复选框，它本就该即时保存`);
  }
});

test("saveSettings 读到的每个文本框都在绑定清单里", () => {
  /* 反-drift：以后新增一个走 settings 的文本框，只写进 saveSettings 不写进清单，
     它就退回"只有失焦才保存"的老毛病，而没人会想起来。这里让它变红 */
  const src = sliceFunction(POPUP_SRC, "saveSettings");
  const used = [...src.matchAll(/\$\("([^"]+)"\)\.value/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, "没从源码里认出文本框取值，正则已经失效");
  for (const id of used) {
    assert.ok(TEXT_IDS.includes(id), `#${id} 被 saveSettings 写进 settings，却不在绑定清单里`);
  }
});

test("绑定循环：input 走去抖、change 即时写，两条各一次", () => {
  /* 先切出整个循环体再在里面找两个监听器：marker 直接写 el.addEventListener 会被
     bindIntervalInputs 里的 sel.addEventListener 撞中——"sel." 的尾巴就是 "el." */
  assert.equal([...POPUP_SRC.matchAll(/for \(const id of TEXT_SETTING_INPUT_IDS\)/g)].length, 1);
  const loop = sliceBlock(POPUP_SRC, "for (const id of TEXT_SETTING_INPUT_IDS)");
  const inputBlk = sliceBlock(loop, 'el.addEventListener("input"');
  const changeBlk = sliceBlock(loop, 'el.addEventListener("change"');
  assert.equal([...loop.matchAll(/el\.addEventListener\("input"/g)].length, 1);
  assert.equal([...loop.matchAll(/el\.addEventListener\("change"/g)].length, 1);
  assert.match(inputBlk, /scheduleSave\(\);/);
  assert.doesNotMatch(inputBlk, /saveNow\(\)|saveSettings\(\)/, "input 里直接写盘就是逐字符写盘");
  assert.match(changeBlk, /saveNow\(\);/);
  assert.doesNotMatch(changeBlk, /scheduleSave\(\)/);
  /* A11 的后半段：非法地址的红字要一边打一边出现，原先挂在 change 上所以从没出现过 */
  assert.match(inputBlk, /renderWebhook\(\);/, "input 不重算状态行，红字仍然要等失焦");
  assert.match(inputBlk, /renderWechat\(\);/);
  assert.equal([...POPUP_SRC.matchAll(/\bel\.addEventListener\(/g)].length, 2,
    "循环之外还有零散的 el 绑定，等于又各自为政");
  assert.ok(
    POPUP_SRC.indexOf("const TEXT_SETTING_INPUT_IDS") <
      POPUP_SRC.indexOf("for (const id of TEXT_SETTING_INPUT_IDS)"),
    "清单必须声明在循环之前"
  );
});

test("关窗两个钩子都在，且都指向补写", () => {
  const vis = sliceBlock(POPUP_SRC, 'document.addEventListener("visibilitychange"');
  assert.match(vis, /document\.visibilityState === "hidden"/);
  assert.match(vis, /flushPendingSave\(\)/);
  const hide = sliceBlock(POPUP_SRC, 'window.addEventListener("pagehide"');
  assert.match(hide, /flushPendingSave\(\)/);
});

test("webhook 的「发送测试」：先落盘再测，且有 finally", () => {
  const blk = sliceBlock(POPUP_SRC, '$("webhookTestBtn").addEventListener("click"');
  const save = blk.indexOf("await saveNow()");
  assert.ok(save >= 0, "没有先落盘：刚打进去的地址测试读不到");
  assert.ok(save < blk.indexOf('"webhook-test"'), "不先写一次，测试读到的还是上一个地址");
  assert.match(blk, /try \{/);
  assert.match(blk, /\} finally \{/);
});

test("微信的「发送测试」：先落盘再测，且有 finally（原先没有，抛错就永远停在「发送中」）", () => {
  const blk = sliceBlock(POPUP_SRC, '$("wechatTestBtn").addEventListener("click"');
  const save = blk.indexOf("await saveNow()");
  assert.ok(save >= 0, "没有先落盘：刚填的凭据测试读不到");
  assert.ok(save < blk.indexOf('"wechat-test"'), "不先写一次，后台读到的是上一个值");
  assert.match(blk, /try \{/);
  assert.match(blk, /\} finally \{/);
  assert.match(blk, /btn\.disabled = false;/);
});

test("旧的单字段绑定没有残留", () => {
  /* 修前是 webhookUrlInput 单独一条 change、凭据四项各自一条 change。
     留着任何一条，那个框就又回到"只有失焦才保存" */
  for (const id of TEXT_IDS) {
    assert.doesNotMatch(
      POPUP_SRC,
      new RegExp(`\\$\\("${id}"\\)\\.addEventListener`),
      `#${id} 上还有清单之外的单独绑定`
    );
  }
});

/* ------------------------------------------------------------------
   红→绿对照（2026-09-19 实跑，node v24.21.0，脚本在仓库外 ctl-a11/）。
   做法与 A10 那批同：整仓复制到 pristine/，每条变异拷一份、只改 popup.js 一处，
   在副本里只跑本文件（跑点名的文件才谈得上归因）。19 条 needle 全部预检过"恰好命中 1 次"。
   下面记的是实际红名单（17 红 + 2 反向绿，无一条例外），不是预测。

   B1  去抖整个消失（setTimeout 换成直接 saveSettings()）
       → 红 5 条：input 那一拍、到点恰好写一次、连打五个字、saveNow 有待写时、cancelScheduledSave
         比预期宽：没有计时器之后"取消/待写作废"三条一起塌，这是同一处改动的连锁，不是断言过松
   B2  SAVE_DEBOUNCE_MS 改成 0
       → 红 2 条：空跑守卫（DEBOUNCE_MS > 0 那一断，正主）、saveNow 有待写时（连带：
         0 毫秒的计时器在 advance(100) 里就先落了一笔，之后 saveNow 又写一笔）
       ※ "input 那一拍"是绿的：setTimeout(fn, 0) 仍然推迟一拍，假时钟看不出区别。
         也就是说"时长是不是 0"这一侧只有常量守卫抓得到，行为用例抓不到——
         别把 5 条行为用例当成去抖的全部保障
   B3  scheduleSave 去掉开头的 cancelScheduledSave()
       → 红 1 条：连打五个字（armed() === 1 先炸）
   B4  saveNow 去掉 cancelScheduledSave()
       → 红 2 条：saveNow 有待写时、flushPendingSave（补写后计时器还挂着，随后又写一笔）
   B5  flushPendingSave 去掉 saveTimer === null 的早退
       → 红 1 条：flushPendingSave
   B6  计时器回调里漏掉 saveTimer = null
       → 红 1 条：到点恰好写一次
   B7  input 分支去掉 renderWebhook()
       → 红 1 条：绑定循环（红字那半）
   B8  input 分支把 scheduleSave() 换成 saveNow()
       → 红 1 条：绑定循环（"input 里直接写盘就是逐字符写盘"）
   B9  删掉 window.addEventListener("pagehide" ...) 整块
       → 红 1 条：关窗两个钩子
   B10 微信测试按钮的 } finally { 换成 } catch (e) {
       → 红 1 条：微信的「发送测试」（finally 那条；try 与 disabled 复位两条仍绿，
         因为变异没动它们——三条各钉一件事，这里要的正是只塌一条）
   B11 微信测试按钮的 await saveNow() 挪到 send 之后
       → 红 1 条：微信的「发送测试」
   B12 TEXT_SETTING_INPUT_IDS 删掉 "wechatTplInput"
       → 红 2 条：空跑守卫（length >= 5）、saveSettings 读到的每个文本框都在清单里
   B13 清单里换成一个页面上不存在的 "ghostInput"
       → 红 3 条：id 真实存在、都是文本框、saveSettings 那条（webhookUrlInput 反过来落在清单外）
   B14 给 webhookUrlInput 补一条修前那种单独 addEventListener("change", saveSettings)
       → 红 1 条：旧的单字段绑定没有残留
   B15（反向）SAVE_DEBOUNCE_MS 500 → 800   → 16/16 全绿，如预期：钉的是 0 与 2000 两个界，不是字面量
   B16 saveSettings 里多读一个清单外的文本框（$("wechatNickInput").value）
       → 红 1 条：saveSettings 读到的每个文本框都在清单里
   B17 visibilitychange 的判据从 hidden 写成 visible
       → 红 1 条：关窗两个钩子
   B18 webhook 测试按钮删掉 await saveNow()
       → 红 1 条：webhook 的「发送测试」
   B19（反向）cancelScheduledSave 里加一行注释   → 16/16 全绿，形状守卫没有被注释文字带偏

   两处开发期实跑出来的教训（不是对照，但同源于 A6 记的"死入口/假绿"那一类）：
   1) marker 写 el.addEventListener("change") 会被 bindIntervalInputs 里的
      sel.addEventListener("change") 撞中——"sel." 的尾巴就是 "el."，第一次跑就红了。
      改成先切出整个循环体、再在块内找两个监听器，并把 \bel\.addEventListener\( 的总数钉成 2。
   2) 本条把 renderWebhook() 的调用点从 4 处变成 5 处，popup-repopulate.test.mjs 那条计数守卫
      随之变红。跨文件的连锁必须在同一批里改掉，不能留着红当"已知失败"。
------------------------------------------------------------------ */
