/* 弹窗与后台共用的常量 */

import { DEFAULT_INTERVAL_SEC } from "./logic.js";

export const PREFIX = "refresh-";

/* 偏好设置默认值：cookie 备份涉及敏感数据，默认关闭，由用户在弹窗显式开启；
   后台保活是纯本地行为、只在已开启任务的标签页生效，默认开启 */
export const DEFAULT_SETTINGS = {
  bypassCache: true,
  skipDiscarded: false,
  cookieBackup: false,
  keepAlive: true,
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
