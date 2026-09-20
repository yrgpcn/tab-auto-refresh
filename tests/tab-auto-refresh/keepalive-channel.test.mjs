/* A20 的门禁：保活通道两头都是零覆盖。
   改之前的状态：把 stopTask 里的 `stopKeepAlive(tabId);` 整行删掉，全套 373 条一条都不红；
   注入侧（startTask 即时一次 + onUpdated 每次加载完成补一次）与 reconcileKeepAlive 整个函数
   同样没有任何用例。桩件早就在记 calls.messagesSent，只是没人去断言它。

   这条通道静默失效的代价不对称：停任务不发 off，页面里那份脚本会继续向对方服务器派合成活动
   ——用户已经在弹窗点了停止，插件却在替他把"有人在看着这个页面"演下去，而且本机毫无症状。
   所以本文件两头都要有正向见证（先证明通道跑到了、再断言这一处不该跑）：
     1) 后台侧：真跑 background.js，断言注入确实发生、推送的配置与两个开关一致、
        keepalive-off 只发给停掉的那一页；
     2) 页面侧：把 content/keepalive.js 的真实源码整个执行一遍（假 window / document / chrome），
        断言 config 真的起了心跳、off 真的全停。只扫源码字符串等于没测——那个文件此前从未被执行过；
     3) 接缝：拿后台真发出来的那两个载荷喂给页面侧真监听器，两边各改一个字节都会红。

   与 frame-scan 的分工：那边管"检测链要不要看子框架、保活脚本不许扩到子框架"，
   这边管"这条通道有没有消息、消息两头认不认"。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

/* 红→绿对照用：TAR_BG 指另一份 background.js（共享桩件的口子），TAR_KEEPALIVE 指另一份
   content/keepalive.js——页面侧那批用例是按文本读源码再执行的，对照要能换文件。
   CI 上不设这两个变量 */
