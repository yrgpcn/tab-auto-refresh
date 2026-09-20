/* 2026-09-19 审计 A32 的门禁：一条消息两头三本账，此前一条也没对过。

   消息这本账分三段，每段都是"同一个名字在两个文件里各写一遍字面量"：
   ① 类型名 —— 弹窗 send({type:"start"}) ↔ 背景 msg.type === "start"；
   ② 请求载荷键 —— 发出的 { tabId, seconds, keyword, keepWatching } ↔ 分支里读的 msg.X；
   ③ 应答字段 —— 分支 sendResponse({ ok, intervalSec }) ↔ 弹窗读的 res.X。
   三段全跨文件、全没有 import，改一边另一边一个字都不会报错。

   为什么这类漂移值钱：它的表现永远是"点了没反应"，不是"报错了"。类型名打错就落到
   分发链末尾那条 else，回一个 {ok:false}，而弹窗有两个调用点（prune-now、resume-task）
   把返回值甩掉不看——它连失败都不知道。载荷键打错，那边读到 undefined，而 undefined
   在这几个参数上全是合法输入："继续盯守"当成没勾、关键词当成没填。没有一条路径抛错，
   也没有一行日志会说这里少了一个字段。

   实测这套机器是瞎的（对照 V1 到 V6 见文件末尾）：从弹窗那一头删掉 keepWatching、
   把 resume-task 打成 resume、把整条 prune-now 删掉、把 res.intervalSec 改成一个不存在
   的字段、把 tabId 打成 tab —— 五样叠起来 510 条一条不红。第六个更难看：从背景那一头
   把 msg.keepWatching 改名，全套照样全绿。原因是测试侧那一份是第三份抄本：
   唯一发过 keepWatching: true 的那条用例（detect-chain）发完从没回头看 tasks[7].onHit，
   所以它既没钉住发送侧也没钉住接收侧。"start 这条消息有测试覆盖"是错觉。

   与相邻门禁的分工（四份都在消息入口这一带，各管一段，别混）：
     message-gate 守"谁能发"：带 sender.tab 的来源必须登记进 FROM_PAGE_TYPES，
       弹窗专用分支必须登记进 POPUP_ONLY。它钉了"页面会发的类型都在表里"这一向，
       这里补另一向"表里的每一条真有人发"（T8）。
     keepalive-channel 守页面侧消费：把真载荷喂给从 keepalive.js 切出来的真监听器，
       看心跳起没起（V10/V11/V12 实测它就是红的）。所以页面那半已经有行为账，
       这里的 T7 只是把名字账也钉上——它管的是"推送、应答、消费三方字段名齐平"，
       那半边的改动只要少一个字段，行为账要红得先看它喂的是哪一个。
     popup-settings-sync / popup-repopulate 管弹窗把值铺进控件、把控件读回载荷，
       两头都在 popup.js 内部；中间那一跳 sendMessage 的报文形状它们一概不管。
     这里管三本名字账，全部只读源码、不执行任何函数体。

   为什么不"跑起来对账"而是扫源码：跑起来要先造一份假载荷，造出来就等于把要核对的字面量
   重写第三遍——那正是本文件要消灭的东西。所以按花括号配对把真实源码里的对象字面量切出来
   求键名（与 popup-settings-sync 切函数同法）。注释行先整行抹成空行、行数不变，
   注释里出现的 type / 键名一律不算证据，报错时给的行号还要能对得上原文。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/* 三份都读真源码。对照跑的是仓库外的整份副本，所以刻意不开 TAR_* 重定向口子：
   这个文件要同时读三个文件，只重定向一个会把两份不配套的源码拼在一起比 */
const read = (rel) =>
  readFileSync(new URL("../../tab-auto-refresh/" + rel, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

const stripComments = (src) =>
  src.split("\n").map((l) => (/^\s*(?:\/\/|\*|\/\*)/.test(l) ? "" : l)).join("\n");

const BG = stripComments(read("background.js"));
const POPUP = stripComments(read("popup.js"));
const KA = stripComments(read("content/keepalive.js"));

const lineAt = (src, idx) => src.slice(0, idx).split("\n").length;
const setOf = (arr) => new Set(arr);
const diff = (a, b) => [...a].filter((x) => !b.has(x));

/* 从 openIdx 的花括号起配对，跳过字符串与模板里的括号。
   切歪了一定抛错：半截的键集合会让下面几条变成空跑，空跑比红更糟 */
function skipString(src, i, quote, what) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === quote) return j;
  }
  throw new Error(`${what} 里的字符串没闭合`);
}

