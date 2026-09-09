/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS } from "./shared/config.js";
import { DEFAULT_INTERVAL_SEC, clampInterval } from "./shared/logic.js";

const DEFAULT_SETTINGS = {
  bypassCache: true,
  skipDiscarded: false,
  lastIntervalSec: DEFAULT_INTERVAL_SEC
};

/* cookie 备份按主机分键存储，避免多站点并发备份时互相覆盖 */
const COOKIE_BACKUP_PREFIX = "cookieBackup:";

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
    /* 开启任务时立即备份一次，避免首次刷新前关闭浏览器导致无备份可恢复 */
    await backupCookies(tabId);
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
  /* 刷新前备份 cookie，并把任务里记录的网址更新为最新地址 */
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: !!settings.bypassCache });
}

/* 主机的域链：nsgt.szns.gov.cn → szns.gov.cn → gov.cn；登录票据常种在父域 */
function domainChain(host) {
  const parts = host.split(".").filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list;
}

/* 备份该主机及全部父域的 cookie；按主机独立存储 */
async function backupCookies(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url) return;
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch (e) {
      return;
    }
    if (!host) return;
    const seen = new Map();
    for (const d of domainChain(host)) {
      let list = [];
      try {
        list = await chrome.cookies.getAll({ domain: d });
      } catch (e) {
        /* 单层查询失败（公共后缀等）不影响其余层 */
      }
      for (const c of list) {
        seen.set(c.domain + "|" + c.name + "|" + c.path, c);
      }
    }
    const cookies = [...seen.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate
    }));
    await chrome.storage.local.set({
      [COOKIE_BACKUP_PREFIX + host]: { cookies, timestamp: Date.now() }
    });
  } catch (e) {
    console.warn("Cookie backup failed:", e);
  }
}

/* 登录完成后地址通常离开登录页；保持任务里的网址最新，自动重开才会打开实际页面 */
function refreshTaskUrl(tabId) {
  return withTaskLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tasks = await getTasks();
    if (tab && tab.url && tasks[tabId] && tasks[tabId].url !== tab.url) {
      tasks[tabId] = Object.assign({}, tasks[tabId], { url: tab.url });
      await setTasks(tasks);
    }
  });
}

/* 恢复某个主机备份的 cookie；返回是否至少恢复成功一条 */
async function restoreCookies(host) {
  try {
    const key = COOKIE_BACKUP_PREFIX + host;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) return false;
    const nowSec = Date.now() / 1000;
    let restored = 0;
    for (const c of entry.cookies) {
      if (c.expirationDate && c.expirationDate < nowSec) continue; /* 已过期的跳过 */
      const url =
        (c.secure ? "https://" : "http://") +
        c.domain.replace(/^\./, "") + (c.path || "/");
      try {
        await chrome.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate || undefined
        });
        restored += 1;
      } catch (e) {
        /* 个别 cookie 不可写（公共后缀限制等）跳过 */
      }
    }
    return restored > 0;
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

/* 任务内页面加载完成即补备份：登录成功后不用等下一个刷新周期 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const tasks = await getTasks();
  if (!tasks[tabId]) return;
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
});

/* 标签页被关闭时：如果在任务列表中，自动重开 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = (await getTasks())[tabId];
  if (!task || !task.url) {
    await stopTask(tabId);
    return;
  }

  try {
    const newTab = await chrome.tabs.create({ url: task.url, active: false });
    await withTaskLock(async () => {
      const tasks = await getTasks();
      if (!tasks[tabId]) return; /* 任务已被其他方式清理 */
      delete tasks[tabId];
      tasks[newTab.id] = Object.assign({}, tasks[tabId], { createdAt: Date.now() });
      await setTasks(tasks);
      await chrome.alarms.clear(alarmName(tabId));
      await chrome.alarms.create(alarmName(newTab.id), {
        periodInMinutes: tasks[newTab.id].intervalSec / 60
      });
    });
    await updateBadge();
  } catch (e) {
    console.warn("Auto-reopen failed:", e);
    await stopTask(tabId);
  }
});

/* 清理标签页已不存在的任务（无延迟、无恢复动作，弹窗打开时即可调用） */
async function cleanupInvalidTasks() {
  const tasks = await getTasks();
  for (const key of Object.keys(tasks)) {
    const tabId = Number(key);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) await stopTask(tabId);
  }
  await updateBadge();
}

/* 浏览器启动/扩展安装时：恢复 cookie → 重载对应标签页 → 清理失效任务 */
async function prune() {
  /* 等待会话恢复的标签页完成加载：既要避免误判失效，也要保证恢复发生在其首次加载之后 */
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const tasks = await getTasks();

  /* 清理 v1.4.1 及之前“单一对象”格式的旧备份 */
  await chrome.storage.local.remove("cookieBackup");

  /* 按主机归组任务 */
  const hostTabs = new Map();
  for (const key of Object.keys(tasks)) {
    const task = tasks[key];
    if (!task.url) continue;
    let host;
    try {
      host = new URL(task.url).hostname;
    } catch (e) {
      continue;
    }
    if (!hostTabs.has(host)) hostTabs.set(host, []);
    hostTabs.get(host).push(Number(key));
  }

  /* 会话恢复的页面加载时还没有 cookie，恢复完成后主动重载一次，让登录态立即生效 */
  for (const [host, tabIds] of hostTabs) {
    if (!(await restoreCookies(host))) continue;
    for (const tabId of tabIds) {
      await chrome.tabs.reload(tabId).catch(() => {});
    }
  }

  await cleanupInvalidTasks();
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
        await cleanupInvalidTasks();
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
