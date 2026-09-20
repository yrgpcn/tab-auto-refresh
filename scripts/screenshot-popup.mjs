#!/usr/bin/env node
/* 用本机 Chrome 渲染 popup 截图：mock chrome API 后加载 popup.html，一次跑两张
   （主视图与微信直连开启后的那一行入口）。本机专用工具：依赖本机 Chrome 路径与 NODE_PATH，
   CI 不运行。playwright 用 createRequire 现找，不在仓库依赖里：
   $env:NODE_PATH=(npm root -g)
   node scripts/screenshot-popup.mjs
   node scripts/screenshot-popup.mjs --measure

   这份 mock 是弹窗 chrome 用面的手抄副本，抄漏一面的表现不是报错而是"截图看着挺好、
   其实那一块根本没渲染"，所以弹窗每多读一块存储，下面 window.chrome 那一套就要跟着加。
   这条对齐由 tests/tab-auto-refresh/screenshot-mock.test.mjs 钉住，不是靠人记得。
   坑记在这里免得再踩：addInitScript 的第二个参数按 JSON 序列化，函数会被丢掉，
   因此整套 mock 写在回调体内、只把纯数据传进去。

   页面报错（pageerror 与 console error）一条都不许悄悄过去：一张"看着挺完整"的截图可以出自
   一个当场死掉的弹窗脚本。原先跑完固定有一行 404 —— Chrome 自己来要 /favicon.ico，而报错文本
   里不含网址、没法与真错分开判，所以临时服务器现在对它直接回 204；这样剩下的每一条 404 都是
   "该在而不在"，正是要红的那一类。

   --measure 只量高度、不写图：把弹窗按几个"多出一行"的形状各渲染一遍，量整页最深内容的
   底边落在哪，跟 Chrome 弹窗外框的 600px 上限比。撑破它的症状是"底部那几张卡片看不见"，
   CSS 里的 max-height 只挡住 body 自己，量不出真实深边，所以这一面此前只能靠人眼看图。
   这些数字只在"这一页真的建完了"的前提下有意义，所以它与上面那条报错判据是同一条通道的两半。 */

import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIP_RT_PREFIX } from "../tab-auto-refresh/shared/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(repoRoot, "tab-auto-refresh");
const outDir = join(repoRoot, "docs", "tab-auto-refresh");
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("未找到 playwright，请按脚本头部注释设置 NODE_PATH 后重试。");
  process.exit(1);
}

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const messages = JSON.parse(
  readFileSync(join(pluginDir, "_locales", "zh_CN", "messages.json"), "utf8"),
);

/* 与 popup.css 的 body width 一致，否则截图会被裁切 */
const VIEWPORT = { width: 400, height: 640 };

function svgDot(color) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='${color}'/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

const TABS = {
  1: {
    id: 1,
    title: "GitHub: Let's build from here",
    url: "https://github.com/dashboard",
    favIconUrl: svgDot("#2563eb"),
  },
  2: {
    id: 2,
    title: "MDN Web Docs",
    url: "https://developer.mozilla.org/zh-CN/docs/Web",
    favIconUrl: svgDot("#059669"),
  },
};

/* 弹窗按"当前标签页"回填任务的关键词、盯守与间隔，所以这一页下面既要把某个标签页交给
   tabs.query，也要按同一个 id 去场景数据里取期望值。两处各写一个数字的话，回填那一条
   断言会在"当前标签页没有任务"上空跑（populateTaskFields 早退，一个字都不填，而 populateTaskFields
   本来就该早退）——所以这个 id 只有一个来源。 */
const CURRENT_TAB_ID = 1;

/* 两张图各自的场景，全部是纯数据。键的形状跟着 DEFAULT_SETTINGS 与 tasks 的当前形状走：
   少给一个键不会报错，只会让那个开关在图上看起来是关的 */
