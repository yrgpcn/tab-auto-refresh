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
  decideBackupWrite,
  BACKUP_ACT,
  looksLikeLoginPage,
  keywordHit,
  jitteredDelayMs,
  hasSessionCookie,
  sameHost,
  sameSite,
  sessionLostDetected,
  siteRoot,
  tabShowsUrl,
  urlKey,
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

test("hostOf extracts hostname from URL and rejects junk", () => {
  assert.equal(hostOf("https://app.example.com/#/login"), "app.example.com");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});

test("domainChain walks the parent domains of a host", () => {
  assert.deepEqual(domainChain("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  assert.deepEqual(domainChain("example.com"), ["example.com"]);
});

test("urlKey keeps origin+pathname and drops query and hash", () => {
  assert.equal(urlKey("https://example.com/page?a=1#frag"), "https://example.com/page");
  assert.equal(urlKey("not a url"), null);
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

test("cookie backup is opt-in: off by default", () => {
  assert.equal(DEFAULT_SETTINGS.cookieBackup, false);
});
