/* 两条外发出口（postWebhook / postWechat）的端到端用例。
   此前一次也没执行过：共享桩件没有 fetch 桩件，两条链路一进 fetch 就 ReferenceError，
   各自外层的 try 把它吞成"静默失败"——而"静默失败"正是这两条链路唯一的失败方式，
   所以它们从来没红过，也从来没绿过。现在桩件给了 env.reply()，才第一次真的把请求发出去。

   分工：logic.test.mjs 钉的是 normalizeWebhookUrl / buildWechatMessage / tokenFresh 这些
   纯函数本身；这边钉的是执行器——什么时候真的发、发出去的形状对不对、失败留没留痕。
   触发口两个：refresh alarm 发现标签页没了（真实事件 task-stopped），
   以及弹窗的"发送测试消息"（wechat-test，唯一能直接点着 postWechat 的入口）。

   2026-09-19 起这个文件还管第二件事（A4）：外发载荷里不得出现 query。做法是把本文件
   通用的任务网址换成带一次性令牌的 RAW，于是每条断言外发形状的用例顺带都在检查剪没剪，
   末尾那一节再把四个事件逐个跑一遍。为什么钉在出口而不是逐处改调用点：见 notifyOut 的注释。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";
import { SESSION_LOST_CONFIRM_SAMPLES } from "../../tab-auto-refresh/shared/logic.js";

const PAGE = "https://a.test/board";
/* A4：任务网址一律给带 query 的形状。外发面上现在只许出现 origin+pathname，
   所以本文件里每一条"发出去的东西"的断言都顺带在钉这件事——令牌串放在这里，
   漏一次就会被点名，而不是只靠下面那一节专门写的用例 */
const SECRET = "ONE-TIME-9f3c";
const RAW = `https://a.test/board?ticket=${SECRET}&email=me%40corp.test#frag`;
const TRIMMED = PAGE;
/* 心跳被踢到的登录页：它自己也带 query，用来确认"落地地址"不会被当成载荷网址发出去 */
const LOGIN = "https://a.test/login?next=%2Fboard";
const task = (over) => Object.assign({ intervalSec: 300, createdAt: 1, url: RAW }, over);
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
  /* 任务网址是带一次性令牌的 RAW，发出去的必须是剪过的 TRIMMED（A4） */
  assert.equal(body.url, PAGE);
  assert.ok(!init.body.includes(SECRET), "原始请求体里混进了令牌串");
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

/* ---------- A8：webhook 投递结果要留痕 ----------
   改之前 fetch 回来连状态码都不看：接收端删了 hook、把频道踢了，这一侧记的都是"没发生任何事"，
   比记成失败更难查。下面这些用例钉的就是"每一次真发出去的投递都留下一笔"，
   以及刻意**不**留痕的那两种"本该不发"（没配地址、事件没勾上）。 */

const last = (env) => env.store.local.webhookLastResult;
const whEnv = async () =>
  boot({ settings: { webhookUrl: HOOK, notifyEvents: ["task-stopped"] } });
/* task-stopped 是这文件里最便宜的触发口：refresh-7 到点时标签页已不在 */
const sentHook = async (env, spec) => {
  env.reply(spec);
  await stoppedByAlarm(env);
  return env;
};

test("投递成功也留痕：状态码、事件名、时间戳一起写", async () => {
  const env = await sentHook(await whEnv(), { status: 204 });
  assert.equal(sent(env).length, 1);
  assert.equal(last(env).ok, true);
  assert.equal(last(env).status, 204);
  assert.equal(last(env).event, "task-stopped");
  assert.equal(typeof last(env).at, "number", "没有时间戳就无法判断这是不是很久以前的一次成功");
});

test("第二次投递覆盖第一次：只留最近一次，不堆积", async () => {
  /* 触发口用"发送测试"而不是再 fire 一次 alarm：上一笔 task-stopped 已经把任务删掉，
     第二次到点根本不会外发，那样跑出来的是"没发出第二笔"的假绿 */
  const env = await boot({ settings: { webhookUrl: HOOK, notifyEvents: [] } });
  env.reply({ status: 204 });
  await env.send({ type: "webhook-test" });
  const first = last(env);
  env.reply({ status: 500 });
  await env.send({ type: "webhook-test" });
  assert.equal(first.ok, true);
  assert.equal(Array.isArray(last(env)), false, "写成数组了：弹窗那一行只能显示一条，其余是死数据");
  assert.equal(last(env).ok, false, "新的一笔没盖掉旧的：那一行会一直停在上次成功");
  assert.equal(last(env).kind, "server");
});

