/* A3 的门禁：关键词检测与验证墙探测都从"只看顶层框架"放开到"看全部框架"。

   这文件管四层，缺一层就会留下静默缺口：
     1) 纯函数层：aggregateFrameHits 怎么合并各框架结果、decideWallFromFrames 怎么逐框架判定；
     2) 注入体层：captchaProbe 是真的从 background.js 里切出来跑的（与 keyword-inpage 同法）；
     3) 两层接缝：注入体回的那份事实形状，必须正好是纯函数层要的入参形状——A3 把判定搬回
        后台之后，这个接缝是新的，谁改了另一边都不会有人报错；
     4) 执行器层：两处注入确实带上了 allFrames，以及 allFrames 整次被拒时退回顶层。

   为什么"框架"这件事值得单开一个文件：跨源 iframe 一样能注入（本插件常驻 <all_urls> 主机
   权限），所以以前检不到子框架纯粹是没要。而 Cloudflare 的挑战页常常就嵌在一层 iframe 里，
   顶层文档只剩一个空壳标题——只看顶层等于这类墙永远检不到，验证墙那道守卫形同虚设。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import * as CONFIG from "../../tab-auto-refresh/shared/config.js";

/* 红→绿对照用：TAR_BG 指另一份 background.js（既当文本读，也交给共享桩件 boot），
   TAR_LOGIC 指另一份 logic.js。CI 上不设这两个变量 */
