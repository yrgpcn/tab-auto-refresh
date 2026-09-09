import assert from "node:assert/strict";
import test from "node:test";

import { PREFIX, PRESETS } from "../../tab-auto-refresh/shared/config.js";
import {
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  clampInterval,
  formatCountdown,
  formatInterval,
  hostOf,
  sameHost,
  sameSite,
  siteRoot,
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
  assert.equal(siteRoot("nsgt.szns.gov.cn"), "szns.gov.cn");
  assert.equal(siteRoot("a.b.c.example.co.uk"), "example.co.uk");
  assert.equal(siteRoot("sub.domain.ac.cn"), "domain.ac.cn");
  assert.equal(siteRoot("192.168.1.10"), "192.168.1.10");
  assert.equal(siteRoot("localhost"), "localhost");
  assert.equal(siteRoot(""), null);
  assert.equal(siteRoot("WWW.Example.COM"), "example.com");
});

test("sameSite treats subdomains as one site but different sites as drifted", () => {
  /* 政务 SSO 在同站子域间跳转，不算漂移 */
  assert.ok(sameSite("sso.szns.gov.cn", "nsgt.szns.gov.cn"));
  assert.ok(sameSite("szns.gov.cn", "nsgt.szns.gov.cn"));
  /* 完全不同的网站算漂移 */
  assert.ok(!sameSite("evil.example.org", "nsgt.szns.gov.cn"));
  assert.ok(!sameSite("baidu.com", "nsgt.szns.gov.cn"));
  /* 不同内网 IP 不互相误判 */
  assert.ok(!sameSite("192.168.1.10", "192.168.2.10"));
  assert.ok(!sameSite(null, "example.com"));
});

test("sameHost is stricter than sameSite: sibling SSO subdomains differ", () => {
  assert.ok(sameHost("nsgt.szns.gov.cn", "szns.gov.cn"));
  assert.ok(sameHost("szns.gov.cn", "nsgt.szns.gov.cn"));
  assert.ok(!sameHost("sso.szns.gov.cn", "nsgt.szns.gov.cn"));
});

test("hostOf extracts hostname from URL and rejects junk", () => {
  assert.equal(hostOf("https://nsgt.szns.gov.cn/#/login"), "nsgt.szns.gov.cn");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});
