/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS, DEFAULT_SETTINGS, HB_PREFIX } from "./shared/config.js";
import {
  RESTRICTED_URL,
  applyBackupAction,
  buildTokenRequest,
  buildWechatMessage,
  capCookies,
  clampInterval,
  domainChain,
  hostOf,
  isErrorStatus,
  isTokenErrorCode,
  jitteredDelayMs,
  getTaskKeywords,
  newlyOf,
  normalizeStoredSettings,
  normalizeWebhookUrl,
  notifyEventsOf,
  oneLine,
  parseKeywords,
  looksLikeLoginPage,
  sameHost,
  sameSite,
  siteRoot,
  tabShowsUrl,
  tokenFresh,
  wechatConfigState,
  wechatErrorKey,
  wechatTitleOf,
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
/* 重启恢复时等待页面自行到位的窗口，救"先跳 SSO 才到位"的页面 */
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

/* 偏好设置存 chrome.storage.sync 跨设备同步；旧版本留在 local 的设置自动迁移。
   存盘设置 → 生效设置一律走 shared/logic.js 的 normalizeStoredSettings，弹窗同款。
   生效值带内存快照：一次任务页加载周期里 getSettings 被调到 5~7 次（保活同步、验证墙
   探测、cookie 备份、刷新、心跳、备份收敛各一次），原先每次都发两笔存储读。
   三个写盘点（迁移、rememberLastInterval、save-settings）与 storage.onChanged 都要显式
   invalidateSettings()，漏一个就会读到过期快照，见各自的调用注释 */
let settingsCache = null;
let settingsLoading = null; /* 并发去重：同一时刻只跑一笔真读 */
let settingsEpoch = 0; /* 读盘期间发生过失效，那次结果就不能回填 */

function invalidateSettings() {
  settingsCache = null;
  settingsLoading = null;
  settingsEpoch++;
}

async function loadSettings() {
  const syncData = await chrome.storage.sync.get("settings");
  if (syncData.settings) {
    return normalizeStoredSettings(syncData.settings, DEFAULT_SETTINGS);
  }
  /* 只有 sync 为空才回读 local，常态下省掉一笔读 */
  const localData = await chrome.storage.local.get("settings");
  if (localData.settings) {
    const migrated = normalizeStoredSettings(localData.settings, DEFAULT_SETTINGS);
    await chrome.storage.sync.set({ settings: migrated });
    await chrome.storage.local.remove("settings");
    return migrated;
  }
  return normalizeStoredSettings(null, DEFAULT_SETTINGS);
}

function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  if (!settingsLoading) {
    const epoch = settingsEpoch;
    settingsLoading = loadSettings().then(
      (s) => {
        /* 被失效过的读盘结果既不能回填缓存，也不能清掉新那次读的门把手 */
        if (epoch === settingsEpoch) {
          settingsCache = s;
          settingsLoading = null;
        }
        return s;
      },
      (e) => {
        if (epoch === settingsEpoch) settingsLoading = null;
        throw e; /* 读失败不留快照：下次调用重新真读 */
      }
    );
  }
  return settingsLoading;
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

/* 掉线探测的行为通道（思路与 staying_alive 一致）：任务页落在登录页 URL、
   心跳被重定向到登录页或返回 401/403，都计为疑似，连续
   SESSION_LOST_CONFIRM_SAMPLES 次确认，一次正常信号即恢复，与状态通道各自独立计数。
   确认后角标变红、发通知（按 6 小时节流），并让 backupCookies 拒绝写入坏备份。
   本函数不经 withTaskLock：它会被已在锁内的 backupCookies 调用，而锁不可重入。
   探针写入碰撞的后果只是计数偏差 1，可以接受 */
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
      p.lastNotifiedAt = 0; /* 恢复即新故障周期的起点：否则 6 小时内二次独立掉线不再通知 */
      p.sus = 0;
      p.lost = false;
    }
    /* 值没变就不写盘、不刷角标：30 秒任务的每次页面加载都会打到这里 */
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

/* 调度用"一次性 when + 周期 period"双保险（思路与 tab-reloader 一致）：
   秒级精度靠 when，周期 alarm 只防漏；每次触发后重新 arm。
   ±15% 抖动让多任务不同拍，也更不像机器行为 */