test("接收端回 200 却说没收到：只看 res.ok 会把这类记成成功", async () => {
  /* Slack 对"hook 已删除 / 频道被踢"照样回 200，失败信号只在正文的 "ok":false 里 */
  const env = await sentHook(await whEnv(), {
    status: 200,
    text: '{"ok":false,"error":"not_authed"}'
  });
  assert.equal(last(env).ok, false, "200 就当成功：这条改动的全部意义就在这儿");
  assert.equal(last(env).kind, "rejected");
  assert.equal(last(env).status, 200);
  assert.equal(last(env).errorKey, "webhookErrRejected");
});

test("正常 200 与 204 不被正文猜成失败：正文里没有那句 ok:false", async () => {
  for (const spec of [
    { status: 200, text: "" },
    { status: 200, text: "ok" },
    { status: 200, text: '{"ok":true,"message":"sent"}' },
    { status: 201, json: { id: "1" } }
  ]) {
    const env = await sentHook(await whEnv(), spec);
    assert.equal(last(env).ok, true, `${JSON.stringify(spec)} 被判成失败：正则是过度匹配`);
  }
});

test("按状态码归桶：每一桶都翻成用户照着能改的一句话", async () => {
  for (const [status, kind, errorKey] of [
    [401, "auth", "webhookErrAuth"],
    [403, "auth", "webhookErrAuth"],
    [404, "gone", "webhookErrGone"],
    [410, "gone", "webhookErrGone"],
    [400, "payload", "webhookErrPayload"],
    [413, "payload", "webhookErrPayload"],
    [429, "rate", "webhookErrRate"],
    [500, "server", "webhookErrServer"],
    [503, "server", "webhookErrServer"],
    [418, "status", "webhookErrStatus"],
    [302, "status", "webhookErrStatus"]
  ]) {
    const env = await sentHook(await whEnv(), { status, text: "" });
    assert.equal(last(env).ok, false, `${status} 被记成成功`);
    assert.equal(last(env).kind, kind, `${status} 归错桶`);
    assert.equal(last(env).status, status);
    assert.equal(last(env).errorKey, errorKey, `${status} 没翻译成文案键，弹窗只能显示一个数字`);
  }
});

test("非 2xx 不读正文：404 的正文写着 ok:true 也算失败", async () => {
  /* 钉的是刻意的不对称：2xx 那一路才需要正文，其余按状态码归桶就够，
     不必再信第三方在错误页里写的任何字 */
  const env = await sentHook(await whEnv(), { status: 404, text: '{"ok":true}' });
  assert.equal(last(env).ok, false);
  assert.equal(last(env).kind, "gone");
});

test("网络被拒：记 network 且状态码为 null，不假报成接口返回", async () => {
  const env = await sentHook(await whEnv(), new Error("Failed to fetch"));
  assert.equal(last(env).ok, false);
  assert.equal(last(env).kind, "network");
  assert.equal(last(env).status, null, "把没发生的请求写成有状态码，用户会去查那个不存在的码");
  assert.equal(last(env).errorKey, "webhookErrNetwork");
});

test("没配地址、事件没勾上：这两种「本该不发」一笔都不留痕", async () => {
  /* 留痕只针对真发出去的那一笔。关着的出口还去写"失败"，等于把"这是关的"说成"坏了" */
  const off = await sentHook(
    await boot({ settings: { webhookUrl: "", notifyEvents: ["task-stopped"] } }),
    { status: 500 }
  );
  const notOn = await sentHook(
    await boot({ settings: { webhookUrl: HOOK, notifyEvents: ["keyword"] } }),
    { status: 500 }
  );
  for (const [name, env] of [["地址为空", off], ["事件没勾", notOn]]) {
    assert.deepEqual(sent(env), [], `${name}却发了请求`);
    assert.equal(env.store.local.webhookLastResult, undefined, `${name}却写了留痕`);
    assert.deepEqual(
      env.calls.localSet.filter((k) => k.includes("webhookLastResult")),
      [],
      `${name}却动了 webhookLastResult`
    );
  }
});

test("两个出口各写各的痕迹：webhook 失败不动微信那一行", async () => {
  const env = await boot({
    settings: Object.assign({}, WX, { webhookUrl: HOOK, notifyEvents: ["task-stopped"] })
  });
  env.reply((url) =>
    tokenUrl(url)
      ? { json: { access_token: "T1", expires_in: 7200 } }
      : url.includes(HOOK)
        ? { status: 404, text: "" }
        : { json: { errcode: 0 } }
  );
  await stoppedByAlarm(env);
  assert.equal(last(env).ok, false);
  assert.equal(last(env).kind, "gone");
  assert.equal(env.store.local.wechatLastResult.ok, true, "一个出口失败把另一个也标成红了");
});

