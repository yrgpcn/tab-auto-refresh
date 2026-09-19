/* 两条外发出口（postWebhook / postWechat）的端到端用例。
   此前一次也没执行过：共享桩件没有 fetch 桩件，两条链路一进 fetch 就 ReferenceError，
   各自外层的 try 把它吞成"静默失败"——而"静默失败"正是这两条链路唯一的失败方式，
   所以它们从来没红过，也从来没绿过。现在桩件给了 env.reply()，才第一次真的把请求发出去。

   分工：logic.test.mjs 钉的是 normalizeWebhookUrl / buildWechatMessage / tokenFresh 这些
   纯函数本身；这边钉的是执行器——什么时候真的发、发出去的形状对不对、失败留没留痕。
   触发口两个：refresh alarm 发现标签页没了（真实事件 task-stopped），
   以及弹窗的"发送测试消息"（wechat-test，唯一能直接点着 postWechat 的入口）。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

const PAGE = "https://a.test/board";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: PAGE }, over);
const HOOK = "https://hooks.test/token-abc";
const WX = {
  wechatEnabled: true,
  wechatAppId: "wxAPP",
  wechatAppSecret: "SECRET",
  wechatOpenId: "OPENID",
  wechatTemplateId: "TPL"
};

async function boot({ tasks, settings } = {}) {
  const env = makeEnv();
  /* 默认不放标签页：refresh-7 到点时发现页不在了，才会走 stopTaskWithNotice → notifyOut */
  env.store.local.tasks = tasks === undefined ? { 7: task() } : tasks;
  env.store.sync.settings = Object.assign(
    { keepAlive: false, httpHeartbeat: false, cookieBackup: false, webhookUrl: "" },
    settings
  );
  await bootBackground(env);
  return env;
}

const sent = (env) => env.calls.fetch;
const bodies = (env) => sent(env).map((c) => JSON.parse(c.init.body));
const stoppedByAlarm = async (env) => {
  await env.fire.alarm("refresh-7");
  return env;
};
const testWx = (env) => env.send({ type: "wechat-test" });
const tokenUrl = (u) => u.includes("/cgi-bin/stable_token");

/* ---------- webhook ---------- */

test("配了地址又勾了这个事件：POST 出去，三个别名字段都填上", async () => {
  const env = await boot({ settings: { webhookUrl: HOOK, notifyEvents: ["task-stopped"] } });
  await stoppedByAlarm(env);
  assert.equal(sent(env).length, 1, "该发的一次没发");
  const { url, init } = sent(env)[0];
  assert.equal(url, HOOK);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal, "没有超时控制器：接收端挂起会把整条停任务链路悬住");
  const body = JSON.parse(init.body);
  assert.equal(body.type, "task-stopped");
  assert.equal(body.host, "a.test");
  assert.equal(body.url, PAGE);
  assert.equal(body.reason, "tab-gone");
  assert.equal(typeof body.ts, "number");
  /* Discord 认 content、Slack 与 Telegram 认 text、body 是兜底：三家各认一个字段，
     留空就等于用户配好地址却收到空白卡片 */
  assert.ok(body.content.length > 0, "content 是空的");
  assert.equal(body.text, body.content);
  assert.equal(body.body, body.content);
});

test("事件没勾上就一笔不发", async () => {
  const env = await boot({ settings: { webhookUrl: HOOK, notifyEvents: ["keyword"] } });
  await stoppedByAlarm(env);
  assert.deepEqual(sent(env), [], "用户明确没订阅 task-stopped，还是被推了一条");
});

test("地址非法一笔都不发", async () => {
  for (const bad of ["", "   ", "javascript:alert(1)", "ftp://a.test/x", "not a url"]) {
    const env = await boot({ settings: { webhookUrl: bad, notifyEvents: ["task-stopped"] } });
    await stoppedByAlarm(env);
    assert.deepEqual(sent(env), [], `地址 ${JSON.stringify(bad)} 竟然发了请求`);
  }
});

/* ---------- 微信直连 ---------- */

