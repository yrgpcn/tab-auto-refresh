/* 标签页定时刷新 · Manifest V3 后台 service worker（ES module） */

import { PREFIX, PRESETS, DEFAULT_SETTINGS, HB_PREFIX, SKIP_RT_PREFIX } from "./shared/config.js";
import {
  RESTRICTED_URL,
  ACTIVITY_SKIP_MS,
  ALARM_ACT,
  aggregateBadgeFacts,
  aggregateFrameHits,
  applyBackupAction,
  buildTokenRequest,
  buildWechatMessage,
  capCookies,
  clampInterval,
  decideAlarmAction,
  decideBadge,
  decideWallFromFrames,
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
  outboundUrl,
  parseKeywords,
  pickKnownSettings,
  planBackupConvergence,
  planPrune,
  looksLikeLoginPage,
  sameSite,
  siteRoot,
  shouldAdoptTaskUrl,
  tabShowsUrl,
  tokenFresh,
  webhookResultOf,
  wechatConfigState,
  wechatErrorKey,
  wechatTitleOf,
  SESSION_LOST_CONFIRM_SAMPLES,
  SESSION_LOST_NOTIFY_MS,
} from "./shared/logic.js";

/* cookie 备份按主机分键存储，避免多站点并发备份时互相覆盖。
   找备份只有一招：get(null) 全量读后按前缀过滤。不建主机名清单——清单少一条，
   那条明文存档就对任何删除路径都不再可见，而清理的判据必须是存档实况 */
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

/* 系统通知的 ID 一律由这里生成。两个原因：Chrome 按 ID 去重与替换，而"点通知跳到对应
   标签页"和"情况解决了就把通知收掉"都要能从 ID 反解出对象；原先四处字符串字面量各写
   一份，改一处就会让另一处反解失败，而且是静默失败。
   session-lost 带的是注册域而不是 tabId：同一站点开几个标签页都只该有一条掉线通知，
   点击时再按根域反查在监控它的哪个标签页 */
const NOTIF_ID = {
  keywordHit: (tabId) => "keyword-hit-" + tabId,
  taskStopped: (tabId) => "refresh-stopped-" + tabId,
  taskPaused: (tabId) => "task-paused-" + tabId,
  sessionLost: (root) => "session-lost-" + root
};
/* ID 里直接带 tabId 的前缀，点击跳转按这张表反解 */
const NOTIF_TAB_PREFIXES = ["keyword-hit-", "refresh-stopped-", "task-paused-"];
const NOTIF_SESSION_PREFIX = "session-lost-";

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
   写盘有两个失效点（patchSettings 读之前、写之后各一次）加上 storage.onChanged，漏一个
   就会读到过期快照。新增的 sync 设置写入一律走 patchSettings，别自己 get/set：
   它同时管住失效与两个入口之间的交错（见下面 withSettingsLock）。唯一不经它的是
   local→sync 迁移那一次整份写入，原因写在 loadSettings 里 */
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
    /* patchSettings 之外仅剩的一个 sync 写点，刻意不走它：它写的是整份规范化结果，且只在 sync 为空时
       发生一次，没有"读别人刚写的基座"要串行；更要紧的是这里在 getSettings 的调用栈里，
       而 patchSettings 正是锁内调 getSettings——改成走它就是自己等自己死锁 */
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

/* settings 的读-改-写走另一把锁，理由与上面同形：`getSettings()` → `Object.assign` →
   整份 `sync.set` 这条链有两个入口（点"开始"的 rememberLastInterval、切开关的 save-settings），
   各自读一份合并基座再整份写回，交错时后落地的会把前一条刚改的值按旧值写回去——
   表现为"我明明勾了，它又自己弹回去"。invalidateSettings() 只保证读到最新落盘值，
   管不了两个读-改-写之间的交错，所以必须串行。
   锁内只碰存储与快照，绝不排队等 withTaskLock，两把锁不会互相等死
   （rememberLastInterval 确实是在任务锁里被 await 的，那是单向等待）。
   这个方向由 tests/tab-auto-refresh/settings-cache.test.mjs 的「手动起任务与切开关并发」钉住 */
let settingsQueue = Promise.resolve();
function withSettingsLock(fn) {
  const run = settingsQueue.then(fn);
  settingsQueue = run.then(() => {}, () => {});
  return run;
}

/* settings 唯一的写入口。partial 给对象就是直接合并；给函数则按当前设置决定增量，
   返回 null 表示"这次不用写"——判断与写盘在同一把锁里，所以"没变就不写"不会被并发写打断。
   两头各失效一次：读之前不失效会拿过期快照当基座，把用户这次没碰的开关按旧值写回去；
   写之后不失效则 onChanged 回流前的一切读取都还是写前的值（弹窗"发送测试"await 到这里，
   正是靠这一次才读得到刚填的凭据） */
function patchSettings(partial) {
  return withSettingsLock(async () => {
    invalidateSettings();
    const settings = await getSettings();
    const delta = typeof partial === "function" ? partial(settings) : partial;
    if (!delta) return settings;
    const merged = Object.assign({}, settings, delta);
    await chrome.storage.sync.set({ settings: merged });
    invalidateSettings();
    return merged;
  });
}