test("「发送测试」不受事件勾选约束，也不惊动微信；真实事件照旧受约束", async () => {
  const env = await boot({ settings: { webhookUrl: HOOK, notifyEvents: [] } });
  env.reply({ status: 204 });
  const r = await env.send({ type: "webhook-test" });
  assert.equal(r.ok, true);
  assert.equal(sent(env).length, 1, "测试按钮没发出去，或顺带把另一个出口也发了");
  assert.equal(sent(env)[0].url, HOOK);
  assert.equal(JSON.parse(sent(env)[0].init.body).type, "test");
  /* 桩件的 getMessage 回显键名（刻意不翻译），所以这里断言的是"取自语言包"这个事实本身：
     句子由后台给，弹窗不能把任意文本塞进外发载荷 */
  assert.equal(JSON.parse(sent(env)[0].init.body).content, "webhookTestBody");
  assert.equal(r.result.ok, true);
  assert.equal(r.result.event, "test");
  assert.equal(env.store.local.wechatLastResult, undefined, "webhook 的测试写了微信的键");
  await stoppedByAlarm(env);
  assert.equal(sent(env).length, 1, "测试绕过事件勾选，真实事件却也跟着绕过了");
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

/* ---------- A4：外发面上不得出现 query ---------- */

const flush = () => new Promise((r) => setTimeout(r, 50));

/* 心跳那一拍按用例给，其余请求（webhook 落地、微信取令牌与推送）一律回成功，
   好让两个出口都真的把请求发出去 */
const replyFor = (hb) => (url) => {
  if (url === RAW) return hb;
  if (tokenUrl(url)) return { json: { access_token: "T1", expires_in: 7200 } };
  return { json: { errcode: 0 } };
};

/* 两个出口一起开：它们读的是同一份 payload.url，只测一个等于放过另一个 */
const bothOutlets = (event) => Object.assign({}, WX, { webhookUrl: HOOK, notifyEvents: [event] });

/* 只取通知类请求的**原始 body 文本**：解析过的对象会漏掉嵌套字段，
   而"不得出现 query"要钉的正是序列化之后真正离开本机的那串字节。
   心跳自己那笔 GET 不算：那是站点页面的地址，本来就该带 query，也不发给第三方 */
const notifyBodies = (env) =>
  env.calls.fetch
    .filter((c) => c.url === HOOK || /\/message\/template\/send/.test(c.url))
    .map((c) => String(c.init.body || ""));

const assertNoQueryLeak = (env, event, withUrl) => {
  const bodies = notifyBodies(env);
  assert.ok(
    bodies.length >= 2,
    `${event}：两个出口一共只发出 ${bodies.length} 笔，下面的断言会空跑`
  );
  for (const body of bodies) {
    assert.ok(!body.includes(SECRET), `${event}：一次性令牌被发出去了 → ${body}`);
    assert.ok(!body.includes("corp.test"), `${event}：query 里的邮箱被发出去了 → ${body}`);
    if (withUrl) {
      /* 剪的是 query，不是整条网址：卡片点不动、载荷里认不出哪个页面都是回归 */
      assert.ok(
        body.includes(`"url":${JSON.stringify(TRIMMED)}`),
        `${event}：载荷没带上剪过的网址 → ${body}`
      );
    } else {
      assert.ok(
        !/"url":/.test(body),
        `${event}：这个事件的载荷本不带网址，冒出来就说明新增的外发点没走 notifyOut 的精简`
      );
    }
    for (const m of body.matchAll(/"(?:url|link|href|page|target|pageUrl|page_url)":"([^"]*)"/g)) {
      assert.ok(!/[?#]/.test(m[1]), `${event}：网址字段带着 query 或 hash → ${m[1]}`);
      assert.equal(m[1], TRIMMED, `${event}：网址字段不是 origin+pathname → ${m[1]}`);
    }
  }
};

/* 四个事件各自的触发口，形状与各门禁文件里已有的用例一致：
   task-stopped 是刷新 alarm 发现页没了，keyword 是页面加载完成后的检测链，
   task-paused 与 session-lost 是心跳的错误页通道与掉线通道 */
const TRIGGERS = {
  "task-stopped": { fire: (env) => env.fire.alarm("refresh-7"), withUrl: true },
  "keyword": {
    withUrl: true,
    fire: async (env) => {
      env.putTab(7, RAW);
      env.onScript((opts) => (opts.args ? [{ result: ["已售罄"] }] : undefined));
      await env.fire.tabUpdated(7, { status: "complete" });
      await flush();
    }
  },
  "task-paused": {
    withUrl: true,
    fire: async (env) => {
      /* 错误页连击阈值（PAUSE_CONFIRM_SAMPLES = 2）住在 background.js 里、不导出，
         所以这里写死 2 拍：阈值改了这条会红在"一笔外发都没发出"，不会悄悄空跑 */
      for (let i = 0; i < 2; i++) await env.fire.alarm("hb-7");
    }
  },
  /* 掉线事件的载荷刻意只有 host，没有网址：这一条顺带把那个形状钉住，
     将来谁给它补 url 字段就必须同时经过精简 */
  "session-lost": {
    withUrl: false,
    fire: async (env) => {
      for (let i = 0; i < SESSION_LOST_CONFIRM_SAMPLES; i++) await env.fire.alarm("hb-7");
    }
  }
};

for (const [event, spec] of Object.entries(TRIGGERS)) {
  test(`${event}：两个出口发出的网址都已剪成 origin+pathname`, async () => {
    const hb =
      event === "task-paused"
        ? { status: 503 }
        : event === "session-lost"
          ? { status: 200, url: LOGIN }
          : { status: 200 };
    const env = await boot({
      tasks: event === "keyword" ? { 7: task({ keywords: ["已售罄"] }) } : undefined,
      settings: Object.assign({}, bothOutlets(event), { httpHeartbeat: true })
    });
    env.reply(replyFor(hb));
    await spec.fire(env);
    assertNoQueryLeak(env, event, spec.withUrl);
  });
}

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
   各红一条，红的是"闸没了就多发出一笔"，而不是"这条用例压根没跑"。

   ---------- A4（载荷剪枝）的对照，同一天实跑，脚本 ctl-a4.mjs ----------
   前 13 处改的是 postWebhook / postWechat / getWechatToken 的函数体；下面这些改的是
   notifyOut 与 shared/logic.js 的 outboundUrl（第 7 处改 popup.html）。跑法：整份插件目录
   复制到仓库外用 TAR_BG 指过去（logic.js 跟着副本走，因为 background 按相对路径 import）；
   后两处落在 logic.test.mjs / popup-repopulate.test.mjs 直读真路径的文件上，所以整仓复制一份。
     1) notifyOut 整段不剪（`const out = payload;`）
        → 红 4：既有那条"配了地址又勾了这个事件" + 三条带 url 的新用例
     2) 只剪 webhook、微信那一侧漏掉（`postWechat(event, out)` 改回 payload）
        → 红 3：三条新用例。**既有那 11 条一条都不红**——它们没开微信凭据。
           这就是"逐处改"当初会漏掉的形状，也是这一节存在的理由
     3) outboundUrl 剪过头，pathname 也没了（只回 origin）
        → 红 4：与第 1 处同一批，红的是"载荷没带上剪过的网址"那半边的断言
     4) outboundUrl 把 query 留着（只去 hash）
        → 红 4：同上这批，红在令牌串/邮箱那两条
     5) 给 session-lost 的载荷补一个 url 字段
        → 红 1：只红在 session-lost 那条。withUrl=false 那一支不是死断言
     6) outboundUrl 解析失败时回退成原样传出去（而不是空串）
        → 红 1：logic.test.mjs 的"outboundUrl 剪掉 query 与 hash，坏输入回空串"
     7) 密钥输入框改回 type="text"
        → 红 1：popup-repopulate.test.mjs 的"密钥输入框是 type=password"
   七处每处都只红在它点名的那些条上，没有一处能把整份文件带崩。

   ---------- A8（webhook 留痕与"发送测试"）的对照，同一天实跑，脚本在仓库外 ctl-a8/ ----------
   整仓复制到仓库外，改坏副本里的 background.js，在副本里同时跑 outbound 与 message-gate
   （后者是"新分支必须过来源守卫"的顺带检查）。基线（四个文件一起跑）122 条全绿。
     B1 成功不留痕，只有失败才写   → 红 4：投递成功也留痕、第二次投递覆盖、正常 200 与 204…、发送测试。
        message-gate 全绿——它不看留痕
     B2 地址没配也写一条失败        → 只红 1：没配地址、事件没勾上…（这一条钉的是"本该不发就一笔不留"）
     B3 ignoreToggle 失效           → 红 2：发送测试（正主）+ 第二次投递覆盖。
        第二条是顺带红：那条用"发送测试"连点两次来制造第二次投递，绕过位没了它就再也发不出去
     B4 webhook-test 的响应不带 result → 只红 1：发送测试（弹窗拿不到结果，状态行停在旧值）
     B5 留痕键名写成 webhookLast    → 红 8：凡是去 local.webhookLastResult 读结果的那几条，
        含"两个出口各写各的痕迹"。而「发送测试」不红——后台写与回读用的是同一个错键，
        自洽；只有跨到弹窗那一侧的读者才发现。所以键名必须由存盘侧与读取侧各钉一次
     B6 2xx 不读正文、交空串给分类器 → 只红 1：接收端回 200 却说没收到。
        与逻辑层的 L1 红在同一条语义上，但一个坏在分类器、一个坏在执行器，两道各钉一头 */
