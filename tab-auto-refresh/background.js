/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS, DEFAULT_SETTINGS } from "./shared/config.js";
import {
  RESTRICTED_URL,
  clampInterval,
  domainChain,
  hostOf,
  sameHost,
  sameSite,
  siteRoot,
  tabShowsUrl,
} from "./shared/logic.js";

/* cookie 备份按主机分键存储，避免多站点并发备份时互相覆盖 */
const COOKIE_BACKUP_PREFIX = "cookieBackup:";
/* 备份保留策略：超过最大条数按时间淘汰；任务全部停完后过期即清 */
const COOKIE_BACKUP_MAX_KEYS = 20;
const COOKIE_BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* 单站点备份的 cookie 条数上限，防止极端站点把存储越写越大 */
const MAX_COOKIES_PER_HOST = 200;
/* 备份失败（如触顶 storage 配额）只告警一次，避免每次刷新都刷日志 */
let cookieBackupWarned = false;

function alarmName(tabId) {
  return PREFIX + tabId;
}

async function getTasks() {
  const data = await chrome.storage.local.get("tasks");
  return data.tasks || {};
}

async function setTasks(tasks) {
  syncTaskTabIds(tasks);
  await chrome.storage.local.set({ tasks });
}

/* 内存中的监控 tabId 快照：全局 tabs 事件先查它，避免每次加载完成都读 storage */
let taskTabIdSet = null;
function syncTaskTabIds(tasks) {
  taskTabIdSet = new Set(Object.keys(tasks).map(Number));
}
async function ensureTaskTabIds() {
  if (!taskTabIdSet) {
    const tasks = await getTasks();
    syncTaskTabIds(tasks);
  }
  return taskTabIdSet;
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
    /* 拿不到标签页或网址时不建任务，否则站点锁定与自动重开都无从依据 */
    if (!tab || !tab.url) {
      throw new Error(chrome.i18n.getMessage("errTabGone") || "Tab unavailable");
    }
    if (RESTRICTED_URL.test(tab.url)) {
      throw new Error(chrome.i18n.getMessage("errRestricted") || "Browser internal pages cannot be auto-refreshed");
    }
    const url = tab.url;
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
    await pruneCookieBackups(tasks);
    await updateBadge();
  });
}

/* 备份清理三条件：站点不再被任何任务使用 / 超过 TTL / 超过站点数上限（按时间留新）；
   备份功能关闭时不留死数据，清空全部备份 */
async function pruneCookieBackups(remainingTasks) {
  if (!(await getSettings()).cookieBackup) {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(COOKIE_BACKUP_PREFIX));
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    return;
  }
  const roots = new Set();
  for (const t of Object.values(remainingTasks || {})) {
    const r = siteRoot(hostOf(t.url));
    if (r) roots.add(r);
  }
  /* storage.get 不支持通配符，必须全量读取再按前缀过滤 */
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const fresh = [];
  const stale = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(COOKIE_BACKUP_PREFIX)) continue;
    const root = siteRoot(key.slice(COOKIE_BACKUP_PREFIX.length));
    const ts = value && typeof value.timestamp === "number" ? value.timestamp : 0;
    if (!root || !roots.has(root) || now - ts > COOKIE_BACKUP_TTL_MS) stale.push(key);
    else fresh.push({ key, ts });
  }
  fresh.sort((a, b) => b.ts - a.ts);
  for (const e of fresh.slice(COOKIE_BACKUP_MAX_KEYS)) stale.push(e.key);
  if (stale.length > 0) await chrome.storage.local.remove(stale);
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
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const task = (await getTasks())[tabId];
  const target = task && task.url;
  const tabHost = hostOf(tab && tab.url);
  const targetHost = hostOf(target);
  /* 标签页跳到完全不同的站点（误开外链）：本次刷新导航回监控目标，而非刷新误开页面 */
  if (tabHost && targetHost && !sameSite(tabHost, targetHost)) {
    await chrome.tabs.update(tabId, { url: target });
    return;
  }
  /* 同站内（含子域登录跳转）正常备份、跟随同站新址并刷新 */
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: !!settings.bypassCache });
}

/* 备份该主机及全部父域的 cookie；按主机独立存储；仅在与监控目标同根域且开关开启时执行 */
async function backupCookies(tabId) {
  try {
    if (!(await getSettings()).cookieBackup) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url) return;
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch (e) {
      return;
    }
    if (!host) return;
    /* 只备份与监控目标同根域的站点：外链漂移时不把无关站点的登录态写进备份 */
    const tasks = await getTasks();
    const task = tasks[tabId];
    if (!task || !sameSite(host, hostOf(task.url))) return;
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
      expirationDate: c.expirationDate,
      hostOnly: c.hostOnly
    }));
    if (cookies.length > MAX_COOKIES_PER_HOST) cookies.length = MAX_COOKIES_PER_HOST;
    await chrome.storage.local.set({
      [COOKIE_BACKUP_PREFIX + host]: { cookies, timestamp: Date.now(), schemaVersion: 2 }
    });
  } catch (e) {
    if (!cookieBackupWarned) {
      cookieBackupWarned = true;
      console.warn("Cookie backup failed (further failures are silent):", e);
    }
  }
}