const BG_SRC = readFileSync(
  process.env.TAR_BG || new URL("../../tab-auto-refresh/background.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const LOGIC = await import(
  process.env.TAR_LOGIC
    ? pathToFileURL(process.env.TAR_LOGIC).href
    : new URL("../../tab-auto-refresh/shared/logic.js", import.meta.url).href
);
const { aggregateFrameHits, decideWallFromFrames, WALL_FRAME_MIN_W, WALL_FRAME_MIN_H } = LOGIC;

/* 按花括号配对切出函数源码（与 keyword-inpage.test.mjs 同一手法）。
   切歪了下面的 new Function 会直接抛，是响失败不是静默假绿 */
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

const PROBE_SRC = sliceFunction(BG_SRC, "captchaProbe");
/* 函数体（去掉签名与最外层花括号）：扫字面量的时候要用这一段，
   函数名 captchaProbe 自己就含 "captcha"，扫整份源码会自己打自己 */
const PROBE_BODY = PROBE_SRC.slice(PROBE_SRC.indexOf("{") + 1, PROBE_SRC.lastIndexOf("}"));
const SEL = "iframe, frame, script[src]";

/* 造一个够用的假现场：注入体的全部外部依赖只有 document / window / location 三个，
   参数名把它们遮蔽掉；Node 侧没有这三个全局，所以跑不了假 DOM 之外的东西 */
function runCaptchaProbe({
  title = "",
  srcs = [],
  top = true,
  w = 1280,
  h = 900,
  href = "https://a.test/board"
} = {}) {
  const els = srcs.map((u) => ({ getAttribute: (a) => (a === "src" ? u : null) }));
  const doc = { title, querySelectorAll: (sel) => (sel === SEL ? els : []) };
  const win = { self: null, top: top ? null : {}, innerWidth: w, innerHeight: h };
  win.self = win;
  if (top) win.top = win;
  return new Function("document", "window", "location", `${PROBE_SRC}; return captchaProbe;`)(
    doc,
    win,
    { href }
  )();
}

/* ---------- 1) 多框架聚合 ---------- */

test("各框架的命中集合并、按首次出现顺序去重", () => {
  const r = aggregateFrameHits([
    { frameId: 0, result: ["A", "B"] },
    { frameId: 3, result: ["B", "C"] }
  ]);
  assert.deepEqual(r.present, ["A", "B", "C"]);
  assert.equal(r.framesOk, 2);
});

test("部分框架没注入进去：取到几个算几个", () => {
  const r = aggregateFrameHits([
    { frameId: 0, result: undefined }, /* 沙箱框架：条目在、result 缺 */
    {},
    { frameId: 3, result: ["A"] }
  ]);
  assert.deepEqual(r.present, ["A"]);
  assert.equal(r.framesOk, 1, "没取到的框架被当成了取到");
});

test("一个框架都没取到才算注入失败（present 回 null）", () => {
  assert.equal(aggregateFrameHits([{ frameId: 0 }, { frameId: 2 }]).present, null);
  assert.equal(aggregateFrameHits(undefined).present, null);
  assert.equal(aggregateFrameHits([]).present, null);
  assert.equal(aggregateFrameHits(null).framesOk, 0);
});

test("取到了但都没命中：present 是空数组，不是 null", () => {
  /* 这条区分的是"注入了、页面确实没这些词"与"根本没注进去"，
     后者要提前结束本轮等下个刷新周期，前者继续走 3s/10s 重采样 */
  const r = aggregateFrameHits([{ frameId: 0, result: [] }, { frameId: 1, result: [] }]);
  assert.deepEqual(r.present, []);
  assert.equal(r.framesOk, 2);
});

test("顺序稳定：同样的框架结果重复聚合，逐次一致", () => {
  const frames = [
    { frameId: 0, result: ["B", "A"] },
    { frameId: 1, result: ["A"] }
  ];
  assert.deepEqual(aggregateFrameHits(frames).present, aggregateFrameHits(frames).present);
  assert.deepEqual(aggregateFrameHits(frames).present, ["B", "A"], "顺序被改了：notifiedKeys 的回写比对会看到抖动");
});

/* ---------- 2) 逐框架的墙判定 ---------- */

const fact = (o) =>
  Object.assign({ top: true, title: "", url: "https://a.test/board", w: 1280, h: 900, assets: [] }, o);
const frames = (...rs) => rs.map((r, i) => ({ frameId: i, result: r }));

test("顶层框架只按标题判墙，挑战脚本本身不是页面状态", () => {
  /* 顶层引入 reCAPTCHA api.js 是普通登录页的常见形状。此前把这份依赖当成墙，
     连续三次加载后会把正常任务永久自动暂停。真正整页挑战 iframe 由子框架分支判。 */
  assert.equal(decideWallFromFrames(frames(fact({ title: "Attention Required! | Cloudflare" }))), true);
  assert.equal(decideWallFromFrames(frames(fact({ assets: ["https://challenges.cloudflare.com/x.js"] }))), false);
  assert.equal(decideWallFromFrames(frames(fact({ title: "正常页面", assets: ["https://a.test/app.js"] }))), false);
  assert.equal(decideWallFromFrames(frames(fact({ assets: ["https://www.google.com/recaptcha/api.js"] }))), false);
});

test("标题正则吃的是标题，不吃正文", () => {
  /* 正文里"验证码"是日常词（登录框提示、帮助文案、页脚都会命中），所以注入体压根不取正文；
     这条钉住判据面：标题命中判、标题不命中就不判，与页面文字量无关 */
  assert.equal(decideWallFromFrames(frames(fact({ title: "登录 · 请输入短信验证码" }))), true, "标题里有验证码三个字就该判，这条测的不是正文");
  assert.equal(decideWallFromFrames(frames(fact({ title: "商品详情" }))), false);
});

test("顶层的 assets 不是数组时不当资产命中", () => {
  assert.equal(decideWallFromFrames(frames(fact({ assets: undefined }))), false);
  assert.equal(decideWallFromFrames(frames(fact({ assets: "https://challenges.cloudflare.com/a" }))), false, "字符串走 some 会抛");
});

test("墙嵌在子框架里：顶层只剩空壳，这种页面以前检不到", () => {
  const r = frames(
    fact({ title: "" }),
    fact({ top: false, url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x", title: "Just a moment...", w: 1000, h: 700 })
  );
  assert.equal(decideWallFromFrames(r), true);
  /* 判别力守卫：按 A3 之前的读法（只读 results[0]，且要求它是布尔）这一组确实是 false */
  assert.equal(!!(r[0] && r[0].result === true), false, "这组数据顶层也在报警，用例就没有判别力了");
});

test("挂件尺寸的子框架不算墙：标题写着 Just a moment 也不算", () => {
  /* reCAPTCHA 复选框 304×78、Turnstile 300×65、hCaptcha 300×88、隐藏框架 0×0 */
  const sizes = [
    [304, 78],
    [300, 65],
    [300, 88],
    [0, 0],
    [WALL_FRAME_MIN_W, WALL_FRAME_MIN_H - 1],
    [WALL_FRAME_MIN_W - 1, 900]
  ];
  for (const [w, h] of sizes) {
    assert.equal(
      decideWallFromFrames(frames(fact({ top: false }), fact({ top: false, title: "Just a moment...", w, h }))),
      false,
      `${w}x${h} 被当成了整页墙`
    );
  }
});

test("子框架过了尺寸关还不够：标题与自身网址都不许带挑战特征", () => {
  assert.equal(
    decideWallFromFrames(frames(fact({ top: false, title: "商品评价", url: "https://reviews.test/w", w: 800, h: 600 }))),
    false
  );
});

test("自身网址是挑战域名的子框架：标题为空也算墙", () => {
  /* 挑战页的 iframe 常常连标题都不设，这时候自身网址是唯一线索。
     这条钉的是 url 那一支——上一轮对照实跑发现把它写死成空串整套用例照样绿 */
  assert.equal(
    decideWallFromFrames(
      frames(fact({ top: false }), fact({ top: false, title: "", url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x", w: 900, h: 650 }))
    ),
    true,
    "自身网址没参与判定"
  );
  /* 判别力守卫：同尺寸同空标题、网址换成普通嵌入页，必须是 false */
  assert.equal(
    decideWallFromFrames(frames(fact({ top: false }), fact({ top: false, title: "", url: "https://partner.test/pay", w: 900, h: 650 }))),
    false
  );
  /* 尺寸没过地板时网址也不许单独定墙 */
  assert.equal(
    decideWallFromFrames(frames(fact({ top: false, title: "", url: "https://challenges.cloudflare.com/x", w: 300, h: 65 }))),
    false
  );
});

test("尺寸地板的边界值本身：正好 400×250 算整页", () => {
  assert.equal(
    decideWallFromFrames(frames(fact({ top: false }), fact({ top: false, title: "人机验证", w: WALL_FRAME_MIN_W, h: WALL_FRAME_MIN_H }))),
    true
  );
  assert.ok(WALL_FRAME_MIN_W > 304 && WALL_FRAME_MIN_H > 88, "地板掉进常见挂件尺寸里了");
});

test("判定链对脏数据免疫：条目缺失、result 非对象、入参非数组", () => {
  const dirty = [{}, { frameId: 1, result: null }, { frameId: 2, result: true }, { frameId: 3, result: "wall" }, fact()];
  assert.equal(decideWallFromFrames(dirty.map((r) => ({ frameId: 9, result: r }))), false);
  assert.equal(decideWallFromFrames([{ frameId: 0, result: fact({ title: "安全验证" }) }]), true);
  assert.equal(decideWallFromFrames(null), false);
  assert.equal(decideWallFromFrames("challenges.cloudflare.com"), false);
});

/* ---------- 3) 注入体真实源码，以及两层接缝 ---------- */

test("空跑守卫：确实从 background.js 切到了 captchaProbe", () => {
  assert.ok(PROBE_SRC.length > 120, "切出来的源码过短，等于什么都没测");
  assert.match(PROBE_SRC, /^function captchaProbe\(\)/);
});

test("注入体必须自包含：不得调用任何模块作用域的函数", () => {
  const shared = new Set([...Object.keys(LOGIC), ...Object.keys(CONFIG)]);
  const called = new Set(
    [...PROBE_SRC.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  );
  const leaked = [...called].filter((n) => shared.has(n));
  assert.deepEqual(leaked, [], "注入体调用了模块作用域的函数，页面里会是 undefined");
});

test("注入体只回事实，一个判断都不下", () => {
  const got = runCaptchaProbe({ title: "Just a moment...", srcs: ["https://challenges.cloudflare.com/a.js"] });
  assert.deepEqual(Object.keys(got).sort(), ["assets", "h", "title", "top", "url", "w"]);
  assert.equal(got.top, true);
  assert.equal(got.title, "Just a moment...");
  assert.deepEqual(got.assets, ["https://challenges.cloudflare.com/a.js"]);
  /* 正则一个都不下页面：函数体里不该出现任何墙特征字面量，否则判据就有两份会分叉。
     扫的是花括号之间那段而不是整份源码——函数名 captchaProbe 自己就含 captcha */
  assert.ok(!/captcha|cloudflare|recaptcha|hcaptcha|人机验证|安全验证|just a moment/i.test(PROBE_BODY), "注入体又开始自己判定了");
});

test("注入体不读正文，标题之外的文字一概不回", () => {
  assert.ok(!/innerText|textContent|innerHTML|body/i.test(PROBE_BODY), "读正文会把日常词判成墙，误判不自愈");
});

test("注入体的回传有上界：资产条数逐条长度都收着", () => {
  const many = Array.from({ length: 200 }, (_, i) => `https://cdn.test/${i}.js`);
  const got = runCaptchaProbe({ srcs: many });
  assert.ok(got.assets.length > 0 && got.assets.length <= 50, `资产条数没收口（${got.assets.length} 条）`);
  const long = runCaptchaProbe({ srcs: ["https://a.test/" + "x".repeat(5000)], href: "https://a.test/" + "y".repeat(5000) });
  assert.ok(long.assets[0].length <= 300, "资产网址没截断");
  assert.ok(long.url.length <= 300, "自身网址没截断");
  const deep = runCaptchaProbe({ title: "z".repeat(5000) });
  assert.ok(deep.title.length <= 300, "标题没截断");
});

test("端到端接缝：真跑注入体 + 真判定，A3 要救的那种页面确实被救到", () => {
  const results = [
    { frameId: 0, result: runCaptchaProbe({ title: "" }) },
    {
      frameId: 1,
      result: runCaptchaProbe({
        top: false,
        title: "请完成安全验证",
        href: "https://challenges.cloudflare.com/cdn-cgi/l/chlqa",
        w: 1000,
        h: 700
      })
    }
  ];
  assert.equal(decideWallFromFrames(results), true);
  /* 顶层挂着挑战域名的脚本只是依赖，不可单独把页面定成墙。 */
  assert.equal(
    decideWallFromFrames([
      { frameId: 0, result: runCaptchaProbe({ title: "页面加载失败", srcs: ["https://challenges.cloudflare.com/a.js"] }) }
    ]),
    false,
    "挑战脚本被当成页面状态，正常页会被误暂停"
  );
  /* 正常页面带评价 iframe（同尺寸、标题正常、非挑战域名）不许被带下水 */
  assert.equal(
    decideWallFromFrames([
      { frameId: 0, result: runCaptchaProbe({ title: "商品详情" }) },
      { frameId: 1, result: runCaptchaProbe({ top: false, title: "用户评价", href: "https://reviews.test/embed", w: 1000, h: 700 }) }
    ]),
    false
  );
  /* 挂件尺寸的子框架：注入体回的内宽内高就是挂件尺寸，正好落在地板之下 */
  assert.equal(
    decideWallFromFrames([
      { frameId: 0, result: runCaptchaProbe({ title: "登录" }) },
      { frameId: 1, result: runCaptchaProbe({ top: false, title: "reCAPTCHA", w: 304, h: 78 }) }
    ]),
    false
  );
  /* 注入体那侧丢掉 url 字段也会被这条抓到：空标题的子框架只剩自身网址一个线索 */
  assert.equal(
    decideWallFromFrames([
      { frameId: 0, result: runCaptchaProbe({ title: "请稍候" }) },
      {
        frameId: 1,
        result: runCaptchaProbe({
          top: false,
          title: "",
          href: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x",
          w: 900,
          h: 650
        })
      }
    ]),
    true,
    "注入体没把自身网址带回来"
  );
});

test("顶层与子框架的区分靠 window.top 同一性比较", () => {
  assert.equal(runCaptchaProbe({ top: true }).top, true);
  assert.equal(runCaptchaProbe({ top: false }).top, false);
});

/* ---------- 4) 执行器接线 ---------- */

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);

async function boot({ tasks, settings } = {}) {
  const env = makeEnv();
  env.store.local.tasks = tasks || {};
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false, captchaGuard: true },
    settings
  );
  env.putTab(7, PAGE);
  await bootBackground(env);
  return env;
}

/* startDetectChain 是 `void` 起的，onUpdated 处理器不等它，所以断言前要让宏任务跑完 */
const flush = () => new Promise((r) => setTimeout(r, 50));

/* 按调用形状识别是哪一路注入：带 args 是关键词，带 func 无 args 是验证墙，带 files 是保活 */
const kind = (o) => (o.args ? "keyword" : o.func ? "wall" : o.files ? "keepalive" : "other");

test("关键词与验证墙两处注入都是 allFrames", async () => {
  const env = await boot({ tasks: { 7: task({ keywords: ["A"] }) } });
  env.onScript((opts) =>
    opts.args
      ? [{ result: [] }]
      : opts.func
        ? [{ result: runCaptchaProbe({ title: "正常页面" }) }]
        : undefined
  );
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  const by = {};
  for (const c of env.calls.executeScript) by[kind(c)] = c;
  assert.ok(by.keyword, "没跑关键词注入");
  assert.ok(by.wall, "没跑验证墙注入");
  assert.equal(by.keyword.allFrames, true, "关键词注入只看顶层框架");
  assert.equal(by.wall.allFrames, true, "验证墙注入只看顶层框架");
  assert.equal(by.keyword.frameIds, undefined, "allFrames 与 frameIds 同时给了，真实 Chrome 会整次拒");
});

test("命中只在子框架：整条链照样落地", async () => {
  /* A3 的正题。旧读法只取 results[0]，顶层那份是空数组，于是这轮等于什么都没检到 */
  const env = await boot({ tasks: { 7: task({ keywords: ["A"] }) } });
  env.onScript((opts) =>
    opts.args
      ? [
          { frameId: 0, result: [] },
          { frameId: 1, result: ["A"] }
        ]
      : [{ result: runCaptchaProbe({ title: "正常页面" }) }]
  );
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.ok(
    env.calls.notifCreated.some(([id]) => id.startsWith("keyword-hit")),
    "子框架里的命中丢了"
  );
  assert.equal(env.store.local.tasks[7], undefined);
});

test("墙只在子框架：连续三次加载后自动暂停", async () => {
  /* 顶层只剩一个空壳标题的挑战页：旧读法（results[0].result === true）永远拿到 false，
     验证墙这道守卫对这类页面形同虚设 */
  const env = await boot({ tasks: { 7: task() } });
  env.onScript((opts) =>
    opts.func && !opts.args
      ? [
          { frameId: 0, result: runCaptchaProbe({ title: "" }) },
          {
            frameId: 1,
            result: runCaptchaProbe({
              top: false,
              title: "Just a moment...",
              href: "https://challenges.cloudflare.com/cdn-cgi/l/chlqa",
              w: 1000,
              h: 700
            })
          }
        ]
      : undefined
  );
  for (let i = 0; i < 3; i++) {
    await env.fire.tabUpdated(7, { status: "complete" });
    await flush();
  }
  assert.equal(env.store.local.tasks[7].autoPaused.reason, "captcha", "子框架里的墙没被认出来");
  assert.ok(env.calls.notifCreated.some(([id]) => id.startsWith("task-paused")));
});

test("保活脚本注入没被顺手扩到全部框架", async () => {
  /* A3 的范围是两条检测链。心跳脚本注进每个子框架是另一件事：会把同一份心跳在子框架里
     再跑一遍，向对方服务器放大请求量，而且子框架的 document.hidden 语义完全不同 */
  const env = await boot({ tasks: { 7: task() }, settings: { keepAlive: true } });
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  const ka = env.calls.executeScript.filter((o) => o.files);
  assert.ok(ka.length > 0, "这一轮没注入保活脚本，用例是空跑");
  for (const c of ka) {
    assert.equal(c.allFrames, undefined, "心跳脚本被注进了子框架");
    assert.equal(c.frameIds, undefined);
  }
});

test("allFrames 整次被拒：退回顶层再试一次，命中照样落地", async () => {
  /* 真实 Chrome 的失败方式是整次调用 reject（一个够不着的沙箱框架就能带走整页结果），
     所以退回单框架重试。A3 不许把原来能成的场景换成新的失败 */
  const env = await boot({ tasks: { 7: task({ keywords: ["已售罄"] }) } });
  env.onScript((opts) => {
    if (opts.allFrames) throw new Error("Cannot access frame");
    return opts.args
      ? [{ result: ["已售罄"] }]
      : [{ result: runCaptchaProbe({ title: "正常页面" }) }];
  });
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  const kw = env.calls.executeScript.filter((o) => kind(o) === "keyword");
  assert.ok(
    kw.some((o) => o.allFrames === true) && kw.some((o) => !o.allFrames && o.frameIds && o.frameIds[0] === 0),
    "没有退回顶层重试那一次：" + JSON.stringify(kw)
  );
  assert.ok(
    env.calls.notifCreated.some(([id]) => id.startsWith("keyword-hit")),
    "回退之后命中丢了"
  );
  assert.equal(env.store.local.tasks[7], undefined, "命中后默认要停任务");
});

test("两次都注入不进去：不发通知也不停任务", async () => {
  const env = await boot({ tasks: { 7: task({ keywords: ["A"] }) } });
  env.onScript(() => {
    throw new Error("Cannot access frame");
  });
  await env.fire.tabUpdated(7, { status: "complete" });
  await flush();
  assert.deepEqual(env.calls.notifCreated.map(([id]) => id), []);
  assert.ok(env.store.local.tasks[7], "注入失败被当成了命中");
  const kw = env.calls.executeScript.filter((o) => kind(o) === "keyword");
  assert.equal(kw.length, 2, "首轮就该是两次（allFrames + 顶层回退），实际 " + kw.length);
});

/* 红→绿对照（做法见 alarm-gate.test.mjs 末尾：副本改在仓库外，仓库源码一个字不动）。
   2026-09-19 实跑，十处变异，每次只改副本里的一处：
     V="$(cygpath -w "$LOCALAPPDATA/node-tools/ctl-a3")"
     TAR_BG="$V/background.js" TAR_LOGIC="$V/shared/logic.js" \
       node --test tests/tab-auto-refresh/frame-scan.test.mjs

   下面每处的红名单都是跑出来的，不是推的：
     1  改前源码（HEAD 那版 background.js + logic.js）
        → 红「整个文件」：切片那步就抛"源码里找不到 captchaProbe()"，加载失败不是假绿
     2  executeInAllFrames 的 try 分支直接注顶层（等于没加 allFrames）
        → 红 2 条：「两处注入都是 allFrames」+「allFrames 整次被拒：退回顶层再试一次」
     3  关键词读法退回 results[0].result
        → 红 1 条：「命中只在子框架」
     4  验证墙读法退回 results[0].result === true
        → 红 1 条：「墙只在子框架：连续三次加载后自动暂停」
     5  aggregateFrameHits 不再区分"注入了没命中"与"一个框架都没取到"
        → 红 1 条：「一个框架都没取到才算注入失败」
     6  去掉子框架视口地板（sized 写死 true）
        → 红 3 条：「挂件尺寸的子框架不算墙」+「自身网址是挑战域名的子框架」+「端到端接缝」
     7  顶层分支丢掉挑战域名资产这条判据
        → 红 2 条：「顶层框架判据与 A3 之前逐条一致」+「端到端接缝」
     8  注入体的 top 写死 true
        → 红 2 条：「端到端接缝」+「顶层与子框架的区分」
     9  注入体回的资产键名漂移（assets → assetUrls）
        → 红 3 条：「注入体只回事实」+「注入体的回传有上界」+「端到端接缝」
        键名漂移是两层接缝独有的失败形状：纯函数那几条照样绿，只有真跑注入体的那条会红
     10 注入体不收子框架自身网址（url 恒为空串）
        → 红 1 条：「端到端接缝」

   第 10 处有个回头账要记着：它第一版跑出来是 exit=0 全绿。当时 url 那一支在整个测试面上
   一次也没被单独依赖过——所有子框架墙的样本都同时带了指纹标题，把注入体的 url 写死成空串
   没有一条用例会发现。补了「自身网址是挑战域名的子框架」（含两条判别力守卫：普通嵌入页同
   尺寸同空标题必须 false、尺寸没过地板时网址不许单独定墙）和接缝里那一段真跑注入体的
   url 样本之后才红。这就是"红名单必须跑出来"的理由：读代码看不出哪条判据其实没人吃。 */
