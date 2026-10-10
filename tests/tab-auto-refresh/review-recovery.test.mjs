import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const page = "https://shop.example.com/board";
const key = "cookieBackup:shop.example.com";
const done = "rt:pruneDone";
const statusKey = "rt:cookieRecovery";
const root = "example.com";
const rawTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => rawTimeout(fn, ms > 50 ? 30 : ms, ...args);
const tick = () => new Promise((r) => rawTimeout(r, 0));
const cookie = (name, value, extra = {}) => ({ name, value, domain: "shop.example.com", path: "/", hostOnly: true, ...extra });
async function boot({ backup = true, enabled = true, target = 7, second = false } = {}) {
  const env = makeEnv();
  env.store.local.tasks = { 7: { url: page, intervalSec: 300, createdAt: 1 } };
  env.store.sync.settings = { cookieBackup: enabled, keepAlive: false, httpHeartbeat: false,
    skipOnActivity: false, captchaGuard: false, bypassCache: false };
  if (target) env.putTab(target, page, { status: "complete" });
  if (backup) env.store.local[key] = { timestamp: Date.now(), schemaVersion: 2,
    cookies: [cookie("sid", "AUTH"), ...(second ? [cookie("second", "AUTH2", { domain: "sso.example.com" })] : [])] };
  await bootBackground(env);
  return env;
}

for (const route of ["keep", "remap", "watch", "reuse"]) {
  for (const backup of [true, false]) test(`early refresh alarm protects ${route}, backup=${backup}`, async () => {
    const env = await boot({ backup, enabled: backup, target: route === "keep" ? 7 : route === "remap" ? 11 : null });
    if (route === "reuse") { env.putTab(7, "https://unrelated.test/other"); env.putTab(11, page, { status: "complete" }); }
    await env.chrome.alarms.create("refresh-7", { when: Date.now() + 50000 });
    const before = structuredClone(env.store.local[key]);
    const startup = env.fire.startup();
    try {
      await tick();
      const created = env.calls.alarmsCreated.length;
      await env.fire.alarm("refresh-7");
      assert.ok(env.store.local.tasks[7], "old task deleted before reclamation");
      assert.deepEqual(env.store.local[key], before, "restore source lost");
      assert.equal(env.calls.alarmsCreated.length, created, "early alarm must not reschedule");
      assert.deepEqual(env.calls.reloaded, [], "no old/reused id reload");
      assert.deepEqual(env.calls.navigated, []);
      assert.equal(env.calls.notifCreated.length, 0);
    } finally { await startup; }
    assert.equal(Object.keys(env.store.local.tasks).length, 1);
    const id = Number(Object.keys(env.store.local.tasks)[0]);
    assert.equal(env.store.local.tasks[id].url, page);
    if (route === "keep") assert.equal(id, 7);
    if (route === "remap" || route === "reuse") assert.equal(id, 11);
    if (route === "watch") assert.notEqual(id, 7);
    assert.ok((await env.chrome.alarms.getAll()).some((a) => a.name === `refresh-${id}`));
    assert.equal(env.store.session[done] > 0, true);
    const reloaded = env.calls.reloaded.length;
    await env.fire.alarm(`refresh-${id}`);
    assert.equal(env.calls.reloaded.length, reloaded + 1, "normal scheduling resumes");
  });
}

test("default-off/no-backup complete before startup cannot adopt reused same-host page", async () => {
  const env = await boot({ backup: false, enabled: false, target: 11 });
  env.putTab(7, "https://shop.example.com/unrelated");
  await env.fire.tabUpdated(7, { status: "complete" });
  await env.fire.startup();
  assert.equal(env.store.local.tasks[11]?.url, page);
  assert.equal(env.store.local.tasks[7], undefined);
  assert.equal(env.store.local[key], undefined);
  env.putTab(11, "https://shop.example.com/after-auth");
  await env.fire.tabUpdated(11, { status: "complete" });
  assert.equal(env.store.local.tasks[11].url, "https://shop.example.com/after-auth", "URL adoption resumes after reclamation");
});

for (const shape of ["session-session", "session-persistent", "persistent-session"]) test(`ambiguous same-name ${shape} preserves archive and reports unverified conflict`, async () => {
  const env = await boot();
  if (shape.startsWith("persistent")) env.store.local[key].cookies[0].expirationDate = Date.now() / 1000 + 3600;
  const before = structuredClone(env.store.local[key]);
  env.setCookies([cookie("sid", "GUEST", shape.endsWith("persistent") ? { expirationDate: Date.now() / 1000 + 3600 } : {})]);
  const info = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  try { await env.fire.startup(); } finally { console.info = info; }
  assert.equal(env.calls.cookieSet.length, 0, "ambiguous guest/new-auth cannot be overwritten blindly");
  assert.ok(logs.some((log) => log.includes("conflict-unverified")), "observable unverified state required");
  assert.ok(logs.every((log) => !log.includes("AUTH") && !log.includes("GUEST")));
  await env.fire.tabUpdated(7, { status: "complete" });
  await bootBackground(env);
  env.putTab(7, "https://shop.example.com/login");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(env.store.local[key], before, "guest/login sample must not replace last authenticated archive");
  assert.equal(env.store.session[statusKey]?.[root]?.kind, "conflict-unverified");
});