async function armRefresh(tabId, intervalSec) {
  const when = Date.now() + jitteredDelayMs(intervalSec);
  await chrome.alarms.create(alarmName(tabId), {
    when,
    periodInMinutes: Math.max(0.5, intervalSec / 60)
  });
}

/* 睡眠唤醒后自愈：过期的刷新 alarm 重走完整周期加抖动，
   过期的心跳 alarm 打散 0~60 秒重建 */
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

/* 按"仍被任务引用的根域"收敛掉线探针。站点掉线后探针 lost=true，用户停掉该站任务时
   探针没有任何清理路径，只有一次正常信号才会复位；于是稍后在同一站点重建任务，
   startTask 里那次备份会被 isProbeLost 跳过，而它正是"首次刷新前关掉浏览器"的兜底。
   角标只读当前任务涉及的根域，删掉无引用的探针不影响判定，也止住了条目的无界增长。
   探针不只服务备份（行为通道与掉线通知也写它），所以开关关闭时同样要收敛，
   不能塞进 cookieBackup 分支 */
async function pruneStaleProbes(roots) {
  const data = await chrome.storage.local.get(PROBE_KEY);
  const all = data[PROBE_KEY];
  if (!all) return;
  const kept = {};
  let dropped = 0;
  for (const [root, value] of Object.entries(all)) {
    if (roots.has(root)) kept[root] = value;
    else dropped++;
  }
  if (dropped > 0) await chrome.storage.local.set({ [PROBE_KEY]: kept });
}

/* 备份清理三条件：站点不再被任何任务使用、超过 30 天 TTL、超过 20 站上限（按时间留新）。
   备份功能关闭时不留死数据，直接清空全部备份 */
async function pruneCookieBackups(remainingTasks) {
  const roots = new Set();
  for (const t of Object.values(remainingTasks || {})) {
    const r = siteRoot(hostOf(t.url));
    if (r) roots.add(r);
  }
  await pruneStaleProbes(roots);
  if (!(await getSettings()).cookieBackup) {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(COOKIE_BACKUP_PREFIX));
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    return;
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

/* 后台保活：默认开启的合成活动注入，对抗按用户交互计时的服务器端会话过期。
   注入是标签页级：startTask 即时注入一次，tabs.onUpdated 对任务页每次加载完成补注入。
   不用 registerContentScripts：它的 matches 是站点级，会溢出到同站无关标签页，
   而且站点注册 id 与任务 id 语义分裂，重启后停任务清不掉注册 */
const KEEPALIVE_SCRIPT = "content/keepalive.js";
/* 错误页与验证墙的确认次数、以及"用户操作后跳过刷新"的窗口 */
const PAUSE_CONFIRM_SAMPLES = 2;
/* 验证墙的阈值单独放宽到 3：它只看页面标题，采样节奏跟着刷新周期（≥30 秒），
   而错误页有独立的 4 分钟心跳通道且能自愈，两者误判的代价不对称（见 probeCaptcha） */
const CAPTCHA_CONFIRM_SAMPLES = 3;
const ACTIVITY_SKIP_MS = 60000;

/* 跨 SW 实例的运行时状态统一放 chrome.storage.session。
   MV3 的 service worker 闲置 30 秒即终止（收到事件或调扩展 API 会重置计时器），
   官方要求为意外终止做好准备。下面这些状态两端间隔都是分钟级，放内存必然被清零：
   异常连击（心跳 4 分钟一次、验证墙随刷新周期一次，两次采样落在两个 SW 实例，
   计数每次从 0 起，"连续 N 次才暂停"退化成永不暂停）、真人活动时间戳（回收即丢，
   60 秒跳过窗口失效）、keepAwake 持锁标记（回收后误判未持锁，关开关时不再释放）。
   session 的语义正好：跨 SW 回收存活、随浏览器会话结束清空（与 chrome.power 请求的
   生命周期一致），不落磁盘、不需要新权限。回归脚本 verify-sw-restart-state.mjs */
const RT_ACTIVITY = "rt:activity";
const RT_ERROR = "rt:error";
const RT_CAPTCHA = "rt:captcha";
const RT_AWAKE = "rt:awake";
const rtTab = (base, tabId) => base + ":" + tabId;

/* 读写走独立串行队列：与 tasks 的 withTaskLock 无关（在锁内再入队会死锁），
   但同一键的读-改-写必须串起来，否则并发加一会丢计数 */
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

/* 防系统休眠（用 chrome.power）：有任务且开关开启时持 system 级锁（屏幕可灭、系统不睡），
   任务清空或开关关闭即释放。updateBadge 是所有任务增删路径的必经点，收敛挂在那里 */
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
      /* 无条件释放：锁挂在扩展上、跨 SW 回收存活，而持锁标记只在会话态，
         靠标记判断会漏掉 SW 回收后的这次释放，系统一直不睡。
         未持锁时 release 无副作用 */
      chrome.power.releaseKeepAwake();
      if (await rtGet(RT_AWAKE)) await rtSet(RT_AWAKE, false);
    }
  } catch (e) {
    /* power API 不可用：静默 */
  }
}

