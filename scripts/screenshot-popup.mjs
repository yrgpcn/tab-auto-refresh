#!/usr/bin/env node
/* 用本机 Chrome 渲染 popup 截图：mock chrome API 后加载 popup.html，一次跑两张
   （主视图与微信直连开启后的那一行入口）。本机专用工具：依赖本机 Chrome 路径与 NODE_PATH，
   CI 不运行。playwright 用 createRequire 现找，不在仓库依赖里：
   $env:NODE_PATH=(npm root -g)
   node scripts/screenshot-popup.mjs

   这份 mock 是弹窗 chrome 用面的手抄副本，抄漏一面的表现不是报错而是"截图看着挺好、
   其实那一块根本没渲染"，所以弹窗每多读一块存储，下面 window.chrome 那一套就要跟着加。
   这条对齐由 tests/tab-auto-refresh/screenshot-mock.test.mjs 钉住，不是靠人记得。
   坑记在这里免得再踩：addInitScript 的第二个参数按 JSON 序列化，函数会被丢掉，
   因此整套 mock 写在回调体内、只把纯数据传进去。

   跑完会有一行 404 的 console 报错：那是 Chrome 自己向临时服务器要 /favicon.ico，
   插件目录里没有这个文件，与弹窗渲染无关。 */

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
mkdirSync(outDir, { recursive: true });
for (const scenario of SCENARIOS) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  page.on("pageerror", (err) => console.error(`${scenario.file} pageerror:`, err.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") console.error(`${scenario.file} console:`, entry.text());
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
  const outFile = join(outDir, scenario.file);
  await page.locator("body").screenshot({ path: outFile });
  console.log(`截图已保存：${outFile}（${scenario.caption}）`);
  await page.close();
}

server.close();
await browser.close();