function matchBraces(src, openIdx, what) {
  if (src[openIdx] !== "{") throw new Error(`${what} 的起点不是花括号`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(src, i, c, what);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(openIdx, i + 1);
  }
  throw new Error(`${what} 的花括号没闭合`);
}

/* 对象字面量的根级键：嵌套对象、数组、函数体里的逗号一概不算分句。
   必须真配对——save-settings 那一笔里嵌着 15 个设置键，不配对就是把账本读歪 */
function objKeys(src, openIdx, what) {
  const body = matchBraces(src, openIdx, what);
  const keys = [];
  let depth = 0;
  let start = 1;
  const push = (chunk) => {
    const t = chunk.trim();
    if (!t || t.startsWith("...")) return; /* 展开进来的键认不出来，不猜 */
    const m = t.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_$]+))\s*(?::|$)/);
    if (m) keys.push(m[1] || m[2] || m[3]);
  };
  for (let i = 1; i < body.length - 1; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(body, i, c, what);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      push(body.slice(start, i));
      start = i + 1;
    }
  }
  push(body.slice(start, body.length - 1));
  return keys;
}

/* 包住 idx 的那一块：先往回找最近的未配对 "{"，再往后配对。
   应答字段的读取范围就取这一块：整份文件会把别的调用点混进来，单行会漏掉 if/else */
function enclosingBlock(src, idx, what) {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{" && --depth < 0) {
      const body = matchBraces(src, i, what);
      return [i, i + body.length];
    }
  }
  throw new Error(`${what} 之前找不到块的起点`);
}