/* heartbeat 与 activityWatch 各有开关，任一开启即注入，配置经 query 拉取与
   config 推送两条通道热更新：关保活不再连坐其他注入功能 */
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

/* 静默 HTTP 心跳（思路与 staying_alive 一致），救"按最后请求计时"的会话：
   分钟级向监控地址发带 cookie 的 GET，不重载页面、不打扰用户。
   响应落在登录页或返回 401/403 视为疑似掉线，正常 2xx 视为恢复 */
async function ensureHeartbeat(tabId) {
  try {
    const [settings, tasks] = await Promise.all([getSettings(), getTasks()]);
    const task = tasks[tabId];
    if (!settings.httpHeartbeat || !task) {
      await chrome.alarms.clear(hbName(tabId));
      return;
    }
    /* 随机初始相位（1 秒到一个周期，下限防止首拍立即触发）：多任务心跳不再同拍 */
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
    /* Range 截断到 1KB：请求到达即完成会话续期，正文没人消费。
       bytes=数字-数字 是 CORS 安全名单里的请求头值形式，不会引入预检；
       站点忽略 Range 时回退整页 200，206 也在 ok 区间，判定不受影响 */
    let res = await send(true);
    /* 416 = 站点拒收这个 Range（实现不规范）：去掉 Range 重试一次，
       免得该站点的心跳通道静默失效 */
    if (res.status === 416) res = await send(false);
    const root = siteRoot(hostOf(task.url));
    const landed = res.url || task.url;
    /* 错误页通道：5xx/404 连续命中就暂停任务，回到 2xx 自动解除。
       连击计数存会话态，否则两次心跳隔 4 分钟、SW 早已回收，计数每次从 0 起，
       阈值永远到不了。与掉线通道并行且互不污染：不进 sessionProbe，不影响备份冻结 */
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
    /* 读之前先失效：这次读的是合并基座，拿过期快照会把别的开关按旧值一并写回 sync。
       只有手动建任务会走到这里（startTask），不是每个刷新周期，代价是一次重读 */
    invalidateSettings();
    const settings = await getSettings();
    if (settings.lastIntervalSec === seconds) return; /* 没变不写，避免无谓的 sync 变更风暴 */
    await chrome.storage.sync.set({
      settings: Object.assign({}, settings, { lastIntervalSec: seconds })
    });
    invalidateSettings();
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

/* 关键词检测链：全在后台，不碰保活注入通道，与保活门控零耦合。
   每次页面加载完成起一条链，立即查一次，未命中再于 3 秒、10 秒重采样
   （SPA 或迟渲染的页面在 complete 时刻正文还没就位）。
   新链起链即作废旧链，避免并发链重复通知或竞态停任务。
   SW 中途回收丢链可以接受，下个加载完成或刷新周期会自动重建 */
const detectChains = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 页内关键词匹配，经 executeScript 注入到被监控页里跑，只把命中的关键词回传后台。
   改这里之前先记住两条约束，破坏任何一条都是静默失效：

   1. 函数体必须完全自包含。executeScript 是把它 toString() 后送到页面里执行的，
      引用任何模块作用域的标识符（连 import 进来的函数都一样）都会在页面里变成 undefined。
      所以匹配逻辑在这里内联了一份，而不是调用 shared/logic.js 的 keywordHit；
      那份是语义基准，两边的一致性由 tests/tab-auto-refresh/keyword-inpage.test.mjs 钉——
      它直接跑这个函数体，与 presentOf 的真实输出逐条比对。

   2. 取文本一律用 innerText，不要"顺手"换成 textContent。看着等价，实际会新增两类命中：
      textContent 含 <script>/<style> 里的源码文本，也含 display:none 的隐藏文字。
      前者会把页面代码里的字符串当成正文，后者会让通知报一个用户在页面上根本看不见的东西。

   匹配搬到页面里做，正文就不再跨上下文序列化，原先"截 300KB、之后的内容永远检不到"
   那个盲区随之消失。这是这次改动的目的，不是顺带的性能优化。 */
function matchInPage(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  const low = String(document.body ? document.body.innerText : "").toLowerCase();
  const hits = [];
  for (const k of list) {
    const needle = String(k == null ? "" : k).trim().toLowerCase();
    if (needle && low.includes(needle)) hits.push(k);
  }
  return hits;
}

async function startDetectChain(tabId) {
  const token = {}; /* 链身份：Map 里的值被替换即视为本链过期 */
  detectChains.set(tabId, token);
  for (const delay of [0, 3000, 10000]) {
    if (delay) await sleep(delay);
    if (detectChains.get(tabId) !== token) return;
    let task;
    try {
      task = (await getTasks())[tabId];
    } catch (e) {
      return;
    }
    const keywords = getTaskKeywords(task);
    if (!task || !keywords.length) {
      detectChains.delete(tabId);
      return;
    }
    let present;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: matchInPage,
        args: [keywords],
      });
      present = results && results[0] && results[0].result;
    } catch (e) {
      present = undefined;
    }
    if (detectChains.get(tabId) !== token) return;
    if (!Array.isArray(present)) {
      detectChains.delete(tabId); /* 注入失败：等下个刷新周期 */
      return;
    }
    const newly = newlyOf(present, task.notifiedKeys);
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
  await notifyOut("keyword", {
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

/* Webhook 通知。不需要新权限，常驻的 host_permissions 已覆盖任意 http(s) 目标。
   载荷填 content（Discord）、text（Slack、Telegram）、body（冗余兜底）三个别名，
   外加 type/url/host/ts，让各家认的字段都能对上。
   ntfy 不在此列：它只在根端点解析 JSON，POST 到 /<主题> 会把整个 JSON 当正文存下，
   而载荷里没有 topic 字段、也改不了填根端点，所以它收到的是原始 JSON 文本。
   调用方必须 await：fetch 要挂在被 await 的链路上，否则 SW 被回收时请求会被截断 */
async function postWebhook(event, payload) {
  try {
    const settings = await getSettings();
    const url = normalizeWebhookUrl(settings.webhookUrl);
    if (!url) return;
    const events = notifyEventsOf(settings);
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

/* 微信直连：扩展 SW 直接调 api.weixin.qq.com 推模板消息，不经中继。
   与 webhook 并列的第二个外发出口，两者共用 notifyEvents 事件清单、各有独立开关。
   可行性的依据是实测对照：网页语境 fetch 微信接口被 CORS 拦（Failed to fetch），
   扩展 SW 语境返回 200：微信不返回 CORS 头对扩展不构成障碍，
   manifest 的 <all_urls> 已覆盖，不需要新增权限。

   令牌缓存必须落 chrome.storage.session：SW 闲置 30 秒就被回收，内存缓存等于没有；
   session 不同步、关浏览器即清，正适合短期令牌。
   推送结果落 chrome.storage.local，静默失败要留痕，否则用户以为配好了在发 */
const WX_TOKEN_KEY = "wechatToken";
const WX_LAST_KEY = "wechatLastResult";
const WX_FETCH_TIMEOUT_MS = 15000;
/* 事件到卡片标题的文案键。卡片标题另用一套短名，不复用弹窗的复选框标签：
   复选框标签是给 400px 宽的弹窗看的，可以长（英文 "task auto-stopped" 有 17 个字符）；
   卡片标题要和站点一起挤在平台的 20 字里，用长标签会把预算吃光，
   站点名要么被截成 "…e.com" 这样的碎片、要么整段消失。
   所以中文 4~5 字、英文 6~7 字符。
   test 是"发送测试消息"按钮专用的伪事件：只要求凭据填全，
   不受总开关与事件勾选约束（配好之前就得能试） */
const WECHAT_EVENT_TITLE_KEYS = {
  keyword: "wechatEvKeywordShort",
  "task-stopped": "wechatEvStoppedShort",
  "task-paused": "wechatEvPausedShort",
  "session-lost": "wechatEvSessionShort",
  test: "wechatEvTest",
};

async function wxFetch(url, body, timeoutMs = WX_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* 取 access_token：优先用缓存，force 时强制刷新（stable_token 的 force_refresh）。
   失败时把微信的错误码挂在 error.wechatCode 上，让调用方能给出可读提示 */
async function getWechatToken(settings, force) {
  const now = Date.now();
  if (!force) {
    const d = await chrome.storage.session.get(WX_TOKEN_KEY);
    if (tokenFresh(d[WX_TOKEN_KEY], now)) return d[WX_TOKEN_KEY].token;
  }
  const data = await wxFetch(
    "https://api.weixin.qq.com/cgi-bin/stable_token",
    buildTokenRequest(settings.wechatAppId, settings.wechatAppSecret, force)
  );
  if (!data || !data.access_token) {
    const err = new Error("stable_token failed");
    err.wechatCode = data && typeof data.errcode === "number" ? data.errcode : -1;
    throw err;
  }
  const cache = {
    token: data.access_token,
    expireAt: now + (Number(data.expires_in) || 7200) * 1000,
  };
  await chrome.storage.session.set({ [WX_TOKEN_KEY]: cache });
  return cache.token;
}

/* 最近一次推送结果（弹窗据此给可见反馈）。只留最近一次，不堆积 */
async function setWechatResult(result) {
  try {
    await chrome.storage.local.set({
      [WX_LAST_KEY]: Object.assign({ at: Date.now() }, result),
    });
  } catch (e) {
    /* 反馈写不进去不能反过来影响推送本身 */
  }
}

/* 卡片正文：按事件给一句结论，都在平台的 20 字以内（规则见 logic.js）。
   刻意不复用 payload.content：那是系统通知与 webhook 用的完整句子（30~60 字），
   发到微信只会被平台从中间截断。站点名走标题那一行，页面地址走卡片的点击跳转，
   两者都不占正文的字数 */
const WECHAT_BODY_KEYS = {
  keyword: "wechatBodyKeyword",
  "task-stopped": "wechatBodyStopped",
  "session-lost": "wechatBodySessionLost",
  test: "wechatTestBody",
};

function buildWechatContent(event, payload) {
  const p = payload || {};
  if (event === "keyword") {
    return chrome.i18n.getMessage("wechatBodyKeyword", [oneLine(p.text || p.content || "")]);
  }
  if (event === "task-paused") {
    return chrome.i18n.getMessage(
      p.reason === "captcha" ? "wechatBodyPausedCaptcha" : "wechatBodyPausedError"
    );
  }
  const key = WECHAT_BODY_KEYS[event];
  /* 未登记的事件（将来新增的）退回原始正文，照旧截到 20 字：
     宁可少说，也不要凭空编一句不对应的话 */
  if (!key) return oneLine(p.content || "");
  return chrome.i18n.getMessage(key);
}

async function postWechat(event, payload, opts) {
  try {
    const settings = await getSettings();
    /* ignoreToggle 给弹窗的"发送测试消息"用：测试的意义就是配好之前先试，
       所以它只看凭据是否齐，不受总开关与事件勾选约束 */
    const forced = !!(opts && opts.ignoreToggle);
    if (!forced && !settings.wechatEnabled) return;
    if (!forced && !notifyEventsOf(settings).includes(event)) return;
    const state = wechatConfigState(settings);
    if (!state.ready) {
      /* 开关开了但四样凭据没填全：留痕，让弹窗点名缺哪几项 */
      await setWechatResult({ ok: false, kind: "incomplete", missing: state.missing, event });
      return;
    }
    const eventLabel = chrome.i18n.getMessage(
      WECHAT_EVENT_TITLE_KEYS[event] || "wechatEvKeywordShort"
    );
    const body = buildWechatMessage({
      openId: settings.wechatOpenId,
      templateId: settings.wechatTemplateId,
      /* 标题 = "事件 · 站点"。品牌名不占位：卡片头部本来就写着模板名，
         20 字的预算里它最不值钱，省下来给站点 */
      title: wechatTitleOf({
        eventLabel,
        host: payload && payload.host,
        sep: chrome.i18n.getMessage("wechatTitleSep"),
      }),
      content: buildWechatContent(event, payload),
      url: payload && payload.url,
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await getWechatToken(settings, attempt === 2);
      const data = await wxFetch(
        "https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" +
          encodeURIComponent(token),
        body
      );
      const code = data && typeof data.errcode === "number" ? data.errcode : -1;
      if (code === 0) {
        await setWechatResult({ ok: true, event });
        return;
      }
      /* 令牌失效（40001/42001）：清缓存重取一次再试，官方文档说这两种码可重试 */
      if (isTokenErrorCode(code) && attempt === 1) continue;
      await setWechatResult({
        ok: false,
        kind: "api",
        code,
        errorKey: wechatErrorKey(code),
        event,
      });
      return;
    }
  } catch (e) {
    const code = e && typeof e.wechatCode === "number" ? e.wechatCode : null;
    await setWechatResult({
      ok: false,
      kind: code === null ? "network" : "api",
      code,
      errorKey: code === null ? "wechatErrNetwork" : wechatErrorKey(code),
      event,
    });
  }
}

/* 外发通知总入口：两个出口各推一份（webhook 没配地址会自己跳过，微信关着也跳过）。
   调用方必须 await：两条链路都是 fetch，裸甩异步会在 SW 回收时被截断 */
async function notifyOut(event, payload) {
  await postWebhook(event, payload);
  await postWechat(event, payload);
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
    /* 超限截断前先按"像登录票据的程度"排序再切。原实现按 chrome.cookies.getAll 的
       返回顺序切尾，而这个顺序未定义：会话票据恰在尾部时每次备份都稳定缺它，
       且前后样本都缺，sessionLostDetected 恒判正常，表现为备份时间戳一直在更新、
       重启后却恢复不出登录态。正常规模不排序，避免无谓的顺序变化 */
    const capped = capCookies(cookies, MAX_COOKIES_PER_HOST);
    const key = COOKIE_BACKUP_PREFIX + host;
    const now = Date.now();
    /* 行为通道已判定该根域掉线：证据强于状态采样，直接保护备份不被写坏 */
    if (await isProbeLost(task.url)) return;
    /* 掉线确认窗口：疑似采样只累加计数，绝不把坏样本写进 cookies。否则下一轮 prev 里
       没有会话票据，streak 恒被清零，确认窗口永远到不了，最后一次好备份也会在第 2 次
       采样就被污染。timestamp 保持最后有效备份时间，长期冻结的备份由 30 天 TTL 淘汰 */
    const prevEntry = (await chrome.storage.local.get(key))[key];
    /* 决策与写盘映射是同一个纯函数：write=null 表示冻结且处于通知节流期，什么都不写 */
    const act = applyBackupAction(prevEntry, capped, now);
    if (act.write) await chrome.storage.local.set({ [key]: act.write });
    /* 必须 await：notifySessionLost 里含 webhook 与微信的 fetch，裸甩会在 SW 回收时
       被截断，丢的正是"会话掉线"这条。行为通道里同一调用点本来就是 await */
    if (act.notify) await notifySessionLost(host);
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
         （带 domain 写入会失败或扩大作用域，__Host- 票据尤其致命）。
         === false：域 cookie，按备份的 domain 写入。
         缺失（v1 旧备份）：无法判定，保持旧行为统一传 domain，比直接丢弃更接近
         升级前的表现 */
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

/* 角标四态集中在这里切换：掉线待重登 "!" 红 > 全局暂停 "‖" 灰 > 监控数量 蓝 > 无任务空 */
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
  /* await 而不是 void：postWebhook 里是 fetch，要挂在被 await 的链路上，
     否则 SW 回收会截断请求 */
  await notifyOut("task-stopped", {
    content: chrome.i18n.getMessage("notifStopped"),
    host: hostOf(url) || "",
    url: url || "",
    reason: reason || "tab-gone",
  });
}

/* URL 必须在 stopTask 之前取：任务记录删掉之后就拿不到了 */
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
  await notifyOut("session-lost", {
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
     永远等不到清理，会留下僵尸任务 */
  if (!tab) {
    await stopTaskWithNotice(tabId, "tab-gone");
    return;
  }
  if (tasks[tabId].autoPaused) return; /* 错误页/验证墙自动暂停：alarm 已由 armRefresh 续跑，等恢复 */
  const settings = await getSettings();
  /* 真人 60 秒内在该页操作过就跳过本次刷新（合成事件 isTrusted 为 false，不会误报）。
     是跳过而不是重置计时：重置会被用户操作无限期推迟，违背盯变化的用途。
     时间戳存会话态，否则 SW 回收后该开关基本无效 */
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
  /* 掉线行为信号：任务页最终落在登录页 URL，说明服务器把你重定向去登录了。
     监控对象本身就是登录页时此信号不适用（会永远命中） */
  const cur = changeInfo.url || (await chrome.tabs.get(tabId).catch(() => null))?.url || "";
  const loginSuspect = looksLikeLoginPage(cur) && !looksLikeLoginPage(task.url);
  await reportSessionSignal(siteRoot(hostOf(task.url)), hostOf(task.url), loginSuspect);
  await backupCookies(tabId);
  await refreshTaskUrl(tabId);
  void startDetectChain(tabId); /* 关键词检测链（立即 + 3s + 10s 有界重采样） */
  /* 保活与活动监听：每次加载完成同步注入与配置 */
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

/* 延迟认领窗口：等 RECLAIM_WATCH_MS，期间任何标签页导航到目标网址即认领成功，
   救"会话恢复晚到"或"先跳 SSO 才到位"的页面，避免无谓重开 */
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

/* 浏览器启动或扩展安装时：恢复 cookie → 把任务重新挂接到会话恢复出来的标签页 →
   失效任务兜底重开。
   adoptLegacyUrls 仅在扩展安装/更新时为真：那时浏览器没重启、tabId 仍有效，
   可以给 v1.4.3 及更早（任务里只有间隔和创建时间、没有网址）的旧任务补记当前网址；
   浏览器重启后 tabId 已重新分配，旧 ID 会撞上无关标签页，无法辨认目标，只能淘汰 */
async function prune(adoptLegacyUrls = false) {
  /* 等待会话恢复的标签页出现，避免误判失效或重复打开 */
  await new Promise((resolve) => setTimeout(resolve, 1500));

  /* 清理 v1.4.1 及之前“单一对象”格式的旧备份 */
  await chrome.storage.local.remove("cookieBackup");

  const settings = await getSettings();

  /* 按注册域恢复所有备份主机（含 SSO 登录所在的兄弟子域），不再只按任务网址的精确主机。
     开关关闭时跳过，遗留备份由下方锁内的 pruneCookieBackups 清掉 */
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
       可能撞上无关的新标签页），只有网址一致才保留。无网址的旧任务按
       adoptLegacyUrls 决定补记网址还是淘汰 */
    const claimed = new Set();
    /* 未认领任务的旧 alarm 先记账、setTasks 落盘之后再清：
       SW 中途回收时宁可留"有 alarm 没任务"（onAlarm 找不到任务会自清），
       也不能留"有任务没 alarm"的僵尸 */
    const staleAlarms = [];
    /* 待处理集合：认领写入 tasks[match.id] 之前必须确认该 id 不再是别的未处理任务的键，
       否则两个任务撞同一页时，后者会被覆盖而静默丢失 */
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
      /* 重映射时跳过已被其他任务认领、或仍是其他未处理任务键的页面：
         同一网址开在多个标签页时，一个页面只挂一个任务，认领不到的走下方重开 */
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
    /* 清理时对照落盘后的最终键集合：延后清理若不看最终键集合，会把本轮刚 arm 的 alarm
       （id 恰好曾是别的任务的键：tabId 互换、watch 等回原 id、Chrome 复用 id）
       一并清掉，产出"任务在、永不刷新"的僵尸 */
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

/* 显式传参而不是直接 addListener(prune)：onInstalled 会把事件详情对象当第一个实参传进来，
   会被 adoptLegacyUrls 当成真值 */
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

/* 设置变化后按需收敛：只在保活、心跳、活动监听、防休眠这几个开关真变化时跑，
   否则 rememberLastInterval 这类无关写盘会引发任务页心跳重置风暴 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  /* 失效排在下面两个分支之前：pruneCookieBackups 与 reconcileKeepAlive 都要按新值收敛，
     读到写前的快照会让开关"改了但没生效"，要等下一次事件才纠正 */
  invalidateSettings();
  const o = changes.settings.oldValue || {};
  const n = changes.settings.newValue || {};
  const touched = (k) => o[k] !== n[k];
  /* 关掉"重启后恢复登录"要立刻清掉遗留备份：README 承诺"关闭状态下不备份、不恢复，
     遗留备份也会被自动清除"，而清理原先只发生在 stopTask 与启动 prune 里。
     用户按说明关掉开关后，含 HttpOnly 登录票据的明文 cookie 仍躺在
     chrome.storage.local，落差偏危险方向。pruneCookieBackups 在开关关闭时正是清空全部
     备份，顺带收敛没有任务的探针 */
  if (touched("cookieBackup")) {
    void (async () => {
      try {
        await pruneCookieBackups(await getTasks());
      } catch (e) {
        /* 收敛失败不影响开关本身的生效 */
      }
    })();
  }
  if (!(["keepAlive", "httpHeartbeat", "skipOnActivity", "keepAwake"].some(touched))) return;
  reconcileKeepAlive();
});

/* 错误页与验证墙都让任务级自动暂停。独立于掉线状态机：不进 sessionProbe，
   不污染备份冻结语义。心跳侧 5xx/404 连续 PAUSE_CONFIRM_SAMPLES 次、
   页面侧验证墙特征连续 CAPTCHA_CONFIRM_SAMPLES 次才暂停。
   两侧能否自愈不一样，这是给验证墙定更高阈值的理由：错误页暂停后有独立的心跳 alarm
   兜着（不受暂停影响），回到 2xx 自动解除；验证墙的解除依赖页面再次加载：
   用户过墙后页面跳转即触发本探测复位，若墙页始终不跳转就只能手动恢复。
   暂停期间定时器照常续跑（onAlarm 早退），恢复零重建。
   探测受 settings.captchaGuard 控制，默认开 */
async function probeCaptcha(tabId) {
  try {
    if (!(await getSettings()).captchaGuard) return; /* 关闭时不注入、不判定 */
    const task = (await getTasks())[tabId];
    if (!task) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        /* 只认"整页就是验证墙"的信号：文档标题，以及挑战域名的 iframe/script。
           刻意不扫正文：正文里出现"验证码""access denied"这类日常词（登录框提示、
           帮助文案、页脚）会把正常页误判成墙，而误暂停后刷新循环停下、页面不再加载、
           本探测也不再运行，任务就一直卡在暂停态。标题是墙页最稳定的特征。
           401/403 的登录墙语义另走掉线通道，这里不重复判定 */
        const s = (document.title || "").slice(0, 300).toLowerCase();
        let hit = /(captcha|verify you are human|human verification|just a moment|attention required|pardon our interruption|安全验证|人机验证|验证码)/.test(s);
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
    /* 连击计数同样存会话态：验证墙随刷新周期（≥30 秒）才探一次，SW 早被回收，
       内存计数永远到不了阈值 */
    const s = await rtBump(rtTab(RT_CAPTCHA, tabId));
    if (s >= CAPTCHA_CONFIRM_SAMPLES) await pauseTaskAuto(tabId, "captcha");
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
  await notifyOut("task-paused", {
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
        /* 两头都要失效。读之前：msg.settings 是增量，合并基座必须是盘上的当前值，
           拿过期快照会把用户这次没碰的开关按旧值写回去。
           写之后：onChanged 回流有延迟，中间任何读取都不该再拿到写前的值。
           弹窗的"发送测试消息"会 await 到这里 sendResponse 才发出，正是靠这一次失效
           才读得到刚填的凭据（2.0.0 修过的时序竞态，不能被缓存重新引入） */
        invalidateSettings();
        const settings = await getSettings();
        await chrome.storage.sync.set({
          settings: Object.assign({}, settings, msg.settings)
        });
        invalidateSettings();
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
      } else if (msg.type === "wechat-test") {
        /* 弹窗的"发送测试消息"：填完凭据立刻能验证，不用等某个事件真的发生。
           载荷为空即可，测试消息的正文取自 wechatTestBody，不由调用方给句子 */
        await postWechat("test", {}, { ignoreToggle: true });
        const r = await chrome.storage.local.get(WX_LAST_KEY);
        sendResponse({ ok: true, result: r[WX_LAST_KEY] || null });
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