const SCENARIOS = [
  {
    file: "popup.png",
    caption: "主视图：两条任务在跑，其中一行带着「上一次到点被跳过」的解释",
    settings: {
      bypassCache: true,
      skipDiscarded: false,
      cookieBackup: false,
      keepAlive: true,
      httpHeartbeat: true,
      skipOnActivity: true,
      keepAwake: false,
      captchaGuard: true,
      webhookUrl: "",
      notifyEvents: ["session-lost", "keyword", "task-stopped", "task-paused"],
      wechatEnabled: false,
      wechatAppId: "",
      wechatAppSecret: "",
      wechatOpenId: "",
      wechatTemplateId: "",
      lastIntervalSec: 300,
    },
    tasks: {
      1: {
        intervalSec: 300,
        createdAt: Date.now() - 61_000,
        url: TABS[1].url,
        keywords: ["Deployed", "Build failed"],
        onHit: "continue",
      },
      2: { intervalSec: 60, createdAt: Date.now() - 121_000, url: TABS[2].url },
    },
    /* 后台写、弹窗按会话态读（A12）：不给这一条，任务行上那句解释永远不出现 */
    skipTraces: { "rt:skip:2": { reason: "user-active", at: Date.now() - 8_000 } },
  },
  {
    file: "popup-wechat.png",
    caption: "微信直连开着：出现「配置…」入口与最近一次投递结果",
    settings: {
      bypassCache: true,
      skipDiscarded: false,
      cookieBackup: false,
      keepAlive: true,
      httpHeartbeat: true,
      skipOnActivity: true,
      keepAwake: false,
      captchaGuard: true,
      webhookUrl: "",
      notifyEvents: ["session-lost", "keyword"],
      wechatEnabled: true,
      wechatAppId: "wx1234567890abcdef",
      wechatAppSecret: "demo-secret",
      wechatOpenId: "o-1234567890abcdef",
      wechatTemplateId: "T-1234567890abcdef",
      lastIntervalSec: 300,
    },
    tasks: {
      1: { intervalSec: 300, createdAt: Date.now() - 61_000, url: TABS[1].url },
    },
    skipTraces: {},
    wechatLastResult: { ok: true, kind: "ok", event: "keyword", at: Date.now() - 90_000 },
  },
];

/* Chrome 给扩展弹窗的外框上限：800 宽 × 600 高。超出部分不是"页面变长"，是底部直接看不见
   （body 自己那条 max-height 只是把 body 的盒子夹在 600，孩子照样能从盒子底下漏出去） */
const POPUP_MAX_H = 600;

/* --measure 用的形状：在某个截图场景之上叠一小撮设置补丁，再按 id 点开二级视图。
   补丁走的是增量，合并进完整场景之后才要求齐备，所以它不进那条"每个场景给全
   DEFAULT_SETTINGS 的键"的门禁——那条只扫 SCENARIOS 那一段（测试文件里注明了为什么） */