for (const failed of ["sid", "second"]) test(`one getAll failure (${failed}) does not abort other restores or lose reload`, async () => {
  const env = await boot({ second: true });
  const before = structuredClone(env.store.local[key]);
  const get = env.chrome.cookies.getAll;
  env.chrome.cookies.getAll = async (q) => {
    if (q.domain === (failed === "sid" ? "shop.example.com" : "sso.example.com")) throw new Error("synthetic secret");
    return get(q);
  };
  await env.fire.startup();
  assert.deepEqual(env.calls.cookieSet.map((c) => c.name), [failed === "sid" ? "second" : "sid"]);
  assert.deepEqual(env.calls.reloaded, [7], "successful writes still require one reload");
  assert.equal(typeof env.store.session[done], "number");
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(env.store.local[key], before, "partial API failure protects archived tickets");
});

test("refresh before onStartup lazily reclaims reused ID without executing old alarm", async () => {
  const env = await boot({ backup: false, enabled: false, target: 11 });
  env.putTab(7, "https://shop.example.com/unrelated");
  await env.fire.alarm("refresh-7");
  assert.equal(env.store.local.tasks[7], undefined);
  assert.equal(env.store.local.tasks[11]?.url, page);
  assert.deepEqual(env.calls.reloaded, []);
  assert.equal(env.calls.alarmsCreated.filter(([name]) => name === "refresh-7").length, 0);
  await env.fire.alarm("refresh-11");
  assert.deepEqual(env.calls.reloaded, [11]);
});

test("same-value live cookie needs no write and allows normal backup sampling", async () => {
  const env = await boot();
  env.setCookies([cookie("sid", "AUTH")]);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, 0);
  assert.equal(env.store.session[statusKey]?.[root], undefined);
  env.setCookies([cookie("sid", "NEW-AUTH")]);
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local[key].cookies[0].value, "NEW-AUTH");
});

test("expired live guest cookie does not block archive restoration", async () => {
  const env = await boot();
  env.setCookies([cookie("sid", "GUEST", { expirationDate: Date.now() / 1000 - 1 })]);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet[0]?.value, "AUTH");
  assert.deepEqual(env.calls.reloaded, [7]);
});

test("newer ambiguous login stays intact; only explicit off/clear/on resets archive protection", async () => {
  const env = await boot();
  env.setCookies([cookie("sid", "NEWER-AUTH")]);
  const before = structuredClone(env.store.local[key]);
  await env.fire.startup();
  assert.equal(env.calls.cookieSet.length, 0);
  assert.equal((await env.chrome.cookies.getAll({ domain: "shop.example.com" }))[0].value, "NEWER-AUTH");
  await env.fire.tabUpdated(7, { status: "complete", url: "https://shop.example.com/after-auth" });
  assert.deepEqual(env.store.local[key], before);
  await env.send({ type: "save-settings", settings: { cookieBackup: false } });
  env.fire.onChanged({ settings: { oldValue: { cookieBackup: true }, newValue: { cookieBackup: false } } }, "sync");
  await tick();
  assert.equal(env.store.local[key], undefined);
  assert.equal(env.store.session[statusKey]?.[root], undefined);
  await env.send({ type: "save-settings", settings: { cookieBackup: true } });
  env.fire.onChanged({ settings: { oldValue: { cookieBackup: false }, newValue: { cookieBackup: true } } }, "sync");
  await tick();
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.equal(env.store.local[key].cookies[0].value, "NEWER-AUTH");
});

test("failure to persist conflict protection leaves recovery retryable across SW", async () => {
  const env = await boot();
  env.setCookies([cookie("sid", "GUEST")]);
  const before = structuredClone(env.store.local[key]);
  const set = env.chrome.storage.session.set;
  env.chrome.storage.session.set = async (data) => {
    if (statusKey in data) throw new Error("synthetic session failure");
    return set(data);
  };
  await env.fire.startup();
  assert.equal(env.store.session[done], undefined);
  assert.deepEqual(env.store.local[key], before);
  env.chrome.storage.session.set = set;
  await bootBackground(env);
  await env.fire.startup();
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.ok(env.store.session[done]);
  assert.equal(env.store.session[statusKey]?.[root]?.kind, "conflict-unverified");
  assert.deepEqual(env.store.local[key], before);
});

test("closing cookie backup while getAll is pending prevents late Cookie write", async () => {
  const env = await boot();
  const get = env.chrome.cookies.getAll;
  let release;
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  env.chrome.cookies.getAll = async (q) => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return get(q);
  };
  const startup = env.fire.startup();
  try {
    await pending;
    await env.send({ type: "save-settings", settings: { cookieBackup: false } });
  } finally { release(); await startup; }
  assert.equal(env.calls.cookieSet.length, 0);
  assert.deepEqual(env.calls.reloaded, []);
  assert.equal(env.store.local[key], undefined);
});

test("failed archive deletion keeps protection when backup is reenabled", async () => {
  const env = await boot();
  env.setCookies([cookie("sid", "GUEST")]);
  const before = structuredClone(env.store.local[key]);
  await env.fire.startup();
  const remove = env.chrome.storage.local.remove;
  env.chrome.storage.local.remove = async () => { throw new Error("synthetic delete failure"); };
  await env.send({ type: "save-settings", settings: { cookieBackup: false } });
  env.fire.onChanged({ settings: { oldValue: { cookieBackup: true }, newValue: { cookieBackup: false } } }, "sync");
  await tick();
  assert.equal(env.store.session[statusKey]?.[root]?.kind, "conflict-unverified");
  env.chrome.storage.local.remove = remove;
  await env.send({ type: "save-settings", settings: { cookieBackup: true } });
  env.fire.onChanged({ settings: { oldValue: { cookieBackup: false }, newValue: { cookieBackup: true } } }, "sync");
  await tick();
  await env.fire.tabUpdated(7, { status: "complete" });
  assert.deepEqual(env.store.local[key], before);
});
