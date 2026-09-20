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
for (const probe of MEASURE ? PROBES : SCENARIOS) {
  const scenario = MEASURE ? scenarioFor(probe) : probe;
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
  await page.addInitScript(({ scenario, tabs, msgs }) => {
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
        query: async () => [tabs[1]],
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
  }, { scenario, tabs: TABS, msgs: messages });
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
      return {
        deepest: Math.round(deep.b),
        tag: deep.t,
        bodyH: Math.round(document.body.getBoundingClientRect().height),
        bodyMax: getComputedStyle(document.body).maxHeight,
        docScroll: de.scrollHeight,
        view: de.clientHeight,
        over: deep.b > max,
      };
    }, POPUP_MAX_H);
    worst = Math.max(worst, m.deepest);
    if (m.over) over++;
    console.log(
      `${m.over ? "✖" : "✔"} ${label}\t最深底边 ${m.deepest}px / 上限 ${POPUP_MAX_H}px` +
        `\t最狠的是 ${m.tag}\tbody ${m.bodyH}px（max ${m.bodyMax}）\tdoc ${m.docScroll}px 视口 ${m.view}px`
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
}
if (pageErrors.length) {
  console.error(`✖ ${pageErrors.length} 条页面报错，这次渲染不算数（详见上面每一条）`);
  process.exitCode = 1;
} else {
  console.log("✔ 页面零报错");
}
