/* 第七轮审计门禁：`AGENTS.md` 与 `README.md` 里写死的数字，逐个从源码现推再比对。

   为什么要有它：A24 收口时留下的边界是"符号名判据挡不了名字还在、语义已经变了"，
   而阈值、时长、上限这一类恰恰是数字在说话——`HEARTBEAT_MINUTES` 从 4 改成 5，
   仓库里没有一个字会红，只有文档里那句"每 4 分钟"变成假话。假话的症状是用户按文档
   的预期去理解行为，所以这一面跟行号锚一样"漂了零症状"。

   两条硬规矩：
   1. 值只能从源码文本现推，测试里不许抄第二份常量。抄了就等于把漂移重新请回来，
      而且第二份自己也会漂。也不 import 模块：静态 import 解析不到副本根目录，
      红→绿对照要在仓库外的整仓副本上跑，控制必须在同一套重定向下生效。
   2. 取不到值就是红，绝不静默跳过。推导失败、文档里一处都没匹配到，都算这条判据不合格——
      措辞改没了和数字改错了是同一类事故：文档不再对得上代码。

   形状：ROWS 每行是「文档里的正则 + 源码现推出来的期望值」。正则一律带 g，
   文档里匹配到的每一处都必须等于期望值，所以"改了一处忘了另一处"也会红。
   同一个数字在两份文档里都出现就写进同一行的 docs（如"每 4 分钟"）。

   实跑记录（base 全绿 + 仓库外副本逐处改坏）与已知边界在本文件末尾。 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = process.env.TAR_NUM_ROOT
  ? resolve(process.env.TAR_NUM_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const AGENTS = "AGENTS.md";
const README = "README.md";
const BG = "tab-auto-refresh/background.js";
const LOGIC = "tab-auto-refresh/shared/logic.js";
const CONFIG = "tab-auto-refresh/shared/config.js";
const KA = "tab-auto-refresh/content/keepalive.js";
const CSS = "tab-auto-refresh/popup.css";
const HTML = "tab-auto-refresh/popup.html";
const MAN = "tab-auto-refresh/manifest.json";

const SRC = {};
for (const p of [AGENTS, README, BG, LOGIC, CONFIG, KA, CSS, HTML, MAN]) SRC[p] = read(p);

/* ---------- 一、取值原语：拿不到就抛，绝不回 undefined ---------- */

function grabOne(label, file, re) {
  const m = SRC[file].match(re);
  if (!m) throw new Error(`取值失败：${label} ← ${file}，判据 ${re}`);
  return m.slice(1);
}

function grabAll(label, file, re) {
  const hits = [...SRC[file].matchAll(re)];
  if (!hits.length) throw new Error(`取值失败：${label} ← ${file}，判据 ${re}`);
  return hits.map((m) => m.slice(1));
}

/* 常量声明右侧只允许整数字面量与算式：源码一改形状就抛，不猜 */
function arithConst(name, file) {
  const [expr] = grabOne(name, file, new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`, "m"));
  return arith(name, expr);
}

function arith(label, raw) {
  const expr = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!/^[\d\s+\-*/().]+$/.test(expr)) throw new Error(`${label} 的右侧不是纯算式：${JSON.stringify(expr)}`);
  const v = Function(`"use strict"; return (${expr});`)();
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${label} 算出来不是数：${JSON.stringify(expr)}`);
  return v;
}

function block(label, file, open, close) {
  const re = new RegExp(`${open}([\\s\\S]*?)${close}`);
  const m = SRC[file].match(re);
  if (!m) throw new Error(`切块失败：${label} ← ${file}`);
  return m[1];
}

/* 中文数字词只到这里，够文档实际用到的量级；写阿拉伯数字的行走另一条判据 */
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(word) {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "十") return 10;
  const m = word.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (CN_DIGIT[word]) return CN_DIGIT[word];
  throw new Error(`认不出中文数字：${word}`);
}

