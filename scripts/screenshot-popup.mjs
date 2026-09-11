#!/usr/bin/env node
/* 用本机 Chrome 渲染 popup 截图：mock chrome API 后加载 popup.html。
   本机专用工具：依赖本机 Chrome 路径与 NODE_PATH，CI 不运行。
   Playwright 来自 Codex 捆绑依赖，运行示例：
   $env:NODE_PATH="C:\Users\yrgpc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
   node scripts/screenshot-popup.mjs
*/

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

function fakeFavicon(color) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='${color}'/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

const browser = await chromium.launch({ executablePath: chromePath });
const page = await browser.newPage({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 2,
});

page.on("pageerror", (err) => console.error("pageerror:", err.message));
page.on("console", (entry) => {
  if (entry.type() === "error") console.error("console:", entry.text());
});

await page.addInitScript((msgs) => {
  const now = Date.now();
  const settings = { bypassCache: true, skipDiscarded: false, cookieBackup: true, keepAlive: true, httpHeartbeat: true };
  const tasks = {
    1: { intervalSec: 300, createdAt: now - 61_000 },
    2: { intervalSec: 60, createdAt: now - 121_000 },
  };
  const tabs = {
    1: {
      id: 1,
      title: "GitHub: Let's build from here",
      url: "https://github.com/",
      favIconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%232563eb'/%3E%3C/svg%3E",
    },
    2: {
      id: 2,
      title: "MDN Web Docs",
      url: "https://developer.mozilla.org/zh-CN/",
      favIconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23059669'/%3E%3C/svg%3E",
    },
  };
  const alarm = (name, inMs) => ({ name, scheduledTime: now + inMs });
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
      sync: { get: async () => ({ settings }) },
      local: {
        get: async () => ({ tasks, pausedAll: false }),
        set: async () => {},
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      getAll: async () => [alarm("refresh-1", 183_000), alarm("refresh-2", 42_000)],
    },
    runtime: {
      sendMessage: (msg, cb) => setTimeout(() => cb({ ok: true, intervalSec: 300 }), 30),
    },
  };
}, messages);

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
const port = server.address().port;
const popupUrl = `http://127.0.0.1:${port}/popup.html`;
await page.goto(popupUrl);
await page.waitForSelector("#taskList li");
await page.waitForTimeout(400);

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "popup.png");
await page.locator("body").screenshot({ path: outFile });
console.log("截图已保存：", outFile);

server.close();
await browser.close();
