/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS, DEFAULT_SETTINGS, HB_PREFIX } from "./shared/config.js";
import {
  RESTRICTED_URL,
  BACKUP_ACT,
  clampInterval,
  decideBackupWrite,
  domainChain,
  hostOf,
  jitteredDelayMs,
  keywordHit,
  looksLikeLoginPage,
  sameHost,
  sameSite,
  siteRoot,
  tabShowsUrl,
  SESSION_LOST_CONFIRM_SAMPLES,
  SESSION_LOST_NOTIFY_MS,
} from "./shared/logic.js";

/* cookie 备份按主机分键存储，避免多站点并发备份时互相覆盖 */
const COOKIE_BACKUP_PREFIX = "cookieBackup:";
/* 备份保留策略：超过最大条数按时间淘汰；任务全部停完后过期即清 */
const COOKIE_BACKUP_MAX_KEYS = 20;
const COOKIE_BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* 单站点备份的 cookie 条数上限，防止极端站点把存储越写越大 */
const MAX_COOKIES_PER_HOST = 200;
/* 会话探针状态（掉线行为信号）：根域 → {sus, lost, lastNotifiedAt} */
const PROBE_KEY = "sessionProbe";
/* 静默 HTTP 心跳周期（分钟）：只刷"按最后请求计时"的服务器端会话，不重载页面 */
const HEARTBEAT_MINUTES = 4;
/* 重启恢复时等待页面自行到位的窗口（学 tab-reloader：救"先 SSO 跳转才到位"的页面） */
const RECLAIM_WATCH_MS = 20000;
/* 备份失败（如触顶 storage 配额）只告警一次；落存储持久化，SW 重启不重置 */
const BACKUP_WARN_KEY = "cookieBa…dOnce";

function alarmName(tabId) {
  return PREFIX + tabId;
}
function hbName(tabId) {
  return HB_PREFIX + tabId;
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

/* ---- 掉线探测·行为通道（学 staying_alive 的"看服务器行为"路线） ----
   与备份层的"状态通道"（decideBackupWrite：会话票据从有到无）互补：本通道把
   任务页落在登录页 URL、HTTP 心跳被重定向到登录页 / 返回 401/403 计为疑似，
   连续 SESSION_LOST_CONFIRM_SAMPLES 次确认、一次正常即恢复（各自独立计数）。
   确认后：角标变红、系统通知（节流）、backupCookies 拒绝写坏备份。
   注意：本函数不经 withTaskLock——它会被已在锁内的 backupCookies 调用，锁不可重入；
   探针写入碰撞的最坏后果只是计数偏差 1，可接受。 ---- */
async function reportSessionSignal(root, host, suspect) {
  try {
    if (!root) return;
    const data = await chrome.storage.local.get(PROBE_KEY);
    const all = data[PROBE_KEY] || {};
    const p = all[root] || { sus: 0, lost: false, lastNotifiedAt: 0 };
    if (suspect) {
      p.sus = (p.sus || 0) + 1;
      if (p.sus >= SESSION_LOST_CONFIRM_SAMPLES) p.lost = true;
    } else {
      p.sus = 0;
      p.lost = false;
    }
    const now = Date.now();
    if (p.lost && now - (p.lastNotifiedAt || 0) >= SESSION_LOST_NOTIFY_MS) {
      p.lastNotifiedAt = now;
      all[root] = p;
      await chrome.storage.local.set({ [PROBE_KEY]: all });
      notifySessionLost(host);
    } else {
      all[root] = p;
      await chrome.storage.local.set({ [PROBE_KEY]: all });
    }
    await updateBadge();
  } catch (e) {
    /* 探针失败不影响主流程 */
  }
}
async function isProbeLost(url) {
  const root = siteRoot(hostOf(url));
  if (!root) return false;
  const data = await chrome.storage.local.get(PROBE_KEY);
  return !!(data[PROBE_KEY] && data[PROBE_KEY][root] && data[PROBE_KEY][root].lost);
}

/* 为某个标签页开启定时刷新，返回实际生效的间隔秒数；开始新任务即解除全局暂停 */
function startTask(tabId, seconds, keyword) {
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
    const kw = String(keyword == null ? "" : keyword).trim();
    const tasks = await getTasks();
    tasks[tabId] = { intervalSec: safe, createdAt: Date.now(), url };
    if (kw) tasks[tabId].keyword = kw.slice(0, 100);
    await setTasks(tasks);
    /* 开启任务时立即备份一次，避免首次刷新前关闭浏览器导致无备份可恢复 */
    await backupCookies(tabId);
    await armRefresh(tabId, safe);
    if ((await getSettings()).keepAlive) await keepAliveInject(tabId);
    await ensureHeartbeat(tabId);
    await chrome.storage.local.set({ pausedAll: false });
    await updateBadge();
    await rememberLastInterval(safe);
    return { safe };
  });
}