/* README 那行预设间隔是人话（"30 秒 / 1 分钟 / 1 小时"），换成秒才能与 PRESETS 比 */
function presetSeconds(line) {
  return line.split("/").map((part) => {
    const m = part.trim().match(/^(\d+)\s*(秒|分钟|小时)$/);
    if (!m) throw new Error(`认不出预设档位：${JSON.stringify(part)}`);
    const n = Number(m[1]);
    return m[2] === "秒" ? n : m[2] === "分钟" ? n * 60 : n * 3600;
  });
}

function backticked(list) {
  return [...list.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}

/* ---------- 二、源码现推的值 ---------- */

function derive() {
  const v = {};

  /* background.js */
  v.HEARTBEAT_MIN = arithConst("HEARTBEAT_MINUTES", BG);
  v.PAUSE_SAMPLES = arithConst("PAUSE_CONFIRM_SAMPLES", BG);
  v.CAPTCHA_SAMPLES = arithConst("CAPTCHA_CONFIRM_SAMPLES", BG);
  v.BACKUP_MAX_SITES = arithConst("COOKIE_BACKUP_MAX_KEYS", BG);
  v.BACKUP_DAYS = arithConst("COOKIE_BACKUP_TTL_MS", BG) / 86400000;
  v.BACKUP_MAX_COOKIES = arithConst("MAX_COOKIES_PER_HOST", BG);
  v.SETTLE_MS = Number(grabOne("prune 等待", BG, /await new Promise\(\(resolve\) => setTimeout\(resolve, (\d+)\)\)/)[0]);
  v.IDLE_SPREAD_SEC = Number(grabOne("心跳打散", BG, /when: now \+ Math\.round\(Math\.random\(\) \* (\d+)\)/)[0]) / 1000;
  {
    const sites = grabAll("fetch 超时", BG, /setTimeout\(\(\) => ctrl\.abort\(\), (\d+)\)/g).map((c) => Number(c[0]));
    const uniq = [...new Set(sites)];
    if (uniq.length !== 1) throw new Error(`background.js 里注入的 abort 超时不止一个值：${uniq.join(", ")}`);
    v.ABORT_SEC = uniq[0] / 1000;
    v.ABORT_SITES = sites.length;
  }
  v.WX_TIMEOUT_SEC = arithConst("WX_FETCH_TIMEOUT_MS", BG) / 1000;
  {
    const delays = grabOne("检测链采样", BG, /for \(const delay of \[([\d,\s]+)\]\)/)[0]
      .split(",").map((s) => Number(s.trim())).filter((n) => n > 0).map((n) => n / 1000);
    if (delays.length < 2) throw new Error(`检测链只剩 ${delays.length} 次延迟重采样，判据该重看`);
    v.DETECT_DELAYS = delays;
  }

  /* shared/logic.js */
  v.MIN_INTERVAL_SEC = arithConst("MIN_INTERVAL_SEC", LOGIC);
  v.DEFAULT_INTERVAL_MIN = arithConst("DEFAULT_INTERVAL_SEC", LOGIC) / 60;
  v.LOST_SAMPLES = arithConst("SESSION_LOST_CONFIRM_SAMPLES", LOGIC);
  v.LOST_THROTTLE_HOURS = arithConst("SESSION_LOST_NOTIFY_MS", LOGIC) / 3600000;
  v.ACTIVITY_SKIP_SEC = arithConst("ACTIVITY_SKIP_MS", LOGIC) / 1000;
  v.TOKEN_MARGIN_MIN = arithConst("TOKEN_REFRESH_MARGIN_MS", LOGIC) / 60000;
  v.WALL_MIN_W = arithConst("WALL_FRAME_MIN_W", LOGIC);
  v.WALL_MIN_H = arithConst("WALL_FRAME_MIN_H", LOGIC);
  v.WECHAT_FIELD_LEN = arithConst("WECHAT_FIELD_MAX", LOGIC);
  {
    const [pct, floor] = grabOne("jitteredDelayMs", LOGIC,
      /function jitteredDelayMs\(seconds, pct = (\d+), rand = Math\.random, minMs = (\d+)\)/);
    v.JITTER_PCT = Number(pct);
    v.JITTER_FLOOR_SEC = Number(floor) / 1000;
  }
  v.KW_MAX_LEN = Number(grabOne("关键词长度", LOGIC, /raw\.trim\(\)\.slice\(0, (\d+)\)/)[0]);
  v.KW_MAX_COUNT = Number(grabOne("关键词条数", LOGIC, /if \(out\.length >= (\d+)\) break;/)[0]);
  v.HOOK_BODY_CHARS = Number(grabOne("webhook 正文截断", LOGIC, /String\(text == null \? "" : text\)\.slice\(0, (\d+)\)/)[0]);

  /* content/keepalive.js：三档节奏 */
  {
    const [lo, span] = grabOne("保活首拍", KA, /\?\s*(\d+) \+ Math\.random\(\) \* (\d+)/).map(Number);
    v.KA_FIRST_LO = lo / 1000;
    v.KA_FIRST_HI = (lo + span) / 1000;
  }
  {
    const [lo, span] = grabOne("保活常态", KA, /:\s*(\d+) \+ Math\.random\(\) \* (\d+)/).map(Number);
    v.KA_STEADY_LO = lo / 1000;
    v.KA_STEADY_HI = (lo + span) / 1000;
  }
  v.KA_REPORT_SEC = Number(grabOne("活动上报节流", KA, /now - lastReport < (\d+)/)[0]) / 1000;

  /* shared/config.js：默认值清单、凭据项数、预设档位 */
  {
    const body = block("DEFAULT_SETTINGS", CONFIG, "const DEFAULT_SETTINGS = \\{", "\\n\\};");
    const bools = [...body.matchAll(/^ {2}(\w+): (true|false),?$/gm)].map((m) => [m[1], m[2] === "true"]);
    if (bools.length < 5) throw new Error(`DEFAULT_SETTINGS 只切出 ${bools.length} 个布尔开关，形状变了`);
    v.DEFAULTS_ON = bools.filter(([, b]) => b).map(([k]) => k);
    v.DEFAULTS_OFF = bools.filter(([, b]) => !b).map(([k]) => k);
    if (v.DEFAULTS_ON.length + v.DEFAULTS_OFF.length !== bools.length) throw new Error("布尔开关数不闭合");
    v.WECHAT_CREDS = Object.keys(Object.fromEntries(
      [...body.matchAll(/^ {2}(wechat[A-Z]\w*):/gm)].map((m) => [m[1], 1])
    )).filter((k) => k !== "wechatEnabled").length;
  }
  {
    const body = block("PRESETS", CONFIG, "export const PRESETS = \\[", "\\n\\];");
    v.PRESET_SECS = [...body.matchAll(/seconds:\s*(\d+)/g)].map((m) => Number(m[1]));
    if (v.PRESET_SECS.length < 3) throw new Error(`PRESETS 只切出 ${v.PRESET_SECS.length} 档`);
  }

  /* 弹窗尺寸与开关格数 */
  {
    const body = block("body 规则", CSS, "\nbody \\{", "\n\\}");
    v.POPUP_W = Number(grabOne("body width", CSS, /width:\s*(\d+)px/)[0]);
    v.POPUP_MAX_H = Number(body.match(/max-height:\s*(\d+)px/)[1]);
  }
  v.LIST_MAX_H = Number(block("任务列表", CSS, "\n#taskList \\{", "\n\\}").match(/max-height:\s*(\d+)px/)[1]);
  {
    const grid = block("check-grid", HTML, '<div class="check-grid">', "\n {4}</div>");
    v.SWITCH_CELLS = (grid.match(/<label class="row-check/g) || []).length;
    if (v.SWITCH_CELLS < 5) throw new Error(`check-grid 只切出 ${v.SWITCH_CELLS} 个开关`);
  }

  /* manifest */
  {
    const man = JSON.parse(SRC[MAN]);
    v.MIN_CHROME = Number(man.minimum_chrome_version);
    if (!Number.isFinite(v.MIN_CHROME)) throw new Error("manifest 的 minimum_chrome_version 不是数字");
    v.PERMISSIONS = [...man.permissions].sort();
    v.NOTIF_KINDS = block("NOTIF_ID", BG, "const NOTIF_ID = \\{", "\n\\};")
      .match(/^ {2}\w+:/gm).length;
  }

  return v;
}

let DERIVE_ERR = null;
let V = null;
try {
  V = derive();
} catch (err) {
  DERIVE_ERR = err;
}

/* ---------- 三、文档里的那些数字 ---------- */

const S = (n) => String(n);

const ROWS = [
  /* 调度 */
  {
    id: "心跳间隔（分钟）",
    docs: [AGENTS, README],
    re: /每\s*(\d+)\s*分钟/g,
    want: (v) => [S(v.HEARTBEAT_MIN)]
  },
  {
    id: "刷新间隔抖动百分比",
    docs: [AGENTS],
    re: /±\s*(\d+)%/g,
    want: (v) => [S(v.JITTER_PCT)]
  },
  {
    /* 同一个 30 在文档里有四种说法：秒档、秒级 alarms、秒地板、最小 30 秒。
       一条正则收四种写法，每处匹配都只该拿到那一个数 */
    id: "最短间隔（秒档 / 最小值 / 秒级 alarms / 秒地板）",
    docs: [AGENTS, README],
    re: /(\d+)\s*秒(?:档|级|地板)|最小\s*(\d+)\s*秒|间隔选\s*(\d+)\s*秒/g,
    want: (v) => [S(v.MIN_INTERVAL_SEC)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    id: "快捷键回退的默认间隔",
    docs: [AGENTS],
    re: /回退\s*(\d+)\s*分钟/g,
    want: (v) => [S(v.DEFAULT_INTERVAL_MIN)]
  },
  {
    id: "idle 回到 active 时心跳的打散上限",
    docs: [AGENTS],
    re: /打散 0~(\d+)\s*秒/g,
    want: (v) => [S(v.IDLE_SPREAD_SEC)]
  },
  {
    id: "启动恢复的等待拍",
    docs: [AGENTS],
    re: /先等\s*(\d+)\s*毫秒/g,
    want: (v) => [S(v.SETTLE_MS)]
  },

  /* 自动暂停与跳过 */
  {
    id: "错误页连击次数",
    docs: [AGENTS],
    re: /`PAUSE_CONFIRM_SAMPLES`（(\d+)）/g,
    want: (v) => [S(v.PAUSE_SAMPLES)]
  },
  {
    id: "验证墙连击次数",
    docs: [AGENTS],
    re: /`CAPTCHA_CONFIRM_SAMPLES`（(\d+)）/g,
    want: (v) => [S(v.CAPTCHA_SAMPLES)]
  },
  {
    id: "尊重操作的时间窗（秒）",
    docs: [AGENTS, README],
    re: /`ACTIVITY_SKIP_MS`（(\d+)\s*秒）|操作的\s*(\d+)\s*秒内|真人\s*(\d+)\s*秒内/g,
    want: (v) => [S(v.ACTIVITY_SKIP_SEC)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    id: "验证墙子框架视口地板",
    docs: [AGENTS],
    re: /`WALL_FRAME_MIN_W`\/`_H`，(\d+)×(\d+)/g,
    want: (v) => [S(v.WALL_MIN_W), S(v.WALL_MIN_H)]
  },

  /* 掉线与保活 */
  {
    id: "掉线确认次数",
    docs: [AGENTS],
    re: /连续\s*(\d+)\s*次才冻结|计入同一个\s*(\d+)\s*次确认窗口/g,
    want: (v) => [S(v.LOST_SAMPLES)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    id: "掉线通知节流（小时）",
    docs: [AGENTS],
    re: /按\s*(\d+)\s*小时节流通知/g,
    want: (v) => [S(v.LOST_THROTTLE_HOURS)]
  },
  {
    id: "保活注入首个心跳区间",
    docs: [AGENTS],
    re: /首个心跳\s*(\d+)~(\d+)\s*秒/g,
    want: (v) => [S(v.KA_FIRST_LO), S(v.KA_FIRST_HI)]
  },
  {
    id: "保活注入常态心跳区间",
    docs: [AGENTS],
    re: /之后\s*(\d+)~(\d+)\s*秒随机/g,
    want: (v) => [S(v.KA_STEADY_LO), S(v.KA_STEADY_HI)]
  },
  {
    id: "模拟活动的上报节流（注释侧）",
    docs: [CONFIG],
    re: /加\s*(\d+)\s*秒节流上报/g,
    want: (v) => [S(v.KA_REPORT_SEC)]
  },
  {
    id: "外发 fetch 的超时（秒）",
    docs: [AGENTS],
    re: /(\d+)\s*秒超时/g,
    want: (v) => [S(v.ABORT_SEC)]
  },

  /* 关键词与检测链 */
  {
    id: "关键词单条字数与条数上限",
    docs: [AGENTS],
    re: /每条\s*≤(\d+)\s*字、上限\s*(\d+)\s*个/g,
    want: (v) => [S(v.KW_MAX_LEN), S(v.KW_MAX_COUNT)]
  },
  {
    id: "检测链的两次延迟重采样",
    docs: [AGENTS],
    re: /未命中再于\s*(\d+)\s*秒、\s*(\d+)\s*秒重采样/g,
    want: (v) => v.DETECT_DELAYS.map(S)
  },

  /* cookie 备份 */
  {
    id: "备份单站点条数封顶",
    docs: [AGENTS],
    re: /单站点封顶\s*(\d+)\s*条/g,
    want: (v) => [S(v.BACKUP_MAX_COOKIES)]
  },
  {
    id: "备份淘汰的天数",
    docs: [AGENTS, README],
    re: /(\d+)\s*天/g,
    want: (v) => [S(v.BACKUP_DAYS)]
  },
  {
    id: "备份淘汰的站点数",
    docs: [AGENTS, README],
    re: /(\d+)\s*站上限|保留\s*(\d+)\s*个站点/g,
    want: (v) => [S(v.BACKUP_MAX_SITES)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    id: "存档代价那句「N 站 × M 条」",
    docs: [AGENTS],
    re: /(\d+)\s*站\s*×\s*(\d+)\s*条/g,
    want: (v) => [S(v.BACKUP_MAX_SITES), S(v.BACKUP_MAX_COOKIES)]
  },

  /* 外发 */
  {
    id: "webhook 正文只看前多少字",
    docs: [AGENTS],
    re: /正文只看前\s*(\d+)\s*字/g,
    want: (v) => [S(v.HOOK_BODY_CHARS)]
  },
  {
    id: "微信模板字段字数",
    docs: [AGENTS, README],
    re: /不超过\s*(\d+)\s*个字|最多\s*(\d+)\s*个字/g,
    want: (v) => [S(v.WECHAT_FIELD_LEN)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    id: "微信令牌提前重取的分钟数",
    docs: [AGENTS],
    re: /距过期\s*(\d+)\s*分钟/g,
    want: (v) => [S(v.TOKEN_MARGIN_MIN)]
  },
  {
    id: "微信凭据项数",
    docs: [README],
    re: /(\S)项凭据/g,
    want: (v) => [S(v.WECHAT_CREDS)],
    norm: (caps) => [S(cnNum(caps[0]))]
  },

  /* 弹窗版面 */
  {
    id: "弹窗宽度",
    docs: [AGENTS],
    re: /宽度\s*(\d+)px/g,
    want: (v) => [S(v.POPUP_W)]
  },
  {
    id: "弹窗整页高度上限",
    docs: [AGENTS],
    re: /(\d+)px\s*(?:内|上限)/g,
    want: (v) => [S(v.POPUP_MAX_H)]
  },
  {
    id: "任务列表封顶",
    docs: [AGENTS],
    re: /列表封顶\s*(\d+)px/g,
    want: (v) => [S(v.LIST_MAX_H)]
  },
  {
    id: "双列网格里的开关格数",
    docs: [AGENTS],
    re: /(\d+)\s*个开关/g,
    want: (v) => [S(v.SWITCH_CELLS)]
  },

  /* 平台与清单 */
  {
    id: "最低 Chrome 版本",
    docs: [AGENTS, README],
    re: /minimum_chrome_version:\s*(\d+)|Chrome\s*(\d+)\+/g,
    want: (v) => [S(v.MIN_CHROME)],
    norm: (caps) => [caps.find((c) => c !== "")]
  },
  {
    /* 两份文档各写各的：AGENTS.md 那句紧跟 NOTIF_ID，README 那句是"这四类系统通知"。
       合一条正则会被"新增一类通知"这种泛指带进射程，所以拆两行、各认各的上下文 */
    id: "系统通知种类（AGENTS.md）",
    docs: [AGENTS],
    re: /([一二两三四五六七八九十]+)类通知的 ID/g,
    want: (v) => [S(v.NOTIF_KINDS)],
    norm: (caps) => [S(cnNum(caps[0]))]
  },
  {
    id: "系统通知种类（README）",
    docs: [README],
    re: /这([一二两三四五六七八九十]+)类系统通知/g,
    want: (v) => [S(v.NOTIF_KINDS)],
    norm: (caps) => [S(cnNum(caps[0]))]
  },
  {
    id: "README 的预设档位序列",
    docs: [README],
    re: /预设间隔：([^\n]+)/g,
    want: (v) => [v.PRESET_SECS.join(",")],
    norm: (caps) => [presetSeconds(caps[0]).join(",")]
  },
  {
    id: "AGENTS.md 的权限清单",
    docs: [AGENTS],
    re: /^- 权限：(.+)$/gm,
    want: (v) => [v.PERMISSIONS.join(" ")],
    norm: (caps) => [caps[0].split("/").map((s) => s.trim()).sort().join(" ")]
  },
  {
    id: "AGENTS.md 的默认开 / 默认关清单",
    docs: [AGENTS],
    re: /当前默认开：([^；]+)；默认关：([^；]+)/g,
    want: (v) => [[...v.DEFAULTS_ON].sort().join(","), [...v.DEFAULTS_OFF].sort().join(",")],
    norm: (caps) => caps.map((c) => backticked(c).sort().join(","))
  }
];

/* ---------- 四、比对 ---------- */

function docCaps(row, text) {
  const hits = [...text.matchAll(row.re)].map((m) => m.slice(1).map((c) => (c === undefined ? "" : c)));
  return hits.map((caps) => (row.norm ? row.norm(caps) : caps));
}

function problems(row, want, doc, text) {
  let got;
  try {
    got = docCaps(row, text);
  } catch (err) {
    return [`${doc}：文档里的这句话解析不动 → ${err.message}`];
  }
  if (!got.length) return [`${doc}：一处都没匹配到（数字被删了，或那句话改了措辞）`];
  const w = want.join(" / ");
  return got
    .map((caps) => caps.join(" / "))
    .filter((line) => line !== w)
    .map((line) => `${doc}：文档写 ${line}，源码现推 ${w}`);
}

/* 取值失败绝不退化成"这行没话说"：整行红，且说不出源码是多少 */
function rowProblemsAll(row) {
  let want;
  try {
    if (DERIVE_ERR) throw DERIVE_ERR;
    want = row.want(V);
  } catch (err) {
    return [`取值失败，本行没比对过 → ${err.message}`];
  }
  const out = [];
  for (const doc of row.docs) out.push(...problems(row, want, doc, SRC[doc]));
  return out;
}

/* ---------- 五、用例 ---------- */

test("取值：每条推导都从源码拿到了有限的数", () => {
  assert.ifError(DERIVE_ERR);
  const nums = Object.entries(V).filter(([, x]) => typeof x === "number");
  assert.ok(nums.length >= 25, `只推出 ${nums.length} 个数值，取值面塌了`);
  for (const [k, x] of nums) {
    assert.ok(Number.isFinite(x) && x > 0, `${k} 取到 ${x}，不像个阈值`);
  }
});

test("取值：两处超时机制是同一个值，文档才只写了一个「15 秒」", () => {
  assert.ifError(DERIVE_ERR);
  assert.equal(V.WX_TIMEOUT_SEC, V.ABORT_SEC);
  assert.ok(V.ABORT_SITES >= 2, `只有 ${V.ABORT_SITES} 处 abort 超时，注入形状变了，去看判据`);
});

test("取值：DEFAULT_SETTINGS 的布尔开关拆成默认开与默认关两组", () => {
  assert.ifError(DERIVE_ERR);
  assert.ok(V.DEFAULTS_ON.length >= 3 && V.DEFAULTS_OFF.length >= 3);
  for (const k of [...V.DEFAULTS_ON, ...V.DEFAULTS_OFF]) assert.match(k, /^\w+$/);
  assert.equal(new Set([...V.DEFAULTS_ON, ...V.DEFAULTS_OFF]).size, V.DEFAULTS_ON.length + V.DEFAULTS_OFF.length);
});

test("原语：中文数字认到十，认不出的要抛而不是给个默认值", () => {
  assert.equal(cnNum("四"), 4);
  assert.equal(cnNum("十"), 10);
  assert.equal(cnNum("十二"), 12);
  assert.equal(cnNum("21"), 21);
  assert.throws(() => cnNum("百"), /认不出中文数字/);
});

test("原语：算式右侧只认数字与四则，改了形状就抛", () => {
  assert.equal(arith("TTL", "30 * 24 * 60 * 60 * 1000"), 2592000000);
  assert.throws(() => arith("X", "SOME_FLAG * 60"), /不是纯算式/);
  assert.throws(() => arith("X", "1/0"), /不是数/);
});

test("原语：README 那行人话预设能换成秒", () => {
  assert.deepEqual(presetSeconds("30 秒 / 1 分钟 / 1 小时"), [30, 60, 3600]);
  assert.throws(() => presetSeconds("半分钟"), /认不出预设档位/);
});

test("判据覆盖面：ROWS 的行数与匹配面本身要够，否则本文件是空跑", () => {
  assert.ok(ROWS.length >= 35, `只有 ${ROWS.length} 行数字判据，这一轮覆盖面不够`);
  const empty = [];
  for (const row of ROWS) {
    for (const doc of row.docs) {
      if (!docCaps(row, SRC[doc]).length) empty.push(`${row.id} @${doc}`);
    }
  }
  assert.deepEqual(empty, [], "这些行一处都没匹配到，等于空跑");
});

for (const [i, row] of ROWS.entries()) {
  test(`对账 ${i + 1}：${row.id}`, () => assert.deepEqual(rowProblemsAll(row), []));
}

test("反向见证：把文档数字改一个就得红（比对器不是恒绿）", () => {
  assert.ifError(DERIVE_ERR);
  /* 这里的期望全从 V 现推：本文件不许知道自己对上了什么数，否则改一个常量会连带把
     见证用例改红，红名单里混进无关条目就看不出真正红了哪条 */
  const beat = ROWS.find((r) => r.id === "心跳间隔（分钟）");
  const want = beat.want(V);
  const problemsOf = (row, text) => problems(row, row.want(V), AGENTS, text);

  const wrong = problemsOf(beat, "心跳每 9 分钟一次，另有静默心跳每 3 分钟");
  assert.equal(wrong.length, 2);
  assert.equal(want.length, 1);
  assert.match(wrong[0], new RegExp(`文档写 9，源码现推 ${want[0]}`));

  assert.deepEqual(problemsOf(beat, "心跳不写分钟"),
    ["AGENTS.md：一处都没匹配到（数字被删了，或那句话改了措辞）"]);

  const wall = ROWS.find((r) => r.id === "验证墙子框架视口地板");
  assert.equal(problemsOf(wall, "（`WALL_FRAME_MIN_W`/`_H`，400×260）").length, 1);

  const cn = ROWS.find((r) => r.id === "系统通知种类（AGENTS.md）");
  assert.deepEqual(problemsOf(cn, "三类通知的 ID 一律由"),
    [`AGENTS.md：文档写 3，源码现推 ${cn.want(V)[0]}`]);
});

test("反向见证：源码里取不到值时，每一行都报取值失败而不是集体消失", () => {
  const saved = DERIVE_ERR;
  DERIVE_ERR = new Error("取值失败：HEARTBEAT_MINUTES ← tab-auto-refresh/background.js");
  try {
    const first = rowProblemsAll(ROWS[0]);
    assert.equal(first.length, 1);
    assert.match(first[0], /取值失败，本行没比对过/);
  } finally {
    DERIVE_ERR = saved;
  }
  assert.ok(!/取值失败/.test(rowProblemsAll(ROWS[0]).join("|")), "恢复之后本该真比对过");
});

/* ---------- 六、实跑记录与已知边界 ----------

   对照在仓库外整仓副本上跑（`D:/Github/_tar_ctl_r7/run.mjs`，判据吃 `TAR_NUM_ROOT`）。
   base 先跑一遍全绿（45 条），再逐处改坏，看红在哪几条。实跑结果：

   D1  background.js 的 `HEARTBEAT_MINUTES = 4` → 5 …… 只红「对账 1：心跳间隔（分钟）」
   D2  AGENTS.md 的「±15%」→「±20%」………………… 只红「对账 2：刷新间隔抖动百分比」
   D3  background.js 里 `MAX_COOKIES_PER_HOST` 改名 … 41 条红，36 行逐个写
       "取值失败，本行没比对过 → 取值失败：MAX_COOKIES_PER_HOST ← background.js，判据 …"，
       测试总数仍是 45 一条不少 —— 推导断了不许退化成"这行没话说"
   D4  popup.html 的 check-grid 里再加一个开关格 …… 只红「对账 30：双列网格里的开关格数」
   D5  config.js 的 PRESETS 删掉 10 分钟那一档 ……… 只红「对账 34：README 的预设档位序列」
   D6  popup.css 的任务列表 max-height 108px → 120px … 只红「对账 29：任务列表封顶」
   D7  config.js 里 `skipDiscarded: false` → true …… 只红「对账 36：AGENTS.md 的默认开 / 默认关清单」
   D8  manifest.json 的 permissions 加一项 …………… 只红「对账 35：AGENTS.md 的权限清单」
   D9  keepalive.js 常态心跳 45000 → 50000 ………… 只红「对账 14：保活注入常态心跳区间」
   D10 AGENTS.md 的「列表封顶 108px」→「列表限高 108px」 红 2 条：对账 29 与"判据覆盖面"
       （数字一个没动，只是那句话换了写法。红是对的：这条判据从此不再覆盖它，
       而下一次改这个数就没人挡了——宁可红得烦，不要静默放行）

   两处第一次不合格的记录（写在这里，免得下一次再犯）：
   - D1 最初连带把两条"反向见证"用例也改红了：它们把"源码现推 4"抄成了字面量。
     见证用例的期望值一律从 V 现推，否则红名单里混进无关条目，真正红了哪条就看不出来
   - D3 一开始用的是"整仓改名"，结果副本里连门禁自己的判据一起被改了，跑出来全绿。
     改产品常量只能在产品源码里改，改判据本身不算对照

   已知边界（写在这里，免得被当成已覆盖）：
   - 只管"文档写的那个数等于源码算出来的那个数"。管不到该不该是这个值：
     把心跳从 4 分钟改成 1 分钟、同步把文档改成 1，这里照样绿。那是设计与纪律 3 的事
   - 不在代码里的数字一律不设判据：Chrome 弹窗外框上限 800×600、SW 闲置 30 秒终止、
     reCAPTCHA 304×78 / Turnstile 300×65 / hCaptcha 300×88 这些是平台与第三方页面的事实，
     没有源码可对。AGENTS.md 里"原先是按任务逐个等 20 秒"讲的是改动前的行为，
     改常量不该让它变错，也刻意没收进判据
   - 一行只管自己那条正则的射程。同一个数字换成写法（中文"三分钟"、"一分钟"）会落到
     "一处都没匹配到"那一支，这是要的效果
   - 数量词只认到"十"这一级：文档将来写"十余个开关"就出射程了
   - `BACKLOG.md` 与 `CHANGELOG.md` 不设数字判据：那两本记的是当时的事实，本来就该随代码漂 */