const BG_SRC = readFileSync(
  process.env.TAR_BG || new URL("../../tab-auto-refresh/background.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const KA_SRC = readFileSync(
  process.env.TAR_KEEPALIVE ||
    new URL("../../tab-auto-refresh/content/keepalive.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

/* 后台派发 onRemoved 时不返回 promise，要排一轮宏任务才看得到结果 */
const flush = () => new Promise((r) => setTimeout(r, 30));

const BASE_SETTINGS = {
  keepAlive: true,
  skipOnActivity: false,
  httpHeartbeat: false,
  cookieBackup: false,
  captchaGuard: false,
  keepAwake: false,
  lastIntervalSec: 300
};

async function boot({ tasks = {}, tabs, settings } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks;
  env.store.sync.settings = Object.assign({}, BASE_SETTINGS, settings);
  for (const t of tabs || []) env.putTab(t.id, t.url);
  env.putTab(7, PAGE);
  env.putTab(9, "https://b.test/other");
  await bootBackground(env);
  return env;
}

/* ---- 后台侧的读法 ---- */

/* 保活注入认 files：关键词链带 args、验证墙带 func，三条通道互不相干（frame-scan 的另一半） */
const kaInjects = (env, tabId) =>
  env.calls.executeScript.filter(
    (o) => o && o.files && (!tabId || (o.target && o.target.tabId === tabId))
  );
const sentTo = (env, tabId, type) =>
  env.calls.messagesSent.filter(([id, m]) => Number(id) === tabId && m.type === type);

/* 把两笔调用按次序并进一条流水：注入必须排在推送之前——脚本正是这次调用注进去的，
   推送早于注入时页面上还没有监听器，那一条配置就丢了 */
function orderLog(env) {
  const log = [];
  const realExec = env.chrome.scripting.executeScript;
  env.chrome.scripting.executeScript = (o) => {
    log.push(o.files ? "inject" : "probe");
    return realExec(o);
  };
  const realSend = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = (id, m) => {
    log.push("push:" + m.type);
    return realSend(id, m);
  };
  return log;
}

/* ---- 页面侧：整份 keepalive.js 真跑一遍 ---- */

/* window 可以外部传入：重复注入那条要在同一个 window 上跑两遍 */
function makeWin() {
  return {
    listeners: [],
    addEventListener(name, fn, opts) {
      this.listeners.push({ name, fn, opts });
    },
    removeEventListener(name, fn) {
      const i = this.listeners.findIndex((l) => l.name === name && l.fn === fn);
      if (i >= 0) this.listeners.splice(i, 1);
    }
  };
}

function loadKeepalive({ queryResp = null, win = makeWin() } = {}) {
  const timers = [];
  const dispatched = [];
  const document = {
    dispatchEvent: (ev) => {
      dispatched.push(ev);
      return true;
    }
  };
  const handlers = [];
  const sent = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (f) => handlers.push(f),
        removeListener: (f) => {
          const i = handlers.indexOf(f);
          if (i >= 0) handlers.splice(i, 1);
        }
      },
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (cb) cb(queryResp);
        return Promise.resolve(queryResp);
      }
    }
  };
  const MouseEvent = function (type, init) {
    Object.assign(this, { type }, init);
  };
  const KeyboardEvent = function (type, init) {
    Object.assign(this, { type }, init);
  };
  const setTimeoutStub = (fn, ms) => {
    timers.push({ fn, ms, cleared: false, fired: false });
    return timers.length;
  };
  const clearTimeoutStub = (id) => {
    const t = timers[Number(id) - 1];
    if (t) t.cleared = true;
  };
  new Function(
    "window",
    "document",
    "chrome",
    "setTimeout",
    "clearTimeout",
    "MouseEvent",
    "KeyboardEvent",
    KA_SRC
  )(win, document, chrome, setTimeoutStub, clearTimeoutStub, MouseEvent, KeyboardEvent);

  /* 跑过的定时器不再算待跑：真实事件循环里回调只会执行一次，
     而 tick 之后会立刻排下一拍，所以"跑一次"让 pending 保持为 1 */
  const pending = () => timers.filter((t) => !t.cleared && !t.fired);
  return {
    win,
    timers,
    dispatched,
    handlers,
    sent,
    pending,
    /* 派发一个页面事件给脚本注册的真人活动监听器，返回有没有被算成真人上报 */
    fireActivity(type, trusted) {
      const before = sent.length;
      for (const l of win.listeners.slice()) if (l.name === type) l.fn({ type, isTrusted: trusted });
      return sent.length > before;
    },
    push(msg) {
      for (const f of handlers.slice()) f(msg);
    },
    runTimer() {
      const t = pending().at(-1);
      if (!t) return false;
      t.fired = true;
      t.fn();
      return true;
    }
  };
}

/* ================= 后台侧：注入 ================= */

test("开始任务：注入保活脚本一次，并把两个开关的当前值推给页面（注入排在推送之前）", async () => {
  const env = await boot({ settings: { keepAlive: true, skipOnActivity: true } });
  const log = orderLog(env);
  await env.send({ type: "start", tabId: 7, seconds: 300 });

  const inj = kaInjects(env, 7);
  assert.equal(inj.length, 1, "启动任务时没注入保活脚本，心跳要等下一次页面加载才开始");
  assert.deepEqual(inj[0].files, ["content/keepalive.js"]);
  assert.equal(inj[0].target.tabId, 7);

  const cfg = sentTo(env, 7, "keepalive-config");
  assert.equal(cfg.length, 1, "注入之后没推配置：脚本只能靠自己那次 keepalive-query 拿到设置");
  assert.deepEqual(cfg[0][1], { type: "keepalive-config", heartbeat: true, activityWatch: true });
  assert.deepEqual(log, ["inject", "push:keepalive-config"], "推送排在了注入前面，页面上还没有监听器");
});

test("两个保活开关都关着：不注入，但仍要把'都别跑'这份配置推下去", async () => {
  const env = await boot({ settings: { keepAlive: false, skipOnActivity: false } });
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(kaInjects(env, 7).length, 0, "两个开关都关着还注入，等于向站点多派一份合成活动");
  const cfg = sentTo(env, 7, "keepalive-config");
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0][1], { type: "keepalive-config", heartbeat: false, activityWatch: false });
});