function stopTask(tabId) {
  return withTaskLock(async () => {
    const tasks = await getTasks();
    if (!tasks[tabId]) return;
    stopKeepAlive(tabId);
    delete tasks[tabId];
    await setTasks(tasks);
    await chrome.alarms.clear(alarmName(tabId));
    await chrome.alarms.clear(hbName(tabId));
    await pruneCookieBackups(tasks);
    await updateBadge();
  });
}

/* ---- 调度：一次性 when（带 ±15% 抖动）+ 周期 period 兜底的双保险模式
   （学 tab-reloader）：秒级精度靠 when，周期 alarm 只防漏；每次触发后重新 arm，
   抖动让多任务不再同拍齐刷，也更不像机器行为 ---- */
async function armRefresh(tabId, intervalSec) {
  const when = Date.now() + jitteredDelayMs(intervalSec);
  await chrome.alarms.create(alarmName(tabId), {
    when,
    periodInMinutes: Math.max(0.5, intervalSec / 60)
  });
}

/* 系统从睡眠唤醒后自愈（学 tab-reloader）：把所有已过期的任务 alarm 打散 0~1s 重建 */
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state !== "active") return;
  try {
    const now = Date.now();
    const alarms = await chrome.alarms.getAll();
    for (const a of alarms) {
      if (!a.scheduledTime || a.scheduledTime >= now) continue;
      if (a.name.startsWith(HB_PREFIX)) {
        await chrome.alarms.create(a.name, {
          when: now + Math.round(Math.random() * 1000),
          periodInMinutes: HEARTBEAT_MINUTES
        });
      } else if (a.name.startsWith(PREFIX)) {
        const tabId = Number(a.name.slice(PREFIX.length));
        const task = (await getTasks())[tabId];
        if (task) await armRefresh(tabId, task.intervalSec);
        else await chrome.alarms.clear(a.name);
      }
    }
  } catch (e) {
    console.warn("idle resync failed:", e);
  }
});

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

/* ---- 后台保活：默认开启的合成活动注入（对抗"按用户交互计时"的服务器端会话过期）
   注入是标签页级：startTask 即时注入 + tabs.onUpdated 对任务页每次加载完成补注入。
   不用 registerContentScripts：matches 是站点级会溢出到同站无关标签页，
   且站点注册 id 与任务 id 语义分裂，重启后停止任务清不掉注册。 ---- */
const KEEPALIVE_SCRIPT = "content/keepalive.js";

/* 向任务标签页注入心跳脚本；脚本守卫可重启，重复注入等价于重启心跳 */
async function keepAliveInject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [KEEPALIVE_SCRIPT] });
  } catch (e) {
    /* 受限页面 / 渲染上下文未就绪 / 缺站点权限 / API 异常：静默降级，绝不阻塞任务主流程 */
  }
}

/* 任务停止：通知页面内脚本自停（标签页级注入没有注册表需要清理） */
function stopKeepAlive(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "keepalive-off" }).catch(() => {});
}

/* ---- 静默 HTTP 心跳（学 staying_alive 的行为路线，救"按最后请求计时"的会话）：
   分钟级向监控地址发带 cookie 的 GET，不重载页面、不打扰用户；
   响应落登录页 / 401 / 403 → 疑似掉线信号，正常 2xx → 恢复信号 ---- */