test("发送测试：先取 stable_token 再推模板消息，两头都留痕", async () => {
  const env = await boot({
    settings: Object.assign({}, WX, { notifyEvents: ["task-stopped"] })
  });
  env.reply((url) =>
    tokenUrl(url)
      ? { json: { access_token: "T1", expires_in: 7200 } }
      : { json: { errcode: 0, errmsg: "ok" } }
  );
  const r = await testWx(env);
  assert.equal(r.ok, true);
  assert.equal(sent(env).length, 2, "取令牌与推送不是各一次");
  assert.ok(tokenUrl(sent(env)[0].url), "第一笔不是令牌请求");
  const t = bodies(env)[0];
  assert.equal(t.grant_type, "client_credential");
  assert.equal(t.appid, "wxAPP");
  assert.equal(t.secret, "SECRET");
  assert.equal(t.force_refresh, false);
  assert.match(sent(env)[1].url, /\/message\/template\/send\?access_token=T1$/);
  const m = bodies(env)[1];
  assert.equal(m.touser, "OPENID");
  assert.equal(m.template_id, "TPL");
  assert.ok(m.data.title.value.length > 0, "卡片标题是空的");
  assert.ok(m.data.content.value.length > 0, "卡片正文是空的");
  /* 令牌缓存必须过 SW 回收，所以它在 session 而不是内存里 */
  assert.equal(env.store.session.wechatToken.token, "T1");
  assert.ok(env.store.session.wechatToken.expireAt > Date.now() + 3600000);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.event, "test");
});

test("令牌还新鲜就不重取", async () => {
  const env = await boot({ settings: Object.assign({}, WX) });
  env.store.session.wechatToken = { token: "CACHED", expireAt: Date.now() + 3600 * 1000 };
  env.reply({ json: { errcode: 0 } });
  await testWx(env);
  assert.equal(sent(env).length, 1, "缓存里的令牌没用上，又去刷了一次：stable_token 每刷一次就作废上一个");
  assert.match(sent(env)[0].url, /access_token=CACHED$/);
});

test("命中 40001：清缓存重取并重试一次", async () => {
  const env = await boot({ settings: Object.assign({}, WX) });
  env.reply([
    { json: { access_token: "T1", expires_in: 7200 } },
    { json: { errcode: 40001, errmsg: "invalid credential" } },
    { json: { access_token: "T2", expires_in: 7200 } },
    { json: { errcode: 0 } }
  ]);
  const r = await testWx(env);
  assert.equal(sent(env).length, 4, `不是"重取一次再试一次"的形状（跑了 ${sent(env).length} 笔）`);
  assert.equal(bodies(env)[2].force_refresh, true, "重取时没带 force_refresh");
  assert.match(sent(env)[3].url, /access_token=T2$/, "重试还在用那个已经失效的令牌");
  assert.equal(r.result.ok, true);
  assert.equal(env.store.session.wechatToken.token, "T2");
});

test("非令牌错误码不重试，留痕要翻成「该去哪改」", async () => {
  const env = await boot({ settings: Object.assign({}, WX) });
  env.reply([
    { json: { access_token: "T1", expires_in: 7200 } },
    { json: { errcode: 43004, errmsg: "subscribe box not opened" } }
  ]);
  const r = await testWx(env);
  assert.equal(sent(env).length, 2, "43004 也去重取令牌重试：那不是令牌问题");
  assert.equal(r.result.ok, false);
  assert.equal(r.result.kind, "api");
  assert.equal(r.result.code, 43004);
  assert.equal(r.result.errorKey, "wechatErrFollow", "错误码没翻译成用户能照着改的提示");
});

test("凭据没填全：一个请求都不发，留痕点名缺哪一项", async () => {
  const env = await boot({ settings: Object.assign({}, WX, { wechatAppSecret: "" }) });
  const r = await testWx(env);
  assert.deepEqual(sent(env), [], "凭据不全还去撞接口");
  assert.equal(r.result.kind, "incomplete");
  assert.deepEqual(r.result.missing, ["secret"]);
});

test("网络被拒留 network 痕迹，不假报成接口返回", async () => {
  const env = await boot({ settings: Object.assign({}, WX) });
  env.reply(new Error("Failed to fetch"));
  const r = await testWx(env);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.kind, "network");
  assert.equal(r.result.errorKey, "wechatErrNetwork");
  assert.equal(r.result.code, null);
});

