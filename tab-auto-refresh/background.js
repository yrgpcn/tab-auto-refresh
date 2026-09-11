/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS, DEFAULT_SETTINGS, HB_PREFIX } from "./shared/config.js";
import {
  RESTRICTED_URL,
  applyBackupAction,
  clampInterval,
  domainChain,
  hostOf,
  isErrorStatus,
  jitteredDelayMs,
  getTaskKeywords,
  keywordHit,
  normalizeWebhookUrl,
  parseKeywords,
  pickHits,
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
const BACKUP_WARN_KEY = "cookieBackupWarnedOnce";

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
    const stamp = () => (p.sus || 0) + "|" + (p.lost ? 1 : 0) + "|" + (p.lastNotifiedAt || 0);
    const before = stamp();
    let notify = false;
    const now = Date.now();
    if (suspect) {
      /* 已确认掉线后不再累加 sus：lost 已锁死，计数只会无上限增长 */
      if (!p.lost) {
        p.sus = (p.sus || 0) + 1;
        if (p.sus >= SESSION_LOST_CONFIRM_SAMPLES) p.lost = true;
      }
      if (p.lost && now - (p.lastNotifiedAt || 0) >= SESSION_LOST_NOTIFY_MS) {
        p.lastNotifiedAt = now;
        notify = true;
      }
    } else {
      p.lastNotifiedAt = 0; /* 恢复=新故障周期起点：否则 6h 内二次独立掉线不再通知（05 §3.2） */
      p.sus = 0;
      p.lost = false;
    }
    /* 值没变就不写盘、不刷角标（04 复审 §4.2）：30 秒任务的每次页面加载都会打到这里 */
    if (stamp() !== before) {
      all[root] = p;
      await chrome.storage.local.set({ [PROBE_KEY]: all });
      await updateBadge();
    }
    if (notify) await notifySessionLost(host);
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
function startTask(tabId, seconds, keyword, keepWatching) {
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
    /* 多关键词（功能3）：keywords[] + onHit；旧任务读侧经 getTaskKeywords 兼容单串 */
    const kws = parseKeywords(keyword);
    const tasks = await getTasks();
    tasks[tabId] = { intervalSec: safe, createdAt: Date.now(), url };
    if (kws.length) {
      tasks[tabId].keywords = kws;
      if (keepWatching) tasks[tabId].onHit = "continue";
    }
    await setTasks(tasks);
    /* 开启任务时立即备份一次，避免首次刷新前关闭浏览器导致无备份可恢复 */
    await backupCookies(tabId);
    await armRefresh(tabId, safe);
    await syncKeepAliveConfig(tabId);
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
    detectChains.delete(tabId); /* 终止该页在飞的关键词检测链 */
    /* 运行时状态一并清（会话态）：真假人活动时间戳与错误/验证墙连击都归属该标签页 */
    await rt(() =>
      chrome.storage.session.remove([
        rtTab(RT_ACTIVITY, tabId),
        rtTab(RT_ERROR, tabId),
        rtTab(RT_CAPTCHA, tabId),
      ])
    );
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

/* 系统从睡眠唤醒后自愈（学 tab-reloader）：过期刷新 alarm 重走完整周期+抖动，
   过期心跳 alarm 打散 0~60 秒重建（与 ensureHeartbeat 的随机相位同一节奏） */
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state !== "active") return;
  try {
    const now = Date.now();
    const alarms = await chrome.alarms.getAll();
    for (const a of alarms) {
      if (!a.scheduledTime || a.scheduledTime >= now) continue;
      if (a.name.startsWith(HB_PREFIX)) {
        await chrome.alarms.create(a.name, {
          when: now + Math.round(Math.random() * 60000),
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
/* 错误页/验证墙确认与交互跳过的参数（06 §4.3 / §4.5 吸收项） */
const PAUSE_CONFIRM_SAMPLES = 2;
const ACTIVITY_SKIP_MS = 60000;

/* ---- 跨 SW 实例的运行时状态（chrome.storage.session）----
   Chrome 官方：MV3 的 service worker「闲置 30 秒即终止（收事件或调扩展 API 会重置计时器）」，
   且明确要求「为意外终止做好准备：持久化状态」。下面三种状态的两端间隔都是分钟级，
   放在内存变量里必然被清零——本批首版就是内存 Map，实测三个功能全废：
     ① 异常连击（error/captcha）：心跳 4 分钟一次、验证墙随刷新周期探一次，
        两次采样落在两个 SW 实例 → 计数每次从 0 起，"连续 2 次才暂停"退化成永不暂停
        （与复审 §2 的 sessionLostStreak 同类缺陷；那次是靠把计数写进备份条目修的）；
     ② 真人活动时间戳：SW 一回收即丢 → 60 秒跳过窗口失效；
     ③ keepAwake 持锁标记：回收后误判"未持锁" → 关开关时不再 release，系统一直不睡。
   chrome.storage.session 的语义正好：跨 SW 回收存活、随浏览器会话结束清空（与 power
   请求的真实生命周期一致），不落磁盘、不需要新权限（storage 已声明）。
   验证脚本：`_code-review/verify-sw-restart-state.mjs`（用二次 import 模拟 SW 重启，
   同一场景对修复前/后两份源码各跑一次）。 */
const RT_ACTIVITY = "rt:activity";
const RT_ERROR = "rt:error";
const RT_CAPTCHA = "rt:captcha";
const RT_AWAKE = "rt:awake";
const rtTab = (base, tabId) => base + ":" + tabId;

/* 读写走独立串行队列：与 tasks 的 withTaskLock 无关（在锁内再入队会死锁），
   但同一键的"读-改-写"必须串起来，否则并发 +1 会丢计数 */
let rtQueue = Promise.resolve();
function rt(run) {
  const job = () => Promise.resolve().then(run).catch(() => {});
  rtQueue = rtQueue.then(job, job);
  return rtQueue;
}

async function rtGet(key) {
  try {
    const data = await chrome.storage.session.get(key);
    return data[key];
  } catch (e) {
    return undefined; /* 会话存储不可用：按"无状态"降级，功能弱化但不报错 */
  }
}

async function rtSet(key, value) {
  await rt(() => chrome.storage.session.set({ [key]: value }));
}

/* 连击计数 +1 并返回新值（读改写整体入队） */
function rtBump(key) {
  let next = 0;
  return rt(async () => {
    const data = await chrome.storage.session.get(key);
    next = (Number(data[key]) || 0) + 1;
    await chrome.storage.session.set({ [key]: next });
  }).then(() => next);
}

/* 向任务标签页注入心跳脚本；脚本守卫可重启，重复注入等价于重启心跳 */
async function keepAliveInject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [KEEPALIVE_SCRIPT] });
  } catch (e) {
    /* 受限页面 / 渲染上下文未就绪 / 缺站点权限 / API 异常：静默降级，绝不阻塞任务主流程 */
  }
}

/* 防系统休眠（学 ARP 的 chrome.power）：有任务且开关开启时持 system 级锁（屏幕可灭、
   系统不睡）；任务清空/开关关闭即释放。updateBadge 是所有任务增删路径的必经点，
   锁的收敛就挂在那里 */
async function applyKeepAwake() {
  try {
    if (!chrome.power) return;
    const [settings, tasks] = await Promise.all([getSettings(), getTasks()]);
    const want = !!settings.keepAwake && Object.keys(tasks).length > 0;
    if (want) {
      /* 持锁标记存会话态：重复 request 按文档是"替换"（无害），但仍挡掉高频无谓调用 */
      if (!(await rtGet(RT_AWAKE))) {
        chrome.power.requestKeepAwake("system");
        await rtSet(RT_AWAKE, true);
      }
    } else {
      /* 无条件 release：锁挂在扩展上、跨 SW 回收存活，而持锁标记只在会话态——
         若靠标记判断，SW 回收后就会漏掉这次释放，系统一直不睡（实测见
         `_code-review/verify-sw-restart-state.mjs` S3）。未持锁时 release 无副作用。 */
      chrome.power.releaseKeepAwake();
      if (await rtGet(RT_AWAKE)) await rtSet(RT_AWAKE, false);
    }
  } catch (e) {
    /* power API 不可用：静默 */
  }
}

/* 注入门控解耦（08 §3.1 裁定）：heartbeat 与 activityWatch 各有开关，任一开启即注入，
   配置经 query 拉取 / config 推送双通道热更新——关保活不再连坐其他注入功能 */
async function syncKeepAliveConfig(tabId) {
  const settings = await getSettings();
  const heartbeat = !!settings.keepAlive;
  const activityWatch = !!settings.skipOnActivity;
  if (heartbeat || activityWatch) await keepAliveInject(tabId);
  chrome.tabs
    .sendMessage(tabId, { type: "keepalive-config", heartbeat, activityWatch })
    .catch(() => {});
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
    /* 随机初始相位（1 秒~一个周期，05 复审 §3.4 下限防首拍立即触发）：多任务心跳不再同拍 */
    await chrome.alarms.create(hbName(tabId), {
      when: Date.now() + 1000 + Math.round(Math.random() * (HEARTBEAT_MINUTES * 60 * 1000 - 1000)),
      periodInMinutes: HEARTBEAT_MINUTES
    });
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
    const send = (useRange) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      return fetch(task.url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal: ctrl.signal,
        headers: useRange ? { Range: "bytes=0-1023" } : undefined,
      }).finally(() => clearTimeout(timer));
    };
    /* Range 截断到 1KB：请求到达即完成会话续期，正文无人消费；
       bytes=数字-数字 属 CORS 安全名单请求头值形式，不会引入预检（05 复审 §3.3 核实）；
       站点忽略 Range 时回退整页 200，判定逻辑不受影响（206 同在 ok 区间） */
    let res = await send(true);
    /* 416 = 站点拒收该 Range（实现不规范）：去 Range 重试一次，
       避免该站点的心跳通道静默失效（05 复审 §3.3） */
    if (res.status === 416) res = await send(false);
    const root = siteRoot(hostOf(task.url));
    const landed = res.url || task.url;
    /* 错误页通道：5xx/404 连续命中 → 任务自动暂停；恢复 2xx 自动解除（06 §4.3）
       连击计数存会话态（跨 SW 回收存活），否则两次心跳隔着 4 分钟、SW 早已回收，
       计数每次从 0 起 → 阈值永远到不了（见 RT_* 注释与 verify-sw-restart-state.mjs）
       与掉线通道并行且互不污染：不进 sessionProbe，不影响备份冻结 */
    if (isErrorStatus(res.status)) {
      const s = await rtBump(rtTab(RT_ERROR, tabId));
      if (s >= PAUSE_CONFIRM_SAMPLES) await pauseTaskAuto(tabId, "error-page");
    } else {
      await rtSet(rtTab(RT_ERROR, tabId), 0); /* 0 = 计数清零（不必删键，读侧 Number()||0 等价） */
    }
    if (looksLikeLoginPage(landed) || res.status === 401 || res.status === 403) {
      await reportSessionSignal(root, hostOf(landed) || root, true);
    } else if (res.ok) {
      await reportSessionSignal(root, hostOf(landed) || root, false);
      const t2 = (await getTasks())[tabId];
      if (t2 && t2.autoPaused && t2.autoPaused.reason === "error-page") {
        await resumeTaskAuto(tabId); /* 站点活着了：静默自愈 */
      }
    }
    /* 401/403 走掉线疑似（登录墙语义），5xx 走错误页暂停，互不混淆 */
  } catch (e) {
    /* fetch 失败（无权限/离线/站点挂了）：无信号，静默 */
  }
}