const PROBES = [
  { name: "主视图：两张任务，其中一行带跳过解释", shot: "popup.png" },
  {
    name: "主视图 + webhook 填了合法地址（状态行与测试按钮出现）",
    shot: "popup.png",
    patch: { webhookUrl: "https://ntfy.sh/demo-topic" },
  },
  {
    name: "主视图 + webhook 地址非法（只有红字那一行，测试按钮藏掉）",
    shot: "popup.png",
    patch: { webhookUrl: "localhost:8080/hook" },
  },
  { name: "主视图 + 微信直连开着（概览行出现）", shot: "popup-wechat.png" },
  {
    name: "主视图 + 微信概览行与 webhook 状态行同时出现（两条状态行都在）",
    shot: "popup-wechat.png",
    patch: { webhookUrl: "https://ntfy.sh/demo-topic" },
  },
  {
    name: "微信二级视图：四项凭据 + 模板示范",
    shot: "popup-wechat.png",
    open: "wechatSetupBtn",
  },
  {
    /* 原先只能靠人眼看图的那一格（V1 h）：长站点名会不会把某一行挤成两行。标题那一格是
       nowrap + ellipsis，多长的名字都只截断；能换行的只有 `task-sub`（间隔 + 倒计时 + 跳过解释），
       所以这一格要的是"两张都塞满长名字"之下各行仍一行、整页仍在 600px 内。
       标题必须长到真的溢出（下面那条截断见证判的就是这件事）：夹具文字没超出可用宽度时，
       "没挤换行"是白说的——2026-09-20 第一版用 23/32 字，把 `.task-title` 的 nowrap 删掉照样零红，
       因为那两个长度在 400px 里本来就放得下。删掉 nowrap 这一对照现在会红（见门禁文件末尾） */
    name: "主视图 + 两行都是长中文站点名（只截断，不许挤行）",
    shot: "popup.png",
    tabsPatch: {
      1: {
        title: "深圳市住房公积金管理中心业务经办与贷款合同查询服务平台在线办理大厅个人信息维护",
        url: "https://www.example.gov.cn/zmcw/service/grzx/loan-records-and-contract-query",
      },
      2: {
        title: "中华人民共和国人力资源和社会保障部政务服务平台个人社保权益记录单打印与参保证明开具",
        url: "https://si.example.gov.cn/12333/portal/personal/rights-record-statement",
      },
    },
  },
];

/* 截图场景是量高度的底座：补丁只改少数几个键，其余取值（任务数、跳过痕迹、微信最近结果）
   连同"给全 DEFAULT_SETTINGS"那条门禁一起继承过来。
   挑探针时别按"显示的行数最多"去挑：实测"两条状态行都在"那一种比"只有 webhook 状态行"矮 31
   像素（540 / 571），因为前者引用的场景底座只有一张任务、后者两张。整页高度先看底座 */
function scenarioFor(probe) {
  const base = SCENARIOS.find((s) => s.file === probe.shot);
  if (!base) throw new Error(`${probe.name} 引用了不存在的截图场景：${probe.shot}`);
  if (!probe.patch) return base;
  return Object.assign({}, base, { settings: Object.assign({}, base.settings, probe.patch) });
}

/* 标签页的补丁按 id 逐格合并（不是整份替换）：任务表里的 tabId 与告警名都写死成 1 与 2，
   换掉一整份会让某个任务找不到自己的标签页，那一行就退回"失效"样式，量到的高度是别的形状 */
function tabsFor(probe) {
  if (!probe.tabsPatch) return TABS;
  const out = Object.assign({}, TABS);
  for (const [id, patch] of Object.entries(probe.tabsPatch)) {
    if (!out[id]) throw new Error(`${probe.name} 补了一个场景里不存在的标签页：${id}`);
    out[id] = Object.assign({}, out[id], patch);
  }
  return out;
}

/* 回填、跳过解释与"某一行有没有被挤成两行"三本账。期望值只从场景数据与 DOM 自己的
   选项列表推：抄一份第二期望值进来，就成了"夹具对夹具"而不是"界面对数据"。
   压制 chip 的那两种情形（全局暂停、任务 autoPaused）不在这里复制判据——
   popup 的 skipEntry 由 tests/tab-auto-refresh/skip-trace.test.mjs 直接切源码跑，
   这里的场景两种都不出现，所以"有痕迹就可见、没痕迹就藏着"在场景内是充分的 */
