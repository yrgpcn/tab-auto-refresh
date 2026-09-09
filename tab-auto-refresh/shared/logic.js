/* 与浏览器 API 无关的纯逻辑，可被 Node 单元测试直接导入 */

export const MIN_INTERVAL_SEC = 30;
export const DEFAULT_INTERVAL_SEC = 300;

/* 兜底刷新间隔：无效输入回退默认值，过小的值提升到最小值 */
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

/* 站点根域（注册域）：nsgt.szns.gov.cn → szns.gov.cn；www.example.com → example.com */
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