const callHead = (text) => {
  const m = text.match(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?[\w$.]*send\w*\(\s*\{$/
  );
  return m ? m[1] : null;
};

/* 载荷对象的第一个根级键必须是 type。锚在开头而不是全文搜：
   嵌套对象里也可能出现 "type"（设置键里就有过），扫全文会把别人的消息算进来 */
const ROOT_TYPE = /^\{\s*"?type"?\s*:\s*"([a-z-]+)"/;

/* ---------- ① 背景分发口：每条分支读 msg 的哪几个键、回哪几个字段 ---------- */

const LISTENER_AT = BG.indexOf("chrome.runtime.onMessage.addListener(");
assert.ok(LISTENER_AT >= 0, "找不到 runtime.onMessage 的分发口");
const DISPATCH_AT = BG.indexOf("{", LISTENER_AT);
const DISPATCH = matchBraces(BG, DISPATCH_AT, "分发口");

const TYPE_HITS = [...DISPATCH.matchAll(/msg\.type === "([a-z-]+)"/g)];
const BRANCHES = new Map();
for (const h of TYPE_HITS) {
  const open = DISPATCH.indexOf("{", h.index + h[0].length - 1);
  const body = matchBraces(DISPATCH, open, `分支 ${h[1]}`);
  const reads = setOf(
    [...body.matchAll(/\bmsg\.([A-Za-z0-9_$]+)/g)].map((m) => m[1]).filter((k) => k !== "type")
  );
  const responses = [];
  for (const s of body.matchAll(/sendResponse\(\s*\{/g)) {
    responses.push(setOf(objKeys(body, body.indexOf("{", s.index), `分支 ${h[1]} 的应答`)));
  }
  const calls = (body.match(/sendResponse\(/g) || []).length;
  assert.equal(
    calls, responses.length,
    `分支 ${h[1]} 有 ${calls} 次 sendResponse，只认出 ${responses.length} 个对象字面量（切片前提变了）`
  );
  BRANCHES.set(h[1], {
    reads,
    responses,
    all: new Set(responses.flatMap((r) => [...r])),
    line: lineAt(BG, DISPATCH_AT + h.index)
  });
}

/* 分支之外的两条应答：来源守卫的拒绝、catch 的兜底。弹窗读 res.error 靠的就是它们 */
const GUARD_AT = DISPATCH.indexOf("page sender not allowed");
assert.ok(GUARD_AT > 0 && GUARD_AT < TYPE_HITS[0].index, "来源守卫那条应答不在所有分支之前");
const GUARD_KEYS = setOf(
  objKeys(DISPATCH, DISPATCH.lastIndexOf("{", GUARD_AT), "来源守卫的应答")
);
const CATCH_AT = DISPATCH.lastIndexOf("sendResponse(");
assert.ok(CATCH_AT > 0 && CATCH_AT > TYPE_HITS[TYPE_HITS.length - 1].index, "catch 的应答不在所有分支之后");
const CATCH_KEYS = setOf(objKeys(DISPATCH, DISPATCH.indexOf("{", CATCH_AT), "catch 的应答"));
/* 弹窗那层 send() 的兜底：拿不到应答时 resolve({ ok: false })，所以 ok 永远读得到 */
const ALWAYS = new Set(["ok", ...GUARD_KEYS, ...CATCH_KEYS]);

/* ---------- ②③ 发送侧：类型、载荷键、以及之后读了应答的哪几个字段 ---------- */

function sendSites(src, re, label) {
  const sites = [];
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("{", m.index);
    const bodyText = matchBraces(src, open, `${label} 的一处发送`);
    const typeM = bodyText.match(ROOT_TYPE);
    assert.ok(typeM, `${label} 有一处 send 的第一个根级键不是 type，切片前提变了`);
    const resVar = callHead(
      src.slice(src.lastIndexOf("\n", m.index) + 1, m.index + m[0].length)
    );
    const [, bEnd] = enclosingBlock(src, open, `${label} ${typeM[1]} 的调用块`);
    const reads = resVar
      ? setOf(
          [...src.slice(open, bEnd).matchAll(new RegExp(`\\b${resVar}\\.([A-Za-z0-9_$]+)`, "g"))]
            .map((x) => x[1])
        )
      : new Set();
    sites.push({
      type: typeM[1],
      keys: objKeys(src, open, `${label} ${typeM[1]} 的载荷`).filter((k) => k !== "type"),
      reads,
      resVar,
      line: lineAt(src, open)
    });
  }
  assert.ok(sites.length, `${label} 一处发送都没认出来，正则失效了`);
  return sites;
}

/* function send(message) 的定义本身不算调用点：靠 \(\s*\{ 已经挡掉，T1 再数一遍 */
const POPUP_SENDS = sendSites(POPUP, /\bsend\(\s*\{/g, "popup.js");
const KA_SENDS = sendSites(KA, /chrome\.runtime\.sendMessage\(\s*\{/g, "keepalive.js");

/* 背景 → 页面：两条推送 */
const BG_PUSHES = [];
for (const m of BG.matchAll(/sendMessage\(\s*[\w$.]+\s*,\s*\{/g)) {
  const open = m.index + m[0].lastIndexOf("{");
  const bodyText = matchBraces(BG, open, "发给页面的一处推送");
  const typeM = bodyText.match(ROOT_TYPE);
  assert.ok(typeM, "发给页面的一条推送的第一个根级键不是 type");
  BG_PUSHES.push({
    type: typeM[1],
    keys: objKeys(BG, open, `推送 ${typeM[1]}`).filter((k) => k !== "type"),
    line: lineAt(BG, open)
  });
}

/* 页面那一侧的消费：监听器认的类型 + applyConfig 读的字段 */
const KA_BRANCHES = [...KA.matchAll(/msg\.type === "([a-z-]+)"/g)].map((m) => m[1]);
const APPLY_AT = KA.indexOf("function applyConfig(");
assert.ok(APPLY_AT >= 0, "找不到 applyConfig");
const APPLY_BODY = matchBraces(KA, KA.indexOf("{", APPLY_AT), "applyConfig");
const CFG_KEYS = setOf([...APPLY_BODY.matchAll(/\bcfg\.([A-Za-z0-9_$]+)/g)].map((m) => m[1]));
assert.ok(APPLY_AT > 0 && /applyConfig\(msg\)/.test(KA), "keepalive-config 不再把 msg 整份交给 applyConfig");
assert.ok(
  /sendMessage\(\s*\{\s*type:\s*"keepalive-query"[\s\S]{0,80}?applyConfig\(resp\)/.test(KA),
  "keepalive-query 的应答不再原样喂给 applyConfig，T7 那条三方比对的前提没了"
);

/* 来源守卫的登记表（message-gate 只钉了一个方向） */
const TABLE_AT = BG.indexOf("const FROM_PAGE_TYPES = new Set(");
assert.ok(TABLE_AT >= 0, "找不到 FROM_PAGE_TYPES");
const TABLE = [...BG.slice(TABLE_AT, BG.indexOf(";", TABLE_AT)).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

const SENDERS = [
  ...POPUP_SENDS.map((s) => ({ ...s, from: "popup.js" })),
  ...KA_SENDS.map((s) => ({ ...s, from: "keepalive.js" }))
];
const SENT_TYPES = setOf(SENDERS.map((s) => s.type));

/* ---------- 用例 ---------- */

test("空跑守卫：分发口、三处发送侧、页面消费端都切到了真东西", () => {
  assert.ok(BRANCHES.size >= 11, `分发口只认出 ${BRANCHES.size} 条分支，账本太小`);
  assert.ok(
    [...BRANCHES.values()].reduce((n, b) => n + b.reads.size, 0) >= 5,
    "所有分支加起来读到的 msg.X 少于 5 个，②那本账是空的"
  );
  assert.ok([...BRANCHES.values()].every((b) => b.responses.length >= 1), "有分支一次都没应答，③那本账是空的");
  assert.ok(new Set(POPUP_SENDS.map((s) => s.type)).size >= 9, "弹窗只认出不到 9 种类型");
  assert.equal(POPUP_SENDS.length, 10, "弹窗的 send 调用点数变了（其中一条类型发了两次）");
  assert.ok(POPUP_SENDS.filter((s) => s.resVar).length >= 3, "没有一处 await send 赋值给变量，③无从核对");
  assert.ok(
    POPUP_SENDS.reduce((n, s) => n + s.reads.size, 0) >= 4,
    "弹窗读到的应答字段少于 4 个，③那本账是空的"
  );
  assert.deepEqual(KA_SENDS.map((s) => s.type).sort(), ["keepalive-query", "user-activity"]);
  assert.deepEqual(BG_PUSHES.map((p) => p.type).sort(), ["keepalive-config", "keepalive-config", "keepalive-off"]);
  assert.ok(GUARD_KEYS.has("ok") && CATCH_KEYS.has("error"), "守卫/catch 的应答键切错了");
  assert.deepEqual(TABLE.sort(), ["keepalive-query", "user-activity"]);
  assert.deepEqual([...CFG_KEYS].sort(), ["activityWatch", "heartbeat"]);
  assert.deepEqual(KA_BRANCHES.sort(), ["keepalive-config", "keepalive-off"]);
});

test("①类型名两头齐平：弹窗与页面发的每一条都有分支接，每条分支也都有人发", () => {
  for (const s of SENDERS) {
    assert.ok(
      BRANCHES.has(s.type),
      `${s.from}:${s.line} 发的是 "${s.type}"，分发口没有这条分支——它会落到末尾的 else，回一个 {ok:false} 就算失败`
    );
  }
  for (const [type, b] of BRANCHES) {
    assert.ok(
      SENT_TYPES.has(type),
      `background.js:${b.line} 的分支 "${type}" 没有任何发送方——要么是真死分支，要么发送侧那条的名字已经改歪`
    );
  }
});

test("②请求载荷：分支读到的每一个 msg.X 都有发送方发出（少一个就是读到 undefined）", () => {
  for (const [type, b] of BRANCHES) {
    const senders = SENDERS.filter((s) => s.type === type);
    const sent = new Set(senders.flatMap((s) => s.keys));
    for (const k of b.reads) {
      assert.ok(
        sent.has(k),
        `background.js:${b.line} 的分支 "${type}" 读 msg.${k}，但 ${senders.map((s) => `${s.from}:${s.line}`).join(" / ")} 没有一处发出 ${k}`
      );
    }
  }
});

test("②反过来：发送方发出的每一个载荷键都有分支读它（多一个键就是白占报文）", () => {
  for (const s of SENDERS) {
    const b = BRANCHES.get(s.type);
    if (!b) continue; /* 上一例已经报过"没人接" */
    for (const k of s.keys) {
      assert.ok(
        b.reads.has(k),
        `${s.from}:${s.line} 给 "${s.type}" 发了 ${k}，分支却不读它——通常是另一头把 msg.${k} 改了名`
      );
    }
  }
});

test("③应答字段：弹窗读的每一个 res.X 都在那条分支真会回的对象里", () => {
  /* 只钉这一向。反过来的"分支多回了一个没人读的字段"刻意不钉：toggle-pause-all 回了
     {ok, pausedAll} 而弹窗靠 storage.onChanged 回流拿真值，res.pausedAll 一辈子没人碰，
     那种形状不会静默失效，钉平它就得开一张豁免清单——豁免清单是"以后什么都能往里加"的东西 */
  for (const s of POPUP_SENDS) {
    const b = BRANCHES.get(s.type);
    if (!b) continue;
    const allowed = new Set([...b.all, ...ALWAYS]);
    for (const k of s.reads) {
      assert.ok(
        allowed.has(k),
        `${s.from}:${s.line} 读 res.${k}，但分支 "${s.type}" 的应答里没有这个字段（应答形状：${[...b.all].join(", ")}）`
      );
    }
  }
});

test("每条分支至少 sendResponse 一次：漏掉的那条会退化成 errUnknown", () => {
  /* 弹窗的 send() 拿不到应答时 resolve({ok:false})，所以不会挂住；但调用点分不出
     "这条消息没被处理"和"处理失败了"，用户看到的都是同一句未知错误。
     只钉"至少回一次"，不钉"每次都带 ok"：keepalive-query 那一条刻意只回两个配置字段，
     页面侧靠 if (resp) 判有没有拿到，带不带 ok 都不影响它 */
  for (const [type, b] of BRANCHES) {
    assert.ok(b.responses.length >= 1, `分支 "${type}"（background.js:${b.line}）一次都没应答`);
  }
});

test("页面配置三方齐平：推送带的字段 == 应答带的字段 == applyConfig 读的字段", () => {
  const push = setOf(BG_PUSHES.find((p) => p.type === "keepalive-config").keys);
  const query = BRANCHES.get("keepalive-query").all;
  assert.deepEqual(
    diff(push, query).concat(diff(query, push)), [],
    `推送带 ${[...push]} 而 keepalive-query 回 ${[...query]}：注入后先拉快照、再等推送，两条路必须给同一样东西`
  );
  assert.deepEqual(
    diff(query, CFG_KEYS).concat(diff(CFG_KEYS, query)), [],
    `应答带 ${[...query]} 而 applyConfig 读 ${[...CFG_KEYS]}：名字对不上时 cfg.X 是 undefined，等于把那个开关判成关`
  );
  assert.ok(
    BG_PUSHES.filter((p) => p.type === "keepalive-off").every((p) => p.keys.length === 0),
    "keepalive-off 开始带字段了，页面侧那条分支只调 teardownAll，没人读它"
  );
});

test("FROM_PAGE_TYPES 的反方向：表里的每一条都真有人发", () => {
  /* message-gate 钉的是"页面会发的都得登记"，少一条就红；这里钉多一条：
     表里留着一条已经没人发的类型，等于守卫的覆盖面比真实通道大——看着安全其实虚报 */
  for (const t of TABLE) {
    assert.ok(
      KA_SENDS.some((s) => s.type === t),
      `FROM_PAGE_TYPES 里有 "${t}"，但 keepalive.js 从不发它：这条许可是死的，该跟着表一起删`
    );
  }
});

/* ------------------------------------------------------------------
   红→绿对照（2026-09-19 实跑，node v24.21.0）。方法沿用十三轮：整份仓库复制到仓库外
   D:\Github\_tar_ctl_r14\_stage\<变体>，在副本里改坏，跑整套（跑整套才谈得上
   "改前的世界看不看得见"），副本用完即删，产品代码一个字没动。
   needle 一律单行（仓库是 CRLF），命中次数不等于 1 直接抛错；同一句字面量在文件里
   本来就有两处的（V9 那句 heartbeat、V14 那行 settings: {）按行号定位，行号取自
   未抹注释的原文件。脚本 D:\Github\_tar_ctl_r14\run14b.mjs。

   每个变体跑两遍：pre = 删掉本文件的副本（本轮之前的世界），post = 留着本文件的副本。
   基线 pristine：510 pass / 0 fail（pre 侧），加本文件 518 / 0（post 侧）。

   —— pre 全盲的六条：这一批才是本文件的理由 ——
   V1  弹窗 start 的载荷里删掉 keepWatching         pre 0 → post 1（②正向）
   V2  弹窗把 "resume-task" 打成 "resume"           pre 0 → post 2（①、②正向）
   V3  弹窗删掉整条 send({type:"prune-now"})        pre 0 → post 2（①、空跑守卫）
   V4  弹窗把 res.intervalSec 读成 res.safeInterval  pre 0 → post 1（③）
   V5  弹窗把 start 的 tabId 打成 tab                pre 0 → post 2（②正向、②反向）
   V6  背景把 msg.keepWatching 读成 msg.watchOnHit   pre 0 → post 2（②正向、②反向）
   六条合起来：①②③从弹窗这一头改坏全盲，②从背景那一头改坏也盲。
   V3 的"红 2"里有一条是空跑守卫——它对 send 调用数写的是精确值 10，删掉一处就响。
   这不是巧合而是同一条决断：调用点数变了必须有人回来看一眼，否则这张表改了也没痕迹。
   V6 值得单独记：测试侧唯一发过 keepWatching: true 的是 detect-chain，它发完只看
   keywords 与 notifiedKeys，从没回头看 onHit。那一份是第三份抄本——两份真源码
   之间的账没人对，抄本自己多齐都对不上任何东西。这也是 ②正向 只认 popup.js 与
   keepalive.js 这两份真源码、不认测试侧的原因。

   —— pre 就有门禁拦住的：不重复领功，只记下 overlap 在哪 ——
   V7   背景分支 "resume-task" 改名        pre 2 → post 4（多红 ①、②正向）
   V8   背景 start 的应答删掉 intervalSec   pre 1 → post 2（多红 ③）
   V9   keepalive-query 的应答删 heartbeat  pre 7 → post 8（多红 T7）
        V9 那 7 条里只有 2 条是"名字"账（keepalive-channel 喂真载荷那条、message-gate
        的"合法通道照常工作"），另外 5 条来自 settings-cache：它把 keepalive-query 的
        应答当成观察设置快照的那扇只读窗口，读的正是 resp.heartbeat。一个字段名被四面
        门同时按字面用着——这更说明它该进名字账，而不该靠"别人顺带撞红"。
   V10  页面监听器把 "keepalive-off" 改名   pre 3 → post 4（多红空跑守卫）
   V11  applyConfig 读成 cfg.hbOn           pre 4 → post 6（多红空跑守卫、T7）
   V12  页面把 "keepalive-query" 改名       pre 2 → post 红在整个文件：那三处模块级
        前置断言（发送正则、"query 应答原样喂给 applyConfig"）抛在 test 之外，文件名
        代替用例名。切片前提塌了就该这样响——下面七条一次都不跑，比让它们拿着半截
        数据比出个绿要好
   V13  背景分支 "user-activity" 改名       pre 3 → post 4（多红 ①）
   V14  弹窗 save-settings 的包装键改名      pre 1 → post 3（多红 ②正向、②反向）。
        pre 那 1 条是十三轮的 settings-map：它真跑 saveSettings、看的是发出去的对象，
        包装键一改名 sent.settings 就是 undefined。所以这一条不盲，但红的原因是
        "求值求出来的载荷变了"，不是"两边名字对不上"——两码事，各钉各的
   V15  背景把 msg.seconds 读成 msg.sec     pre 3 → post 5（多红 ②正向、②反向）

   本文件净新增的覆盖面就是 V1 到 V6 这六条；V7 到 V15 是"已经有人守、这里再钉一次
   名字账"。overlap 刻意保留：那几条现在红靠的是行为用例，行为用例改天少喂一个字段
   就不再是名字账了，而这三段名字（类型、载荷、应答）本身要能在不看行为的情况下被核对。

   V16 反向自检：把空跑守卫的分支下限改成一个不可能的数 → post 红 1（就是那条守卫）。
   说明"切到了真东西"那一句不是白写的。

   三处边界（不是缺陷，是划在这里的界）：
   1) 测试侧那份第三抄本不入账。测试里出现故意喂给末尾 else 的假类型是合法输入，
      拿真源码的口径去要求它一定假红；②正向反过来把测试抄本顶掉了——分支读的每个键
      都必须出自两份真源码之一，所以"测试发了、真弹窗没发"这种假覆盖照样红（V6 就是它）
   2) ③反向（分支多回一个没人读的字段）刻意不钉，理由写在③那条的注释里
   3) 键名只认根级：嵌套对象里的同名字（settings 里那 15 个键）与计算键都不进账，
      所以 payload 再往里套一层"名字对不上"，要靠②③各跑一次才撞得出来
   ------------------------------------------------------------------ */
