/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS } from "./shared/config.js";
import { DEFAULT_INTERVAL_SEC, clampInterval } from "./shared/logic.js";

const DEFAULT_SETTINGS = {
  bypassCache: true,
  skipDiscarded: false,
  lastIntervalSec: DEFAULT_INTERVAL_SEC
};

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

/* 偏好设置存 chrome.storage.sync 跨设备同步；旧版本留在 local 的设置自动迁移 */
async function getSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("settings"),
  ]);
  if (syncData.settings) {
    return Object.assign({}, DEFAULT_SETTINGS, syncData.settings);
  }
  if (localData.settings) {
    const migrated = Object.assign({}, DEFAULT_SETTINGS, localData.settings);
    await chrome.storage.sync.set({ settings: migrated });
    await chrome.storage.local.remove("settings");
    return migrated;
  }
  return Object.assign({}, DEFAULT_SETTINGS);
}

/* 全局暂停是本机状态，跟随任务一起存 chrome.storage.local */
async function isPausedAll() {
  const data = await chrome.storage.local.get("pausedAll");
  return !!data.pausedAll;
}

/* tasks 的读改写走同一队列，避免弹窗 / 右键菜单 / 定时器并发覆盖 */
let taskQueue = Promise.resolve();
function withTaskLock(fn) {
  const run = taskQueue.then(fn);
  taskQueue = run.then(() => {}, () => {});
  return run;
}

/* 为某个标签页开启定时刷新，返回实际生效的间隔秒数；开始新任务即解除全局暂停 */
function startTask(tabId, seconds) {
  const { seconds: safe } = clampInterval(seconds);
  return withTaskLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab ? tab.url : null;
    const tasks = await getTasks();
    tasks[tabId] = { intervalSec: safe, createdAt: Date.now(), url };
    await setTasks(tasks);
    await chrome.alarms.create(alarmName(tabId), { periodInMinutes: safe / 60 });
    await chrome.storage.local.set({ pausedAll: false });
    await updateBadge();
    await rememberLastInterval(safe);
    return safe;
  });
}

function stopTask(tabId) {
  return withTaskLock(async () => {
    const tasks = await getTasks();
    if (!tasks[tabId]) return;
    delete tasks[tabId];
    await setTasks(tasks);
    await chrome.alarms.clear(alarmName(tabId));
    await updateBadge();
  });
}

/* 快捷键没有显式间隔，复用最近一次手动任务的实际间隔 */
async function rememberLastInterval(seconds) {
  try {
    const settings = await getSettings();
    await chrome.storage.sync.set({
      settings: Object.assign({}, settings, { lastIntervalSec: seconds })
    });
  } catch (e) {
    /* 保存偏好失败不应阻止当前任务启动 */
  }
}

async function reloadTab(tabId) {
  const settings = await getSettings();
  /* 刷新前备份 cookie */
  await backupCookies(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: !!settings.bypassCache });
}

/* 备份指定标签页域名的 cookie */
async function backupCookies(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url) return;
    const url = new URL(tab.url);
    const domain = url.hostname;
    const cookies = await chrome.cookies.getAll({ domain });
    const backup = await chrome.storage.local.get("cookieBackup");
    const cookieBackup = backup.cookieBackup || {};
    cookieBackup[domain] = {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
      })),
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ cookieBackup });
  } catch (e) {
    console.warn("Cookie backup failed:", e);
  }
}

