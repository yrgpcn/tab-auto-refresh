/* 标签页定时刷新 · Manifest V3 后台 service worker */
"use strict";

const PREFIX = "refresh-";

/* 预设间隔（秒），popup.js 中有一份对应文案列表 */
const PRESETS = [
  { label: "每 30 秒", seconds: 30 },
  { label: "每 1 分钟", seconds: 60 },
  { label: "每 2 分钟", seconds: 120 },
  { label: "每 5 分钟", seconds: 300 },
  { label: "每 10 分钟", seconds: 600 },
  { label: "每 30 分钟", seconds: 1800 },
  { label: "每 1 小时", seconds: 3600 }
];

function alarmName(tabId) {
  return PREFIX + tabId;
}

async function getTasks() {
  const data = await chrome.storage.local.get("tasks");
  return data.tasks || {};
}

async function setTasks(tasks) {
  await chrome.storage.local.set({ tasks });
}

async function getSettings() {
  const data = await chrome.storage.local.get("settings");
  return Object.assign({ bypassCache: true }, data.settings || {});
}

/* 为某个标签页开启定时刷新，返回实际生效的间隔秒数 */
async function startTask(tabId, seconds) {
  const safe = Math.max(30, Math.floor(Number(seconds) || 0) || 30);
  const tasks = await getTasks();
  tasks[tabId] = { intervalSec: safe, createdAt: Date.now() };
  await setTasks(tasks);
  await chrome.alarms.create(alarmName(tabId), { periodInMinutes: safe / 60 });
  await updateBadge();
  return safe;
}

async function stopTask(tabId) {
  const tasks = await getTasks();
  delete tasks[tabId];
  await setTasks(tasks);
  await chrome.alarms.clear(alarmName(tabId));
  await updateBadge();
}

async function reloadTab(tabId) {
  const settings = await getSettings();
  await chrome.tabs.reload(tabId, { bypassCache: !!settings.bypassCache });
}

/* 工具栏图标角标 = 当前定时刷新中的标签页数量 */
async function updateBadge() {
  const tasks = await getTasks();
  const n = Object.keys(tasks).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

/* 定时器触发：刷新对应标签页 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(PREFIX)) return;
  const tabId = Number(alarm.name.slice(PREFIX.length));
  const tasks = await getTasks();
  if (!tasks[tabId]) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  try {
    await reloadTab(tabId);
  } catch (e) {
    /* 标签页已关闭或页面受限，自动清理任务 */
    await stopTask(tabId);
  }
});

/* 标签页被关闭时同步清理任务 */
chrome.tabs.onRemoved.addListener((tabId) => {
  stopTask(tabId);
});

/* 启动/安装时清理已经失效的任务 */
async function prune() {
  const tasks = await getTasks();
  for (const key of Object.keys(tasks)) {
    const tabId = Number(key);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) await stopTask(tabId);
  }
  await updateBadge();
}

chrome.runtime.onStartup.addListener(prune);
chrome.runtime.onInstalled.addListener(prune);

/* 右键标签页的快捷菜单 */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "root", title: "标签页定时刷新", contexts: ["tab"] });
    for (const p of PRESETS) {
      chrome.contextMenus.create({
        id: "start-" + p.seconds,
        parentId: "root",
        title: p.label,
        contexts: ["tab"]
      });
    }
    chrome.contextMenus.create({ id: "stop", parentId: "root", title: "停止定时刷新", contexts: ["tab"] });
  });
}
chrome.runtime.onInstalled.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || typeof tab.id !== "number") return;
  const id = String(info.menuItemId);
  if (id === "stop") {
    await stopTask(tab.id);
  } else if (id.startsWith("start-")) {
    await startTask(tab.id, Number(id.slice("start-".length)));
  }
});

/* 与弹窗通信 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "start") {
        const sec = await startTask(msg.tabId, msg.seconds);
        sendResponse({ ok: true, intervalSec: sec });
      } else if (msg.type === "stop") {
        await stopTask(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "reload-now") {
        await reloadTab(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "save-settings") {
        await chrome.storage.local.set({ settings: msg.settings });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; /* 异步应答 */
});