/* 设置变化（含跨设备同步）、浏览器启动恢复后，按开关对存量任务页收敛心跳与保活 */
async function reconcileKeepAlive() {
  try {
    const [settings, tasks] = await Promise.all([getSettings(), getTasks()]);
    for (const tabId of Object.keys(tasks).map(Number)) {
      if (settings.keepAlive || settings.skipOnActivity) await keepAliveInject(tabId);
      else stopKeepAlive(tabId);
      chrome.tabs
        .sendMessage(tabId, {
          type: "keepalive-config",
          heartbeat: !!settings.keepAlive,
          activityWatch: !!settings.skipOnActivity,
        })
        .catch(() => {});
      await ensureHeartbeat(tabId);
    }
    await applyKeepAwake();
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

/* ---- 关键词检测链（08 裁定方案 C：全在后台，不碰注入通道，
   与 keepAlive 门控零耦合）。每次页面 complete 起一条链：立即查一次，
   未命中再于 3s / 10s 有界重采样——专治 SPA/迟渲染在 complete 时刻正文
   未就位的漏检；正文与上次相同则提前结束。新链起链即作废旧链（Map 里换
   token），杜绝并发链重复通知/竞态停任务。SW 中途回收丢链可接受，
   下个 complete 或刷新周期自动重建 ---- */
const detectChains = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDetectChain(tabId) {
  const token = {}; /* 链身份：Map 里的值被替换即视为本链过期 */
  detectChains.set(tabId, token);
  let lastText = null;
  for (const delay of [0, 3000, 10000]) {
    if (delay) await sleep(delay);
    if (detectChains.get(tabId) !== token) return;
    let task;
    try {
      task = (await getTasks())[tabId];
    } catch (e) {
      return;
    }
    if (!task || !getTaskKeywords(task).length) {
      detectChains.delete(tabId);
      return;
    }
    let text;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const t = document.body && document.body.innerText;
          return typeof t === "string" ? t.slice(0, 300000) : "";
        },
      });
      text = results && results[0] && results[0].result;
    } catch (e) {
      text = undefined;
    }
    if (detectChains.get(tabId) !== token) return;
    if (typeof text !== "string") {
      detectChains.delete(tabId); /* 注入失败：等下个刷新周期 */
      return;
    }
    const { present, newly } = pickHits(text, getTaskKeywords(task), task.notifiedKeys);
    if (newly.length) {
      detectChains.delete(tabId);
      await onKeywordHit(tabId, task, newly, present);
      return;
    }
    /* continue 模式下在场集收缩（关键词消失→下次再现重新通知）；值没变不写 */
    if (task.onHit === "continue" && sameSet(present, task.notifiedKeys) === false) {
      await withTaskLock(async () => {
        const tasks = await getTasks();
        if (tasks[tabId] && detectChains.get(tabId) === token) {
          tasks[tabId] = Object.assign({}, tasks[tabId], { notifiedKeys: present });
          await setTasks(tasks);
        }
      });
    }
    if (lastText !== null && text === lastText) {
      detectChains.delete(tabId); /* 正文稳定：继续等没意义 */
      return;
    }
    lastText = text;
  }
  detectChains.delete(tabId);
}

