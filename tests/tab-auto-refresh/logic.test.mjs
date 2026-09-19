import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, PREFIX, PRESETS } from "../../tab-auto-refresh/shared/config.js";
import {
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  RESTRICTED_URL,
  clampInterval,
  domainChain,
  formatCountdown,
  formatInterval,
  hostOf,
  nextBackupState,
  applyBackupAction,
  capCookies,
  compareCookiePriority,
  cookieTicketScore,
  parseKeywords,
  getTaskKeywords,
  newlyOf,
  presentOf,
  normalizeWebhookUrl,
  webhookResultOf,
  WEBHOOK_STATUS_BUCKETS,
  normalizeStoredSettings,
  isErrorStatus,
  decideBackupWrite,
  BACKUP_ACT,
  looksLikeLoginPage,
  keywordHit,
  jitteredDelayMs,
  hasSessionCookie,
  sameHost,
  sameSite,
  shouldAdoptTaskUrl,
  sessionLostDetected,
  siteRoot,
  planBackupConvergence,
  withinRoot,
  tabShowsUrl,
  urlKey,
  outboundUrl,
  NOTIFY_EVENTS,
  WECHAT_TEMPLATE_KEYS,
  WECHAT_FIELD_MAX,
  WECHAT_TITLE_MAX,
  TOKEN_REFRESH_MARGIN_MS,
  buildTokenRequest,
  buildWechatMessage,
  clipHostTail,
  clipOneLine,
  isTokenErrorCode,
  notifyEventsOf,
  oneLine,
  tokenFresh,
  wechatConfigState,
  wechatErrorKey,
  wechatTitleOf,
} from "../../tab-auto-refresh/shared/logic.js";

test("clampInterval falls back to the default for invalid input", () => {
  assert.deepEqual(clampInterval(0), { seconds: MIN_INTERVAL_SEC, clamped: false });
  assert.deepEqual(clampInterval(-5), { seconds: MIN_INTERVAL_SEC, clamped: false });
  assert.deepEqual(clampInterval("abc"), { seconds: MIN_INTERVAL_SEC, clamped: false });
  assert.deepEqual(clampInterval(NaN), { seconds: MIN_INTERVAL_SEC, clamped: false });
});

test("clampInterval lifts too-small values to the minimum", () => {
  assert.deepEqual(clampInterval(29), { seconds: 30, clamped: true });
  assert.deepEqual(clampInterval(29.9), { seconds: 30, clamped: true });
});

test("clampInterval keeps valid values unchanged", () => {
  assert.deepEqual(clampInterval(30), { seconds: 30, clamped: false });
  assert.deepEqual(clampInterval(45), { seconds: 45, clamped: false });
  assert.deepEqual(clampInterval("60"), { seconds: 60, clamped: false });
});

test("formatInterval renders localized units", () => {
  const zh = { hours: "小时", minutes: "分钟", seconds: "秒" };
  assert.equal(formatInterval(3600, zh), "1 小时");
  assert.equal(formatInterval(300, zh), "5 分钟");
  assert.equal(formatInterval(45, zh), "45 秒");
});

test("formatCountdown renders mm:ss and hh:mm:ss", () => {
  assert.equal(formatCountdown(0), "00:00");
  assert.equal(formatCountdown(-1000), "00:00");
  assert.equal(formatCountdown(59_000), "00:59");
  assert.equal(formatCountdown(61_000), "01:01");
  /* 小时位保持原版行为：不补零 */
  assert.equal(formatCountdown(3_661_000), "1:01:01");
});

test("presets are ordered, respect the minimum, and include the default", () => {
  const seconds = PRESETS.map((p) => p.seconds);
  assert.deepEqual([...seconds].sort((a, b) => a - b), seconds);
  for (const s of seconds) assert.ok(s >= MIN_INTERVAL_SEC);
  assert.ok(seconds.includes(DEFAULT_INTERVAL_SEC));
});

test("alarm prefix matches the documented naming scheme", () => {
  assert.equal(PREFIX, "refresh-");
});

test("siteRoot slices the registered domain, incl. multi-level public suffixes", () => {
  assert.equal(siteRoot("www.example.com"), "example.com");
  assert.equal(siteRoot("example.com"), "example.com");
  assert.equal(siteRoot("news.example.org.cn"), "example.org.cn");
  assert.equal(siteRoot("a.b.c.example.co.uk"), "example.co.uk");
  assert.equal(siteRoot("sub.domain.ac.cn"), "domain.ac.cn");
  assert.equal(siteRoot("192.168.1.10"), "192.168.1.10");
  assert.equal(siteRoot("localhost"), "localhost");
  assert.equal(siteRoot(""), null);
  assert.equal(siteRoot("WWW.Example.COM"), "example.com");
});

test("sameSite treats subdomains as one site but different sites as drifted", () => {
  /* 登录 / SSO 常在同站子域间跳转，不算漂移 */
  assert.ok(sameSite("sso.example.org.cn", "app.example.org.cn"));
  assert.ok(sameSite("example.org.cn", "app.example.org.cn"));
  /* 完全不同的网站算漂移 */
  assert.ok(!sameSite("evil.example.org", "app.example.org.cn"));
  assert.ok(!sameSite("other-site.com", "app.example.org.cn"));
  /* 不同内网 IP 不互相误判 */
  assert.ok(!sameSite("192.168.1.10", "192.168.2.10"));
  assert.ok(!sameSite(null, "example.com"));
});

test("sameHost is stricter than sameSite: sibling SSO subdomains differ", () => {
  assert.ok(sameHost("app.example.org.cn", "example.org.cn"));
  assert.ok(sameHost("example.org.cn", "app.example.org.cn"));
  assert.ok(!sameHost("sso.example.org.cn", "app.example.org.cn"));
});

/* A14：task.url 的语义是"用户指定的监控对象"，不是"这一页此刻的地址"。
   一旦让它跟着页面跳到登录页，行为通道那句"监控对象本身就是登录页时信号不适用"
   就恒成立，掉线检测自己把自己 disarm */
test("shouldAdoptTaskUrl follows same-host business pages but never adopts a login page", () => {
  /* 同站业务页正常跟随：登录完成后地址离开登录页，那一刻还是要更新成真实目标页 */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "https://shop.example.co.nz/board?page=2"), true);
  assert.equal(shouldAdoptTaskUrl("https://example.co.nz/board", "https://shop.example.co.nz/board"), true);
  /* 同站跳登录页：这正是要钉住的那一步，A14 之前它返回 true */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "https://shop.example.co.nz/login"), false);
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "https://shop.example.co.nz/signin?next=%2Fboard"), false);
  /* 从登录页回到业务页也要能更新回去，否则"任务记录的永远是登录页"没法自愈 */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/login", "https://shop.example.co.nz/board"), true);
  /* 跨站不覆盖，保留原始监控对象以便自动返回 */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "https://other.example.co.nz/board"), false);
  /* 没变化就别写盘：探针那套"值没变就不写"的纪律在这儿同样成立 */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "https://shop.example.co.nz/board"), false);
  assert.equal(shouldAdoptTaskUrl(null, "https://shop.example.co.nz/board"), false);
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", ""), false);
  /* 畸形网址：不跟随，也不抛 */
  assert.equal(shouldAdoptTaskUrl("https://shop.example.co.nz/board", "not a url"), false);
});