/* 登录完成后地址通常离开登录页；保持任务里的网址最新，自动重开才会打开实际页面 */
function refreshTaskUrl(tabId) {
  return withTaskLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tasks = await getTasks();
    const t = tasks[tabId];
    if (!tab || !tab.url || !t || !t.url) return;
    /* 仅在同站时跟随更新目标网址，跨站漂移不覆盖，保留原始监控对象以便自动返回 */
    if (t.url !== tab.url && sameHost(hostOf(tab.url), hostOf(t.url))) {
      tasks[tabId] = Object.assign({}, t, { url: tab.url });
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
        String(c.domain || "").replace(/^\./, "") + (c.path || "/");
      const base = {
        url,
        name: c.name,
        value: c.value,
        path: c.path || "/",
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate || undefined
      };
      /* hostOnly === true：主机专属 cookie，省略 domain 让 Chrome 从 url 推导
         （带 domain 写入会失败或扩大作用域，__Host- 票据尤其致命）；
         === false：域 cookie 按备份的 domain 写入；
         缺失（v1 旧备份）：无法判定主机/域，保持旧行为统一传 domain，
         至少比直接丢弃更接近升级前的表现 */
      try {
        if (c.hostOnly === true) {
          await chrome.cookies.set(base);
        } else {
          await chrome.cookies.set(Object.assign({ domain: c.domain }, base));
        }
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
  chrome.notifications
    .create("refresh-stopped-" + tabId, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message: chrome.i18n.getMessage("notifStopped")
    })
    .catch(() => {}); /* 系统通知被关闭时不影响任务清理流程 */
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
  const ids = await ensureTaskTabIds();
  if (!ids.has(tabId)) return; /* 非监控标签页：零 storage 读写 */
  const tasks = await getTasks();
  if (!tasks[tabId]) return; /* 快照与存储有竞态时以存储为准 */
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
});

/* 按任务记录的网址重新打开标签页并重映射任务与定时器；返回是否成功 */
function reopenTaskTab(oldTabId) {
  return withTaskLock(async () => {
    const tasks = await getTasks();
    const task = tasks[oldTabId];
    if (!task || !task.url) return false;
    const newTab = await chrome.tabs
      .create({ url: task.url, active: false })
      .catch(() => null);
    if (!newTab || typeof newTab.id !== "number") return false;
    delete tasks[oldTabId];
    tasks[newTab.id] = task;
    await setTasks(tasks);
    await chrome.alarms.clear(alarmName(oldTabId));
    await chrome.alarms.create(alarmName(newTab.id), {
      periodInMinutes: task.intervalSec / 60
    });
    await updateBadge();
    return true;
  });
}

/* 标签页被关闭：窗口整体关闭（含退出浏览器）时不处理，避免关闭竞态，由启动恢复兜底 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (removeInfo && removeInfo.isWindowClosing) return;
  reopenTaskTab(tabId);
});

/* 清理标签页已不存在的任务（弹窗打开时调用） */
async function cleanupInvalidTasks() {
  const tasks = await getTasks();
  for (const key of Object.keys(tasks)) {
    const tabId = Number(key);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) await stopTask(tabId);
  }
  await updateBadge();
}

/* 浏览器启动/扩展安装时：恢复 cookie → 任务重新挂接到会话恢复的标签页 → 失效任务兜底重开
   adoptLegacyUrls：仅扩展安装/更新时为真，此时浏览器未重启、tabId 仍有效，可为 v1.4.3
   及更早（任务里只有间隔与创建时间、没有网址）的旧任务补记当前标签页网址；
   浏览器重启后 tabId 已重新分配，旧 ID 会撞上无关标签页，无法辨认目标只能淘汰 */