function sameSet(a, b) {
  const x = (a || []).slice().sort().join("\u0000");
  const y = (b || []).slice().sort().join("\u0000");
  return x === y;
}

async function onKeywordHit(tabId, task, newly, present) {
  const label = newly.join(", ");
  const message = chrome.i18n.getMessage("notifKeywordHits", [label]);
  chrome.notifications
    .create("keyword-hit-" + tabId, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message,
    })
    .catch(() => {});
  await postWebhook("keyword", {
    content: message,
    text: label,
    host: hostOf(task.url) || "",
    url: task.url || "",
  });
  if (task.onHit === "continue") {
    /* 持续监控：记录已通知集，等待新命中；任务不停 */
    await withTaskLock(async () => {
      const tasks = await getTasks();
      if (tasks[tabId]) {
        tasks[tabId] = Object.assign({}, tasks[tabId], { notifiedKeys: present });
        await setTasks(tasks);
      }
    });
  } else {
    await stopTask(tabId); /* 默认行为不变：命中即停（抢一次场景） */
  }
}

/* ---- Webhook 通知（学 ARP"通知出机器"）：无新权限，常驻 host_permissions
   已覆盖任意 http(s) 目标。载荷同时填充 content(Discord/Slack)/text(Telegram)/
   body(通用) 三个别名 + type/url/host/ts，任何预设服务或自定义端点开箱即用。
   调用方必须 await（四处调用点都写在 async 函数里）：fetch 必须挂在被 await 的
   链路里，否则扩展 SW 被回收时请求会被截断（Chrome 要求"持久化状态、别裸甩异步"） ---- */
