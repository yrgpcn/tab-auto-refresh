import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import { siteRoot, domainChain, decideCookieRecovery, shouldReloadCookiePage, decideCookieRestore } from "../../tab-auto-refresh/shared/logic.js";

const url = "https://shop.example.com/board";
const key = "cookieBackup:shop.example.com";
const done = "rt:pruneDone";
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms > 50 ? 10 : ms, ...args);
const tick = () => new Promise((r) => realTimeout(r, 0));
async function boot({ session = false, target = 7, backup = true, enabled = true } = {}) {
  const env = makeEnv();
  env.store.sync.settings = { cookieBackup: enabled, keepAlive: false, httpHeartbeat: true,
    skipOnActivity: false, captchaGuard: false };
  env.store.local.tasks = { 7: { url, intervalSec: 300, createdAt: 1 } };
  env.putTab(target, url, { status: "complete" });
  if (backup) env.store.local[key] = { timestamp: Date.now(), schemaVersion: 2, cookies: [{
    name: "ticket", value: "synthetic", domain: "shop.example.com", path: "/",
    hostOnly: true, ...(session ? {} : { expirationDate: Date.now() / 1000 + 3600 })
  }] };
  await bootBackground(env);
  return env;
}

for (const session of [false, true]) test(`cold startup protects ${session ? "session" : "persistent"} backup from early events`, async () => {
  const env = await boot({ session });
  const before = structuredClone(env.store.local[key]);
  const reload = env.chrome.tabs.reload;
  env.chrome.tabs.reload = async (id) => {
    const live = await env.chrome.cookies.getAll({ domain: "shop.example.com" });
    assert.ok(live.some((c) => c.name === "ticket" && c.value === "synthetic"), "reloaded page must see restored cookie");
    return reload(id);
  };
  const startup = env.fire.startup();
  await tick();
  env.reply({ status: 401, url: "https://shop.example.com/login" });
  await env.fire.tabUpdated(7, { status: "complete" });
  await env.fire.tabUpdated(7, { status: "complete" });
  await env.fire.alarm("hb-7");
  assert.deepEqual(env.store.local[key], before);
  assert.equal(env.calls.localSet.filter((keys) => keys.includes(key)).length, 0, "early samples must not even persist counters");
  assert.equal(env.calls.notifCreated.length, 0);
  await startup;
  assert.equal(env.calls.cookieSet.length, 1, "real restore path ran");
  assert.deepEqual(env.calls.reloaded, [7]);
  assert.equal(typeof env.store.session[done], "number");
  const sets = env.calls.cookieSet.length;
  await bootBackground(env);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, sets, "SW reentry must not restore twice");
  assert.deepEqual(env.calls.reloaded, [7]);
});

test("keep repairs only missing refresh alarm", async () => {
  const env = await boot({ backup: false });
  await env.fire.startup();
  assert.equal(env.calls.alarmsCreated.filter(([n]) => n === "refresh-7").length, 1);
  assert.deepEqual(env.calls.reloaded, []);
  const next = await boot({ backup: false });
  await next.chrome.alarms.create("refresh-7", { when: Date.now() + 50000 });
  await next.fire.startup();
  assert.equal(next.calls.alarmsCreated.filter(([n]) => n === "refresh-7").length, 1);
});

test("remap reloads once; watch creates after restore without reload", async () => {
  const remap = await boot({ target: 11 });
  await remap.fire.startup();
  assert.deepEqual(remap.calls.reloaded, [11]);
  assert.ok(remap.store.local.tasks[11]);
  const watch = await boot();
  watch.dropTab(7);
  await watch.fire.startup();
  assert.equal(watch.calls.cookieSet.length, 1);
  assert.deepEqual(watch.calls.reloaded, []);
  assert.equal(Object.keys(watch.store.local.tasks).length, 1);
});

test("disabled/expired/failed restores never reload or claim login success", async () => {
  for (const mode of ["disabled", "expired", "failed", "null", "old"]) {
    const env = await boot({ enabled: mode !== "disabled" });
    if (mode === "expired") env.store.local[key].cookies[0].expirationDate = Date.now() / 1000 - 1;
    if (mode === "old") env.store.local[key].timestamp -= 31 * 86400000;
    if (mode === "failed") env.chrome.cookies.set = async () => { throw new Error("synthetic secret must not be logged"); };
    if (mode === "null") env.chrome.cookies.set = async () => null;
    await env.fire.startup();
    assert.deepEqual(env.calls.reloaded, [], mode);
    if (mode === "disabled" || mode === "old") assert.equal(env.store.local[key], undefined);
  }
});