function domFactProblems(label, scenario, dom, probe) {
  const out = [];
  const at = (what) => `${label} · ${what}`;
  const task = scenario.tasks[CURRENT_TAB_ID];
  if (!task) return [at(`场景里没有标签页 ${CURRENT_TAB_ID} 的任务，回填断言没有期望值可对`)];

  const keywords = task.keywords ?? (task.keyword ? [task.keyword] : []);
  if (dom.keyword !== keywords.join(",")) {
    out.push(at(`关键词框是 "${dom.keyword}"，任务里记的是 "${keywords.join(",")}"`));
  }
  if (dom.keepWatching !== (task.onHit === "continue")) {
    out.push(at(`"命中后继续盯守"是 ${dom.keepWatching}，任务的 onHit 是 ${task.onHit ?? "（停任务）"}`));
  }
  const sec = String(task.intervalSec);
  if (!dom.presetValues.length) return out.concat(at("预设下拉一个选项都没读到，间隔那一条无从判断"));
  const isPreset = dom.presetValues.includes(sec);
  const wantPreset = isPreset ? sec : "";
  const wantCustom = isPreset ? "" : sec;
  if (dom.preset !== wantPreset || dom.custom !== wantCustom) {
    out.push(at(`间隔是 预设="${dom.preset}" 自定义="${dom.custom}"，应当是 预设="${wantPreset}" 自定义="${wantCustom}"`));
  }

  const traces = scenario.skipTraces || {};
  if (dom.chips.length !== Object.keys(scenario.tasks).length) {
    out.push(at(`chip 节点 ${dom.chips.length} 个而任务 ${Object.keys(scenario.tasks).length} 条，一行都没有的 chip 说明节点没挂上`));
  }
  /* 时刻的形状只按"数字:数字"认，不写字面的 16:38：本机与 CI 的 locale 与时区不同，
     12 小时制那边是 "4:38 PM"。这条判的是 A12 那个决定的两半——正文短、时刻只住在悬停里 */
  const CLOCK = /\d{1,2}:\d{2}/;
  for (const chip of dom.chips) {
    const traced = Boolean(traces[`${SKIP_RT_PREFIX}:${chip.tab}`]);
    const suppressed = Boolean(scenario.tasks[chip.tab] && scenario.tasks[chip.tab].autoPaused);
    if (traced && !suppressed) {
      if (chip.hidden || !chip.text) out.push(at(`标签页 ${chip.tab} 有跳过痕迹却没显示解释（hidden=${chip.hidden} 正文="${chip.text}"）`));
      if (CLOCK.test(chip.text)) out.push(at(`标签页 ${chip.tab} 的正文里出现了时刻（"${chip.text}"），时刻按设计只住在悬停里`));
      if (!CLOCK.test(chip.title)) out.push(at(`标签页 ${chip.tab} 的悬停提示没有时刻（title="${chip.title}"），正文与提示的分工是"理由在正文、时刻在提示"`));
    } else if (!chip.hidden && chip.text) {
      out.push(at(`标签页 ${chip.tab} 没有跳过痕迹却显示着 "${chip.text}"`));
    }
  }

  if (dom.rows.length < 2) return out.concat(at(`只扫到 ${dom.rows.length} 条任务行文字，扫描是空转`));
  /* 单行判据只管 `.task-title`：那一格是 CSS 钉死的 nowrap，出了第二行就是那行 CSS 坏了。
     `.task-sub` 反过来——它本来就会换行，README 那张图里"上次跳过：你在 / 操作"已经是两行
     （2026-09-20 实测），因为列表封顶 108px 会滚，多出来的行高不撑破整页。所以 sub 的行数
     只报数字不判红，撑不撑破版面归上面那条 600px 判据 */
  for (const row of dom.rows) {
    if (row.sel === ".task-title" && row.lines > 1) {
      out.push(at(`${row.sel} "${row.text}" 被挤成 ${row.lines} 行（那一格靠 nowrap 只截断，出第二行等于这行 CSS 没了）`));
    }
  }
  /* 只验"截断之后不出第二行"还不够：夹具文字若根本没超出可用宽度，上面那条循环就是空跑。
     哪个形状改了标签页标题，哪个形状就是在验溢出，于是它必须真出现一条被截断的标题——
     这条不满足时红的是"截断那一本账是空跑"，不是"界面坏了"，两种红点名的话不一样。
     （overflow 用 clientWidth 比，二级视图那一趟整块 display:none，rows 一条矩形都没有，
     所以只在这个形状自己画出标题时才要求） */
  if (probe && probe.tabsPatch) {
    const titles = dom.rows.filter((r) => r.sel === ".task-title" && r.lines > 0);
    if (!titles.some((r) => r.clipped)) {
      out.push(at("这一格改长标题就是为了验溢出，可两条标题都没超出可用宽度（截断那一本账是空跑）"));
    }
  }
  return out;
}