async function postWebhook(event, payload) {
  try {
    const settings = await getSettings();
    const url = normalizeWebhookUrl(settings.webhookUrl);
    if (!url) return;
    const events =
      Array.isArray(settings.webhookEvents) && settings.webhookEvents.length
        ? settings.webhookEvents
        : DEFAULT_SETTINGS.webhookEvents;
    if (!events.includes(event)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const body = Object.assign({ type: event, ts: Date.now() }, payload);
      body.content = payload.content || "";
      body.text = payload.text || payload.content || "";
      body.body = payload.body || payload.content || "";
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    /* 辅助链路：失败静默，绝不影响主流程 */
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
    /* 行为通道已判定该根域掉线：证据强于状态采样，直接保护备份不被写坏 */
    if (await isProbeLost(task.url)) return;
    /* 掉线确认窗口（复审§2 修复）：疑似采样只累加计数（MERGE），绝不把坏样本
       写进 cookies——否则下一轮 prev 里没有会话票据，streak 恒被清零，
       确认窗口不可达且最后一次好备份在第 2 次采样就被污染。timestamp 保持
       最后有效备份时间，长期冻结的备份由 30 天 TTL 自然淘汰 */
    const prevEntry = (await chrome.storage.local.get(key))[key];
    /* 决策与落盘映射同一纯函数（04 复审 §4.4）：write=null 表示冻结且节流，什么都不写 */
    const act = applyBackupAction(prevEntry, cookies, now);
    if (act.write) await chrome.storage.local.set({ [key]: act.write });
    if (act.notify) notifySessionLost(host);
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
  void applyKeepAwake(); /* 任务增删/暂停的所有路径都经过这里 */
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
    let anyAutoPaused = false;
    for (const t of Object.values(tasks)) {
      if (t.autoPaused) { anyAutoPaused = true; break; }
    }
    /* 五态优先级：掉线 ! 红 > 自动暂停 ⚠ 橙 > 全部暂停 ‖ 灰 > 计数 蓝 > 空 */
    const color = anyLost ? "#dc2626" : anyAutoPaused ? "#d97706" : paused ? "#6b7280" : "#2563eb";
    const text = anyLost ? "!" : anyAutoPaused ? "⚠" : paused && n > 0 ? "‖" : n > 0 ? String(n) : "";
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    /* 角标失败不影响任务 */
  }
}

async function notifyTaskStopped(tabId, url, reason) {
  chrome.notifications
    .create("refresh-stopped-" + tabId, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message: chrome.i18n.getMessage("notifStopped")
    })
    .catch(() => {}); /* 系统通知被关闭时不影响任务清理流程 */
  /* await 而非 void：postWebhook 内是 fetch，必须挂在被 await 的链路里，
     否则 SW 回收会截断请求（本批首版四处都写成 void，与函数注释自相矛盾） */
  await postWebhook("task-stopped", {
    content: chrome.i18n.getMessage("notifStopped"),
    host: hostOf(url) || "",
    url: url || "",
    reason: reason || "tab-gone",
  });
}