test("只开活动监听也要注入：关掉保活不连坐另一项注入功能", async () => {
  const env = await boot({ settings: { keepAlive: false, skipOnActivity: true } });
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(kaInjects(env, 7).length, 1, "heartbeat 关掉就把整个注入通道拆了，活动监听从此没实现");
  const cfg = sentTo(env, 7, "keepalive-config");
  assert.deepEqual(cfg[0][1], { type: "keepalive-config", heartbeat: false, activityWatch: true });
});

test("任务页每次加载完成各补注入一次；非监控标签页一次都不注", async () => {
  /* 注入是标签页级、随文档销毁，所以每次 complete 都要补一次；判据按页而不是按站点，
     同站另一张无关页不能被顺带注上（这正是没用 registerContentScripts 的理由） */
  const env = await boot({ tasks: { 7: task() } });
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(kaInjects(env, 7).length, 1, "页面加载完成后没补注入");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(kaInjects(env, 7).length, 2, "第二次加载没注：脚本守卫本来就是可重启语义");
  await env.fire.tabUpdated(9, { status: "complete" });
  assert.equal(kaInjects(env, 9).length, 0, "非监控标签页被注入了保活脚本");
});

test("注入被站点拒绝时不阻塞任务主流程：任务照建、alarm 照挂", async () => {
  /* 受限页 / 渲染上下文未就绪 / 站点策略都会让 executeScript 整次 reject。
     这一拍在 withTaskLock 里 await 着，抛出来就是"点开始没反应"——心跳是锦上添花，
     刷新任务是主流程，两者的优先级必须在这个 try/catch 上体现 */
  const env = await boot({ settings: { keepAlive: true } });
  const real = env.chrome.scripting.executeScript;
  let attempts = 0;
  env.chrome.scripting.executeScript = async (o) => {
    if (o.files) {
      attempts++;
      throw new Error("Cannot access contents of the page");
    }
    return real(o);
  };
  const r = await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(attempts, 1, "这一轮根本没试过注入，用例是空跑");
  assert.equal(r.ok, true, "注入失败把开始任务整个带崩了");
  assert.equal(r.intervalSec, 300);
  assert.ok(env.store.local.tasks[7], "注入失败却把任务写丢了");
  assert.ok(env.calls.alarmsCreated.some(([n]) => n === "refresh-7"));
});

/* ================= 后台侧：停止 ================= */

test("停任务：向这一页发 keepalive-off，另一张在跑的页不受牵连", async () => {
  const env = await boot({ tasks: { 7: task(), 9: task({ url: "https://b.test/other" }) } });
  await env.send({ type: "stop", tabId: 7 });
  assert.equal(sentTo(env, 7, "keepalive-off").length, 1, "停任务没让页面内的脚本自停");
  assert.equal(sentTo(env, 9, "keepalive-off").length, 0, "停一张页把别人的心跳也停了");
  assert.equal(sentTo(env, 9, "keepalive-config").length, 0);
});

test("停一张没有任务的页：向任何一页都不发消息", async () => {
  /* 见证在上一条；这条钉的是 stopTask 的早退排在那句之前——任务不存在时页面从未被注过，
     发 off 无害但会让"这条通道什么时候该响"变成不可读的巧合 */
  const env = await boot({ tasks: {} });
  await env.send({ type: "stop", tabId: 7 });
  assert.deepEqual(env.calls.messagesSent, []);
});

test("重开任务页：旧 id 收到 keepalive-off，新页加载完成后重新注入", async () => {
  const env = await boot({ tasks: { 7: task() } });
  env.chrome.tabs.create = async (props) => {
    env.putTab(42, props.url);
    return { id: 42, url: props.url };
  };
  await env.fire.tabRemoved(7, false);
  await flush();
  assert.equal(sentTo(env, 7, "keepalive-off").length, 1, "任务搬走之后旧页还在派合成活动");

  await env.fire.tabUpdated(42, { status: "complete" });
  assert.equal(kaInjects(env, 42).length, 1, "新页没被补注入：搬完任务这一页从此不心跳");
  assert.equal(kaInjects(env, 7).length, 0);
});