/* 掉线探测的行为通道（思路与 staying_alive 一致）：任务页落在登录页 URL、
   心跳被重定向到登录页或返回 401/403，都计为疑似，连续
   SESSION_LOST_CONFIRM_SAMPLES 次确认，一次正常信号即恢复，与状态通道各自独立计数。
   确认后角标变红、发通知（按 6 小时节流），并让 backupCookies 拒绝写入坏备份。
   本函数不经 withTaskLock：它的三个调用点（任务页加载、心跳）都在锁外，而探针写的是
   `sessionProbe` 不是 `tasks`。探针写入碰撞的后果只是计数偏差 1，可以接受 */
async function reportSessionSignal(root, host, suspect) {
  try {
    if (!root) return;
    const data = await chrome.storage.local.get(PROBE_KEY);
    const all = data[PROBE_KEY] || {};
    const p = all[root] || { sus: 0, lost: false, lastNotifiedAt: 0 };
    const stamp = () => (p.sus || 0) + "|" + (p.lost ? 1 : 0) + "|" + (p.lastNotifiedAt || 0);
    const before = stamp();
    const wasLost = !!p.lost;
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
      /* 重新登录成功就把"待重登"那条通知收掉：角标已经变回蓝色，通知中心里留着
         是让人去登一个已经登录上的站点。只在从 lost 翻回正常的那一刻清一次 */
      if (wasLost && !p.lost) clearNotice(NOTIF_ID.sessionLost(root));
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
async function startTask(tabId, seconds, keyword, keepWatching) {
  const { seconds: safe } = clampInterval(seconds);
  const done = await withTaskLock(async () => {
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
    /* 写盘之后紧接着挂两条定时器，中间不许插任何可失败的等待（A15）。
       反过来排会把"任务已落盘、alarm 一条没有"的窗口撑到几十秒：SW 正在等网络时被回收，
       就没有人来补挂，任务从此只躺在清单里永不刷新。ensureHeartbeat 排在 setTasks 之后
       是同一条纪律的另一半——它按落盘后的键读任务，早于写盘会读到"这个 id 没任务"而把心跳清掉 */
    await armRefresh(tabId, safe);
    await ensureHeartbeat(tabId);
    /* 重新开始就是新的一轮：这个标签页上旧的命中/停止/暂停通知都已经不成立，
       留着等于让用户对着上个周期的结论做判断。
       不清 session-lost：那是站点级状态，与本标签页重不重启无关 */
    clearNotice(NOTIF_ID.keywordHit(tabId));
    clearNotice(NOTIF_ID.taskStopped(tabId));
    clearNotice(NOTIF_ID.taskPaused(tabId));
    /* 上一轮的结论不止通知：连击计数与 rt:skip 同样要作废（A17）。只清通知等于漏了另一半——
       用户在同一个标签页上改个间隔再点开始，rt:captcha 还留着 2，下一面墙只需一次命中
       就把任务停了（本该三次）。rt:activity 按 rtRoundKeys 里写的理由留着 */
    await rt(() => chrome.storage.session.remove(rtRoundKeys(tabId)));
    await syncKeepAliveConfig(tabId);
    await chrome.storage.local.set({ pausedAll: false });
    await updateBadge();
    await rememberLastInterval(safe);
    return { safe };
  });
  /* 开启任务时立即备份一次，避免首次刷新前关闭浏览器导致无备份可恢复。
     这一拍排在锁外（A15）：backupCookies 一旦走到掉线确认，就会一路 await 到
     notifyOut 的两笔 fetch（15 秒超时，微信还要先取一次令牌），而任务锁是全站共享的——
     压在锁上等网络时，别的标签页连"开始/停止"都要排在它后面几十秒。
     仍然 await 而不裸甩：那笔外发丢的正是"会话掉线"这条通知 */
  await backupCookies(tabId);
  return done;
}

function stopTask(tabId) {
  return withTaskLock(async () => {
    const tasks = await getTasks();
    if (!tasks[tabId]) return;
    stopKeepAlive(tabId);
    detectChains.delete(tabId); /* 终止该页在飞的关键词检测链 */
    /* 只清"自动暂停"那条：任务都没了，暂停中的提示留着也无法处理。
       不清 keyword-hit 与 task-stopped：前者往往是 stopTask 的起因（命中即停是默认行为），
       在这里清等于把用户刚收到的那条通知立刻撤回；后者正是这次停止本身的通知 */
    clearNotice(NOTIF_ID.taskPaused(tabId));
    /* 运行时状态一并清（会话态）：真假人活动时间戳、错误/验证墙连击与 rt:skip 都归属该标签页。
       最后一条其实不清也不会显示（弹窗只按在场任务读这一族键），但它一个标签页一行地
       在会话态里攒着，停任务时顺手一起删。清单只有一个来源，见 rtTabKeys */
    await rt(() => chrome.storage.session.remove(rtTabKeys(tabId)));
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
  const dropped = [];
  for (const root of Object.keys(all)) {
    if (roots.has(root)) kept[root] = all[root];
    else dropped.push(root);
  }
  if (dropped.length > 0) {
    await chrome.storage.local.set({ [PROBE_KEY]: kept });
    /* 站点不再被任何任务监控，它的"待重登"通知已经没有落点：按根域生成的 ID
       不随任务消失，只能在这里跟着探针一起收掉 */
    for (const root of dropped) clearNotice(NOTIF_ID.sessionLost(root));
  }
}

/* 备份存档的唯一读法：一次全量读，按前缀过滤出实际存在的存档。
   chrome.storage.local.get 不支持通配符，拿键名只能整仓读回来。存档封顶 20 站 × 200 条，
   最坏一次要反序列化几 MB 明文进 SW——但代价止于慢：换成"只读清单上那几条"的定向读，
   清单漏一条就是丢登录态，而且丢的是没有任何本地症状的一种（见 pruneCookieBackups） */
async function readBackupEntries() {
  const raw = await chrome.storage.local.get(null);
  const entries = [];
  for (const [key, entry] of Object.entries(raw || {})) {
    if (!key.startsWith(COOKIE_BACKUP_PREFIX)) continue;
    entries.push({ key, host: key.slice(COOKIE_BACKUP_PREFIX.length), entry });
  }
  return entries;
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
  const entries = await readBackupEntries();
  if (!(await getSettings()).cookieBackup) {
    if (entries.length > 0) await chrome.storage.local.remove(entries.map((e) => e.key));
    return;
  }
  const now = Date.now();
  const fresh = [];
  const stale = [];
  for (const { key, host, entry: value } of entries) {
    const root = siteRoot(host);
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
/* 错误页与验证墙的确认次数。"用户操作后跳过刷新"的窗口长度在 shared/logic.js 的
   ACTIVITY_SKIP_MS，因为它是 decideAlarmAction 的判据 */
const PAUSE_CONFIRM_SAMPLES = 2;
/* 验证墙的阈值单独放宽到 3：它只看页面标题，采样节奏跟着刷新周期（≥30 秒），
   而错误页有独立的 4 分钟心跳通道且能自愈，两者误判的代价不对称（见 probeCaptcha） */
const CAPTCHA_CONFIRM_SAMPLES = 3;

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
/* 上一拍到点被跳过的 {reason, at}（A12）。放会话态而不是 local：它每拍都在重写，
   而 local 是每个刷新周期都要动的键区；它的寿命也不超过这次浏览器会话 */
const RT_SKIP = SKIP_RT_PREFIX;
/* 这一轮浏览器会话的启动恢复（prune）跑完没有。弹窗那条清理网按它决定动不动手（A16）：
   没跑完之前"取不到标签页"完全可能只是会话恢复还没到，这时候删任务等于把用户正在恢复的
   监控静默停掉。放会话态与它要回答的问题同寿命——活过 SW 回收（弹窗可能在 prune 跑完之后
   很久才打开，那时这个实例是新的），随浏览器重启清零（下一轮恢复要重新等） */
const RT_PRUNE_DONE = "rt:pruneDone";
const rtTab = (base, tabId) => base + ":" + tabId;
/* 一个标签页在会话态里的键分两份清单（A17）。rtRoundKeys 是"上一轮的结论"：两条连击计数
   加上"上次到点为什么被跳过"。凡任务搬离一个 id、或在同一个 id 上重新开始，这几条就都不成立
   了，必须作废——残留最阴的地方是它不报错，只是让阈值悄悄变低（还剩 2 时一次命中就暂停）。
   rt:activity 刻意不在里面：它是"用户最后一次真在这个页面上操作"的事实，重开一个监控周期
   并不改变这个事实，跟着清反而会让下一次到点立刻刷到用户眼前；它自己按 ACTIVITY_SKIP_MS 过期。
   两份清单是包含关系，新增一族按标签页存放的会话态键只要进 rtRoundKeys，
   停任务与重开标签页那两处就自动跟着清。由 tests/tab-auto-refresh/rt-lifecycle.test.mjs 扫源码钉住 */
const rtRoundKeys = (tabId) => [RT_ERROR, RT_CAPTCHA, RT_SKIP].map((base) => rtTab(base, tabId));
const rtTabKeys = (tabId) => [rtTab(RT_ACTIVITY, tabId), ...rtRoundKeys(tabId)];

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

async function rtRemove(key) {
  await rt(() => chrome.storage.session.remove(key));
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

/* 关闭验证墙保护时收敛已经被它暂停的存量任务。不能等 probeCaptcha：自动暂停的
   refresh alarm 只会 SKIP，页面不再加载，探测链永远没有下一次机会自行解除。 */
async function reconcileCaptchaGuard() {
  try {
    /* 回流是异步的：若用户在这项收敛排队期间又打开守卫，不能拿旧事件把新设置撤回。 */
    if ((await getSettings()).captchaGuard) return;
    const tasks = await getTasks();
    await Promise.all(
      Object.entries(tasks)
        .filter(([, task]) => task && task.autoPaused && task.autoPaused.reason === "captcha")
        .map(([tabId]) => resumeTaskAuto(Number(tabId)))
    );
  } catch (e) {
    console.warn("reconcile captcha guard failed:", e);
  }
}


/* 快捷键没有显式间隔，复用最近一次手动任务的实际间隔 */
async function rememberLastInterval(seconds) {
  try {
    /* 只有手动建任务会走到这里（startTask），不是每个刷新周期。
       "没变就不写"的判断放进 patchSettings 的函数式增量里，与写盘同处一把锁：
       在外面先读再判，读到的可能不是落盘时的基座，等于把这条链又变回无锁读-改-写 */
    await patchSettings((s) => (s.lastIntervalSec === seconds ? null : { lastIntervalSec: seconds }));
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

/* 多框架注入的检测脚本。allFrames 的失败方式是整次调用 reject：一个够不着的子框架
   （沙箱框架、view-source）就能把整页的检测结果一起带走，所以拒了之后退回顶层再试一次
   （frameIds:[0] 就是顶层框架）。加多框架只该增加覆盖面，不该因为某个子框架进不去
   反而丢掉原来单框架能成的场景。两次都失败才抛给调用方 */
async function executeInAllFrames(base) {
  try {
    return await chrome.scripting.executeScript(Object.assign({}, base, { allFrames: true }));
  } catch (e) {
    return await chrome.scripting.executeScript(Object.assign({}, base, { frameIds: [0] }));
  }
}

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
      const results = await executeInAllFrames({
        target: { tabId },
        func: matchInPage,
        args: [keywords],
      });
      /* 各框架的命中集合并、按首次出现顺序去重；一个框架都没取到才回 null */
      present = aggregateFrameHits(results).present;
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
    .create(NOTIF_ID.keywordHit(tabId), {
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
   外加 type/url/host/ts，让各家认的字段都能对上（url 到这儿时已被 notifyOut 剪成
   origin+pathname，query 不在外发面上）。
   ntfy 不在此列：它只在根端点解析 JSON，POST 到 /<主题> 会把整个 JSON 当正文存下，
   而载荷里没有 topic 字段、也改不了填根端点，所以它收到的是原始 JSON 文本。
   调用方必须 await：fetch 要挂在被 await 的链路上，否则 SW 被回收时请求会被截断

   结果一律留痕在 chrome.storage.local 的 webhookLastResult，与微信的 wechatLastResult 对等：
   原先 fetch 回来连状态码都不看，Discord 的 hook 被删、Slack 的频道被踢都算成功，
   用户以为"配好了、在发"。两种"本该不发"的早退刻意不留痕——没配地址、事件没勾上，
   写一笔反而把"这个出口是关着的"说成失败 */
const WH_LAST_KEY = "webhookLastResult";

/* 最近一次 webhook 投递结果（弹窗据此给可见反馈）。只留最近一次，不堆积 */
async function setWebhookResult(result) {
  try {
    await chrome.storage.local.set({
      [WH_LAST_KEY]: Object.assign({ at: Date.now() }, result),
    });
  } catch (e) {
    /* 反馈写不进去不能反过来影响推送本身 */
  }
}

async function postWebhook(event, payload, opts) {
  try {
    const settings = await getSettings();
    const url = normalizeWebhookUrl(settings.webhookUrl);
    if (!url) return;
    /* ignoreToggle 与微信侧同义：弹窗的"发送测试"只看地址合不合法。
       webhook 没有总开关（地址非空即开），所以这里绕过的只有事件勾选 */
    const forced = !!(opts && opts.ignoreToggle);
    const events = notifyEventsOf(settings);
    if (!forced && !events.includes(event)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let status = null;
    let text = "";
    try {
      const body = Object.assign({ type: event, ts: Date.now() }, payload);
      body.content = payload.content || "";
      body.text = payload.text || payload.content || "";
      body.body = payload.body || payload.content || "";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      status = res.status;
      /* 只在 2xx 这一路读正文：那一路要靠正文里的 "ok":false 才认得出
         "状态码说成功、接收端说没有"。非 2xx 按状态码归桶就够了，不必再信第三方写的字 */
      if (res.ok) text = await res.text().catch(() => "");
    } finally {
      clearTimeout(timer);
    }
    const verdict = webhookResultOf(status, text);
    await setWebhookResult(Object.assign({ event }, verdict));
  } catch (e) {
    /* 到这里只剩"根本没拿到应答"：网络被拒、DNS 失败、15 秒到点 abort。
       与微信侧同一处理——失败要留痕，但绝不影响主流程 */
    await setWebhookResult({
      ok: false,
      kind: "network",
      status: null,
      errorKey: "webhookErrNetwork",
      event,
    });
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
   调用方必须 await：两条链路都是 fetch，裸甩异步会在 SW 回收时被截断
   载荷里的 url 在这里统一剪成 origin+pathname：被监控页的 query 常带一次性签名、
   会话令牌、邮箱手机号（工单与后台系统尤其如此），而"是哪个站点的哪条路径"这点信息
   origin+pathname 就给得齐。前端哈希路由的页面例外：路由在 hash 里，剪完跳到的是应用根，
   代价与是否要补深链记在 `BACKLOG.md` V1 (g)。
   剪的位置是总入口而不是各调用点，有两个理由：两个出口读的是同一个 payload.url，
   逐处改必然出现"改了 webhook 忘了微信"；将来新增事件不必再记得重复一遍。
   解析不出来（不是合法 URL）就当没有网址可发，原样传出去等于给漏 query 留后门。
   其余字段不在精简之列：host 是刻意的定位信息，keyword 的 text 是用户自己填的监控词 */
async function notifyOut(event, payload) {
  const out =
    payload && payload.url
      ? Object.assign({}, payload, { url: outboundUrl(payload.url) })
      : payload;
  /* 两个出口互不依赖。串行等待会让 webhook 的 15 秒超时把微信也堵住；两条仍须
     await，不能裸甩，否则 MV3 Service Worker 回收会截断尚未完成的投递。各出口自己
     把网络失败收敛成最近一次结果，所以其中一条失败不妨碍另一条完成。 */
  await Promise.all([postWebhook(event, out), postWechat(event, out)]);
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

/* 登录完成后地址通常离开登录页；保持任务里的网址最新，自动重开才会打开实际页面。
   判据是纯函数 shouldAdoptTaskUrl：同站、且新地址不是登录页（A14） */
function refreshTaskUrl(tabId) {
  return withTaskLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tasks = await getTasks();
    const t = tasks[tabId];
    if (!tab || !tab.url || !t || !t.url) return;
    if (shouldAdoptTaskUrl(t.url, tab.url)) {
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

/* 角标集中在这里刷新。哪一态赢、给什么颜色与文字全在 shared/logic.js 的 decideBadge，
   四件事实怎么从任务与探针里推出来也全在那一侧的 aggregateBadgeFacts；
   这一段只读盘、把返回值递过去、再写盘 */
async function updateBadge() {
  void applyKeepAwake(); /* 任务增删/暂停的所有路径都经过这里 */
  try {
    const [tasks, paused, probeData] = await Promise.all([
      getTasks(),
      isPausedAll(),
      chrome.storage.local.get(PROBE_KEY),
    ]);
    const facts = aggregateBadgeFacts({ tasks, probes: probeData[PROBE_KEY] || {}, pausedAll: paused });
    const { color, text } = decideBadge({
      probeLost: facts.probeLost,
      autoPaused: facts.autoPaused,
      pausedAll: facts.pausedAll,
      count: facts.count,
    });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    /* 角标失败不影响任务 */
  }
}

/* 收通知的唯一入口。什么时候收哪一条，写在各自的调用点上（startTask / stopTask /
   resumeTaskAuto / reportSessionSignal / pruneStaleProbes），判据都是"这条通知还成不成立"
   而不是"任务还存不存在"。ID 已不存在时 Chrome 返回 false，不抛错 */
function clearNotice(id) {
  try {
    Promise.resolve(chrome.notifications.clear(id)).catch(() => {});
  } catch (e) {
    /* 系统通知整体不可用：没有可清理的东西，也不需要上报 */
  }
}

function notifTabId(id) {
  for (const p of NOTIF_TAB_PREFIXES) {
    if (id.startsWith(p)) {
      const n = Number(id.slice(p.length));
      return Number.isInteger(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

/* 把某个标签页带到前台。通知点开的用途就是"人过去了，接着处理"，
   所以跳转失败（标签页早就关了）只要不抛错即可，不给任何提示 */
async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || typeof tab.id !== "number") return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  try {
    clearNotice(id); /* 点过就算处理过了，不留到用户手动划掉 */
    const tabId = notifTabId(id);
    if (tabId !== null) {
      await focusTab(tabId);
      return;
    }
    if (!id.startsWith(NOTIF_SESSION_PREFIX)) return;
    /* 掉线通知的 ID 带的是注册域：跳到正在监控这个站点的任一标签页，让用户去重新登录 */
    const root = id.slice(NOTIF_SESSION_PREFIX.length);
    const tasks = await getTasks();
    const hit = Object.keys(tasks).find((k) => siteRoot(hostOf(tasks[k].url)) === root);
    if (hit) await focusTab(Number(hit));
  } catch (e) {
    /* 点击跳转是锦上添花，绝不能在监听器里抛未处理拒绝 */
  }
});

async function notifyTaskStopped(tabId, url, reason) {
  chrome.notifications
    .create(NOTIF_ID.taskStopped(tabId), {
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

/* 服务器端会话失效提醒：cookie 备份只能恢复票据，救不回已注销的会话。
   通知 ID 一律归一到注册域：调用方可能给整页主机名（www.example.com）也可能给根域，
   不归一的话一次掉线会因为 SSO 在兄弟子域上而发出两条几乎一样的通知，
   而点击跳转与恢复时的清理都按根域反查，对不上就是静默失效。正文照旧显示调用方给的主机 */
async function notifySessionLost(host) {
  const root = siteRoot(host) || host;
  chrome.notifications
    .create(NOTIF_ID.sessionLost(root), {
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

/* 这个标签页此刻是不是正被用户看着：它是所在窗口的活动页，且那个窗口是焦点窗口。
   这是 skipOnActivity 不依赖注入的第二条通道——内容脚本注入失败（受限页、时序、
   站点权限）时该页永不上报活动，只靠时间戳就会在用户眼皮底下把页面重载掉。
   焦点窗口 id 跟着 windows.onFocusChanged 记；SW 刚起来还没有事件时补查一次 getLastFocused。
   认不出来一律返回 false：宁可多刷一次，也绝不能反过来变成"永远不刷新"。
   不需要新权限，tabs 已经给到 tab.windowId */

/* 三态，不能压成两态：
   undefined = 这个 SW 实例还没收到过任何焦点事件，焦点在哪真不知道；
   null      = 最后一个事件是 WINDOW_ID_NONE，浏览器确实不在前台；
   数字      = 那个窗口正有焦点。
   把后两者合并成一个 null 会出事：Chrome 在焦点去了别的应用之后，getLastFocused() 仍然
   返回最后聚焦的那个窗口（只有"一个窗口都没有"才 reject），于是"已知不在前台"会被这次补查
   重新填成 tab.windowId，用户走开期间的每一次触发都判成"人正看着这页"，任务从此不再刷新——
   恰好是上面那句"绝不能变成永不刷新"的反面。 */
let focusedWindowId;
chrome.windows.onFocusChanged.addListener((id) => {
  focusedWindowId = typeof id === "number" && id !== chrome.windows.WINDOW_ID_NONE ? id : null;
});

async function isTabOnScreen(tab) {
  if (!tab || !tab.active || typeof tab.windowId !== "number") return false;
  if (focusedWindowId === null) return false; /* 已知浏览器不在前台：照刷 */
  if (focusedWindowId === undefined) {
    /* 冷启动且还没有焦点事件，补查这一次。reject（没有任何窗口）与"不在前台"同样放行 */
    const w = await chrome.windows.getLastFocused().catch(() => null);
    focusedWindowId = w && typeof w.id === "number" ? w.id : null;
    if (focusedWindowId === null) return false;
  }
  return focusedWindowId === tab.windowId;
}

/* 定时器触发：刷新类 alarm 走刷新并重新 arm；心跳 alarm 走静默请求。
   "到点之后该做什么"的判断全部在 shared/logic.js 的 decideAlarmAction 里，
   这里只负责把事实取齐（任务、标签页、设置、活动时间戳）再把结论执行掉一遍。
   次序不能调换的两条（pausedAll 早于标签页存在性、存在性早于 autoPaused）写在纯函数侧 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(HB_PREFIX)) {
    await doHeartbeat(Number(alarm.name.slice(HB_PREFIX.length)));
    return;
  }
  if (!alarm.name.startsWith(PREFIX)) return;
  const tabId = Number(alarm.name.slice(PREFIX.length));
  const [tasks, pausedAll] = await Promise.all([getTasks(), isPausedAll()]);
  const task = tasks[tabId];
  if (!task) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  /* 每次触发重新 arm：重算抖动窗口（周期 alarm 只兜底，主循环节奏由重 arm 决定）。
     暂停与自动暂停期间也续跑，恢复时零重建 */
  await armRefresh(tabId, task.intervalSec);
  const [tab, settings] = await Promise.all([
    chrome.tabs.get(tabId).catch(() => null),
    getSettings()
  ]);
  /* 真人活动的时间戳存会话态：SW 一回收内存就没了，60 秒跳过窗口会失效 */
  const lastActivity = Number(await rtGet(rtTab(RT_ACTIVITY, tabId))) || 0;
  const verdict = decideAlarmAction({
    task,
    tab,
    pausedAll,
    skipOnActivity: settings.skipOnActivity,
    skipDiscarded: settings.skipDiscarded,
    lastActivityAgoMs: lastActivity ? Date.now() - lastActivity : Infinity,
    /* 可见性只有 skipOnActivity 开着时才用得上，未开就别为每次触发多问两回窗口焦点 */
    tabIsVisible: settings.skipOnActivity ? await isTabOnScreen(tab) : false
  });
  if (verdict.action === ALARM_ACT.STOP) {
    await stopTaskWithNotice(tabId, verdict.reason);
    return;
  }
  if (verdict.action === ALARM_ACT.SKIP) {
    /* 到点了却没刷新，用户在弹窗里只看得到倒计时一遍遍归零——四种跳过理由原先一律不留痕，
       "任务没在刷"只能靠猜（A12）。把最近一次的理由与时刻留在会话态，任务行才有地方说一句
       "上次跳过：你在看这页"，A1 那个误判正是藏在这个看不见里 */
    await rtSet(rtTab(RT_SKIP, tabId), { reason: verdict.reason, at: Date.now() });
    return;
  }
  if (verdict.action !== ALARM_ACT.RELOAD) return;
  /* 真的刷了这一拍，上一条解释就作废：留着它，弹窗会一直挂着一句过期的理由 */
  await rtRemove(rtTab(RT_SKIP, tabId));
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
    /* 旧 id 的会话态整批跟着拆（A17）：连击计数与活动戳都按 tabId 存，任务搬走之后就没人再读它们，
       而同一次浏览器会话里 tabId 不回收，反复重开就一路攒脏键。更要紧的是新 id 要一份干净的现场
       ——不然是把"差一次就暂停"的旧计数搬过去接着数。
       排在写盘之前：setTasks 到 armRefresh 之间那段是"写完紧接着挂"的窗口，不往里添新的等待 */
    await rt(() => chrome.storage.session.remove(rtTabKeys(oldTabId)));
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

/* 清理标签页已不存在的任务（弹窗打开时调用）。
   "这一页取不到"与"这一页再也不会回来"是两件事（A16）：浏览器重启后会话恢复晚到的那几秒里
   chrome.tabs.get 就是失败的，而同一时刻并跑的 prune 正因为知道这件事才先等 1500 毫秒、
   再给未认领任务一个共享的认领窗口。两个函数对同一件事的假设不能相反——所以这一条网在
   本轮启动恢复收尾之前一条都不动，交回 prune；真删的时候要发通知，静默消失是这类 bug 里
   最难被用户报告的一种 */
async function cleanupInvalidTasks() {
  const tasks = await getTasks();
  const missing = [];
  for (const key of Object.keys(tasks)) {
    const tabId = Number(key);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) missing.push(tabId);
  }
  if (missing.length && (await rtGet(RT_PRUNE_DONE))) {
    const gone = missing.map((tabId) => ({ tabId, url: tasks[tabId].url || "" }));
    for (const { tabId } of gone) await stopTask(tabId);
    /* 通知排在全部停完之后：notifyTaskStopped 里那一笔外发是 await 的，逐条"停一条发一条"
       会让挂住的网络把后面几条任务的停止一起堵在外面。停要当场停完，留痕晚一点没有代价 */
    for (const { tabId, url } of gone) await notifyTaskStopped(tabId, url);
  }
  await updateBadge();
}

/* 共享的等待窗口：等这批网址里任意一个在任何标签页上到位，全部到位或等满
   RECLAIM_WATCH_MS 就返回。返回与否都不影响正确性——调用方随后会用最新的现场重跑
   planPrune，这里只是给"会话恢复晚到"和"先跳 SSO 才到位"的页面一点时间。
   与原先按任务逐个等的区别：那一版每多一个认领不到的任务就多花整整 20 秒，
   而且整段时间都持着任务锁，弹窗的起停与到点刷新全排在后面 */
function waitForUrls(urls) {
  const wanted = new Set(urls || []);
  if (!wanted.size) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUp);
      resolve();
    };
    const timer = setTimeout(finish, RECLAIM_WATCH_MS);
    function onUp(tabId, changeInfo, tab) {
      if (changeInfo.status !== "complete") return;
      for (const url of wanted) {
        if (tabShowsUrl(tab, url)) {
          wanted.delete(url);
          break;
        }
      }
      if (!wanted.size) finish();
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
    const backups = await readBackupEntries();
    /* 先收敛历史越界备份，再恢复。反过来不行：restoreCookies 按每条自己的 domain 写回浏览器，
       先恢复等于已经替别家站点复活了一遍登录态，之后删存档也收不回来 */
    const conv = planBackupConvergence(backups);
    if (conv.remove.length) await chrome.storage.local.remove(conv.remove);
    if (conv.rewrite.length) {
      await chrome.storage.local.set(
        Object.fromEntries(conv.rewrite.map((r) => [r.key, r.entry]))
      );
    }
    for (const { host } of backups) {
      const root = siteRoot(host);
      if (!root || !taskRoots.has(root)) continue;
      if (await restoreCookies(host)) restoredRoots.add(root);
    }
  }

  /* 会话恢复后 tabId 会重新分配：把任务重新挂接到正在打开的标签页，挂不上就先给页面一点
     时间到位，仍然挂不上才按记录的网址重开。顺序决策全部在 planPrune（shared/logic.js）
     里，本函数只负责浏览器调用——那套规则因此能被单测直接断言，而不是靠读代码推断。 */
  const first = planPrune({
    tasks: await getTasks(),
    tabs: await chrome.tabs.query({}),
    adoptLegacyUrls
  });
  /* 认领不到的先等一轮。原先是每个候选各等 20 秒且全程持着任务锁，5 个未认领任务能让
     弹窗与刷新停摆 100 秒；这里改成所有候选共享一个上限窗口 */
  if (first.watch.length) await waitForUrls(first.watch.map((w) => w.url));

  await withTaskLock(async () => {
    /* 等待期间用户可能起停过任务、页面也可能正好到位了，所以用最新的现场重跑一遍计划：
       等完之后的认领与等不到的重开走的是同一套规则，不需要第二份判断 */
    const plan = planPrune({
      tasks: await getTasks(),
      tabs: await chrome.tabs.query({}),
      adoptLegacyUrls
    });
    const tasks = plan.next;
    /* 先落盘、后挂定时器。反过来会让 ensureHeartbeat 按新 id 读不到任务，
       以为"这个页面没任务了"而把心跳 alarm 清掉——重启后恢复的任务于是只剩刷新、
       没有静默心跳，直到下一次刷新完成才自愈。startTask 与 reopenTaskTab 都是先写后挂 */
    const rearm = plan.remap.map(({ to }) => ({ id: to, restore: true }));
    for (const { url, task } of plan.watch) {
      /* 等过一轮还是不认：按记录的网址重开。任务原样搬过去，
         keywords / onHit / notifiedKeys / autoPaused 都不能在恢复时丢掉 */
      const newTab = await chrome.tabs.create({ url, active: false }).catch(() => null);
      if (!newTab || typeof newTab.id !== "number") continue;
      tasks[newTab.id] = task;
      /* 新建的页面本来就带着恢复好的 cookie 加载，不需要再补一次刷新 */
      rearm.push({ id: newTab.id, restore: false });
    }
    for (const { from } of plan.dropped) {
      /* 浏览器重启后的旧格式任务：目标页面无从辨认，只能淘汰 */
      console.warn("Dropped legacy task without url:", from);
    }
    if (plan.dirty) await setTasks(tasks);
    for (const { id, restore } of rearm) {
      await armRefresh(id, tasks[id].intervalSec);
      await ensureHeartbeat(id);
      /* 会话恢复的页面是在 cookie 恢复之前加载的，补一次刷新让登录态生效 */
      if (restore && restoredRoots.has(siteRoot(hostOf(tasks[id].url)))) {
        chrome.tabs.reload(id).catch(() => {});
      }
    }
    /* 未认领任务留下的 alarm 一律等写盘之后再清，且对照写盘后的最终键集合：
       不看最终键集合会把本轮刚 arm 的 alarm（id 恰好曾是别的任务的键：tabId 互换、
       重开拿到回用的 id）一并清掉，产出"任务在、永不刷新"的僵尸 */
    const liveIds = new Set(Object.keys(tasks));
    for (const id of plan.staleIds) {
      if (liveIds.has(String(id))) continue;
      await chrome.alarms.clear(alarmName(id));
      await chrome.alarms.clear(hbName(id));
    }
    /* 启动时统一淘汰：v1.4.5 前遗留的多余备份、过期备份、超量备份 */
    await pruneCookieBackups(tasks);
  });

  await updateBadge();
  /* 本轮启动恢复收尾（A16）。排在最后：只有整套认领/重挂/重开都走完了，"这一轮会话恢复
     已经过去了"才成立。中途抛错就不写——那种情况下宁可让弹窗的清理网继续推迟（幽灵任务
     多留一会儿），也不要在恢复现场上删任务 */
  await rtSet(RT_PRUNE_DONE, Date.now());
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
  /* 已因 captcha 暂停的任务不会再触发页面加载，不能依赖 probeCaptcha 的自愈分支。 */
  if (touched("captchaGuard") && !n.captchaGuard) void reconcileCaptchaGuard();
  if (!(["keepAlive", "httpHeartbeat", "skipOnActivity", "keepAwake"].some(touched))) return;
  reconcileKeepAlive();
});

/* 页内验证墙探测（executeScript 按 toString 注入，函数必须自包含，约束同 matchInPage）。
   与关键词那条的分工不一样：这里只回原始事实，两条正则一个都不下页面，
   判定全在 logic.js 的 decideWallFromFrames 里做——页内没有判断，就没有"两份实现分叉"，
   整条决策链也就直接被单测断言到了（纪律 1）。具名是为了让门禁能按花括号配对
   从源码里切出这个函数体并真的执行它，不手抄复刻。

   判据面刻意只有标题、自身网址与挑战域名的 iframe/script 资产，不扫正文：正文里出现
   "验证码""access denied"这类日常词（登录框提示、帮助文案、页脚）会把正常页误判成墙，
   而误暂停后刷新循环停下、页面不再加载、本探测也不再运行，任务就一直卡在暂停态。
   标题是墙页最稳定的特征。401/403 的登录墙语义另走掉线通道，这里不重复判定 */
function captchaProbe() {
  const assets = [];
  for (const el of document.querySelectorAll("iframe, frame, script[src]")) {
    /* 封顶加逐条截断：一次 allFrames 注入会让每个框架都回一份，整页上百条脚本时
       不能把跨上下文载荷撑到那个量级。挑战域名总在网址最前部，截不断 */
    if (assets.length >= 50) break;
    assets.push(String(el.getAttribute("src") || "").slice(0, 300));
  }
  return {
    /* 跨源框架里 window.top 只能做同一性比较，访问它的属性会抛，比较本身不抛 */
    top: window.top === window.self,
    title: String(document.title || "").slice(0, 300),
    url: String(location.href || "").slice(0, 300),
    w: window.innerWidth,
    h: window.innerHeight,
    assets
  };
}

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
    if (!(await getSettings()).captchaGuard) {
      /* 关闭时不注入、不判定，但连击要复位（A17）：这一拍确实没确认到墙，把计数留在 2
         等着，等于用户重新打开开关后一次命中就暂停（本该三次）。守卫关着的这段时间里
         页面正常加载过若干次却不清零，就是"开关复位了"和"计数复位了"两件事被分开了 */
      if ((await getTasks())[tabId]) await rtSet(rtTab(RT_CAPTCHA, tabId), 0);
      return;
    }
    const task = (await getTasks())[tabId];
    if (!task) return;
    /* 全部框架都探：整页是墙的挑战页常嵌在一层 iframe 里，顶层文档只剩一个空壳标题，
       只看顶层就检不到 */
    const results = await executeInAllFrames({ target: { tabId }, func: captchaProbe });
    const wall = decideWallFromFrames(results);
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
    .create(NOTIF_ID.taskPaused(tabId), {
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
  if (done) {
    clearNotice(NOTIF_ID.taskPaused(tabId)); /* 暂停的原因已经消失，通知跟着作废 */
    await updateBadge();
  }
}

/* 页面侧唯一会发消息的是注入的 content/keepalive.js，它只用这两种。
   MV3 下普通网页根本到不了 runtime.onMessage，这条守的是同样带 sender.tab 的自己人：
   注入脚本一旦被站点想办法碰到，能起停任务、能整份改设置。把"页面不能做这些"从
   "碰巧没写"变成代码里的约束，代价是一次集合查表。
   反向不守（弹窗发 user-activity / keepalive-query）：前者只认 sender.tab.id，
   弹窗那条自己就空转了，后者是只读的配置快照，拒了反而添乱 */
const FROM_PAGE_TYPES = new Set(["keepalive-query", "user-activity"]);

/* 与弹窗通信 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (sender && sender.tab && !FROM_PAGE_TYPES.has(msg.type)) {
        sendResponse({ ok: false, error: "page sender not allowed: " + msg.type });
        return;
      }
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
        /* 必须走 patchSettings 而不是在这里自己 get/set：它和 rememberLastInterval 是两条
           "读基座 → 整份写回"的链，不串行时后落地的会把前一条刚改的开关按旧值写回去。
           两头失效的契约在 patchSettings 里。弹窗的"发送测试消息"会 await 到这里才发出，
           靠的正是写盘后那次失效（2.0.0 修过的时序竞态，不能被缓存重新引入）。
           白名单放在这个入口而不是 patchSettings 里：msg.settings 是唯一的外部输入，
           内部调用方交来的增量都是源码里写死的键 */
        await patchSettings(pickKnownSettings(msg.settings, DEFAULT_SETTINGS));
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
      } else if (msg.type === "webhook-test") {
        /* 与上一条对等：webhook 原先只有微信有测试按钮，配好之后能不能通只能等事件真发生。
           句子取自 webhookTestBody，不由调用方给——否则弹窗能把任意文本塞进外发载荷 */
        await postWebhook(
          "test",
          { content: chrome.i18n.getMessage("webhookTestBody") },
          { ignoreToggle: true }
        );
        const r = await chrome.storage.local.get(WH_LAST_KEY);
        sendResponse({ ok: true, result: r[WH_LAST_KEY] || null });
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
