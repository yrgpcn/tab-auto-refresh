/* 与浏览器 API 无关的纯逻辑，可被 Node 单元测试直接导入 */

export const MIN_INTERVAL_SEC = 30;
export const DEFAULT_INTERVAL_SEC = 300;

/* 兜底刷新间隔：无效输入与过小值都按最小间隔处理（30 秒起步） */
export function clampInterval(seconds, min = MIN_INTERVAL_SEC) {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n) || n <= 0) {
    return { seconds: min, clamped: false };
  }
  if (n < min) {
    return { seconds: min, clamped: true };
  }
  return { seconds: n, clamped: false };
}

/* 把秒数格式化为本地化的“N 小时 / 分钟 / 秒” */
export function formatInterval(seconds, units) {
  const u = units || { hours: "h", minutes: "min", seconds: "s" };
  if (seconds % 3600 === 0) return seconds / 3600 + " " + u.hours;
  if (seconds % 60 === 0) return seconds / 60 + " " + u.minutes;
  return seconds + " " + u.seconds;
}

/* 剩余毫秒 → mm:ss（超过 1 小时为 hh:mm:ss） */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

/* 从完整 URL 取主机名（纯函数，service worker 与 Node 通用） */
export function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return null;
  }
}

/* 常见多级公共后缀（启发式，覆盖国内外主流站点）；命中则注册域多取一段 */
export const MULTI_SUFFIXES = new Set([
  "gov.cn", "com.cn", "org.cn", "edu.cn", "net.cn", "ac.cn",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "gov.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "co.in", "com.hk", "org.hk", "idv.hk",
  "com.tw", "org.tw", "co.kr", "or.kr", "com.sg", "com.my",
  "com.mx", "co.za", "com.ar", "com.tr", "com.pl"
]);

/* 站点根域（注册域）：a.b.example.com → b.example.com；多级后缀如 news.example.org.cn → example.org.cn */
export function siteRoot(host) {
  if (!host) return null;
  const parts = String(host).toLowerCase().split(".").filter(Boolean);
  /* IPv4 主机不做注册域切片，整串即身份 */
  if (/^\d+(\.\d+){3}$/.test(parts.join("."))) return parts.join(".");
  if (parts.length <= 2) return parts.join(".");
  const cut = MULTI_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-cut).join(".");
}