/* ================= 后台侧：按开关收敛 ================= */

test("关掉保活开关：reconcile 停掉存量任务页，而不是继续注入", async () => {
  /* 用户把开关关掉之后，页面不会重新加载，onUpdated 那条补注入网永远不来。
     这条路径是唯一能让"已经开着的任务页"停下来的 */
  const env = await boot({ tasks: { 7: task() }, settings: { keepAlive: true } });
  env.calls.messagesSent.length = 0;
  env.calls.executeScript.length = 0;
  const next = Object.assign({}, BASE_SETTINGS, { keepAlive: false });
  /* 落盘与事件都要给：桩件的 onChanged 不回流（真实 Chrome 才回流），
     只发事件不回写存储，reconcile 读到的还是写前的旧值，测出来的是"开关没生效"这种假失败 */
  env.store.sync.settings = next;
  await env.fire.onChanged(
    {
      settings: {
        oldValue: Object.assign({}, BASE_SETTINGS, { keepAlive: true }),
        newValue: next
      }
    },
    "sync"
  );
  await flush();
  assert.equal(sentTo(env, 7, "keepalive-off").length, 1, "关掉开关后存量任务页里的心跳还在跑");
  assert.equal(kaInjects(env, 7).length, 0, "都关了还在注入");
  assert.deepEqual(sentTo(env, 7, "keepalive-config")[0][1], {
    type: "keepalive-config",
    heartbeat: false,
    activityWatch: false
  });
});

test("设置里无关的键变了：不惊动任何任务页", async () => {
  const env = await boot({ tasks: { 7: task() }, settings: { keepAlive: true } });
  env.calls.messagesSent.length = 0;
  env.calls.executeScript.length = 0;
  const same = Object.assign({}, BASE_SETTINGS, { keepAlive: true });
  const next = Object.assign({}, same, { lastIntervalSec: 600 });
  env.store.sync.settings = next;
  await env.fire.onChanged({ settings: { oldValue: same, newValue: next } }, "sync");
  await flush();
  assert.deepEqual(env.calls.messagesSent, [], "一次无关写盘引发任务页心跳重置风暴");
  assert.deepEqual(env.calls.executeScript, []);
});

/* ================= 页面侧：真实源码执行 ================= */

test("空跑守卫：页面侧那份源码确实被跑起来了，两种类名都还在", () => {
  assert.match(KA_SRC, /chrome\.runtime\.onMessage\.addListener\(onMessage\)/);
  assert.match(BG_SRC, /const KEEPALIVE_SCRIPT = "content\/keepalive\.js";/);
});

test("keepalive-config 的 heartbeat 为真时页面真的发合成活动", () => {
  const p = loadKeepalive({ queryResp: null });
  assert.equal(p.pending().length, 0, "没拿到配置就起了心跳");
  p.push({ type: "keepalive-config", heartbeat: true, activityWatch: false });
  assert.equal(p.pending().length, 1, "配置说该跑心跳，页面里却没挂上定时器");
  assert.ok(p.runTimer(), "定时器回调没跑");
  assert.deepEqual(
    p.dispatched.map((e) => e.type),
    ["mousemove", "keydown", "keyup"],
    "派发的事件面与文档记录不一致（document 级冒泡是刻意的）"
  );
  assert.equal(p.win.listeners.length, 0, "只开 heartbeat 却把真人活动的监听器也挂上了");
});

test("真人事件上报 user-activity，合成事件绝不算真人", () => {
  const p = loadKeepalive();
  p.push({ type: "keepalive-config", heartbeat: false, activityWatch: true });
  assert.equal(p.win.listeners.length, 5, "活动监听要挂 mousemove/mousedown/keydown/scroll/touchstart");
  assert.ok(p.pending().length === 0, "只开活动监听却把心跳也起了");
  assert.equal(p.fireActivity("mousemove", true), true, "真人操作没上报，后台那条跳过判据拿不到输入");
  assert.equal(p.fireActivity("mousemove", false), false, "自己派发的合成事件被算成了真人");
  assert.deepEqual(p.sent.at(-1), { type: "user-activity" });
});

