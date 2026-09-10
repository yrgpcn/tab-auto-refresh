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
  sameHost,
  sameSite,
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

test("cookie backup is opt-in: off by default", () => {
  assert.equal(DEFAULT_SETTINGS.cookieBackup, false);
});