/* Chrome 禁止 file:// 页面加载 ES module，改用临时本地服务器 */
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  /* Chrome 每次加载页面都自己来要 /favicon.ico，插件目录里没有这个文件。下面那套
     "页面报错就判红"的通道分不清这条噪音与真错，而 console error 的文本里又不含网址
     （实测只有 "Failed to load resource: ... 404"），没法按内容放过它——所以直接回 204：
     浏览器对 No Content 不产生 console 报错，其余任何 404 就都是"这个资源真的该在而不在" */
  if (urlPath === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const filePath = join(pluginDir, urlPath);
  if (!filePath.startsWith(pluginDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const popupUrl = `http://127.0.0.1:${server.address().port}/popup.html`;

const browser = await chromium.launch({ executablePath: chromePath });
const MEASURE = process.argv.includes("--measure");
if (!MEASURE) mkdirSync(outDir, { recursive: true });
let worst = 0;
let over = 0;
/* 页面里抛出来的错一个都不许悄悄过去：一张"看着挺完整"的截图可以出自一个当场死掉的脚本
   （$() 取不到控件就是这种），量到的高度同样能落在限内。攒着不立即退出，是为了让
   后面的形状也各跑各的、一次把账报全 */
const pageErrors = [];
/* DOM 事实不符与页面报错同权重：量到的高度在限内，不代表那三个控件真被填上、
   那行解释真带着悬停时刻 */
const factProblems = [];
for (const probe of MEASURE ? PROBES : SCENARIOS) {
  const scenario = MEASURE ? scenarioFor(probe) : probe;
  const tabSet = MEASURE ? tabsFor(probe) : TABS;
  const label = MEASURE ? probe.name : scenario.file;
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  page.on("pageerror", (err) => {
    pageErrors.push(`${label} pageerror: ${err.message}`);
    console.error(pageErrors[pageErrors.length - 1]);
  });
  page.on("console", (entry) => {
    if (entry.type() !== "error") return;
    pageErrors.push(`${label} console: ${entry.text()}`);
    console.error(pageErrors[pageErrors.length - 1]);
  });
  await page.addInitScript(({ scenario, tabs, currentTabId, msgs }) => {
    /* 真 Chrome 的 get 只回你问的那些键，mock 照做：整份返回会让"读了哪个键"这类改坏查不出来 */
    const pick = (dict, keys) => {
      const out = {};
      const want =
        keys == null
          ? Object.keys(dict)
          : Array.isArray(keys)
            ? keys
            : typeof keys === "object"
              ? Object.keys(keys)
              : [keys];
      for (const k of want) if (k in dict) out[k] = dict[k];
      return out;
    };
    const drop = (dict, keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete dict[k];
    };
    const local = Object.assign({ tasks: scenario.tasks, pausedAll: false },
      scenario.wechatLastResult ? { wechatLastResult: scenario.wechatLastResult } : {});
    const session = Object.assign({}, scenario.skipTraces);
    const alarm = (name, inMs) => ({ name, scheduledTime: Date.now() + inMs });
    window.chrome = {
      i18n: {
        getUILanguage: () => "zh-CN",
        getMessage(key, subs) {
          const entry = msgs[key];
          if (!entry) return key;
          let text = entry.message;
          if (entry.placeholders && subs) {
            text = text.replace(/\$(\w+)\$/g, (raw, name) => {
              /* Chrome 的 i18n 占位符不区分大小写，mock 保持一致 */
              const ph = entry.placeholders[name.toLowerCase()];
              if (!ph) return raw;
              const index = Number(String(ph.content).replace(/\D/g, "")) - 1;
              return subs[index] != null ? subs[index] : raw;
            });
          }
          return text;
        },
      },
      tabs: {
        query: async () => [tabs[currentTabId]],
        get: async (id) => tabs[id] || null,
        update: async () => {},
      },
      windows: { update: async () => {} },
      storage: {
        sync: {
          get: async (keys) => pick({ settings: scenario.settings }, keys),
          set: async (items) => Object.assign(scenario.settings, items),
        },
        local: {
          get: async (keys) => pick(local, keys),
          set: async (items) => Object.assign(local, items),
          remove: async (keys) => drop(local, keys),
        },
        session: {
          get: async (keys) => pick(session, keys),
          set: async (items) => Object.assign(session, items),
          remove: async (keys) => drop(session, keys),
        },
        onChanged: { addListener: () => {} },
      },
      alarms: {
        getAll: async () => [alarm("refresh-1", 183_000), alarm("refresh-2", 42_000)],
      },
      runtime: {
        /* 弹窗按 type 分发，回错形状不报错、只是那一块静默不显示 */
        sendMessage: (msg, cb) => {
          const res =
            msg && msg.type === "start" ? { ok: true, intervalSec: msg.seconds } : { ok: true };
          setTimeout(() => cb(res), 30);
        },
      },
    };
  }, { scenario, tabs: tabSet, currentTabId: CURRENT_TAB_ID, msgs: messages });
  await page.goto(popupUrl);
  await page.waitForSelector("#taskList li");
  /* 倒计时每秒重绘一次，等一下让那行数字与"被跳过"的解释落位 */
  await page.waitForTimeout(1200);
  if (probe.open) await page.click(`#${probe.open}`);
  if (MEASURE) {
    /* 量的是"最深的一条底边"而不是 body 的高度：body 被自己的 max-height 夹在 600，
       内容从盒子底下漏出去时它一个字都不报，只有孩子的矩形看得见。
       rect 是布局盒、不被视口裁剪，所以这个数字跟 VIEWPORT.height 给多少没关系（同一份内容
       在视口 600 与 640 下都报 640），别以为把视口压到 600 就量不到溢出 */
    const m = await page.evaluate((max) => {
      let deep = { b: 0, t: "body" };
      for (const el of document.body.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom > deep.b) deep = { b: r.bottom, t: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") };
      }
      const de = document.documentElement;
      const byId = (id) => document.getElementById(id);
      const preset = byId("presetSelect");
      const rows = [];
      /* 按行数的正确量法是 Range 的行矩形，不是元素的 getClientRects()：后者给的是"盒碎片"，
         一个 div 内部换成三行它也只报一个矩形（2026-09-20 实测：把 .task-title 的 nowrap 删掉
         照样零红，就是栽在这里）。Range 选内容才按行给矩形，同一行的几块顶边相同，按 2px 聚一次
         ——字高不同的行顶边会差一两像素，不聚就报出假的多行 */
      const lineCount = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const tops = [];
        for (const q of r.getClientRects()) {
          if (q.width <= 0) continue;
          if (!tops.some((t) => Math.abs(t - q.top) <= 2)) tops.push(q.top);
        }
        return tops.length;
      };
      for (const sel of [".task-title", ".task-sub"]) {
        for (const el of document.querySelectorAll(sel)) {
          rows.push({
            sel,
            lines: lineCount(el),
            /* scrollWidth 与 clientWidth 都是整数：不裁剪时两者相等，裁剪时至少差几像素。
               留 2px 余量再判，免得四舍五入把"刚好放得下"读成"被截断" */
            clipped: el.scrollWidth > el.clientWidth + 2,
            overPx: el.scrollWidth - el.clientWidth,
            text: el.textContent.slice(0, 18),
          });
        }
      }
      return {
        deepest: Math.round(deep.b),
        tag: deep.t,
        bodyH: Math.round(document.body.getBoundingClientRect().height),
        bodyMax: getComputedStyle(document.body).maxHeight,
        docScroll: de.scrollHeight,
        view: de.clientHeight,
        over: deep.b > max,
        /* 截图只证明"看起来填上了"，量不出框里那个值是不是这条任务的实际值；chip 那句
           的悬停时刻更是一个字节都拍不出来。所以同一趟渲染里把 DOM 的真实取值读回去判 */
        dom: {
          keyword: byId("keywordInput") ? byId("keywordInput").value : null,
          keepWatching: byId("keepWatchingCheck") ? byId("keepWatchingCheck").checked : null,
          preset: preset ? preset.value : null,
          presetValues: preset ? [...preset.options].map((o) => o.value) : [],
          custom: byId("customInput") ? byId("customInput").value : null,
          chips: [...document.querySelectorAll(".skip[data-tab]")].map((n) => ({
            tab: n.dataset.tab,
            hidden: n.hidden,
            text: n.textContent,
            title: n.title,
          })),
          rows,
        },
      };
    }, POPUP_MAX_H);
    worst = Math.max(worst, m.deepest);
    if (m.over) over++;
    console.log(
      `${m.over ? "✖" : "✔"} ${label}\t最深底边 ${m.deepest}px / 上限 ${POPUP_MAX_H}px` +
        `\t最狠的是 ${m.tag}\tbody ${m.bodyH}px（max ${m.bodyMax}）\tdoc ${m.docScroll}px 视口 ${m.view}px`
    );
    const problems = domFactProblems(label, scenario, m.dom, probe);
    factProblems.push(...problems);
    const d = m.dom;
    const shown = d.chips.filter((c) => !c.hidden && c.text);
    /* 二级视图那一趟任务行整块是 display:none，矩形一个都没有（lines 是 0），
       所以"最多几行"只在真渲染出来的那些行里取，别看 0 以为是空表 */
    const drawn = d.rows.filter((r) => r.lines > 0);
    const maxLines = (sel) => Math.max(0, ...drawn.filter((r) => r.sel === sel).map((r) => r.lines));
    console.log(
      `   └ 回填 关键词="${d.keyword}" 盯守=${d.keepWatching} 间隔=${d.preset || d.custom}` +
        `\t跳过解释 ${shown.length} 条可见${shown.length ? `（正文="${shown[0].text}"，悬停="${shown[0].title}"）` : ""}` +
        `\t标题 ${drawn.filter((r) => r.sel === ".task-title").length} 条（最多 ${maxLines(".task-title")} 行，` +
        `截断 ${drawn.filter((r) => r.sel === ".task-title" && r.clipped).length} 条，最宽超出 ${Math.max(0, ...d.rows.filter((r) => r.sel === ".task-title").map((r) => r.overPx))}px）` +
        `\t说明行最多 ${maxLines(".task-sub")} 行` +
        `${problems.length ? `\t✖ ${problems.length} 条不符（详见下面清单）` : ""}`
    );
    await page.close();
    continue;
  }
  const outFile = join(outDir, scenario.file);
  await page.locator("body").screenshot({ path: outFile });
  console.log(`截图已保存：${outFile}（${scenario.caption}）`);
  await page.close();
}

server.close();
await browser.close();
if (MEASURE) {
  console.log(
    over
      ? `✖ ${over} / ${PROBES.length} 个形状撑破了 ${POPUP_MAX_H}px（最深 ${worst}px）`
      : `✔ ${PROBES.length} 个形状都在 ${POPUP_MAX_H}px 内（最深 ${worst}px）`
  );
  if (over) process.exitCode = 1;
  if (factProblems.length) {
    console.error(`✖ ${factProblems.length} 条界面事实与场景数据不符：`);
    for (const p of factProblems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`✔ ${PROBES.length} 个形状的回填值、跳过解释与单行判据都对得上场景数据`);
  }
}
if (pageErrors.length) {
  console.error(`✖ ${pageErrors.length} 条页面报错，这次渲染不算数（详见上面每一条）`);
  process.exitCode = 1;
} else {
  console.log("✔ 页面零报错");
}