test("逐项起停：关掉 heartbeat 不停活动监听，反之亦然", () => {
  const p = loadKeepalive({ queryResp: { heartbeat: true, activityWatch: true } });
  assert.equal(p.pending().length, 1);
  assert.equal(p.win.listeners.length, 5);
  p.push({ type: "keepalive-config", heartbeat: false, activityWatch: true });
  assert.equal(p.pending().length, 0, "关 heartbeat 连坐了活动监听");
  assert.equal(p.win.listeners.length, 5);
  p.push({ type: "keepalive-config", heartbeat: true, activityWatch: false });
  assert.equal(p.pending().length, 1, "关活动监听连坐了 heartbeat");
  assert.equal(p.win.listeners.length, 0);
});

test("keepalive-off 真的全停：定时器清掉、监听摘掉、全局钩子删掉", () => {
  const p = loadKeepalive({ queryResp: { heartbeat: true, activityWatch: true } });
  assert.equal(typeof p.win.__tarKeepAlive, "function", "全局钩子没挂上，重复注入无法重启旧实例");
  p.push({ type: "keepalive-off" });
  assert.equal(p.pending().length, 0);
  assert.equal(p.win.listeners.length, 0);
  assert.equal(p.handlers.length, 0, "消息监听器没摘：这张页之后还能被后台远程启动心跳");
  assert.equal(p.win.__tarKeepAlive, undefined);
  assert.equal(p.runTimer(), false, "还有没清掉的定时器");
});

test("重复注入可重启：新实例先全停旧实例，自己接着跑", () => {
  /* start → stop → start 不重载页面时，同一份源码会被注进同一个 window 两次。
     守卫若只"已存在就 return"，第二次启动等于什么都没发生——停掉的任务页继续心跳 */
  const win = makeWin();
  const first = loadKeepalive({ win, queryResp: { heartbeat: true, activityWatch: false } });
  assert.equal(first.pending().length, 1);
  const second = loadKeepalive({ win, queryResp: { heartbeat: true, activityWatch: false } });
  assert.ok(
    first.timers.every((t) => t.cleared),
    "第二次注入没先停掉第一次：同一份心跳在同一页上跑了两遍"
  );
  assert.equal(first.handlers.length, 0, "旧实例的消息监听器还挂着");
  assert.equal(second.timers.length, 1, "第二次注入自己没起来");
  assert.equal(second.handlers.length, 1);
});

/* ================= 接缝：两头各跑真身 ================= */

test("后台发的载荷喂给页面侧真监听器：config 起心跳、off 停到底", async () => {
  /* 这条是同类型名两头的唯一门禁：后台把 "keepalive-config" 改成别的写法，
     页面侧的 if 就不再匹配，而两侧各自的用例都还会绿 */
  const env = await boot({ settings: { keepAlive: true } });
  const query = await env.send({ type: "keepalive-query" }, { tab: { id: 7 } });
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  const cfg = sentTo(env, 7, "keepalive-config")[0][1];
  await env.send({ type: "stop", tabId: 7 });
  const off = sentTo(env, 7, "keepalive-off")[0][1];

  const p = loadKeepalive({ queryResp: query });
  /* 启动时那一次一问一答本身也要成立：页面脚本只发 keepalive-query，
     而它拿到的那份应答要真能让心跳起来（拿不到就全停，等推送） */
  assert.deepEqual(p.sent[0], { type: "keepalive-query" });
  assert.equal(p.pending().length, 1, "后台的查询应答没让页面起心跳");

  assert.ok(cfg.heartbeat === true, "这一轮后台给的 heartbeat 不是 true，用例是空跑");
  p.push(cfg);
  assert.equal(p.pending().length, 1, "后台推的那条配置页面侧不认");
  assert.ok(p.runTimer());
  assert.ok(p.dispatched.length > 0, "起了定时器却没派发事件");

  assert.equal(off.type, "keepalive-off");
  p.push(off);
  assert.equal(p.pending().length, 0);
  assert.equal(p.handlers.length, 0);
});

