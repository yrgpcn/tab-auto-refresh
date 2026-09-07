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