/* 恢复指定域名的 cookie */
async function restoreCookies(domain) {
  try {
    const backup = await chrome.storage.local.get("cookieBackup");
    const cookieBackup = backup.cookieBackup || {};
    const data = cookieBackup[domain];
    if (!data || !data.cookies) return false;
    for (const c of data.cookies) {
      await chrome.cookies.set({
        url: `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
      });
    }
    return true;
  } catch (e) {
    console.warn("Cookie restore failed:", e);
    return false;
  }
}

/* 工具栏角标 = 监控中的标签页数量；全局暂停时显示暂停符号 */
async function updateBadge() {
  const [tasks, paused] = await Promise.all([getTasks(), isPausedAll()]);
  const n = Object.keys(tasks).length;
  await chrome.action.setBadgeBackgroundColor({ color: paused ? "#6b7280" : "#2563eb" });
  await chrome.action.setBadgeText({
    text: paused && n > 0 ? "‖" : n > 0 ? String(n) : "",
  });
}

function notifyTaskStopped(tabId) {
  chrome.notifications.create("refresh-stopped-" + tabId, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: chrome.i18n.getMessage("notifTitle"),
    message: chrome.i18n.getMessage("notifStopped")
  });
}

/* 定时器触发：刷新对应标签页 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(PREFIX)) return;
  const tabId = Number(alarm.name.slice(PREFIX.length));
  const [tasks, paused] = await Promise.all([getTasks(), isPausedAll()]);
  if (!tasks[tabId]) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  if (paused) return; /* 暂停期间跳过，恢复后按原周期继续 */
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await stopTask(tabId);
    notifyTaskStopped(tabId);
    return;
  }
  const settings = await getSettings();
  if (settings.skipDiscarded && tab.discarded) return; /* 休眠标签页不唤醒 */
  try {
    await reloadTab(tabId);
  } catch (e) {
    /* 标签页已关闭或页面受限：清理任务并通知用户 */
    await stopTask(tabId);
    notifyTaskStopped(tabId);
  }
});

/* 标签页被关闭时：如果在任务列表中，自动重开 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tasks = await getTasks();
  const task = tasks[tabId];
  if (!task || !task.url) {
    await stopTask(tabId);
    return;
  }
  
  /* 自动重开标签页 */
  try {
    const newTab = await chrome.tabs.create({ url: task.url, active: false });
    /* 更新任务列表中的 tabId */
    delete tasks[tabId];
    tasks[newTab.id] = { ...task, createdAt: Date.now() };
    await setTasks(tasks);
    /* 重建 alarm */
    await chrome.alarms.clear(alarmName(tabId));
    await chrome.alarms.create(alarmName(newTab.id), { periodInMinutes: task.intervalSec / 60 });
    await updateBadge();
    console.log(`Auto-reopened tab ${tabId} as ${newTab.id}: ${task.url}`);
  } catch (e) {
    console.warn("Auto-reopen failed:", e);
    await stopTask(tabId);
  }
});

/* 启动/安装时清理已经失效的任务并恢复 cookie */
async function prune() {
  /* 等待标签页恢复完成，避免误判 */
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const tasks = await getTasks();
  
  /* 收集所有需要恢复的域名 */
  const domains = new Set();
  for (const key of Object.keys(tasks)) {
    const task = tasks[key];
    if (task.url) {
      try {
        const url = new URL(task.url);
        domains.add(url.hostname);
      } catch (e) {
        /* 忽略无效 URL */
      }
    }
  }
  
  /* 恢复 cookie */
  for (const domain of domains) {
    await restoreCookies(domain);
  }
  
  /* 清理无效任务 */
  for (const key of Object.keys(tasks)) {
    const tabId = Number(key);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) await stopTask(tabId);
  }
  await updateBadge();
}

chrome.runtime.onStartup.addListener(prune);
chrome.runtime.onInstalled.addListener(prune);

/* 标签页与网页上的右键菜单 */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "root",
      title: chrome.i18n.getMessage("menuRoot"),
      contexts: ["tab", "page"]
    });
    for (const p of PRESETS) {
      chrome.contextMenus.create({
        id: "start-" + p.seconds,
        parentId: "root",
        title: chrome.i18n.getMessage(p.key),
        contexts: ["tab", "page"]
      });
    }
    chrome.contextMenus.create({
      id: "stop",
      parentId: "root",
      title: chrome.i18n.getMessage("menuStop"),
      contexts: ["tab", "page"]
    });
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

/* 快捷键 Alt+Shift+R：开关当前标签页的定时刷新 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-refresh") return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== "number") return;
  const tasks = await getTasks();
  if (tasks[tab.id]) {
    await stopTask(tab.id);
  } else {
    const settings = await getSettings();
    await startTask(tab.id, settings.lastIntervalSec);
  }
});

/* 与弹窗通信 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "prune-now") {
        await prune();
        sendResponse({ ok: true });
      } else if (msg.type === "start") {
        const sec = await startTask(msg.tabId, msg.seconds);
        sendResponse({ ok: true, intervalSec: sec });
      } else if (msg.type === "stop") {
        await stopTask(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "reload-now") {
        await reloadTab(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "toggle-pause-all") {
        const paused = !(await isPausedAll());
        await chrome.storage.local.set({ pausedAll: paused });
        await updateBadge();
        sendResponse({ ok: true, pausedAll: paused });
      } else if (msg.type === "save-settings") {
        const settings = await getSettings();
        await chrome.storage.sync.set({
          settings: Object.assign({}, settings, msg.settings)
        });
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
