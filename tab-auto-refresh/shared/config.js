/* 弹窗与后台共用的常量 */

import { DEFAULT_INTERVAL_SEC, NOTIFY_EVENTS } from "./logic.js";

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
  /* 尊重用户操作：真人 60 秒内在该页操作过就跳过本次刷新。默认开启，因为刷新是为了
     盯变化，用户正在看这个页面时再把它重载掉只会打断他，跳一轮的代价小得多。
     注意它同时是内容脚本注入的开关之一（keepAlive 或 skipOnActivity 任一开启即注入），
     所以默认开启也意味着默认会向被监控页注入活动监听（isTrusted 过滤加 5 秒节流上报，
     合成事件不会被当成真人）。
     对已有安装不追溯：存盘值优先于默认值，只有新装或从没存过这个键时才会取到 true */
  skipOnActivity: true,
  keepAwake: false,
  /* 验证墙探测（页面侧）。默认开启，由用户在弹窗里显式关闭。
     匹配面只取标题与挑战域名 iframe：误判代价很高，一旦误暂停，刷新循环就停下，
     页面不再加载，探测也不再运行，任务会一直卡在暂停态只能手动恢复 */
  captchaGuard: true,
  /* Webhook：载荷会披露被监控站点，属敏感面，默认空即彻底关闭 */
  webhookUrl: "",
  /* 外发通知的事件清单，webhook 与微信直连共用。1.7.0 的键名是 webhookEvents，
     旧值由 logic.notifyEventsOf 接续，这里不留兼容分支 */
  notifyEvents: NOTIFY_EVENTS.slice(),
  /* 微信直连：扩展 SW 直接调腾讯官方接口（api.weixin.qq.com）推模板消息，
     不经任何中继、也不用第三方推送服务商。默认关即彻底关闭。

     这四项凭据存在 chrome.storage.sync，会随 Google 账号同步到其它登录了同一账号的
     桌面 Chrome；appsecret 是唯一一把能以此公众号名义发消息的钥匙，README 里有说明。
     手机端 Chrome 不支持扩展，不构成暴露面。

     改默认值不影响已装用户（getSettings 是 Object.assign(DEFAULT, 已存值)），
     只有新增的键才会从默认里补上，所以这里给的是"首次出现时"的取值 */
  wechatEnabled: false,
  wechatAppId: "",
  wechatAppSecret: "",
  wechatOpenId: "",
  wechatTemplateId: "",
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