/* 08 复审 §3.6：URL 必须在 stopTask 之前取——任务记录删除后就拿不到了 */
async function stopTaskWithNotice(tabId, reason) {
  const task = (await getTasks())[tabId];
  const url = (task && task.url) || "";
  await stopTask(tabId);
  await notifyTaskStopped(tabId, url, reason);
}

/* 服务器端会话失效提醒：cookie 备份只能恢复票据，救不回已注销的会话 */
async function notifySessionLost(host) {
  chrome.notifications
    .create("session-lost-" + host, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message: chrome.i18n.getMessage("notifSessionLost", [host])
    })
    .catch(() => {});
  await postWebhook("session-lost", {
    content: chrome.i18n.getMessage("notifSessionLost", [host]),
    host,
  });
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
  /* 标签页不存在优先于自动暂停判定：否则"被自动暂停的任务 + 用户关掉标签页"
     永远等不到清理（旧行为是关掉即停任务并通知），会留下静默僵尸任务 */
  if (!tab) {
    await stopTaskWithNotice(tabId, "tab-gone");
    return;
  }
  if (tasks[tabId].autoPaused) return; /* 错误页/验证墙自动暂停：alarm 已由 armRefresh 续跑，等恢复 */
  const settings = await getSettings();
  /* 真人 60 秒内在该页操作过则跳过本次刷新（isTrusted 过滤，保活合成事件不会误报，06 §4.5）
     策略是"跳过"而非"重置计时"：重置会被用户操作无限期推迟，违背盯变化的用途；
     时间戳存会话态——SW 回收后仍记得，否则该开关基本无效（见 RT_* 注释） */
  if (settings.skipOnActivity) {
    const last = Number(await rtGet(rtTab(RT_ACTIVITY, tabId))) || 0;
    if (Date.now() - last < ACTIVITY_SKIP_MS) return;
  }
  if (settings.skipDiscarded && tab.discarded) return; /* 休眠标签页不唤醒 */
  try {
    await reloadTab(tabId);
  } catch (e) {
    /* 标签页已关闭或页面受限：清理任务并通知用户 */
    await stopTaskWithNotice(tabId, "refresh-failed");
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
  void startDetectChain(tabId); /* 关键词检测链（立即 + 3s + 10s 有界重采样） */
  /* 保活/活动监听：每次加载完成同步注入与配置（门控解耦见 08 §3.1） */
  await syncKeepAliveConfig(tabId);
  await probeCaptcha(tabId); /* 验证墙探测：连续命中自动暂停，见 probeCaptcha 注释 */
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
    /* 未认领任务的旧 alarm 先记账、setTasks 落盘后再清（04 复审 §4.1）：
       SW 中途回收时宁可留"有 alarm 没任务"（onAlarm 找不到任务会自清），
       也不能留"有任务没 alarm"的静默僵尸 */
    const staleAlarms = [];
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
      staleAlarms.push(alarmName(tabId), hbName(tabId));
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
    const liveIds = new Set(Object.keys(tasks)); /* 落盘后的最终键：被重挂接/重开占用的 id 不能清 */
    /* 05 复审 §2 回归修复：延后清理若不看最终键集合，会把本轮刚 arm 的 alarm
       （id 恰好曾是其他任务的键：tabId 互换 / watch 等回原 id / Chrome 复用 id）
       一并清掉，产出"任务在、永不刷新"的僵尸——正是这次修复要消灭的状态 */
    for (const name of staleAlarms) {
      const id = name.startsWith(HB_PREFIX) ? name.slice(HB_PREFIX.length) : name.slice(PREFIX.length);
      if (liveIds.has(id)) continue;
      await chrome.alarms.clear(name);
    }
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
  const touched = (k) => o[k] !== n[k];
  if (!(["keepAlive", "httpHeartbeat", "skipOnActivity", "keepAwake"].some(touched))) return;
  reconcileKeepAlive();
});