async function ensureHeartbeat(tabId) {
  try {
    const [settings, tasks] = await Promise.all([getSettings(), getTasks()]);
    const task = tasks[tabId];
    if (!settings.httpHeartbeat || !task) {
      await chrome.alarms.clear(hbName(tabId));
      return;
    }
    await chrome.alarms.create(hbName(tabId), { periodInMinutes: HEARTBEAT_MINUTES });
  } catch (e) {
    /* 心跳开关或闹钟异常不阻塞任务 */
  }
}

async function doHeartbeat(tabId) {
  try {
    const task = (await getTasks())[tabId];
    if (!task || !(await getSettings()).httpHeartbeat) {
      await chrome.alarms.clear(hbName(tabId));
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(task.url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const root = siteRoot(hostOf(task.url));
    const landed = res.url || task.url;
    if (looksLikeLoginPage(landed) || res.status === 401 || res.status === 403) {
      await reportSessionSignal(root, hostOf(landed) || root, true);
    } else if (res.ok) {
      await reportSessionSignal(root, hostOf(landed) || root, false);
    }
    /* 其余状态码（5xx/网络错）是站点故障，不产生掉线信号 */
  } catch (e) {
    /* fetch 失败（无权限/离线/站点挂了）：无信号，静默 */
  }
}

/* 设置变化（含跨设备同步）、浏览器启动恢复后，按开关对存量任务页收敛心跳与保活 */
async function reconcileKeepAlive() {
  try {
    const [settings, tasks] = await Promise.all([getSettings(), getTasks()]);
    for (const tabId of Object.keys(tasks).map(Number)) {
      if (settings.keepAlive) await keepAliveInject(tabId);
      else stopKeepAlive(tabId);
      await ensureHeartbeat(tabId);
    }
  } catch (e) {
    console.warn("reconcile keep-alive failed:", e);
  }
}


/* 快捷键没有显式间隔，复用最近一次手动任务的实际间隔 */
async function rememberLastInterval(seconds) {
  try {
    const settings = await getSettings();
    if (settings.lastIntervalSec === seconds) return; /* 没变不写，避免无谓的 sync 变更风暴 */
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

/* 关键词命中检查（品类第二曲线：从"定时刷新"到"页面监控"）：
   任务页每次加载完成后在页面里取 innerText，命中 → 系统通知 + 停止任务 */
async function checkKeyword(tabId, keyword) {
  if (!keyword) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = document.body && document.body.innerText;
        return typeof t === "string" ? t.slice(0, 300000) : "";
      },
    });
    const text = results && results[0] && results[0].result;
    if (keywordHit(text, keyword)) {
      chrome.notifications
        .create("keyword-hit-" + tabId, {
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: chrome.i18n.getMessage("notifTitle"),
          message: chrome.i18n.getMessage("notifKeywordHit", [keyword])
        })
        .catch(() => {});
      await stopTask(tabId);
    }
  } catch (e) {
    /* 缺权限 / 渲染层未就绪 / 注入失败：下个刷新周期再试 */
  }
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
    const key = COOKIE_BACKUP_PREFIX + host;
    const now = Date.now();
    /* 会话探针已判定该根域掉线：行为证据强于状态采样，直接保护备份不被写坏 */
    if (await isProbeLost(task.url)) return;
    /* 掉线确认窗口（复审§2 修复）：疑似采样只累加计数（MERGE），绝不把坏样本
       写进 cookies——否则下一轮 prev 里没有会话票据，streak 恒被清零，
       确认窗口不可达且最后一次好备份在第 2 次采样就被污染。timestamp 保持
       最后有效备份时间，长期冻结的备份由 30 天 TTL 自然淘汰 */
    const prevEntry = (await chrome.storage.local.get(key))[key];
    const d = decideBackupWrite(prevEntry, cookies, now);
    if (d.action === BACKUP_ACT.FREEZE) {
      if (d.notify) {
        await chrome.storage.local.set({ [key]: Object.assign({}, prevEntry, d.entry) });
        notifySessionLost(host);
      }
      return;
    }
    if (d.action === BACKUP_ACT.MERGE) {
      await chrome.storage.local.set({ [key]: Object.assign({}, prevEntry, d.entry) });
      return;
    }
    await chrome.storage.local.set({
      [key]: { cookies, timestamp: now, schemaVersion: 2 }
    });
  } catch (e) {
    try {
      const flagged = (await chrome.storage.local.get(BACKUP_WARN_KEY))[BACKUP_WARN_KEY];
      if (!flagged) {
        await chrome.storage.local.set({ [BACKUP_WARN_KEY]: true });
        console.warn("Cookie backup failed (further failures are silent):", e);
      }
    } catch (e2) {
      /* 存储都写不了就只剩静默 */
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

/* 工具栏角标四态（学 tab-reloader 的集中切换）：
   掉线待重登 "!" 红 > 全局暂停 "‖" 灰 > 监控数量 蓝 > 无任务空 */
async function updateBadge() {
  try {
    const [tasks, paused, probeData] = await Promise.all([
      getTasks(),
      isPausedAll(),
      chrome.storage.local.get(PROBE_KEY),
    ]);
    const n = Object.keys(tasks).length;
    const probes = probeData[PROBE_KEY] || {};
    let anyLost = false;
    for (const t of Object.values(tasks)) {
      const root = siteRoot(hostOf(t.url));
      if (root && probes[root] && probes[root].lost) { anyLost = true; break; }
    }
    const color = anyLost ? "#dc2626" : paused ? "#6b7280" : "#2563eb";
    const text = anyLost ? "!" : paused && n > 0 ? "‖" : n > 0 ? String(n) : "";
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    /* 角标失败不影响任务 */
  }
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

/* 服务器端会话失效提醒：cookie 备份只能恢复票据，救不回已注销的会话 */
function notifySessionLost(host) {
  chrome.notifications
    .create("session-lost-" + host, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message: chrome.i18n.getMessage("notifSessionLost", [host])
    })
    .catch(() => {});
}

/* 定时器触发：刷新类 alarm 走刷新并重新 arm；心跳 alarm 走静默请求 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(HB_PREFIX)) {
    await doHeartbeat(Number(alarm.name.slice(HB_PREFIX.length)));
    return;
  }
  if (!alarm.name.startsWith(PREFIX)) return;
  const tabId = Number(alarm.name.slice(PREFIX.length));
  const [tasks, paused] = await Promise.all([getTasks(), isPausedAll()]);
  if (!tasks[tabId]) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  /* 每次触发重新 arm：重算抖动窗口（周期 alarm 只兜底，主循环节奏由重 arm 决定） */
  await armRefresh(tabId, tasks[tabId].intervalSec);
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

/* 任务内页面加载完成：补备份、跟随同站新址、掉线行为探测、关键词检查、保活补注入 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const ids = await ensureTaskTabIds();
  if (!ids.has(tabId)) return; /* 非监控标签页：零 storage 读写 */
  const tasks = await getTasks();
  const task = tasks[tabId];
  if (!task) return; /* 快照与存储有竞态时以存储为准 */
  /* 掉线行为信号：任务页最终落在登录页 URL = 服务器把你重定向去登录了；
     监控对象本身就是登录页时此信号不适用（永远命中会误报） */
  const cur = changeInfo.url || (await chrome.tabs.get(tabId).catch(() => null))?.url || "";
  const loginSuspect = looksLikeLoginPage(cur) && !looksLikeLoginPage(task.url);
  await reportSessionSignal(siteRoot(hostOf(task.url)), hostOf(task.url), loginSuspect);
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
  await checkKeyword(tabId, task.keyword);
  /* 保活注入点：每次加载完成补注入，覆盖刷新、页面内导航与会话恢复后的首载 */
  if ((await getSettings()).keepAlive) await keepAliveInject(tabId);
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
    stopKeepAlive(oldTabId);
    await chrome.alarms.clear(alarmName(oldTabId));
    await chrome.alarms.clear(hbName(oldTabId));
    await armRefresh(newTab.id, task.intervalSec);
    await ensureHeartbeat(newTab.id);
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

/* 延迟认领窗口（学 tab-reloader）：等 RECLAIM_WATCH_MS，期间任何标签页导航到
   目标网址即认领成功；救"会话恢复晚到 / 先跳 SSO 才到位"的页面，避免无谓重开 */
function watchForUrl(url, excludeIds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUp);
      resolve(null);
    }, RECLAIM_WATCH_MS);
    function onUp(tabId, changeInfo, tab) {
      if (changeInfo.status !== "complete") return;
      if (excludeIds.has(tabId)) return;
      if (tabShowsUrl(tab, url)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUp);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(onUp);
  });
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
    /* 待处理集合（复审§3.1 修复）：认领写入 tasks[match.id] 前必须确认该 id
       不再是别的未处理任务的键，否则两个任务撞同一页时后者被覆盖静默丢失 */
    const pending = new Set(Object.keys(tasks).map(Number));
    let dirty = false;
    for (const key of Object.keys(tasks)) {
      const task = tasks[key];
      const live = openById.get(Number(key));
      if (!live) continue;
      if (task.url) {
        if (tabShowsUrl(live, task.url)) {
          claimed.add(Number(key));
          pending.delete(Number(key));
        }
        continue;
      }
      if (adoptLegacyUrls && /^https?:/i.test(live.url || "")) {
        /* 扩展更新：浏览器没重启，ID 仍指向原页面，补记网址升级为正常任务 */
        tasks[key] = Object.assign({}, task, { url: live.url });
        claimed.add(Number(key));
        pending.delete(Number(key));
        dirty = true;
      }
      /* 浏览器重启：无从辨认目标，不认领，交由下方淘汰 */
    }
    for (const key of Object.keys(tasks)) {
      const tabId = Number(key);
      if (claimed.has(tabId)) continue;
      pending.delete(tabId);
      const task = tasks[tabId];
      /* 未认领的任务重映射时跳过已被其他任务认领 / 仍是其他未处理任务键的页面：
         同一网址开在多个标签页时，一个页面只会被一个任务挂接，认领不到的走下方重开 */
      let match =
        openTabs.find((t) => !claimed.has(t.id) && !pending.has(t.id) && tabShowsUrl(t, task.url)) || null;
      delete tasks[tabId];
      await chrome.alarms.clear(alarmName(tabId));
      await chrome.alarms.clear(hbName(tabId));
      if (match) {
        claimed.add(match.id);
        pending.delete(match.id);
        tasks[match.id] = Object.assign({}, task, { url: match.url || task.url });
        await armRefresh(match.id, task.intervalSec);
        await ensureHeartbeat(match.id);
        /* 会话恢复的页面是在 cookie 恢复前加载的，补一次刷新让登录态生效 */
        if (restoredRoots.has(siteRoot(hostOf(match.url || task.url)))) {
          chrome.tabs.reload(match.id).catch(() => {});
        }
      } else if (task.url && /^https?:/i.test(task.url)) {
        /* 先等 20 秒观察该 URL 是否会被其他页面导航到位，等不到再重开 */
        const watched = await watchForUrl(task.url, new Set(Object.keys(tasks).map(Number)));
        if (watched && typeof watched.id === "number" && !tasks[watched.id]) {
          claimed.add(watched.id);
          tasks[watched.id] = Object.assign({}, task, { url: watched.url || task.url });
          await armRefresh(watched.id, task.intervalSec);
          await ensureHeartbeat(watched.id);
        } else {
          const newTab = await chrome.tabs
            .create({ url: task.url, active: false })
            .catch(() => null);
          if (newTab && typeof newTab.id === "number") {
            tasks[newTab.id] = task;
            await armRefresh(newTab.id, task.intervalSec);
            await ensureHeartbeat(newTab.id);
          }
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
chrome.runtime.onStartup.addListener(async () => { await prune(false); await reconcileKeepAlive(); });
chrome.runtime.onInstalled.addListener(async () => { await prune(true); await reconcileKeepAlive(); });

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

/* 设置变化后按需收敛（复审§3.2）：只在保活/心跳开关真变化时跑，
   否则 rememberLastInterval 等无关写盘会引发全站任务页心跳重置风暴 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const o = changes.settings.oldValue || {};
  const n = changes.settings.newValue || {};
  if (o.keepAlive === n.keepAlive && o.httpHeartbeat === n.httpHeartbeat) return;
  reconcileKeepAlive();
});

/* 与弹窗通信 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "prune-now") {
        await cleanupInvalidTasks();
        sendResponse({ ok: true });
      } else if (msg.type === "start") {
        const r = await startTask(msg.tabId, msg.seconds, msg.keyword);
        sendResponse({ ok: true, intervalSec: r.safe });
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