test("PRIVATE suffix tenants are independent sites", () => {
  assert.equal(siteRoot("alice.github.io"), "alice.github.io");
  assert.equal(siteRoot("github.io"), null);
  assert.deepEqual(domainChain("www.alice.github.io"), ["www.alice.github.io", "alice.github.io"]);
  assert.notEqual(siteRoot("alice.blogspot.com"), siteRoot("bob.blogspot.com"));
  assert.equal(siteRoot("b.compute.amazonaws.com"), null);
  assert.equal(siteRoot("www.a.b.compute.amazonaws.com"), "a.b.compute.amazonaws.com");
});

test("recovery decisions expose sequence and one-reload rules", () => {
  assert.equal(decideCookieRecovery({ inFlight: true, pruneDone: 1 }), "defer");
  assert.equal(decideCookieRecovery({}), "recover", "no backup still requires task reclamation");
  assert.equal(decideCookieRecovery({ pruneDone: 1 }), "sample");
  assert.equal(shouldReloadCookiePage({ restored: true, loadedBeforeRestore: true }), true);
  assert.equal(shouldReloadCookiePage({ restored: true, loadedBeforeRestore: false }), false);
  assert.equal(shouldReloadCookiePage({ restored: true, loadedBeforeRestore: true, reloaded: true }), false);
  assert.equal(decideCookieRestore({ name: "sid", domain: ".a.test", value: "old" }, [{ name: "sid", domain: "a.test", value: "new" }], 1), "conflict-unverified");
});

test("unverified conflicting live cookie or still loading needs no extra reload", async () => {
  const env = await boot();
  env.setCookies([{ ...env.store.local[key].cookies[0], value: "browser-newer-ticket" }]);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, 0);
  assert.deepEqual(env.calls.reloaded, []);
  assert.equal(env.store.session["rt:cookieRecovery"]?.["example.com"]?.kind, "conflict-unverified");
  const loading = await boot();
  loading.putTab(7, url, { status: "loading" });
  await loading.fire.startup();
  assert.equal(loading.calls.cookieSet.length, 1);
  assert.deepEqual(loading.calls.reloaded, []);
});

test("transient prune failure retries after SW reentry and releases sampling", async () => {
  const env = await boot();
  const query = env.chrome.tabs.query;
  let fail = true;
  env.chrome.tabs.query = async (q) => { if (fail) throw new Error("synthetic failure"); return query(q); };
  await env.fire.startup();
  assert.equal(env.store.session[done], undefined);
  assert.ok(env.store.local[key].cookies.length);
  fail = false;
  await bootBackground(env);
  await env.fire.tabUpdated(7, { status: "complete" }); /* onStartup 不重派，普通事件恢复 */
  assert.equal(typeof env.store.session[done], "number");
  assert.deepEqual(env.calls.reloaded, [7]);
  const writes = env.calls.localSet.filter((keys) => keys.includes(key)).length;
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.ok(env.calls.localSet.filter((keys) => keys.includes(key)).length > writes);
});

test("failure after reload persists one-reload marker through retry", async () => {
  const env = await boot();
  const get = env.chrome.storage.local.get;
  let scans = 0;
  env.chrome.storage.local.get = async (keys) => {
    if (keys === null && ++scans === 2) throw new Error("prune cleanup failed");
    return get(keys);
  };
  await env.fire.startup();
  assert.deepEqual(env.calls.reloaded, [7]);
  assert.equal(env.store.session[done], undefined);
  env.setCookies([]); /* 再次恢复仍会实际写 Cookie，但不再 reload */
  await bootBackground(env);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, 2);
  assert.deepEqual(env.calls.reloaded, [7]);
  assert.equal(typeof env.store.session[done], "number");
});