/* ---- 错误页 / 验证墙 → 任务级自动暂停（06 §4.3）----
   独立于掉线状态机（不进 sessionProbe，防污染备份冻结语义）：
   心跳侧 5xx/404 连续 PAUSE_CONFIRM_SAMPLES 次、或页面侧验证墙特征连续命中才暂停；
   错误页暂停后若心跳恢复 2xx 自动解除；验证墙由用户过墙后手动/自动恢复。
   暂停期间定时器照常续跑（onAlarm 早退），恢复零重建 ---- */
async function probeCaptcha(tabId) {
  try {
    const task = (await getTasks())[tabId];
    if (!task) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const s = ((document.title || "") + "\n" + ((document.body && document.body.innerText) || "")).slice(0, 4000).toLowerCase();
        let hit = /(captcha|verify you are human|just a moment|attention required|access denied|pardon our interruption|human verification|安全验证|验证码|人机验证)/.test(s);
        if (!hit) {
          for (const el of document.querySelectorAll("iframe, frame, script[src]")) {
            const u = el.getAttribute("src") || "";
            if (/challenges\.cloudflare\.com|recaptcha|hcaptcha/i.test(u)) { hit = true; break; }
          }
        }
        return hit;
      },
    });
    const wall = !!(results && results[0] && results[0].result === true);
    const cur = (await getTasks())[tabId];
    if (!cur) return;
    if (!wall) {
      await rtSet(rtTab(RT_CAPTCHA, tabId), 0);
      if (cur.autoPaused && cur.autoPaused.reason === "captcha") await resumeTaskAuto(tabId);
      return;
    }
    /* 连击计数同样存会话态：验证墙随刷新周期（≥30 秒）探一次，SW 早被回收，
       内存计数永远到不了阈值（见 RT_* 注释与 verify-sw-restart-state.mjs） */
    const s = await rtBump(rtTab(RT_CAPTCHA, tabId));
    if (s >= PAUSE_CONFIRM_SAMPLES) await pauseTaskAuto(tabId, "captcha");
  } catch (e) {
    /* 注入失败（权限/时序）：忽略，下个周期再探 */
  }
}

