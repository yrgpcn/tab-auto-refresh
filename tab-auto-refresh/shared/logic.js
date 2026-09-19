/* 与浏览器 API 无关的纯逻辑，可被 Node 单元测试直接导入 */

export const MIN_INTERVAL_SEC = 30;
export const DEFAULT_INTERVAL_SEC = 300;

/* 外发通知的事件清单，webhook 与微信直连共用一份。
   1.7.0 只在 webhook 上用，键名是 webhookEvents；1.8.0 起叫 notifyEvents，
   旧键由 notifyEventsOf 接续 */
export const NOTIFY_EVENTS = ["session-lost", "keyword", "task-stopped", "task-paused"];

/* 存盘设置 → 生效设置（后台与弹窗共用一份，避免兼容逻辑各写一份后分叉）：
   补默认值 + 承接键改名。1.7.0 的事件清单叫 webhookEvents，1.8.0 起叫 notifyEvents。
   判断"存盘里有没有新键"必须按原始 stored 在合并默认值之前做——合并之后新键总在
   （默认值注入），老用户的勾选会被默认值悄悄覆盖成全选。
   返回值不携带旧键：调用方把返回值写回存盘即顺手完成迁移清理 */
export function normalizeStoredSettings(stored, defaults) {
  const s = Object.assign({}, defaults || {}, stored || {});
  if (!Array.isArray((stored || {}).notifyEvents) && Array.isArray((stored || {}).webhookEvents)) {
    s.notifyEvents = stored.webhookEvents;
  }
  delete s.webhookEvents;
  return s;
}

/* 外部来源交来的设置增量按已知键过滤（弹窗 save-settings 的载荷就是这个来源）。
   只管键不管值：值的形状由读侧负责（normalizeStoredSettings 补默认，webhookUrl 另有
   normalizeWebhookUrl，非法即当空）。放任意外来键进 settings 的代价是持久的——它会跟着
   `sync` 漫游到用户其它设备、占 8KB 配额，而且没人读它，属于纯粹的污染。
   判据必须是自有属性而不是 `in`：`constructor in DEFAULT_SETTINGS` 为真，
   用 `in` 等于把原型链上那批键全当成合法设置键收下来 */
export function pickKnownSettings(partial, defaults) {
  const out = {};
  if (!partial || typeof partial !== "object") return out;
  for (const k of Object.keys(partial)) {
    if (Object.prototype.hasOwnProperty.call(defaults || {}, k)) out[k] = partial[k];
  }
  return out;
}

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

/* 二级公共后缀里的"品牌段"：co / com / net / org / gov / ac 这一类。
   以前这里是一张手写的完整后缀表（"co.uk"、"com.cn"…），漏一条就整条踩空——
   co.nz、com.ua、co.id、com.ph 都不在表里，于是 shop.example.co.nz 的根域被判成
   "co.nz"，接着拿它去查 cookie，把浏览器里所有 .co.nz 站点的登录态捞进明文备份（2026-09-19 审计的 A2）。
   现在的判据是一条形状规则：末段是两字母国家/地区码，且倒数第二段是品牌段。
   它一次覆盖整个 ccTLD × 品牌段组合，不依赖清单抄全。
   清单的边界要说清：一是品牌段没抄全的那条后缀仍会算宽（漏 "co" 之外的生僻段才会发生，
   新增条目只增不减即可），二是 github.io / blogspot.com 这类"私有后缀"任何形状规则都抓不到。
   真正兜住这两条的是 domainChain 的下探地板（绝不查注册域以上）与启动时的备份收敛 */
const SLD_BRANDS = new Set([
  "co", "com", "net", "org", "gov", "mil", "ac", "or", "ne", "go", "ed", "edu",
  "sch", "res", "gen", "asn", "nic", "idv", "club", "biz", "info", "nom", "asso",
  "coop", "gob", "gouv", "adm", "adv", "amb", "apo", "art", "blog", "cnt", "eco",
  "esp", "eti", "far", "flog", "fnd", "g12", "log", "mat", "not", "oji", "psi",
  "qsl", "rcv", "seg", "slg", "srv", "taxi", "teo", "tmp", "tur", "tv", "vet",
  "vlog", "wiki", "tol", "firm", "ind", "in", "lg", "pb", "hs", "ms", "es", "re"
]);

/* 一对标签看起来就是"品牌段 + 两字母码"（co.nz / com.ua / or.jp / gov.uk …） */
function isSuffixPair(pair) {
  return pair.length === 2 && /^[a-z]{2}$/.test(pair[1]) && SLD_BRANDS.has(pair[0]);
}

const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;

/* 主机的标签段（小写、去空） */
function hostParts(host) {
  return String(host == null ? "" : host).toLowerCase().split(".").filter(Boolean);
}

/* 可信注册域：a.b.example.com → b.example.com；shop.example.co.nz → example.co.nz。
   取不到可信注册域时返回 null，调用方一律不备份、不建探针——宁可丢掉登录态
   （用户重新登录就好），也不能退化成公共后缀，那等于替无关站点复活一遍会话票据。
   单段主机（localhost、单机内网名）与 IPv4 没有父域可下探，整串即身份，照原样返回。
   规则偏保守：判据命中就多切一段，最坏结果是把根域算窄（少覆盖一些兄弟子域的 SSO 票），
   而不是算宽——只有算宽才会越界采集到别人的 cookie */