test("微信总开关只管真实事件，「发送测试」不受它约束", async () => {
  const env = await boot({ settings: Object.assign({}, WX, { wechatEnabled: false }) });
  await stoppedByAlarm(env);
  assert.deepEqual(sent(env), [], "wechatEnabled 关着还在推真实事件");
  env.reply((url) =>
    tokenUrl(url)
      ? { json: { access_token: "T1", expires_in: 7200 } }
      : { json: { errcode: 0 } }
  );
  await testWx(env);
  assert.equal(sent(env).length, 2, "测试消息也被总开关挡住了：没填完就永远试不出来");
});

test("事件清单是两个出口共用的：微信也听它", async () => {
  const env = await boot({ settings: Object.assign({}, WX, { notifyEvents: ["keyword"] }) });
  await stoppedByAlarm(env);
  assert.deepEqual(sent(env), [], "勾选只管 webhook，微信照推不误");
});

/* 红→绿对照（2026-09-19 实跑：整份插件目录复制到仓库外，每处只改坏 postWebhook / postWechat /
   getWechatToken 函数体内的一处——needle 在区段内断言正好命中一次——TAR_BG 指过去跑本文件）：
     1) webhook 的 `if (!events.includes(event)) return;` 改成 `if (false) return;`
        → 红 1：只红在"事件没勾上就一笔不发"
     2) 删掉载荷里 content / text / body 三行别名赋值
        → 红 1：只红在"配了地址又勾了这个事件"（三家各认一个字段，全空就是空白卡片）
     3) `normalizeWebhookUrl(settings.webhookUrl)` 换成 `String(...).trim()`（不做协议校验）
        → 红 1：只红在"地址非法一笔都不发"
     4) webhook 的 `method: "POST"` 改成 "GET"
        → 红 1：只红在"配了地址又勾了这个事件"
     5) 微信的 `if (!forced && !settings.wechatEnabled)` 去掉 forced（总开关连测试按钮一起管住）
        → 红 1：只红在"微信总开关只管真实事件"
     6) 微信的 `if (!forced && !notifyEventsOf(settings).includes(event)) return;` 改成永不返回
        → 红 1：只红在"事件清单是两个出口共用的"
     7) 微信的 `if (!state.ready) {` 改成 `if (false) {`（凭据不全也去撞接口）
        → 红 1：只红在"凭据没填全"
     8) 删掉 `if (isTokenErrorCode(code) && attempt === 1) continue;`（令牌失效不重试）
        → 红 1：只红在"命中 40001"
     9) `getWechatToken(settings, attempt === 2)` 的 force 实参改成恒 false
        → 红 1：只红在"命中 40001"（重取时没带 force_refresh，拿回来的还是那个废令牌）
    10) `errorKey: wechatErrorKey(code)` 换成写死的 "wechatErrOther"
        → 红 1：只红在"非令牌错误码不重试"
    11) catch 里 `kind: code === null ? "network" : "api"` 换成恒 "api"
        → 红 1：只红在"网络被拒留 network 痕迹"
    12) `if (tokenFresh(...)) return ...token` 改成永不命中缓存
        → 红 1：只红在"令牌还新鲜就不重取"
    13) 删掉 `await chrome.storage.session.set({ [WX_TOKEN_KEY]: cache })`
        → 红 2："发送测试"（断言缓存里落的是 T1）与"命中 40001"（断言重试之后缓存已是 T2）。
           请求形状两处都还是对的，红的全是"缓存没被写"这一条
   桩件侧的反向事实：把 background-harness.mjs 的 `globalThis.fetch = env.fetch` 摘掉，
   本文件红 7/11，绿的四条恰好全是"断言一笔都不发"的否定式用例（事件没勾上、地址非法、
   凭据没填全、事件清单共用）。fetch 根本不存在时它们照样绿——单看这四条，
   它们证明不了任何一条链路跑过。但这四条本身是被钉住的：改坏对应的四道闸（1/3/6/7）
   各红一条，红的是"闸没了就多发出一笔"，而不是"这条用例压根没跑"。 */