test("hostOf extracts hostname from URL and rejects junk", () => {
  assert.equal(hostOf("https://app.example.com/#/login"), "app.example.com");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});

test("domainChain walks the parent domains of a host", () => {
  assert.deepEqual(domainChain("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  assert.deepEqual(domainChain("example.com"), ["example.com"]);
});

test("siteRoot never degrades to a multi-level public suffix", () => {
  /* 旧实现是一张手写的完整后缀表（"co.uk"、"com.cn"…），漏一条就把整段公共后缀当成注册域：
     shop.example.co.nz 的根域算成 "co.nz"，随后拿它去查 cookie，全站 .co.nz 一起进备份。
     换成"品牌段 + 两字母码"的形状规则之后，这一整类不再依赖清单抄全 */
  assert.equal(siteRoot("shop.example.co.nz"), "example.co.nz");
  assert.equal(siteRoot("a.example.com.ua"), "example.com.ua");
  assert.equal(siteRoot("www.example.co.id"), "example.co.id");
  assert.equal(siteRoot("shop.example.com.ph"), "example.com.ph");
  assert.equal(siteRoot("shop.example.com.vn"), "example.com.vn");
  assert.equal(siteRoot("api.example.com.ru"), "example.com.ru");
  /* 表里原本有的那些不能因为换规则而退化 */
  assert.equal(siteRoot("news.example.com.au"), "example.com.au");
  assert.equal(siteRoot("shop.example.co.jp"), "example.co.jp");
  assert.equal(siteRoot("shop.example.com.br"), "example.com.br");
  /* 末段是两字母码、但倒数第二段不是品牌段：注册域就是它自己，不许多切一段 */
  assert.equal(siteRoot("shop.example.io"), "example.io");
  assert.equal(siteRoot("my.site.me"), "site.me");
  /* 单段主机与 IPv4 没有父域可切，整串即身份 */
  assert.equal(siteRoot("intranet"), "intranet");
  assert.equal(siteRoot("localhost"), "localhost");
  assert.equal(siteRoot("10.0.0.7"), "10.0.0.7");
  /* 整串本身就是公共后缀：取不到可信注册域就返回 null，调用方宁可不备份 */
  assert.equal(siteRoot("co.nz"), null);
  assert.equal(siteRoot("com.ua"), null);
});

test("domainChain bottoms out at the registrable root, never above it", () => {
  /* 这条不变式是越界采集的总闸：只要末段恒等于 siteRoot，就永远不可能拿公共后缀去查 cookie。
     逐条断言具体层级只能覆盖写到用例里的那几个域名，形状规则改了也测不出来 */
  const hosts = [
    "a.b.example.com", "example.com", "shop.example.co.nz", "deep.a.b.example.org.cn",
    "x.example.com.ua", "localhost", "intranet", "192.168.1.10", "WWW.Example.COM",
    "shop.example.io", "a.gov.uk", "co.nz", "com.ua"
  ];
  for (const host of hosts) {
    const chain = domainChain(host);
    const root = siteRoot(host);
    if (!root) {
      assert.deepEqual(chain, [], host + " 取不到可信注册域，域链必须是空的");
      continue;
    }
    assert.equal(chain.at(-1), root, host + " 的域链末段不是它的注册域");
    for (const d of chain) assert.ok(withinRoot(root, d), host + " 的域链里有 " + d + " 跑到注册域之外");
  }
  /* 修之前的失效形状点名一遍：旧链最后一层是 co.nz，语义是"等于或子域于它" */
  assert.deepEqual(domainChain("shop.example.co.nz"), ["shop.example.co.nz", "example.co.nz"]);
  assert.deepEqual(domainChain("localhost"), ["localhost"]);
  assert.deepEqual(domainChain("192.168.1.10"), ["192.168.1.10"]);
  assert.deepEqual(domainChain("co.nz"), []);
});

test("withinRoot covers the root itself and its subdomains only", () => {
  assert.ok(withinRoot("example.co.nz", "example.co.nz"));
  assert.ok(withinRoot("example.co.nz", ".example.co.nz")); /* cookie 的父域写法 */
  assert.ok(withinRoot("example.co.nz", "sso.example.co.nz"));
  assert.ok(!withinRoot("example.co.nz", "other.co.nz"));
  assert.ok(!withinRoot("example.co.nz", "example.co.nz.evil.com"));
  assert.ok(!withinRoot("example.co.nz", ""));
  assert.ok(!withinRoot(null, "example.co.nz"));
  assert.ok(!withinRoot("example.co.nz", null));
});

test("planBackupConvergence drops only what sits outside the registrable root", () => {
  const c = (domain, name) => ({ domain, name, path: "/", value: "v" });
  const own = c("shop.example.co.nz", "sid");
  const parent = c(".example.co.nz", "sso");
  const sibling = c("sso.example.co.nz", "tick");
  const foreign = c("other.co.nz", "their-session");
  const unrelated = c("unrelated.com", "x");
  const plan = planBackupConvergence([
    {
      key: "cookieBackup:shop.example.co.nz",
      host: "shop.example.co.nz",
      entry: { cookies: [own, parent, sibling, foreign, unrelated], timestamp: 111, schemaVersion: 2 }
    },
    /* 键本身就是公共后缀：里面每一条都属于别人 */
    { key: "cookieBackup:co.nz", host: "co.nz", entry: { cookies: [foreign], timestamp: 222 } },
    /* 只有这一条才真正钉住"键不可信就整条删"：后缀键里一条 cookie 都没有时，
       走过滤分支的结果是"干净、留着"，只有 !root 分支会把它删掉 */
    { key: "cookieBackup:com.ua", host: "com.ua", entry: { cookies: [], timestamp: 666 } },
    /* 全是从别家捞来的：整条删掉，不留空壳 */
    { key: "cookieBackup:clean.example.com", host: "clean.example.com", entry: { cookies: [foreign], timestamp: 333 } },
    /* 一条越界的都没有：不该出现在 remove / rewrite 里，也不该被写一遍 */
    { key: "cookieBackup:a.example.com", host: "a.example.com", entry: { cookies: [c("a.example.com", "sid")], timestamp: 444 } },
    /* 结构不成样子：这里不处理，留给 pruneCookieBackups 的 TTL 淘汰 */
    { key: "cookieBackup:junk.example.com", host: "junk.example.com", entry: { timestamp: 555 } }
  ]);
  assert.deepEqual(plan.remove.sort(), [
    "cookieBackup:clean.example.com",
    "cookieBackup:co.nz",
    "cookieBackup:com.ua"
  ]);
  assert.equal(plan.rewrite.length, 1);
  const rw = plan.rewrite[0];
  assert.equal(rw.key, "cookieBackup:shop.example.co.nz");
  assert.deepEqual(rw.entry.cookies.map((x) => x.name).sort(), ["sid", "sso", "tick"]);
  /* timestamp 是"最后一次有效备份"的时间，收敛不是重新备份，30 天 TTL 照原样起效 */
  assert.equal(rw.entry.timestamp, 111);
  assert.equal(rw.entry.schemaVersion, 2);
  assert.equal(plan.clean, 2);
});

test("urlKey keeps origin+pathname and drops query and hash", () => {
  assert.equal(urlKey("https://example.com/page?a=1#frag"), "https://example.com/page");
  assert.equal(urlKey("not a url"), null);
});

test("outboundUrl 剪掉 query 与 hash，坏输入回空串", () => {
  assert.equal(
    outboundUrl("https://example.com/ticket/42?sig=ONE-TIME&email=a%40b.test#s=9"),
    "https://example.com/ticket/42"
  );
  assert.equal(outboundUrl("https://example.com"), "https://example.com/");
  /* 与 urlKey 唯一的形状差别是刻意的：载荷字段要的是字符串，不是"可以传 null 进去" */
  assert.equal(outboundUrl("not a url"), "");
  assert.equal(outboundUrl(null), "");
});

test("tabShowsUrl matches exact url or origin+pathname, rejects junk", () => {
  const tab = { url: "https://example.com/page?x=1" };
  assert.ok(tabShowsUrl(tab, "https://example.com/page"));
  assert.ok(tabShowsUrl(tab, "https://example.com/page?x=1"));
  assert.ok(!tabShowsUrl(tab, "https://example.com/other"));
  assert.ok(!tabShowsUrl(tab, "https://another.com/page"));
  assert.ok(!tabShowsUrl(null, "https://example.com/page"));
  assert.ok(!tabShowsUrl(tab, null));
});

test("RESTRICTED_URL flags browser internal pages only", () => {
  for (const url of ["chrome://newtab", "edge://settings", "devtools://devtools/bundled/inspector.html", "about:blank", "chrome-extension://abc/popup.html"]) {
    assert.ok(RESTRICTED_URL.test(url), url);
  }
  assert.ok(!RESTRICTED_URL.test("https://example.com"));
  assert.ok(!RESTRICTED_URL.test("http://localhost:3000/"));
});

test("hasSessionCookie detects cookies without expirationDate", () => {
  assert.equal(hasSessionCookie([]), false);
  assert.equal(hasSessionCookie(null), false);
  assert.equal(hasSessionCookie([{ name: "a", expirationDate: 123 }]), false);
  assert.equal(hasSessionCookie([{ name: "a", expirationDate: 123 }, { name: "b" }]), true);
  assert.equal(hasSessionCookie([{ name: "b", expirationDate: 0 }]), true);
});

test("sessionLostDetected fires only when session cookies go from present to absent", () => {
  const withSession = [{ name: "sid" }];
  const persistentOnly = [{ name: "pref", expirationDate: 9e9 }];
  /* 有 → 无：判定掉线 */
  assert.equal(sessionLostDetected(withSession, persistentOnly), true);
  assert.equal(sessionLostDetected(withSession, []), true);
  /* 无 → 无：本来就没有可丢的会话（或从未登录），不误报 */
  assert.equal(sessionLostDetected(persistentOnly, []), false);
  assert.equal(sessionLostDetected([], []), false);
  /* 有 → 有：会话仍在，正常 */
  assert.equal(sessionLostDetected(withSession, withSession), false);
  /* 首份备份（prev 为空）不判定 */
  assert.equal(sessionLostDetected(undefined, persistentOnly), false);
  assert.equal(sessionLostDetected(null, null), false);
});

test("keep-alive is on by default (only acts on tabs with an active task)", () => {
  assert.equal(DEFAULT_SETTINGS.keepAlive, true);
});

test("nextBackupState requires a confirmation window before freezing backups", () => {
  const now = 1_800_000_000_000;
  /* 采样正常：不冻结、无附加字段（覆盖备份时自然清掉 streak / sessionLostAt） */
  assert.deepEqual(nextBackupState(null, 0, now), { lost: false });
  assert.deepEqual(nextBackupState({ sessionLostAt: now }, 0, now), { lost: false });
  /* 第 1 次疑似：只记计数，不冻结不通知 */
  const suspect = nextBackupState({ cookies: [] }, 1, now);
  assert.equal(suspect.lost, false);
  assert.deepEqual(suspect.entry, { sessionLostStreak: 1 });
  /* 第 2 次（确认阈值）：冻结并要求通知 */
  const confirmed = nextBackupState({ sessionLostStreak: 1 }, 2, now);
  assert.equal(confirmed.lost, true);
  assert.equal(confirmed.notify, true);
  assert.deepEqual(confirmed.entry, { sessionLostAt: now });
  /* 持续掉线：6 小时内的通知节流，超期恢复提醒 */
  const throttled = nextBackupState({ sessionLostAt: now - 60_000 }, 3, now);
  assert.equal(throttled.lost, true);
  assert.equal(throttled.notify, false);
  const overdue = nextBackupState({ sessionLostAt: now - 7 * 60 * 60 * 1000 }, 4, now);
  assert.equal(overdue.notify, true);
});

/* 复审§2 集成契约（04 复审 §4.4 升级版）：测试直接驱动 applyBackupAction——
   后台写盘用的就是它，决策与落盘映射不再有两半，测试不可能与实现悄悄分家。 */
function runSamples(samples, now0 = 1_800_000_000_000) {
  let entry;
  const acts = [];
  samples.forEach((cookies, i) => {
    const act = applyBackupAction(entry, cookies, now0 + i * 1000);
    if (act.write) entry = act.write;
    acts.push(act);
  });
  return { acts, entry };
}

test("applyBackupAction keeps the last good backup until the loss is confirmed", () => {
  const withTicket = [{ name: "sid" }];
  const noTicket = [{ name: "pref", expirationDate: 9e9 }];
  const { acts, entry } = runSamples([withTicket, noTicket, noTicket, noTicket]);
  assert.equal(hasSessionCookie(acts[0].write.cookies), true); /* 1 在线：正常覆盖 */
  assert.equal(acts[1].notify, false);
  assert.equal(hasSessionCookie(acts[1].write.cookies), true, "疑似采样绝不能覆盖最后一次好备份");
  assert.equal(acts[1].write.sessionLostStreak, 1);
  assert.equal(acts[2].notify, true); /* 2 连缺：确认冻结并通知 */
  assert.equal(acts[2].write.sessionLostAt !== undefined, true);
  assert.equal(hasSessionCookie(acts[2].write.cookies), true);
  assert.equal(acts[3].write, null, "持续掉线：什么都不写");
  assert.equal(acts[3].notify, false, "通知按 6h 节流");
  assert.equal(hasSessionCookie(entry.cookies), true, "存储里仍是最后一次好备份");
});

test("applyBackupAction recovers when a session ticket comes back", () => {
  const withTicket = [{ name: "sid" }];
  const noTicket = [{ name: "pref", expirationDate: 9e9 }];
  const { acts, entry } = runSamples([withTicket, noTicket, withTicket]);
  assert.equal(acts[1].write.sessionLostStreak, 1);
  assert.equal(acts[2].write.sessionLostStreak, undefined, "重新登录后计数清除");
  assert.equal(acts[2].write.sessionLostAt, undefined, "冻结标记随之清除");
  assert.equal(entry.cookies[0].name, "sid", "恢复即正常覆盖");
});

test("decideBackupWrite: first sample with no history just writes normally", () => {
  const noTicket = [{ name: "pref", expirationDate: 9e9 }];
  const d = decideBackupWrite(undefined, noTicket, 1);
  assert.equal(d.action, BACKUP_ACT.OVERWRITE);
  assert.equal(d.streak, 0);
});

test("looksLikeLoginPage matches login paths but ignores query returnURL noise", () => {
  assert.ok(looksLikeLoginPage("https://ex.com/login"));
  assert.ok(looksLikeLoginPage("https://ex.com/accounts/Signin?next=/home"));
  assert.ok(looksLikeLoginPage("https://sso.ex.com/oauth/authorize"));
  assert.ok(looksLikeLoginPage("https://ex.com/login.html"));
  /* 普通页面不误判 */
  assert.ok(!looksLikeLoginPage("https://ex.com/dashboard"));
  assert.ok(!looksLikeLoginPage("https://ex.com/blog/logging-basics"));
  /* query 里的 returnURL 含 login 不该触发（只看 pathname） */
  assert.ok(!looksLikeLoginPage("https://ex.com/home?next=/login"));
  assert.ok(!looksLikeLoginPage("not a url"));
  assert.ok(!looksLikeLoginPage(""));
});

test("keywordHit is case-insensitive substring and rejects empty keyword", () => {
  assert.ok(keywordHit("已售罄，请明天再来", "售罄"));
  assert.ok(keywordHit("OUT OF STOCK", "out of stock"));
  assert.ok(keywordHit("In Stock Now", "in stock"));
  assert.ok(!keywordHit("hello", ""));
  assert.ok(!keywordHit("hello", "   "));
  assert.ok(!keywordHit("", "x"));
  assert.ok(!keywordHit(null, "x"));
});

test("jitteredDelayMs stays within ±pct and above the 30s alarm floor", () => {
  /* rand 注入使结果确定 */
  assert.equal(jitteredDelayMs(300, 15, () => 1), 300000 * 1.15); /* +15% */
  assert.equal(jitteredDelayMs(300, 15, () => 0), 300000 * 0.85); /* -15% */
  assert.equal(jitteredDelayMs(300, 15, () => 0.5), 300000); /* 中点无偏移 */
  /* 30 秒 -15% 会低于 30000，被下限抬到 30000 */
  assert.equal(jitteredDelayMs(30, 15, () => 0), 30000);
  /* pct 上限夹到 50%，rand 结果仍在 [0,1] 内 */
  const hi = jitteredDelayMs(60, 90, () => 1);
  assert.ok(hi <= 60000 * 1.5 + 1 && hi >= 60000);
});

test("jitteredDelayMs jitters forward-only at the 30s floor", () => {
  /* 30 秒档基准即地板：对称抖动约一半样本被抬平，正向抖动保住全幅（04 §4.5） */
  assert.equal(jitteredDelayMs(30, 15, () => 0), 30000);
  assert.ok(jitteredDelayMs(30, 15, () => 0.5) > 30000);
  assert.equal(jitteredDelayMs(30, 15, () => 1), 34500);
});

test("httpHeartbeat is on by default like keepAlive", () => {
  assert.equal(DEFAULT_SETTINGS.httpHeartbeat, true);
});

test("parseKeywords splits, dedupes case-insensitively, caps length and count", () => {
  assert.deepEqual(parseKeywords("补货, 有票 ,,补货"), ["补货", "有票"]);
  assert.deepEqual(parseKeywords("a, A ,b"), ["a", "b"]);
  assert.deepEqual(parseKeywords("x".repeat(150)), ["x".repeat(100)]);
  const many = Array.from({ length: 15 }, (_, i) => "k" + i).join(",");
  assert.equal(parseKeywords(many).length, 10);
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords("  "), []);
});

test("getTaskKeywords prefers keywords[] and falls back to legacy keyword string", () => {
  assert.deepEqual(getTaskKeywords({ keywords: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(getTaskKeywords({ keyword: "old" }), ["old"]);
  assert.deepEqual(getTaskKeywords({ keywords: ["a"], keyword: "b" }), ["a"]);
  assert.deepEqual(getTaskKeywords({}), []);
  assert.deepEqual(getTaskKeywords(null), []);
});

test("presentOf and newlyOf split hits for continuous watching", () => {
  const text = "NOW IN STOCK and available";
  const keywords = ["in stock", "available"];
  assert.deepEqual(presentOf(text, keywords), keywords);
  assert.deepEqual(newlyOf(presentOf(text, keywords), []), keywords);
  /* 已通知（大小写不同也算已通知）→ 不重复报 */
  assert.deepEqual(newlyOf(presentOf(text, keywords), ["IN STOCK"]), ["available"]);
  /* 关键词消失：present 收缩，供检测链回写在场集 */
  assert.deepEqual(presentOf("nothing here", keywords), []);
  assert.deepEqual(newlyOf([], keywords), []);
  assert.deepEqual(newlyOf(null, null), []);
});

test("normalizeWebhookUrl accepts only http(s) and trims", () => {
  assert.equal(normalizeWebhookUrl("  https://h.example/x  "), "https://h.example/x");
  assert.equal(normalizeWebhookUrl("http://localhost:8080/hook"), "http://localhost:8080/hook");
  assert.equal(normalizeWebhookUrl("javascript:alert(1)"), "");
  assert.equal(normalizeWebhookUrl("ftp://x"), "");
  assert.equal(normalizeWebhookUrl(""), "");
  assert.equal(normalizeWebhookUrl(null), "");
  assert.equal(normalizeWebhookUrl("not a url"), "");
});

/* ---------- A8：webhook 回执分类 ---------- */

test("webhookResultOf：2xx 就算送到", () => {
  assert.deepEqual(webhookResultOf(204, ""), { ok: true, status: 204 });
  assert.deepEqual(webhookResultOf(200, ""), { ok: true, status: 200 });
  assert.deepEqual(webhookResultOf(200, "ok"), { ok: true, status: 200 });
  assert.deepEqual(webhookResultOf(200, '{"ok":true}'), { ok: true, status: 200 });
  /* Telegram / ntfy 各有自己的成功形状，不认它们的正文键，只认 2xx */
  assert.deepEqual(webhookResultOf(200, '{"result":{"message_id":1}}'), { ok: true, status: 200 });
});

test("webhookResultOf：2xx 里的 ok=false 翻成被拒", () => {
  const r = webhookResultOf(200, '{"ok":false,"error":"not_authed","code":50313}');
  assert.equal(r.ok, false);
  assert.equal(r.kind, "rejected");
  assert.equal(r.status, 200);
  assert.equal(r.errorKey, "webhookErrRejected");
  /* 冒号两侧的空白、嵌套层里的字段都得认出来 */
  assert.equal(webhookResultOf(200, '{ "ok" : false }').kind, "rejected");
  assert.equal(webhookResultOf(200, '{"a":{"ok":false}}').kind, "rejected");
  /* 反例：正文里出现 ok 这个词但不是否定式，不能误判成被拒 */
  assert.equal(webhookResultOf(200, '{"message":"all ok, isOkTrue"}').ok, true);
  assert.equal(webhookResultOf(200, '{"ok":true,"errors":false}').ok, true);
  assert.equal(webhookResultOf(200, null).ok, true);
});

test("webhookResultOf：非 2xx 按状态码归桶，一律不看正文", () => {
  const table = [
    [401, "auth", "webhookErrAuth"],
    [403, "auth", "webhookErrAuth"],
    [404, "gone", "webhookErrGone"],
    [410, "gone", "webhookErrGone"],
    [400, "payload", "webhookErrPayload"],
    [406, "payload", "webhookErrPayload"],
    [413, "payload", "webhookErrPayload"],
    [415, "payload", "webhookErrPayload"],
    [422, "payload", "webhookErrPayload"],
    [429, "rate", "webhookErrRate"],
    [500, "server", "webhookErrServer"],
    [503, "server", "webhookErrServer"],
    [418, "status", "webhookErrStatus"],
    [302, "status", "webhookErrStatus"]
  ];
  for (const [code, kind, errorKey] of table) {
    assert.deepEqual(
      webhookResultOf(code, "ignored body"),
      { ok: false, kind, status: code, errorKey },
      `${code} 归错了桶`
    );
  }
  /* 302 是"抓到了登录跳转页并回 200/302"这一类接错地址的现场，
     fetch 自动跟随后拿到的最终状态照样可能是 200 —— 那属于 V1 的已知盲区，不在这里猜 */
  /* 表与实现同源核对：上面那张表是手写的（照抄源码就等于什么都不钉），
     所以这里反向比一次，源码新增一桶而测试没跟着加就红 */
  for (const [codes, kind] of WEBHOOK_STATUS_BUCKETS) {
    for (const code of codes) {
      const row = table.find((r) => r[0] === code);
      assert.ok(row, `源码把 ${code} 归进 ${kind} 桶，测试表里没有这一行`);
      assert.equal(row[1], kind, `${code} 在测试表与源码里归的不是同一个桶`);
    }
  }
});

test("webhookResultOf：拿不到状态码就是网络层", () => {
  for (const bad of [null, undefined, 0, -1, "abc", NaN, 2.5]) {
    assert.deepEqual(webhookResultOf(bad, ""), {
      ok: false,
      kind: "network",
      errorKey: "webhookErrNetwork"
    }, `${String(bad)} 没归到 network`);
  }
});

test("webhookResultOf：正文只看前 2000 字", () => {
  /* 截断就在分类器自己身上（postWebhook 交的是整段正文）：填错的地址可能指向一个大文件，
     而正常 webhook 的回执就一行 JSON。代价是标记埋在窗口之外就认不出来，
     三条把这条代价的边界钉成显式约定 */
  const marker = '{"ok":false}';
  assert.equal(webhookResultOf(200, "x".repeat(1980) + marker).kind, "rejected", "窗口内的标记漏判了");
  assert.equal(webhookResultOf(200, "x".repeat(1995) + marker).ok, true, "跨越截断点的标记不该被认出来");
  assert.equal(webhookResultOf(200, "x".repeat(2000) + marker).ok, true, "窗口外的标记不该被认出来");
});

test("isErrorStatus covers server faults and missing pages only", () => {
  assert.ok(isErrorStatus(500) && isErrorStatus(503) && isErrorStatus(404));
  assert.ok(!isErrorStatus(200) && !isErrorStatus(206) && !isErrorStatus(403));
  assert.ok(!isErrorStatus(302));
});

test("monitoring-related defaults are off-by-default / empty-by-default", () => {
  assert.equal(DEFAULT_SETTINGS.keepAwake, false);
  assert.equal(DEFAULT_SETTINGS.webhookUrl, "");
  /* 1.8.0 起事件清单键名是 notifyEvents（webhook 与微信直连共用一份） */
  assert.deepEqual(DEFAULT_SETTINGS.notifyEvents, ["session-lost", "keyword", "task-stopped", "task-paused"]);
  /* 微信直连：凭据是"能以你的名义发消息"的钥匙，默认必须关且四项全空 ——
     打开它、填凭据都必须是用户的显式动作 */
  assert.equal(DEFAULT_SETTINGS.wechatEnabled, false);
  assert.equal(DEFAULT_SETTINGS.wechatAppId, "");
  assert.equal(DEFAULT_SETTINGS.wechatAppSecret, "");
  assert.equal(DEFAULT_SETTINGS.wechatOpenId, "");
  assert.equal(DEFAULT_SETTINGS.wechatTemplateId, "");
});
test("respecting user activity is on by default", () => {
  /* 刻意与上一组分开：它是注入门控之一，默认值变更是有行为面影响的有意决定，
     不该混在"默认关闭"的清单里被顺手改掉 */
  assert.equal(DEFAULT_SETTINGS.skipOnActivity, true);
});
test("cookie backup is opt-in: off by default", () => {
  assert.equal(DEFAULT_SETTINGS.cookieBackup, false);
});

/* ================= 微信直连（公众号模板消息） =================
   这块全是纯函数，所以"发什么给微信"离线就能钉死，不需要真凭据、不联网。
   线上真正会咬人的两类错误：模板变量名不匹配（推出一张空白卡片）、
   把整条推失败当作"没配好"（其实只是 url 不合法）—— 下面都覆盖了。 */

test("wechatConfigState names every missing credential", () => {
  assert.deepEqual(wechatConfigState({}).missing, ["appId", "secret", "openId", "templateId"]);
  assert.equal(wechatConfigState({}).ready, false);
  /* 只填了空白不算填过——从页面复制时很容易带进空格 */
  assert.deepEqual(
    wechatConfigState({ wechatAppId: "   ", wechatAppSecret: "s" }).missing,
    ["appId", "openId", "templateId"]
  );
  const full = wechatConfigState({
    wechatAppId: "wx1",
    wechatAppSecret: "sec",
    wechatOpenId: "o1",
    wechatTemplateId: "tpl"
  });
  assert.equal(full.ready, true);
  assert.deepEqual(full.missing, []);
});

test("notifyEventsOf reads the new key and keeps the 1.7.0 webhookEvents value", () => {
  assert.deepEqual(notifyEventsOf({ notifyEvents: ["keyword"] }), ["keyword"]);
  /* 老安装存的键名是 webhookEvents：升级后不能把用户的勾选静默覆盖成默认全选 */
  assert.deepEqual(notifyEventsOf({ webhookEvents: ["keyword"] }), ["keyword"]);
  /* 两个键都在时以新键为准 */
  assert.deepEqual(
    notifyEventsOf({ notifyEvents: ["keyword"], webhookEvents: ["session-lost"] }),
    ["keyword"]
  );
  assert.deepEqual(notifyEventsOf({}), NOTIFY_EVENTS);
});

test("normalizeStoredSettings merges defaults, migrates the old key and drops it", () => {
  const d = { notifyEvents: ["session-lost"], keepAlive: true, webhookTemplateId: "" };
  /* 老安装只存了 webhookEvents：勾选接续进新键，且旧键从返回值中删除（写回存盘即完成迁移） */
  const old = normalizeStoredSettings({ webhookEvents: ["keyword"] }, d);
  assert.deepEqual(old.notifyEvents, ["keyword"]);
  assert.equal("webhookEvents" in old, false);
  assert.equal(old.keepAlive, true);
  /* 新键存在时以它为准，不被默认值覆盖 */
  const fresh = normalizeStoredSettings({ notifyEvents: ["task-stopped"] }, d);
  assert.deepEqual(fresh.notifyEvents, ["task-stopped"]);
  assert.equal("webhookEvents" in fresh, false);
  /* 空 stored → 默认值原样回来；且不会因 defaults 缺省而抛错 */
  assert.deepEqual(normalizeStoredSettings(null, d), d);
  assert.deepEqual(normalizeStoredSettings({ webhookEvents: ["keyword"] }), { notifyEvents: ["keyword"] });
});

test("buildTokenRequest follows the stable_token contract", () => {
  assert.deepEqual(buildTokenRequest(" wx1 ", " sec ", false), {
    grant_type: "client_credential",
    appid: "wx1",
    secret: "sec",
    force_refresh: false
  });
  assert.equal(buildTokenRequest("wx1", "sec", true).force_refresh, true);
});

test("buildWechatMessage uses exactly the title/content template keys", () => {
  const body = buildWechatMessage({
    openId: " o1 ",
    templateId: " tpl ",
    title: "标题",
    content: "正文",
    url: "https://example.com/x"
  });
  /* 变量名必须与用户模板里的 {{title.DATA}} / {{content.DATA}} 完全一致 */
  assert.deepEqual(Object.keys(body.data).sort(), WECHAT_TEMPLATE_KEYS.slice().sort());
  assert.equal(body.touser, "o1");
  assert.equal(body.template_id, "tpl");
  assert.equal(body.data.title.value, "标题");
  assert.equal(body.data.content.value, "正文");
  assert.equal(body.url, "https://example.com/x");
});

test("buildWechatMessage drops a non-http url instead of failing the whole push", () => {
  for (const bad of ["", null, undefined, "chrome://extensions", "javascript:alert(1)", "ftp://x/y"]) {
    const body = buildWechatMessage({ openId: "o", templateId: "t", title: "a", content: "b", url: bad });
    assert.equal("url" in body, false, "不该带上非法 url: " + String(bad));
  }
  assert.equal(
    buildWechatMessage({ openId: "o", templateId: "t", title: "a", content: "b", url: "http://x/y" }).url,
    "http://x/y"
  );
});

test("buildWechatMessage clips over-long fields rather than sending them verbatim", () => {
  const long = "x".repeat(WECHAT_FIELD_MAX + 50);
  const body = buildWechatMessage({ openId: "o", templateId: "t", title: long, content: long });
  assert.equal(body.data.title.value.length, WECHAT_TITLE_MAX);
  assert.equal(body.data.content.value.length, WECHAT_FIELD_MAX);
  assert.ok(body.data.content.value.endsWith("…"));
});

test("tokenFresh keeps a safety margin before the token expires", () => {
  const now = 1_000_000;
  assert.equal(tokenFresh({ token: "t", expireAt: now + 7_200_000 }, now), true);
  /* 距过期只剩 5 分钟以内算过期：提前重取，别等它自然失效时才发第一条 */
  assert.equal(tokenFresh({ token: "t", expireAt: now + TOKEN_REFRESH_MARGIN_MS }, now), false);
  assert.equal(tokenFresh({ token: "", expireAt: now + 9e9 }, now), false);
  assert.equal(tokenFresh(null, now), false);
});

test("wechat error codes map to a fix-it message, unknown codes fall back", () => {
  assert.equal(wechatErrorKey(40013), "wechatErrAppId");
  assert.equal(wechatErrorKey(43004), "wechatErrFollow");
  assert.equal(wechatErrorKey(40164), "wechatErrIp");
  assert.equal(wechatErrorKey(40037), "wechatErrTemplate");
  assert.equal(wechatErrorKey(47003), "wechatErrTemplate");
  assert.equal(wechatErrorKey(12345), "wechatErrOther");
  assert.equal(wechatErrorKey(undefined), "wechatErrOther");
  /* 40001/42001 是"令牌失效"，代码据此清缓存重取一次再试 */
  assert.ok(isTokenErrorCode(40001) && isTokenErrorCode(42001));
  assert.ok(!isTokenErrorCode(40013));
});

/* ---- 备份截断必须保住登录票据（12 报告 §4）----
   原实现是 `cookies.length = MAX`，按 chrome.cookies.getAll 的返回顺序切尾，
   而该顺序未定义——票据落在尾部就是"每次备份都稳定缺它"的静默失效。
   这组用例把"该被保住的那类 cookie"钉死，防止将来排序规则被改回去。 */
const tracking = (i) => ({ name: "ad_" + i, domain: "ads.site.test", path: "/track", secure: true, expirationDate: 9e9 });
const sessionTicket = { name: "sid", domain: "site.test", path: "/", httpOnly: true, secure: true };
const persistentTicket = { name: "remember", domain: "site.test", path: "/", httpOnly: true, expirationDate: 9e9 };

test("cookieTicketScore ranks session tickets above long-lived tracking cookies", () => {
  assert.ok(cookieTicketScore(sessionTicket) > cookieTicketScore(persistentTicket));
  assert.ok(cookieTicketScore(persistentTicket) > cookieTicketScore(tracking(1)));
  assert.equal(cookieTicketScore(null), 0);
  /* __Host- / __Secure- 前缀是站点显式标记的关键票据 */
  assert.ok(cookieTicketScore({ name: "__Host-sid", path: "/" }) > cookieTicketScore({ name: "sid", path: "/" }));
});

test("compareCookiePriority is a total order (no equal-score ties drift)", () => {
  const a = { name: "a", domain: "x.y.site.test", path: "/" };
  const b = { name: "b", domain: "site.test", path: "/" };
  /* 同分时域更短的在前，且方向必须稳定 */
  assert.ok(compareCookiePriority(b, a) < 0);
  assert.ok(compareCookiePriority(a, b) > 0);
  assert.equal(compareCookiePriority(a, a), 0);
});

test("capCookies keeps the session ticket when the backup is truncated", () => {
  /* 票据放在最后一位——正是原实现会切掉的位置 */
  const cookies = [];
  for (let i = 0; i < 199; i++) cookies.push(tracking(i));
  cookies.push(sessionTicket);
  const capped = capCookies(cookies, 200);
  assert.equal(capped.length, 200); /* 200 条不截断 */
  assert.equal(capCookies(cookies.concat(tracking(200)), 200).some((c) => c.name === "sid"), true);
});

test("capCookies truncates to the cap and keeps ticket-like cookies, not insertion order", () => {
  const cookies = [];
  for (let i = 0; i < 300; i++) cookies.push(tracking(i));
  cookies.push(sessionTicket, persistentTicket); /* 两条票据都在尾部 */
  const capped = capCookies(cookies, 200);
  assert.equal(capped.length, 200);
  assert.ok(capped.some((c) => c.name === "sid"));
  assert.ok(capped.some((c) => c.name === "remember"));
  /* 原实现（直接切尾）会丢掉这两条：这就是红/绿的分界 */
  const naive = cookies.slice(0, 200);
  assert.equal(naive.some((c) => c.name === "sid"), false);
});

test("capCookies leaves normal-sized backups in their original order", () => {
  const cookies = [tracking(1), sessionTicket, tracking(2)];
  assert.deepEqual(capCookies(cookies, 200).map((c) => c.name), ["ad_1", "sid", "ad_2"]);
  /* 不改动入参，也不在未超限时排序 */
  assert.equal(cookies[0].name, "ad_1");
  assert.deepEqual(capCookies(null, 200), []);
});

/* ---- 微信卡片字段的平台硬上限（17 报告）----
   2023-05-04 起微信规定：模板消息单个字段 ≤ 20 字、且不支持换行，
   超长由平台直接砍掉、连省略号都不给。用户在手机上看到的那张卡片就是
   这么被切成半句话的（实测正好停在第 20 个字）。扩展必须自己先截好：
   截在哪、要不要给省略号，得由我们决定。 */
test("the platform caps every WeChat field at 20 characters", () => {
  assert.equal(WECHAT_FIELD_MAX, 20);
  assert.equal(WECHAT_TITLE_MAX, 20);
});

test("oneLine collapses newlines, tabs and runs of spaces", () => {
  assert.equal(oneLine("a\nb"), "a b");
  assert.equal(oneLine("a\r\n  b\tc"), "a b c");
  assert.equal(oneLine("  x  "), "x");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine(undefined), "");
});

test("clipOneLine keeps a single line and marks the cut with an ellipsis", () => {
  /* 1.8.0 发出去的那句："这是一条测试消息：能收到即说明微信推送已配好。"（23 字）
     微信把它砍在第 20 个字（…微信推送已），用户看到的是半句话 */
  const sent = "这是一条测试消息：能收到即说明微信推送已配好。";
  assert.equal(sent.length, 23);
  assert.equal(clipOneLine(sent, 20), "这是一条测试消息：能收到即说明微信推送…");
  assert.equal(clipOneLine("短句", 20), "短句");
  /* 换行先压平再截：否则平台会把多行连成一串后再砍，第一行之后的信息全丢 */
  assert.equal(clipOneLine("第一行\n第二行", 20), "第一行 第二行");
  assert.equal(clipOneLine("abcdef", 4), "abc…");
  /* 按码点而不是 UTF-16 码元截（20 报告 §8）：emoji 是两个码元，
     按码元切会留下一个孤立代理，卡片上显示成乱码方块 */
  const emoji = clipOneLine("出现关键词「abcdefghijkl🔥」", 20);
  assert.equal(Array.from(emoji).length, 20);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(emoji),
    "不该切出孤立代理: " + JSON.stringify(emoji));
});

test("clipHostTail drops subdomains, never the registrable part", () => {
  assert.equal(clipHostTail("example.com", 12), "example.com");
  /* 在 label 边界上切：整段丢掉子域，而不是切进 label 中间——
     "…xample.com" 看着就像一个别的域名了 */
  assert.equal(clipHostTail("shop.example.com", 12), "…example.com");
  /* 省略号放不下时（预算刚好等于域名长度）就不再前缀，只给域名本身 */
  assert.equal(clipHostTail("shop.example.com", 11), "example.com");
  assert.equal(clipHostTail("a.b.c.example.com", 12), "…example.com");
  /* 注册域本身就超预算（长域名）：**返回 null，由调用方整段丢掉站点**（20 报告 §2）。
     旧实现会硬截出 "…domain.com" ——那不是这个站点的域名，看着像另一个站 */
  assert.equal(clipHostTail("www.some-very-long-domain.com", 12), null);
  assert.equal(clipHostTail("shop.example.com", 6), null);
  assert.equal(clipHostTail("shop.example.com", 5), null);
  /* 完全没有点（不是域名）：没有 label 边界可谈，只能硬截右边 */
  assert.equal(clipHostTail("很长的中文域名测试站点", 5), "…测试站点");
});

/* label 边界后缀判定（20 报告 §2 的回归断言用） */
function isLabelBoundarySuffix(host, fragment) {
  const bare = fragment.replace(/^…/, "");
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (labels.slice(i).join(".") === bare) return true;
  }
  return false;
}

test("wechatTitleOf always keeps the event name and fits the 20-char budget", () => {
  /* 站点放得下：事件 + 分隔符 + 站点（分隔符自带空格，zh 是 " · "） */
  assert.equal(wechatTitleOf({ eventLabel: "会话掉线", host: "example.com", sep: " · " }), "会话掉线 · example.com");
  /* 没有站点（如测试消息）就不留分隔符，也不会留一个孤零零的点 */
  assert.equal(wechatTitleOf({ eventLabel: "测试消息", host: "", sep: " · " }), "测试消息");
  /* 站点超长：从左侧截到 label 边界，事件名一个字都不能少 */
  const t = wechatTitleOf({ eventLabel: "关键词命中", host: "a.b.c.example.com", sep: " · " });
  assert.equal(t, "关键词命中 · …example.com");
  assert.ok(Array.from(t).length <= WECHAT_TITLE_MAX, t + " 长度 " + Array.from(t).length);
  /* 英文用更短的分隔符（"·"）才放得下注册域：事件名长，空格必须省掉 */
  assert.equal(wechatTitleOf({ eventLabel: "test", host: "x.com", sep: "·" }), "test·x.com");
});

test("wechatTitleOf never emits a mid-label host fragment, at any budget", () => {
  /* 20 报告 §2 的回归：英文事件名 11~17 字符，把 20 字预算吃到只剩 0~6，
     旧实现（以及旧测试只用 11~12 的预算）因此完全没暴露这条路径——
     实际发出的是 "keyword hit - …e.com" 这种"看着像另一个域名"的结果。
     不变量：站点部分要么是 label 边界上的后缀，要么整段不出现，绝不给碎片 */
  const hosts = ["x.io", "shop.example.com", "news.example.org.cn", "a.b.c.example.com", "www.some-very-long-domain.com"];
  const labels = ["keyword", "stopped", "paused", "session", "test message", "关键词命中", "任务自动停止", "会话掉线"];
  let withSite = 0;
  for (const label of labels) {
    for (const sep of ["·", " · ", "-"]) {
      for (const host of hosts) {
        const title = wechatTitleOf({ eventLabel: label, host, sep });
        assert.ok(Array.from(title).length <= WECHAT_TITLE_MAX,
          "超长: " + JSON.stringify(title) + " (" + Array.from(title).length + ")");
        if (title === label) continue; /* 站点放不下 → 整段不要，允许 */
        withSite++;
        const fragment = title.slice(label.length + sep.length);
        assert.ok(isLabelBoundarySuffix(host, fragment),
          "切进了 label 中间: " + JSON.stringify(title) + "（源 " + host + "）");
      }
    }
  }
  /* 空跑守卫：必须真跑过"带站点"的分支，否则上面全是 continue，等于没测 */
  assert.ok(withSite > 0, "没有任何用例真正带上站点，断言失去判别力");
});

test("buildWechatMessage never emits a newline or an over-long field", () => {
  const body = buildWechatMessage({
    openId: "o",
    templateId: "t",
    title: "会话掉线\n第二行",
    content: "第一行\n" + "很长".repeat(30),
  });
  for (const k of WECHAT_TEMPLATE_KEYS) {
    const v = body.data[k].value;
    assert.ok(!/\n/.test(v), k + " 里不该有换行: " + JSON.stringify(v));
    assert.ok(v.length <= 20, k + " 超过平台的 20 字上限: " + v.length);
  }
});

/* 红→绿对照（A2 那四条：siteRoot 不退化成公共后缀、domainChain 的注册域地板不变式、
   withinRoot 边界、planBackupConvergence）
   本文件直接 import 真源码，而 harness 的 TAR_BG 只换 background.js，所以对照必须
   把**整仓**复制到仓库外、在副本里改坏 tab-auto-refresh/shared/logic.js，再在副本里跑。
   五处改坏的完整红名单与两条"第一次跑是绿的"的教训记在 cookie-backup.test.mjs 末尾，
   那里同时跑的是同一份副本，一份证据覆盖两个文件。

   ---------- A8 的 webhookResultOf 对照（2026-09-19 实跑，脚本在仓库外 ctl-a8/）----------
   同一种跑法：整仓复制到仓库外、在副本里改坏 tab-auto-refresh/shared/logic.js，
   在副本里跑 logic.test.mjs 与 outbound.test.mjs（后者经 background 的相对 import 也吃到那份）。
   基线（未改坏的副本，四个文件一起跑）122 条全绿。
     L1 2xx 不读正文（判据换成 if (false)）
        → 红 3：logic「ok=false 翻成被拒」+「只看前 2000 字」、outbound「接收端回 200 却说没收到」。
          这一处等于回到 A8 之前的行为，outbound 那条红的就是本次要修的正主
     L2 判据放宽成 /false/（正文里出现 false 就算被拒）
        → 只红 logic「ok=false 翻成被拒」一条（它带三条反例）。outbound 全绿——
          它的正文里只有那一句 false，宽判据与窄判据拿到同一个结果，
          所以钉"判据过宽"的必须是纯函数那层，不是链路那层
     L3 429 的 errorKey 写错成 webhookErrStatus
        → 红 2：logic 归桶表 + outbound 归桶表，两边各查一次同一件事
     L4 去掉 .slice(0, 2000)
        → 只红 logic「正文只看前 2000 字」。这条是"把代价写成显式约定"的那类断言：
          行为更宽松了，但边界挪动没人知道
     L5 2xx 区间收窄到 200~203（204 掉进兜底桶）
        → 红 4：logic「2xx 就算送到」+ outbound 三条（成功留痕、覆盖、发送测试）。
          ntfy 与部分自建接收端回的就是 204，这一处会把正常投递报成失败
     L6 去掉状态码地板（s <= 0 不再算网络层）
        → 只红 logic「拿不到状态码就是网络层」：0 从 network 掉进 status 兜底桶
     L7 源码新增一桶 451 而测试表没跟着加
        → 只红 logic「非 2xx 按状态码归桶」一条，且红的是末尾那个同源核对。
          上面那张表是手写的，照抄源码就什么都钉不住，所以反向比一次：
          新加桶忘了同步测试表，红的就是"忘了"这件事本身 */