/* 同一主机或其子域视为同站（比注册域更严格，用于目标网址跟随，避免被带到兄弟 SSO 子域） */
export function sameHost(a, b) {
  if (!a || !b) return false;
  a = String(a).toLowerCase();
  b = String(b).toLowerCase();
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/* 同一站点 = 注册域相同；登录 / SSO 常在同站子域间跳转，都不算漂移 */
export function sameSite(a, b) {
  const ra = siteRoot(a);
  const rb = siteRoot(b);
  return !!ra && !!rb && ra === rb;
}

/* 浏览器内部页面：不能刷新也种不了 cookie，弹窗用于提示，后台用于拒绝建任务 */
export const RESTRICTED_URL = /^(chrome|edge|devtools|about|chrome-extension):/i;

/* 主机的域链：a.b.example.com → b.example.com → example.com；登录票据常种在父域 */
export function domainChain(host) {
  const parts = host.split(".").filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list;
}

/* 会话 cookie：无过期时间、随浏览器关闭而清除；登录票据通常是这类 */
export function isSessionCookie(c) {
  return !!c && !c.expirationDate;
}

/* cookie 列表（备份或实时采样）中是否含会话 cookie */
export function hasSessionCookie(cookies) {
  return Array.isArray(cookies) && cookies.some(isSessionCookie);
}

/* 掉线确认窗口：单次“会话票据从有到无”可能只是站点换票节奏
   （会话票换成持久票、采样时机差），连续 N 次缺失才判定掉线，防误报冻结备份 */
export const SESSION_LOST_CONFIRM_SAMPLES = 2;
/* 掉线通知最小间隔：持续掉线期间不必每个刷新周期都弹 */
export const SESSION_LOST_NOTIFY_MS = 6 * 60 * 60 * 1000;

/* 单次采样判定：上次备份里还有会话 cookie，本次采样却一个都没有 */
export function sessionLostDetected(prevCookies, nextCookies) {
  return hasSessionCookie(prevCookies) && !hasSessionCookie(nextCookies);
}

/**
 * 掉线确认状态机（纯函数）：把“疑似 → 确认 → 恢复”的决策从备份流程里拆出来便于测试。
 * @param {object|null} prevEntry 上一份备份记录
 * @param {number} streak 连续缺失采样计数（含本次；0 = 本次采样正常）
 * @param {number} now 当前毫秒时间戳
 * @returns {{lost?: boolean, notify?: boolean, entry?: object}} lost=冻结备份；
 *   notify=本次要弹通知（按 SESSION_LOST_NOTIFY_MS 节流）；entry=需并入备份记录的字段
 */
export function nextBackupState(prevEntry, streak, now) {
  if (!streak) return { lost: false };
  if (streak >= SESSION_LOST_CONFIRM_SAMPLES) {
    const throttled = prevEntry && prevEntry.sessionLostAt && now - prevEntry.sessionLostAt < SESSION_LOST_NOTIFY_MS;
    return { lost: true, notify: !throttled, entry: { sessionLostAt: now } };
  }
  return { lost: false, entry: { sessionLostStreak: streak } };
}

/* 备份写入决策（纯函数，复审§2 修复的核心）：把"上一份备份 + 本次采样"映射为
   对存储的写入动作。与 nextBackupState 的区别：streak 从 prevEntry 内部推导，
   且疑似未确认时动作是 MERGE（只并入计数字段、保留旧 cookies 与 timestamp），
   绝不用坏样本覆盖最后一次在线备份——否则下一轮 prev 里没有会话票据，
   suspect 恒假、streak 永远到不了确认值（复审报告实证的死代码 bug）。 */
export const BACKUP_ACT = { OVERWRITE: "overwrite", MERGE: "merge", FREEZE: "freeze" };

export function decideBackupWrite(prevEntry, nextCookies, now) {
  if (!prevEntry) return { action: BACKUP_ACT.OVERWRITE, streak: 0, notify: false };
  const suspect = sessionLostDetected(prevEntry.cookies, nextCookies);
  const streak = suspect ? (prevEntry.sessionLostStreak || 0) + 1 : 0;
  if (!suspect) return { action: BACKUP_ACT.OVERWRITE, streak: 0, notify: false };
  const st = nextBackupState(prevEntry, streak, now);
  if (st.lost) return { action: BACKUP_ACT.FREEZE, streak, entry: st.entry, notify: !!st.notify };
  return { action: BACKUP_ACT.MERGE, streak, entry: { sessionLostStreak: streak }, notify: false };
}

/* 登录页 URL 启发式：只看 pathname（忽略 query 里 returnURL 之类的干扰项），
   命中 login/signin/auth/sso 等路径段即疑似登录页。掉线行为信号用 */
export function looksLikeLoginPage(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return /(^|\/)(login|logon|log-in|signin|sign-in|sign_in|auth|oauth|sso|cas|passport|id\.html)(\/|[.?#]|$)/.test(p);
  } catch (e) {
    return false;
  }
}

/* 关键词命中：大小写不敏感的包含判断；空关键词不判定 */
export function keywordHit(text, keyword) {
  const k = String(keyword == null ? "" : keyword).trim().toLowerCase();
  if (!k) return false;
  return String(text == null ? "" : text).toLowerCase().includes(k);
}

/* 刷新间隔抖动：±pct%（rand 注入以便测试），下限 minMs（30 秒 alarms 红线） */
export function jitteredDelayMs(seconds, pct = 15, rand = Math.random, minMs = 30000) {
  const base = Math.max(Number(seconds) || 0, 30) * 1000;
  const ratio = rand() * 2 - 1;
  const v = base * (1 + (Math.max(0, Math.min(50, pct)) / 100) * ratio);
  return Math.max(minMs, Math.round(v));
}

/* 取 origin+pathname 作为网址匹配键（忽略 hash 查询参数差异） */
export function urlKey(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch (e) {
    return null;
  }
}

/* 网址与目标一致（精确或 origin+pathname 相等）的标签页判定 */
export function tabShowsUrl(tab, url) {
  if (!tab || !tab.url || !url) return false;
  if (tab.url === url) return true;
  const k = urlKey(url);
  return !!k && urlKey(tab.url) === k;
}