test("disabling during suspended Cookie sampling clears all plaintext", async () => {
  const env = await boot({ backup: false });
  env.store.session[done] = Date.now();
  const get = env.chrome.cookies.getAll;
  let release;
  let entered;
  const started = new Promise((r) => { entered = r; });
  env.chrome.cookies.getAll = async (q) => { entered(); await new Promise((r) => { release = r; }); return get(q); };
  const sampling = env.fire.tabUpdated(7, { status: "complete" });
  await started;
  const oldValue = env.store.sync.settings;
  const newValue = { ...oldValue, cookieBackup: false };
  env.store.sync.settings = newValue;
  await env.fire.onChanged({ settings: { oldValue, newValue } }, "sync");
  env.chrome.cookies.getAll = get;
  release();
  await sampling;
  await tick();
  assert.equal(env.store.local[key], undefined);
  assert.ok(env.calls.cookieGet.length > 0, "sampling ran");
});

test("PRIVATE query and historical convergence exclude another tenant", async () => {
  const env = await boot({ backup: false });
  const page = "https://alice.github.io/board";
  env.store.local.tasks[7].url = page;
  env.putTab(7, page, { status: "complete" });
  env.store.local["cookieBackup:alice.github.io"] = { timestamp: Date.now(), cookies: [
    { name: "own", value: "fake", domain: "alice.github.io", path: "/" },
    { name: "foreign", value: "fake", domain: "bob.github.io", path: "/" }
  ] };
  await env.fire.startup();
  assert.deepEqual(env.calls.cookieSet.map((c) => c.name), ["own"]);
  assert.ok(!env.calls.cookieGet.includes("github.io"));
  assert.equal(env.store.local["cookieBackup:alice.github.io"].cookies.length, 1);
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.ok(!env.calls.cookieGet.includes("github.io"));
});

test("heartbeat response started before recovery cannot poison its probe", async () => {
  const env = await boot();
  env.store.session[done] = Date.now();
  let release;
  env.reply(new Promise((r) => { release = r; }));
  const heartbeat = env.fire.alarm("hb-7");
  while (!env.pendingFetch().length) await tick();
  const recovery = env.fire.installed();
  release({ status: 401, url: "https://shop.example.com/login" });
  await heartbeat;
  assert.equal(env.store.local.sessionProbe, undefined);
  assert.equal(env.calls.notifCreated.length, 0);
  await recovery;
  assert.equal(env.calls.cookieSet.length, 1);
});

test("disable during restoration stops remaining writes and cleans plaintext", async () => {
  const env = await boot();
  env.store.local[key].cookies.push({ ...env.store.local[key].cookies[0], name: "second" });
  const set = env.chrome.cookies.set;
  env.chrome.cookies.set = async (cookie) => {
    const result = await set(cookie);
    const oldValue = env.store.sync.settings;
    const newValue = { ...oldValue, cookieBackup: false };
    env.store.sync.settings = newValue;
    await env.fire.onChanged({ settings: { oldValue, newValue } }, "sync");
    return result;
  };
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, 1, "second cookie must not be restored after disable");
  assert.equal(env.store.local[key], undefined);
  assert.deepEqual(env.calls.reloaded, []);
});

test("partial Cookie API failure preserves archive without leaking errors", async () => {
  const env = await boot();
  env.store.session[done] = Date.now();
  const before = structuredClone(env.store.local[key]);
  const get = env.chrome.cookies.getAll;
  env.chrome.cookies.getAll = async (q) => {
    if (q.domain === "example.com") throw new Error("synthetic secret token");
    return get(q);
  };
  const warn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  try { await env.fire.tabUpdated(7, { status: "complete" }); }
  finally { console.warn = warn; }
  assert.deepEqual(env.store.local[key], before);
  assert.ok(env.calls.cookieGet.length > 0);
  assert.ok(logs.every((log) => !log.includes("synthetic secret")));
});

test("default Cookie API scope excludes partitioned and other-store credentials", async () => {
  const env = await boot({ backup: false });
  env.store.session[done] = Date.now();
  const cookie = { name: "normal", value: "fake", domain: "shop.example.com", path: "/" };
  env.setCookies([cookie, { ...cookie, name: "partitioned", partitionKey: { topLevelSite: "https://other.test" } },
    { ...cookie, name: "other-store", storeId: "1" }]);
  const get = env.chrome.cookies.getAll;
  const queries = [];
  env.chrome.cookies.getAll = async (query) => { queries.push(query); return get(query); };
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(env.store.local[key].cookies.map((c) => c.name), ["normal"]);
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => !Object.hasOwn(q, "partitionKey") && !Object.hasOwn(q, "storeId")));
});