export function siteRoot(host) {
  const parts = hostParts(host);
  if (!parts.length) return null;
  const joined = parts.join(".");
  if (IPV4_HOST.test(joined)) return joined;
  if (parts.length === 1) return joined;
  const cut = isSuffixPair(parts.slice(-2)) ? 3 : 2;
  /* 整串本身就是公共后缀（如主机就叫 co.nz）：切不出可信注册域 */
  if (parts.length < cut) return null;
  return parts.slice(-cut).join(".");
}

/* 这个域落在注册域之内吗（含它自己和它的子域）；cookie 的 .example.com 写法要先去掉前导点 */
export function withinRoot(root, domain) {
  if (!root || !domain) return false;
  const d = String(domain).toLowerCase().replace(/^\./, "");
  const r = String(root).toLowerCase();
  if (!d) return false;
  return d === r || d.endsWith("." + r);
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

/* 主机的域链：a.b.example.com → b.example.com → example.com；登录票据常种在父域。
   下探到注册域就停，一层都不能再多。旧写法是"一直切到只剩两段"，于是
   shop.example.co.nz 会连着交出 example.co.nz 和 co.nz，而后者的语义是
   "域等于或子域于它"，一次查询就把全站 .co.nz 的 cookie 都捞进备份。
   拿不到可信注册域（siteRoot 返回 null）时给空链：宁可不采，也不能越界 */
export function domainChain(host) {
  const parts = hostParts(host);
  if (!parts.length) return [];
  const root = siteRoot(parts.join("."));
  if (!root) return [];
  const floor = root.split(".").length;
  const list = [];
  for (let i = 0; i <= parts.length - floor; i++) list.push(parts.slice(i).join("."));
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

/* 掉线确认状态机（纯函数）：把"疑似、确认、恢复"的决策从备份流程里拆出来便于测试。
   prevEntry 上一份备份记录；streak 连续缺失采样计数（含本次，0 表示本次正常）；
   now 当前毫秒时间戳。
   返回 { lost, notify, entry }：lost 表示冻结备份，notify 表示本次要弹通知
   （按 SESSION_LOST_NOTIFY_MS 节流），entry 是需并入备份记录的字段 */
export function nextBackupState(prevEntry, streak, now) {
  if (!streak) return { lost: false };
  if (streak >= SESSION_LOST_CONFIRM_SAMPLES) {
    const throttled = prevEntry && prevEntry.sessionLostAt && now - prevEntry.sessionLostAt < SESSION_LOST_NOTIFY_MS;
    return { lost: true, notify: !throttled, entry: { sessionLostAt: now } };
  }
  return { lost: false, entry: { sessionLostStreak: streak } };
}

/* 备份写入决策（纯函数）：把"上一份备份 + 本次采样"映射成对存储的写入动作。
   与 nextBackupState 的区别是 streak 从 prevEntry 内部推导，且疑似未确认时的动作是
   MERGE（只并入计数字段，保留旧 cookies 与 timestamp）。这一点不能省：一旦用坏样本
   覆盖了最后一次在线备份，下一轮 prev 里就没有会话票据，suspect 恒假、streak 永远
   到不了确认值，确认窗口形同不存在 */
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

/* 决策与写盘映射合在一处：后台写入和回归测试共用这一个实现，避免"测试复刻一遍映射、
   后台另写一遍"两半漂移（之前那个死代码 bug 就是这么来的）。
   返回 { write, notify }，write=null 表示本次什么都不写（冻结且处于通知节流期） */
export function applyBackupAction(prevEntry, nextCookies, now) {
  const d = decideBackupWrite(prevEntry, nextCookies, now);
  if (d.action === BACKUP_ACT.FREEZE) {
    return { write: d.notify ? Object.assign({}, prevEntry, d.entry) : null, notify: !!d.notify };
  }
  if (d.action === BACKUP_ACT.MERGE) {
    return { write: Object.assign({}, prevEntry, d.entry), notify: false };
  }
  return { write: { cookies: nextCookies, timestamp: now, schemaVersion: 2 }, notify: false };
}

/* cookie 的"登录票据"得分：备份超限需要截断时用它决定留谁。
   判据取自各家会话 cookie 的通行写法，从强到弱：
     httpOnly（脚本不可读，登录票据几乎都带）
     无 expirationDate（会话票，随浏览器关闭失效，正是"重启后恢复登录"要保的）
     __Host- / __Secure- 前缀（站点显式标记的关键票据）
     path=/（作用域最广） */
export function cookieTicketScore(c) {
  if (!c) return 0;
  let score = 0;
  if (c.httpOnly) score += 8;
  if (isSessionCookie(c)) score += 4;
  if (/^__(Host|Secure)-/i.test(String(c.name || ""))) score += 2;
  if (String(c.path || "") === "/") score += 1;
  return score;
}

/* 同分时的次序：域越短越可能是父域 SSO 票据，最后按 name 兜底。
   必须构成全序，否则同一份 cookie 集合两次排序可能给出不同结果 */
export function compareCookiePriority(a, b) {
  const byScore = cookieTicketScore(b) - cookieTicketScore(a);
  if (byScore) return byScore;
  const byDomain = String((a && a.domain) || "").length - String((b && b.domain) || "").length;
  if (byDomain) return byDomain;
  return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
}

/* 备份条目数封顶。只在超限时排序切尾，正常规模原样返回，否则每次备份的 cookie 顺序
   都会变，白白制造内容差异。
   原来的写法是 `cookies.length = max`，按 getAll 的返回顺序切尾，而这个顺序未定义：
   票据落在尾部时每次备份都稳定缺它，而且前后样本都缺，掉线检测也判不出来 */
export function capCookies(cookies, max) {
  const list = Array.isArray(cookies) ? cookies.slice() : [];
  if (!(max > 0) || list.length <= max) return list;
  list.sort(compareCookiePriority);
  list.length = max;
  return list;
}

/* 历史越界备份的收敛计划（纯函数，纪律 1）：domainChain 修好之前落盘的备份里混着别家
   站点的 cookie，而 restoreCookies 是按每条自己的 domain 写回的——留着它等于每次重启都
   替无关站点复活一遍登录态。整条清除又会让"重启后恢复登录"在用户没碰过任何开关的情况下
   静默失效，所以只剔越界的那几条：
     - 备份键本身就是公共后缀（siteRoot 为 null）→ 整条删，里面每一条都属于别人；
     - 键可信 → 留注册域之内的（含兄弟子域的 SSO 票据），其余丢掉；筛完为空的也删，
       它恢复不出任何东西，却照样占掉 pruneCookieBackups 那 20 站的额度。
   timestamp 一律不动：它是"最后一次有效备份"的时间，30 天 TTL 照原样起效，
   收敛不是重新备份。
   入参 [{ key, host, entry }]，返回 { remove, rewrite, clean } */
export function planBackupConvergence(backups) {
  const remove = [];
  const rewrite = [];
  let clean = 0;
  for (const { key, host, entry } of backups || []) {
    const cookies = entry && Array.isArray(entry.cookies) ? entry.cookies : null;
    /* 结构不成样子的条目不在这里处理，交给 pruneCookieBackups 的 TTL 与键数淘汰 */
    if (!cookies) {
      clean++;
      continue;
    }
    const root = siteRoot(host);
    if (!root) {
      remove.push(key);
      continue;
    }
    const kept = cookies.filter((c) => withinRoot(root, c && c.domain));
    if (kept.length === cookies.length) clean++;
    else if (kept.length === 0) remove.push(key);
    else rewrite.push({ key, entry: Object.assign({}, entry, { cookies: kept }) });
  }
  return { remove, rewrite, clean };
}

/* 备份没有"主机名清单"这类索引。想过用它省掉全量读（存档封顶 20 站 × 200 条，一次
   get(null) 要把几 MB 明文反序列化进 SW），2026-09-19 落地当天回退：登记是索引自己的一次
   无锁读-改-写，漏一次、或写盘后 SW 被回收，那条存档就对定向读永久隐身，而清理与恢复
   全部改按索引取数之后，它同时变成"删不掉、也恢复不了"的死数据。读法见 background.js
   的 readBackupEntries */

/* 错误页判定：服务器故障或页面失踪，心跳连续命中则自动暂停任务 */
export function isErrorStatus(status) {
  return status >= 500 || status === 404;
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

/* 任务网址的跟随判据（纯函数，A14）。task.url 的语义是"用户指定的监控对象"，不是"这一页此刻的地址"。
   同站才跟随，这条原有；新加的是后半句：登录页不当监控对象。少了它，站点一跳 /login 就把 task.url
   改写成登录页，而行为通道那句"监控对象本身就是登录页时此信号不适用"从此恒成立 → 信号永远报正常
   → sus 清零 → 确认窗口（2 次）再也走不到，掉线检测自己把自己 disarm。
   不跟随也不耽误原意：登录成功之后页面离开登录路径，那一刻照样更新成真实目标页 */
export function shouldAdoptTaskUrl(taskUrl, tabUrl) {
  if (!taskUrl || !tabUrl || taskUrl === tabUrl) return false;
  try {
    if (!sameHost(new URL(tabUrl).hostname, new URL(taskUrl).hostname)) return false;
  } catch (e) {
    return false;
  }
  return !looksLikeLoginPage(tabUrl);
}

/* 用户输入解析：逗号/换行分隔，去空、按小写去重，每条 ≤100 字、上限 10 条 */
export function parseKeywords(input) {
  const out = [];
  const seen = new Set();
  for (const raw of String(input == null ? "" : input).split(/[,\n]/)) {
    const k = raw.trim().slice(0, 100);
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= 10) break;
  }
  return out;
}

/* 任务关键词读取（单一事实源）：新数据读 keywords[]，v1.7.0 旧任务兼容单串 keyword。
   后台与弹窗都用它，杜绝"两处各自做兼容"的分叉 */
export function getTaskKeywords(task) {
  if (!task) return [];
  const list = Array.isArray(task.keywords)
    ? task.keywords
    : task.keyword
      ? [task.keyword]
      : [];
  return list.filter((k) => typeof k === "string" && k.trim());
}

/* 在场判定（纯函数）：给完整正文与关键词表，返回当前在场的有哪些。
   页内匹配走的是 background.js 的 matchInPage（另一份实现，把匹配搬到页面里做），
   所以这里同时是那份实现的语义基准——门禁会拿它比对 matchInPage 的判定结果 */
export function presentOf(text, keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  return list.filter((k) => keywordHit(text, k));
}

/* 新出现判定（纯函数）：在场集里尚未通知过的那些，大小写不敏感。
   检测链用在场集回写"已通知"，关键词消失即移出，下次再现重新通知 */
export function newlyOf(present, notifiedKeys) {
  const known = new Set(
    (Array.isArray(notifiedKeys) ? notifiedKeys : []).map((k) => String(k).toLowerCase())
  );
  return (Array.isArray(present) ? present : []).filter(
    (k) => !known.has(String(k).toLowerCase())
  );
}

/* 多框架聚合（纯函数）：executeScript 带 allFrames 之后回的是每个框架一条
   [{frameId, result}]。个别框架可能根本进不去（沙箱框架、view-source、被扩展自己的
   受限页规则挡掉的），那些条目缺失或 result 是 undefined——按"取到几个算几个"处理：
   一个都没取到才算注入失败（present 回 null，调用方据此提前结束这一轮等下个刷新周期），
   取到一个以上就照常合并。命中集按首次出现的顺序去重，顺序会被 notifiedKeys 的比对看到 */
export function aggregateFrameHits(frames) {
  const present = [];
  let framesOk = 0;
  for (const f of Array.isArray(frames) ? frames : []) {
    const list = f && f.result;
    if (!Array.isArray(list)) continue;
    framesOk++;
    for (const k of list) if (!present.includes(k)) present.push(k);
  }
  return { present: framesOk ? present : null, framesOk };
}

/* 挑战域名清单。只在顶层框架的资产列表与子框架自身网址上匹配 */
export const CHALLENGE_URL_RE = /challenges\.cloudflare\.com|recaptcha|hcaptcha/i;

/* 验证墙的标题特征。判据面刻意只取标题与挑战域名资产，不扫正文：正文里"验证码"
   "access denied"是日常词（登录框提示、帮助文案、页脚都会命中），误判成墙的代价是
   任务卡在暂停态且不自愈——页面不再加载，探测也就不再运行。标题才是墙页最稳定的特征。
   401/403 的登录墙语义另走掉线通道，这里不重复判定 */
export const WALL_TITLE_RE =
  /(captcha|verify you are human|human verification|just a moment|attention required|pardon our interruption|安全验证|人机验证|验证码)/i;

export function isChallengeUrl(u) {
  return CHALLENGE_URL_RE.test(String(u == null ? "" : u));
}

/* 子框架要多过一道视口地板才算墙。挂件尺寸的 iframe 自己的文档标题也会写着
   "Just a moment"（reCAPTCHA 复选框 304×78、Turnstile 300×65、hCaptcha 300×88，
   隐藏起来的宽高是 0），它们都过不了这道地板；真正把整页变成墙的 iframe 是视口尺寸。
   门槛取 400×250：高于所有常见挂件，远低于整页。漏判只少一次暂停、下轮刷新还会再看，
   误判却会卡死，所以地板宁可留在子框架这一侧 */
export const WALL_FRAME_MIN_W = 400;
export const WALL_FRAME_MIN_H = 250;

/* 逐框架的墙判定。页内函数只回原始事实（是否顶层、标题、自身网址、自身视口宽高、
   挂在文档里的 iframe/frame/script 网址），两条正则一个都不下页面，所以这条决策链
   能被单测直接断言。顶层框架维持一贯的判据：标题命中，或文档里挂着挑战域名的资产；
   子框架要多过一道视口地板，理由见 WALL_FRAME_MIN_* */
export function decideWallFromFrames(frames) {
  for (const f of Array.isArray(frames) ? frames : []) {
    const r = f && f.result;
    if (!r || typeof r !== "object") continue; /* 这个框架没注入进去 */
    const titled = WALL_TITLE_RE.test(String(r.title == null ? "" : r.title));
    if (r.top) {
      const asset = Array.isArray(r.assets) && r.assets.some(isChallengeUrl);
      if (titled || asset) return true;
      continue;
    }
    const sized = Number(r.w) >= WALL_FRAME_MIN_W && Number(r.h) >= WALL_FRAME_MIN_H;
    if (sized && (titled || isChallengeUrl(r.url))) return true;
  }
  return false;
}

/* webhook 地址校验：仅接受 http(s)，其余（空/非法/其他协议）一律视为关闭 */
export function normalizeWebhookUrl(u) {
  const v = String(u == null ? "" : u).trim();
  try {
    const x = new URL(v);
    return x.protocol === "https:" || x.protocol === "http:" ? v : "";
  } catch (e) {
    return "";
  }
}

/* webhook 回执分类（纯函数，纪律 1）：输入是已经取到的 HTTP 状态与响应正文，
   输出 { ok: true } 或 { ok: false, kind, errorKey }。弹窗只把 errorKey 翻成文案，
   kind 是留在存储里给排障用的粗分类，与微信侧 wechatLastResult 的 kind 同义。
   errorKey 与 wechatErrorKey 同一路数——给用户的是"该去哪改"，不是一个数字。

   为什么 2xx 还要读正文：Slack 那类接收端对"hook 已删除 / 频道被踢"照样回 200，
   失败信号只在正文里的 "ok":false。只看 res.ok 会把这类失败记成成功，
   而"外发失败原来完全无痕"正是这条要修的东西。
   刻意**不**去认 Slack 的纯文本错误（"no_service" 那一类）：正文来自第三方，
   判据一开始按字面猜，绿和红就都不再可信——宁可显示成"200 成功"，也不要凭猜把一次
   正常投递报成失败，那样用户会被训练成不信任这条状态行。
   非 2xx 一律不看正文，只按状态码归桶。
   正文截到前 2000 字再判：填错的地址可能指向一个大文件，而正常 webhook 的回执就一行 JSON。
   代价是标记埋在 2000 字之后时按成功记，这条边界由 logic.test 钉着，别当成"读了全量正文" */
export const WEBHOOK_STATUS_BUCKETS = [
  [[401, 403], "auth", "webhookErrAuth"],
  [[404, 410], "gone", "webhookErrGone"],
  [[400, 406, 413, 415, 422], "payload", "webhookErrPayload"],
  [[429], "rate", "webhookErrRate"]
];

export function webhookResultOf(status, text) {
  const s = Number(status);
  if (!Number.isInteger(s) || s <= 0) {
    return { ok: false, kind: "network", errorKey: "webhookErrNetwork" };
  }
  if (s >= 200 && s <= 299) {
    const body = String(text == null ? "" : text).slice(0, 2000);
    if (/"ok"\s*:\s*false/.test(body)) {
      return { ok: false, kind: "rejected", status: s, errorKey: "webhookErrRejected" };
    }
    return { ok: true, status: s };
  }
  for (const [codes, kind, errorKey] of WEBHOOK_STATUS_BUCKETS) {
    if (codes.includes(s)) return { ok: false, kind, status: s, errorKey };
  }
  if (s >= 500) return { ok: false, kind: "server", status: s, errorKey: "webhookErrServer" };
  return { ok: false, kind: "status", status: s, errorKey: "webhookErrStatus" };
}

/* 关键词命中：大小写不敏感的包含判断；空关键词不判定 */
export function keywordHit(text, keyword) {
  const k = String(keyword == null ? "" : keyword).trim().toLowerCase();
  if (!k) return false;
  return String(text == null ? "" : text).toLowerCase().includes(k);
}

/* 刷新间隔抖动：±pct%（rand 注入以便测试），下限 minMs（alarms 的 30 秒红线）。
   30 秒档的基准已经贴在地板上，对称抖动会有一半样本被抬回原值，所以那一档只正向抖 */
export function jitteredDelayMs(seconds, pct = 15, rand = Math.random, minMs = 30000) {
  const base = Math.max(Number(seconds) || 0, 30) * 1000;
  const p = Math.max(0, Math.min(50, pct)) / 100;
  const ratio = base <= minMs ? rand() : rand() * 2 - 1;
  return Math.max(minMs, Math.round(base * (1 + p * ratio)));
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

/* 外发载荷里的网址：同样只留 origin+pathname，把 query 与 hash 剪掉。
   形状与 urlKey 相同却**故意不共用一个函数**——urlKey 是页面认领的匹配键，为了匹配
   它将来可能放宽（忽略尾部斜杠、把 hash 算进去都合理），而这类改动对匹配是修 bug、
   对外发是把一次性令牌送出去。两个语义各自演化，各自的门禁各自红。
   解析不出来回空串而不是 null：调用方把它当载荷字段值用，"没有可发的网址"就该是空 */
export function outboundUrl(u) {
  try {
    const x = new URL(String(u == null ? "" : u));
    return x.origin + x.pathname;
  } catch (e) {
    return "";
  }
}

/* 网址与目标一致（精确或 origin+pathname 相等）的标签页判定 */
export function tabShowsUrl(tab, url) {
  if (!tab || !tab.url || !url) return false;
  if (tab.url === url) return true;
  const k = urlKey(url);
  return !!k && urlKey(tab.url) === k;
}

/* ================= 微信直连（公众号模板消息）纯逻辑 =================
   扩展的 Service Worker 带 <all_urls> 主机权限就能跨源 fetch，可以直连
   api.weixin.qq.com（微信不返回 CORS 头，网页语境会被拦，扩展 SW 语境返回 200）。
   所以不需要第三方推送服务商，也不用自建中继。
   下面把"发什么、怎么判失败"做成纯函数，Node 单测离线可覆盖，不需要真凭据。 */

/* 模板消息只认这两个变量名，与用户在测试号后台建的模板一一对应：
   {{title.DATA}} 与 {{content.DATA}}。两条规矩必须同时满足，否则用户收到的是
   一张空白卡片，而接口照旧返回 errcode=0：
     1. 变量名不能写错；
     2. 变量前必须有关键词加中文冒号，写成"关键词：{{变量}}"。裸写变量（整行只有
        {{title.DATA}}）会被平台整行丢弃。
   这两条也写在教程页和弹窗提示里，有 `tests/tab-auto-refresh/wechat-copy.test.mjs` 守着
   （示范与变量名同源、裸变量只允许出现在自带反例标记的那句里） */
export const WECHAT_TEMPLATE_KEYS = ["title", "content"];

/* 微信平台的硬上限（2023-05-04 生效的《关于规范公众号模板消息的再次公告》）：
   中间主内容的单个字段不超过 20 个字，且不支持换行，超长由平台直接去掉、不留提示，
   用户看到的是半截话。所以自己按 20 字截：既决定切在哪（要紧的放前面），
   也由我们给出省略号，让"内容就这些"和"被切掉了"能区分开。
   另外首行（first）与尾部备注（remark）会被平台整体去除，模板里不能用这两个变量名 */
export const WECHAT_FIELD_MAX = 20;
export const WECHAT_TITLE_MAX = 20;

/* 压成单行：平台会去掉换行。照原样发的话，多行内容会先被连成一串、再整段截 20 字，
   第一行之后的信息全丢（真实事件就是这样把站点名丢掉的）。
   顺带把连续空白收成一个空格，免得 20 字预算被空格吃掉 */
export function oneLine(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/* 单行 + 截断，超长补省略号（微信自己截是不留提示的）。
   按码点而不是 UTF-16 码元截：按码元切会把 emoji 切成孤立代理，卡片上显示成乱码方块。
   平台数的是"字"，码点数才是对的账 */
export function clipOneLine(s, n = WECHAT_FIELD_MAX) {
  const v = oneLine(s);
  const cps = Array.from(v);
  if (cps.length <= n) return v;
  if (n <= 1) return cps.slice(0, Math.max(n, 0)).join("");
  return cps.slice(0, n - 1).join("") + "…";
}

/* 域名超长时从左侧截：右侧（注册域 + TLD）才是"这是哪个站"的识别信息。
   优先在 label 边界上切，整段丢子域，而不是切进 label 中间：
   "…xample.com" 看起来像一个别的域名，而 "…example.com" 至少还是真实存在的域名。
   例：a.b.c.example.com → …example.com

   放不下时返回 null，由调用方决定整段丢掉站点。这里不能硬截：预算 5 会截出 "…com"、
   预算 6 会截出 "…e.com"，正是上面要避免的形态；而英文的事件名有 11~17 字符，
   把 20 字预算吃到只剩 0~6，硬截会让每一条英文卡片都变成碎片。
   例外：无点主机（内网名、单段域名）没有 label 边界可谈，从左侧截是唯一选择 */
export function clipHostTail(host, n = WECHAT_FIELD_MAX) {
  const v = oneLine(host);
  if (v.length <= n) return v;
  const labels = v.split(".");
  /* 先整段丢子域（至少保留"注册域 + TLD"两段）：比切进 label 中间可读得多 */
  for (let i = 1; i <= labels.length - 2; i++) {
    const tail = labels.slice(i).join(".");
    if (tail.length <= n) return tail.length + 1 <= n ? "…" + tail : tail;
  }
  if (labels.length === 1) {
    /* 无点主机：硬截左侧是唯一选择；顺手去掉开头残留的 "-" / "."，
       免得出现 "…-domain.com" 这种别扭写法 */
    if (n <= 1) return v.slice(-Math.max(n, 0));
    return "…" + v.slice(-(n - 1)).replace(/^[-.]+/, "");
  }
  /* 有 label 边界、却连"注册域 + TLD"两段都放不下 → 交给调用方丢弃站点 */
  return null;
}

/* 卡片标题 = "事件 + 分隔符 + 站点"。事件名不可省：站点放不下时宁可只留事件，
   也不要从右边把事件名切掉，切了就等于没说发生了什么。

   sep 由语言包给，并且自带需要的空格（zh " · "、en "·"）：分隔符占几个字符是排版决定，
   写死在代码里就没法按语言调预算（英文事件名长，必须把空格省掉才放得下注册域）。
   预算 = max 减事件名减分隔符，剩下的全给站点；站点放不下完整域名就整段不要。
   长度一律按码点算，与 clipOneLine 的账一致 */
export function wechatTitleOf({ eventLabel, host, sep = " · ", max = WECHAT_TITLE_MAX } = {}) {
  const e = clipOneLine(eventLabel, max);
  /* 分隔符不做 trim：它前后的空格是排版的一部分（zh " · "、en "·"）。
     只压平换行与连续空白，免得语言包里带进一个换行把 20 字预算搞乱 */
  const s = String(sep == null ? " · " : sep).replace(/\s+/g, " ") || "·";
  const h = oneLine(host);
  if (!h) return e;
  const budget = max - Array.from(e).length - Array.from(s).length;
  if (budget < 4) return e; /* 留给站点的位置太小，显示个"…c"没有意义 */
  const tail = clipHostTail(h, budget);
  if (!tail) return e; /* 放不下完整域名：只留事件，不给碎片 */
  return clipOneLine(e + s + tail, max);
}

/* ================= 启动恢复与定时器门控的顺序决策 =================
   这两处原先是命令式循环里的 if 嵌套，顺序就是正确性本身（谁排在谁前面决定会不会
   产出僵尸任务），而顺序在代码评审里是读不出来的。抽成纯函数后单测能直接断言序列。
   执行器（background.js）只负责读写浏览器状态，不再自己做判断。 */

/* "任务里没有网址、也没有可辨认的目标"时该淘汰还是补记：与 prune 的 adoptLegacyUrls 同义 */
const HTTP_URL = /^https?:/i;

/* 启动恢复的挂接计划（纯函数）。
   输入 tasks（tabId → 任务）与 tabs（当前打开的标签页），输出一个可以自己走一遍的执行序列。
   几条不容回退的规则，都是历史上真出过事故的：
   - ID 仍被占用不代表挂接正确。浏览器重启后 tabId 会重新分配，旧任务 ID 可能撞上一个无关
     的新标签页，只有网址一致才算认领（keep），否则宁可重挂或重开。
   - 认领写入之前必须确认目标 id 不再是别的未处理任务的键（pending），否则两个任务撞同一页
     时，后写入的会把先写入的整条覆盖掉——任务静默丢失，界面上一件事也看不出来。
   - 同一网址开在多个标签页上时，一个页面只挂一个任务（claims 去重），认领不到的走 watch。
   - adoptLegacyUrls 只在扩展安装/更新那一回为真：那时浏览器没重启、tabId 仍指向原页面，
     可以给 v1.4.3 及更早"任务里只有间隔和创建时间"的旧数据补记当前网址；重启之后无从辨认，
     只能淘汰（drop）。注册写成 () => prune(true/false)，不能直接 addListener(prune)。
   watch 是"现场还认领不到、但值得等会话恢复再判一次"的候选：执行器等满一个共享窗口后用
   最新的 tasks/tabs 再跑一遍本函数，剩下的才重开标签页。原先是每个候选各等 20 秒且全程
   持着任务锁，5 个未认领任务能让弹窗与刷新停摆 100 秒。 */
export function planPrune({ tasks, tabs, adoptLegacyUrls = false } = {}) {
  const next = Object.assign({}, tasks || {});
  const list = Array.isArray(tabs) ? tabs.filter((t) => t && typeof t.id === "number") : [];
  const byId = new Map(list.map((t) => [t.id, t]));
  /* 已被任务占用的标签页 id：认领写入前查它 */
  const claims = new Set();
  const pending = new Set(Object.keys(next).map(Number));
  const keep = [];
  const adopt = [];
  const remap = [];
  const watch = [];
  const dropped = [];
  /* 原任务键里不再有效的那些。旧 alarm 要等写盘之后再清，且只对照写盘后的最终键集合，
     否则会把本轮刚 arm 上去的 alarm（id 恰好曾是别的任务的键）一起清掉，
     产出"任务在、永不刷新"的僵尸 */
  const staleIds = [];

  for (const key of Object.keys(next)) {
    const id = Number(key);
    const task = next[key];
    const live = byId.get(id);
    if (!live) continue;
    if (task.url) {
      if (tabShowsUrl(live, task.url)) {
        claims.add(id);
        pending.delete(id);
        keep.push(id);
      }
      continue;
    }
    if (adoptLegacyUrls && HTTP_URL.test(live.url || "")) {
      next[key] = Object.assign({}, task, { url: live.url });
      claims.add(id);
      pending.delete(id);
      keep.push(id);
      adopt.push(id);
    }
    /* 浏览器重启后碰上无网址的旧任务：不认领，交由下面淘汰 */
  }

  for (const key of Object.keys(next)) {
    const id = Number(key);
    if (claims.has(id)) continue;
    pending.delete(id);
    const task = next[key];
    let match = null;
    for (const t of list) {
      if (claims.has(t.id) || pending.has(t.id)) continue;
      if (tabShowsUrl(t, task.url)) {
        match = t;
        break;
      }
    }
    delete next[key];
    staleIds.push(id);
    if (match) {
      claims.add(match.id);
      pending.delete(match.id);
      next[match.id] = Object.assign({}, task, { url: match.url || task.url });
      remap.push({ from: id, to: match.id, url: next[match.id].url });
    } else if (task.url && HTTP_URL.test(task.url)) {
      /* 带上整个 task：执行器等到窗口结束后要么把它挂到到位的页面上，要么原样重开
         （保留 keywords / onHit / notifiedKeys / autoPaused，不能只留网址和间隔） */
      watch.push({ from: id, url: task.url, task });
    } else {
      dropped.push({ from: id, url: task.url || "", task });
    }
  }

  const dirty =
    adopt.length > 0 || remap.length > 0 || watch.length > 0 || dropped.length > 0;
  return { next, keep, adopt, remap, watch, dropped, staleIds, claims, dirty };
}

/* 用户在该页上真实操作后多久内跳过刷新。放在这里是因为它是 decideAlarmAction 的判据，
   而 decideAlarmAction 必须能被单测直接调用 */
export const ACTIVITY_SKIP_MS = 60000;

export const ALARM_ACT = { CLEAR: "clear", STOP: "stop", SKIP: "skip", RELOAD: "reload" };

/* 定时器到点后该做什么（纯函数）。输入全是已经取好的事实，不做任何浏览器调用。
   次序就是语义，三处不能调换：
   - pausedAll 排在标签页存在性之前：全局暂停期间不去动"页没了就停任务"那条，
     否则暂停状态下随手关一个被监控页就会收到"任务已停止"。
   - 标签页存在性排在 autoPaused 之前：被自动暂停的任务如果标签页被关掉了，
     没人清理就会留下僵尸。
   - 活动跳过排在休眠判定之前，两条都是"跳过这一拍"，谁先谁后只影响 reason。
   活动跳过的 tabIsVisible 与 lastActivityAgoMs 是 or：前者是不依赖注入的兜底
   （人正看着这页就别重载它），后者来自内容脚本上报。焦点窗口认不出来时
   tabIsVisible 给 false，宁可多刷一次也绝不能变成"永不刷新"。
   返回 { action, reason }，action 取 ALARM_ACT 四个值之一。 */
export function decideAlarmAction({
  task,
  tab,
  pausedAll,
  skipOnActivity,
  skipDiscarded,
  lastActivityAgoMs = Infinity,
  tabIsVisible = false
} = {}) {
  if (!task) return { action: ALARM_ACT.CLEAR, reason: "no-task" };
  if (pausedAll) return { action: ALARM_ACT.SKIP, reason: "paused-all" };
  if (!tab) return { action: ALARM_ACT.STOP, reason: "tab-gone" };
  if (task.autoPaused) {
    return { action: ALARM_ACT.SKIP, reason: "auto-paused", pausedReason: task.autoPaused.reason };
  }
  const recentlyUsed =
    Number.isFinite(lastActivityAgoMs) && lastActivityAgoMs < ACTIVITY_SKIP_MS;
  if (skipOnActivity && (tabIsVisible || recentlyUsed)) {
    return { action: ALARM_ACT.SKIP, reason: "user-active" };
  }
  if (skipDiscarded && tab.discarded) return { action: ALARM_ACT.SKIP, reason: "discarded" };
  return { action: ALARM_ACT.RELOAD, reason: "" };
}

/* SKIP 的四种理由 → 弹窗任务行那句解释的 i18n 键（A12）。
   住在 decideAlarmAction 旁边是刻意的：理由在这里产生，也只在这里产生，两张表隔得远
   就会各改各的，而表现是"那一行永远不出现"或者干脆显示裸键名。
   并集由 tests/tab-auto-refresh/skip-trace.test.mjs 钉住——它遍历真实判定的输出收集理由，
   不是抄一份清单来比。ALARM_SKIP_UNKNOWN_KEY 是兜底：新加理由忘了登记时弹窗要给一句话，
   不能给 "skipReasonFoo" */
export const ALARM_SKIP_REASONS = {
  "paused-all": "skipReasonPausedAll",
  "auto-paused": "skipReasonAutoPaused",
  "user-active": "skipReasonUserActive",
  discarded: "skipReasonDiscarded"
};
export const ALARM_SKIP_UNKNOWN_KEY = "skipReasonUnknown";

/* 凭据完整性：四样缺一不可。返回缺失项（键名），让弹窗能点名而不是笼统报错 */
export function wechatConfigState(settings) {
  const s = settings || {};
  const fields = [
    ["appId", s.wechatAppId],
    ["secret", s.wechatAppSecret],
    ["openId", s.wechatOpenId],
    ["templateId", s.wechatTemplateId]
  ];
  const missing = fields
    .filter(([, v]) => !String(v == null ? "" : v).trim())
    .map(([k]) => k);
  return { ready: missing.length === 0, missing };
}

/* 通知事件清单读取（单一事实源）：新键 notifyEvents，兼容 1.7.0 的 webhookEvents */
export function notifyEventsOf(settings) {
  const s = settings || {};
  if (Array.isArray(s.notifyEvents)) return s.notifyEvents;
  if (Array.isArray(s.webhookEvents)) return s.webhookEvents;
  return NOTIFY_EVENTS.slice();
}

/* access_token 请求体（stable_token 接口）。用 stable_token 而非老 /cgi-bin/token：
   老接口每刷一次就把上一个 token 作废，多端并发/多重启会互相打掉；
   stable_token 在 force_refresh=false 时有效期内返回同一个 token（官方语义） */
export function buildTokenRequest(appId, secret, force = false) {
  return {
    grant_type: "client_credential",
    appid: String(appId == null ? "" : appId).trim(),
    secret: String(secret == null ? "" : secret).trim(),
    force_refresh: !!force
  };
}

/* 模板消息请求体。url 只在合法 http(s) 时带上，用于点击卡片跳转，
   非法值会让整条消息被拒，宁可不给跳转也不要整条失败。
   两个字段值都过 clipOneLine：单行化（平台不支持换行）并截到平台的 20 字以内，
   免得微信那边截出半句话（这里同时也是最后一道防线：调用方万一直接塞长文本进来） */
export function buildWechatMessage({ openId, templateId, title, content, url } = {}) {
  const data = {};
  data[WECHAT_TEMPLATE_KEYS[0]] = { value: clipOneLine(title, WECHAT_TITLE_MAX) };
  data[WECHAT_TEMPLATE_KEYS[1]] = { value: clipOneLine(content, WECHAT_FIELD_MAX) };
  const body = {
    touser: String(openId == null ? "" : openId).trim(),
    template_id: String(templateId == null ? "" : templateId).trim(),
    data
  };
  const u = String(url == null ? "" : url).trim();
  if (/^https?:\/\//i.test(u)) body.url = u;
  return body;
}

/* token 缓存新鲜度：过期前 5 分钟即视为过期（留出网络往返余量，
   避免"刚取到就过期"的边界失败）。cache = {token, expireAt} */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export function tokenFresh(cache, now) {
  if (!cache || !cache.token) return false;
  return Number(cache.expireAt) - TOKEN_REFRESH_MARGIN_MS > now;
}

/* token 失效码：清缓存重取一次再试（40001 invalid credential / 42001 token expired） */
export function isTokenErrorCode(code) {
  return code === 40001 || code === 42001;
}

/* 错误码 → 文案键。给用户看的是"该去哪改"，不是一个数字 */
export const WECHAT_ERROR_KEYS = {
  40001: "wechatErrToken",
  42001: "wechatErrToken",
  40003: "wechatErrOpenId",
  40013: "wechatErrAppId",
  40037: "wechatErrTemplate",
  40164: "wechatErrIp",
  43004: "wechatErrFollow",
  45009: "wechatErrQuota",
  47003: "wechatErrTemplate"
};
export function wechatErrorKey(code) {
  return WECHAT_ERROR_KEYS[code] || "wechatErrOther";
}