async function pauseTaskAuto(tabId, reason) {
  let didPause = false;
  let task;
  await withTaskLock(async () => {
    const tasks = await getTasks();
    task = tasks[tabId];
    if (task && !task.autoPaused) {
      tasks[tabId] = Object.assign({}, task, { autoPaused: { reason, at: Date.now() } });
      await setTasks(tasks);
      didPause = true;
    }
  });
  if (!didPause) return;
  await updateBadge();
  const message = chrome.i18n.getMessage(
    reason === "captcha" ? "notifTaskPausedCaptcha" : "notifTaskPausedError"
  );
  chrome.notifications
    .create("task-paused-" + tabId, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: chrome.i18n.getMessage("notifTitle"),
      message,
    })
    .catch(() => {});
  await postWebhook("task-paused", {
    content: message,
    host: hostOf(task.url) || "",
    url: task.url || "",
    reason,
  });
}

async function resumeTaskAuto(tabId) {
  let done = false;
  await withTaskLock(async () => {
    const tasks = await getTasks();
    if (tasks[tabId] && tasks[tabId].autoPaused) {
      const t = Object.assign({}, tasks[tabId]);
      delete t.autoPaused;
      tasks[tabId] = t;
      await setTasks(tasks);
      done = true;
    }
  });
  /* 恢复即清连击：避免"过墙后残留计数"让下一次同因暂停来得过早 */
  await rtSet(rtTab(RT_ERROR, tabId), 0);
  await rtSet(rtTab(RT_CAPTCHA, tabId), 0);
  if (done) await updateBadge();
}

/* 与弹窗通信 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "prune-now") {
        await cleanupInvalidTasks();
        sendResponse({ ok: true });
      } else if (msg.type === "start") {
        const r = await startTask(msg.tabId, msg.seconds, msg.keyword, msg.keepWatching);
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
      } else if (msg.type === "keepalive-query") {
        /* 页面脚本注入后拉配置快照（心跳/活动监听各自开关） */
        const settings = await getSettings();
        sendResponse({
          heartbeat: !!settings.keepAlive,
          activityWatch: !!settings.skipOnActivity,
        });
      } else if (msg.type === "user-activity") {
        if (sender.tab && typeof sender.tab.id === "number") {
          await rtSet(rtTab(RT_ACTIVITY, sender.tab.id), Date.now());
        }
        sendResponse({ ok: true });
      } else if (msg.type === "resume-task") {
        await resumeTaskAuto(msg.tabId);
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
