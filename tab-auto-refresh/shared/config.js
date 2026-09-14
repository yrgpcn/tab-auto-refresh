/* 弹窗与后台共用的常量 */

import { DEFAULT_INTERVAL_SEC } from "./logic.js";

export const PREFIX = "refresh-";
/* 静默 HTTP 心跳的 alarm 前缀 */
export const HB_PREFIX = "hb-";

/* 偏好设置默认值：cookie 备份涉及敏感数据，默认关闭，由用户在弹窗显式开启；
   后台保活是纯本地行为、只在已开启任务的标签页生效，默认开启 */
export const DEFAULT_SETTINGS = {
  bypassCache: true,
  skipDiscarded: false,
  cookieBackup: false,
  keepAlive: true,
  httpHeartbeat: true,
  skipOnActivity: false,
  keepAwake: false,
  /* 验证墙探测（页面侧）。默认开启以维持既有行为（07 批次的原始设计），由用户在弹窗显式关闭。
     匹配面刻意只取标题与挑战域名 iframe——误判的代价很高：一旦误暂停，刷新循环随之停下
     → 页面不再加载 → 探测也不再运行，任务会一直卡在暂停态，只能手动恢复。 */
  captchaGuard: true,
  /* Webhook：载荷会向所配 URL 披露被监控站点，敏感面——默认空=彻底关闭 */
  webhookUrl: "",
  webhookEvents: ["session-lost", "keyword", "task-stopped", "task-paused"],
  lastIntervalSec: DEFAULT_INTERVAL_SEC
};

export const PRESETS = [
  { key: "preset30s", seconds: 30 },
  { key: "preset1m", seconds: 60 },
  { key: "preset2m", seconds: 120 },
  { key: "preset5m", seconds: 300 },
  { key: "preset10m", seconds: 600 },
  { key: "preset30m", seconds: 1800 },
  { key: "preset1h", seconds: 3600 }
];