async function prune(adoptLegacyUrls = false) {
  /* 等待会话恢复的标签页出现，避免误判失效或重复打开 */
  await new Promise((resolve) => setTimeout(resolve, 1500));

  /* 清理 v1.4.1 及之前“单一对象”格式的旧备份 */
  await chrome.storage.local.remove("cookieBackup");

  const settings = await getSettings();

  /* 按注册域恢复所有备份主机（含 SSO 登录所在的兄弟子域），不再只按任务网址的精确主机；
     开关关闭时跳过，pruneCookieBackups 会在下方锁内清掉遗留备份 */
  const initial = await getTasks();
  const taskRoots = new Set();
  for (const task of Object.values(initial)) {
    const r = siteRoot(hostOf(task.url));
    if (r) taskRoots.add(r);
  }
  const restoredRoots = new Set();
  if (settings.cookieBackup) {
    const all = await chrome.storage.local.get(null);
    for (const key of Object.keys(all)) {
      if (!key.startsWith(COOKIE_BACKUP_PREFIX)) continue;
      const host = key.slice(COOKIE_BACKUP_PREFIX.length);
      const root = siteRoot(host);
      if (!root || !taskRoots.has(root)) continue;
      if (await restoreCookies(host)) restoredRoots.add(root);
    }
  }

  /* 把死 tabId 的任务重新挂接到正在打开的标签页（会话恢复后 ID 会变），挂接不上就重新打开 */
  await withTaskLock(async () => {
    const tasks = await getTasks();
    const openTabs = await chrome.tabs.query({});
    const openById = new Map(openTabs.map((t) => [t.id, t]));
    /* 预扫描认领：ID 仍被占用不代表挂接正确（重启后 tabId 会重新分配，旧任务 ID
       可能撞上无关的新标签页），只有网址一致才保留；无网址的旧任务按
       adoptLegacyUrls 决定补记网址（扩展更新，tabId 仍有效）还是淘汰（浏览器重启） */
    const claimed = new Set();
    let dirty = false;
    for (const key of Object.keys(tasks)) {
      const task = tasks[key];
      const live = openById.get(Number(key));
      if (!live) continue;
      if (task.url) {
        if (tabShowsUrl(live, task.url)) claimed.add(Number(key));
        continue;
      }
      if (adoptLegacyUrls && /^https?:/i.test(live.url || "")) {
        /* 扩展更新：浏览器没重启，ID 仍指向原页面，补记网址升级为正常任务 */
        tasks[key] = Object.assign({}, task, { url: live.url });
        claimed.add(Number(key));
        dirty = true;
      }
      /* 浏览器重启：无从辨认目标，不认领，交由下方淘汰 */
    }
    for (const key of Object.keys(tasks)) {
      const tabId = Number(key);
      const task = tasks[key];
      if (claimed.has(tabId)) continue;
      /* 未认领的任务重映射时跳过已被其他任务认领的页面：同一网址开在多个
         标签页时，一个页面只会被一个任务挂接，认领不到的走下方重开 */
      const match =
        openTabs.find((t) => !claimed.has(t.id) && tabShowsUrl(t, task.url)) || null;
      delete tasks[tabId];
      await chrome.alarms.clear(alarmName(tabId));
      if (match) {
        claimed.add(match.id);
        tasks[match.id] = Object.assign({}, task, { url: match.url || task.url });
        await chrome.alarms.create(alarmName(match.id), {
          periodInMinutes: task.intervalSec / 60
        });
        /* 会话恢复的页面是在 cookie 恢复前加载的，补一次刷新让登录态生效 */
        if (restoredRoots.has(siteRoot(hostOf(match.url || task.url)))) {
          chrome.tabs.reload(match.id).catch(() => {});
        }
      } else if (task.url && /^https?:/i.test(task.url)) {
        const newTab = await chrome.tabs
          .create({ url: task.url, active: false })
          .catch(() => null);
        if (newTab && typeof newTab.id === "number") {
          tasks[newTab.id] = task;
          await chrome.alarms.create(alarmName(newTab.id), {
            periodInMinutes: task.intervalSec / 60
          });
        }
      } else if (!task.url) {
        /* 浏览器重启后的旧格式任务：目标页面无从辨认，只能淘汰 */
        console.warn("Dropped legacy task without url:", tabId);
      }
      dirty = true;
    }
    if (dirty) await setTasks(tasks);
    /* 启动时统一淘汰：v1.4.5 前遗留的多余备份、过期备份、超量备份 */
    await pruneCookieBackups(tasks);
  });

  await updateBadge();
}

/* 显式传参而非直接 addListener(prune)：onInstalled 会把事件详情对象作为首个实参传入，
   会被 adoptLegacyUrls 误判为真值 */
chrome.runtime.onStartup.addListener(() => prune(false));
chrome.runtime.onInstalled.addListener(() => prune(true));

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
  try {
    if (id === "stop") {
      await stopTask(tab.id);
    } else if (id.startsWith("start-")) {
      await startTask(tab.id, Number(id.slice("start-".length)));
    }
  } catch (e) {
    /* 菜单路径无弹窗承接错误，失败仅记录 */
    console.warn("Context menu action failed:", e);
  }
});

/* 快捷键 Alt+Shift+R：开关当前标签页的定时刷新 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-refresh") return;
  try {
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
  } catch (e) {
    console.warn("Command toggle-refresh failed:", e);
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