test("后台发给页面侧的消息类型与页面侧监听的同集合", () => {
  /* 新增一类后台→页面的消息，页面侧漏了分支的表现是那条功能静默失效（注入脚本自己吞掉失败），
     上面那些按具体类型写的用例只会一直测旧的两种。这条集合守卫管的是第三种类型进来时 */
  const fromBg = new Set([...BG_SRC.matchAll(/type:\s*"(keepalive-[^"]+)"/g)].map((m) => m[1]));
  const handled = new Set(
    [...KA_SRC.matchAll(/msg\.type === "(keepalive-[^"]+)"/g)].map((m) => m[1])
  );
  assert.ok(fromBg.size >= 2 && handled.size >= 2, "两条正则一条没切到，本条是空跑");
  assert.deepEqual([...fromBg].sort(), [...handled].sort(), "后台发出的类型页面侧不认，或反过来");
});

/* ---------- 红→绿对照（照本仓库方法学：没见过红的门禁不算门禁） ----------

   整份插件目录复制到仓库外，在副本上逐处改坏，用 TAR_BG / TAR_KEEPALIVE 指过来跑本文件。
   17 处对照 2026-09-19 实跑（九处后台、七处页面侧、一处反向），每处点名的用例都红，
   没有出现"改坏了却全绿"的背景侧条目：
     K1 删掉 stopTask 的 `stopKeepAlive(tabId);`（A20 报的那个缺陷本身）→ 红 2：
        「停任务：向这一页发 keepalive-off」＋接缝那条。改之前全套 373 条零红
     K2 删掉 startTask 的 `await syncKeepAliveConfig(tabId);` → 红 5：三条注入用例＋
        「注入被站点拒绝时不阻塞任务」＋接缝那条
     K3 `if (heartbeat || activityWatch)` 收成 `if (heartbeat)` → 红 1「只开活动监听也要注入」
     K4 把配置推送挪到注入之前 → 红 1（流水顺序断言）
     K5 删掉 reopenTaskTab 的 `stopKeepAlive(oldTabId);` → 红 1「重开任务页」
     K6 删掉 reconcileKeepAlive 的 else 分支 → 红 1「关掉保活开关：reconcile 停掉存量任务页」
     K7 把 off 挪到 stopTask 的早退之前 → 红 1「停一张没有任务的页」
     K8 删掉 onUpdated 的 `await syncKeepAliveConfig(tabId);` → 红 2（补注入＋重开）
     K9 删掉 keepAliveInject 的 try/catch → 红 1「注入被站点拒绝时不阻塞任务主流程」
   页面侧六处（TAR_KEEPALIVE）：
     P1 off 的类型名改掉 → 红 3（含集合守卫）
     P2 重复注入的守卫只判不叫 → 红 1「重复注入可重启」
     P3 heartbeat 为 false 时顺手 stopActivityWatch() → 零红，但不是门禁缺口而是等价变异：
        紧接着一行 `if (cfg.activityWatch) startActivityWatch();` 又把它原样起回来，净结果与原文
        一致，没有可观察的行为差别。换成非等价的 P3b（删掉 `else stopActivityWatch();`）即红 1
        「逐项起停」。记下来是因为这类"看着像连坐、其实被下一行抵消"的改法在这段两行代码上很多，
        挑对照要挑净结果变了的那一种
     P4 全停时不删全局钩子 → 红 1
     P5 真人活动监听面少一种事件 → 红 2
     P6 config 的类型名改掉 → 红 4
   一处反向绿：R1 删掉 stopTask 的 `detectChains.delete(tabId);` → 本文件零红，符合预期
   （关键词链不归这条通道管）。但顺手拿同一份变体跑了 detect-chain.test.mjs，那头也零红：
   停任务时在飞的检测链没有被任何用例钉住。已另记 BACKLOG A21，含可用的测法
   （executeScript 挂起期间停任务，放开后断言不发 keyword-hit）。 */
