/* 驱动真实 background.js 的 chrome 桩件，供 tests/ 下各门禁共用。
   为什么要共用：background.js 在模块顶层注册监听器，每新增一个 chrome.*.addListener
   就会让每一份手写桩件在 import 那一步直接抛错（先踩过一次：加了 notifications.onClicked
   之后 5 条无关用例全红）。桩件分散重写等于把这类失败变成"改一处、修三份"。

   用法：
     const env = makeEnv();                    // 需要初始状态就写 env.store / env.putTab()
     await bootBackground(env);                // 每个用例一套新桩件 + 新实例，别复用 env
     await env.send({ type: "..." });          // 走真实 onMessage 入口（处理器不 return true 即失败）
     env.fire.onChanged(changes, "sync");      // 手工喂存储变更事件
     env.onScript((opts) => [...]);            // 改 executeScript 的返回，命中/验证墙分支靠它
     env.focusWindow(1 | null);                // 有焦点 / 浏览器退到后台（窗口还在）
     env.closeAllWindows();                    // 一个窗口都没有，这时 getLastFocused 才 reject
     env.setCookies([...]);                    // 放 cookie 数据，备份采集与还原用
     env.reply({ status: 503 });               // 改 fetch 应答（数组=逐次给，Error=reject，promise=挂住）
     env.pendingFetch()[0].abort();            // 打断挂住的那笔外发，等价于后台那 15 秒超时到点
     await settles(inflight)                   // 打断之后必须带上限地等落定，见文件末尾那条注释
     env.calls.keepAwake                       // chrome.power 调用序列：["request","system"] / ["release"]
   env.chrome 可以被测试直接改（例如把 storage.sync.get 换成可控放行的挂起读）。
   桩件的 storage.set 不做 onChanged 回流：真实 Chrome 是异步回流的，
   "写完立刻读"和"外部改动回流后再读"两条路要各自单独测，不能互相顶包。
   i18n.getMessage 回显键名（带 subs 时回 "key:a,b"）：这是刻意的，桩件不翻译文案。
   所以任何断言"文案里含站点名/关键词"都必须走 subs 那条通道去断言，别把回显改成照抄语言包
   ——那样每条用例都要跟着语言包改，而且会把"文案没翻"这类错误测成通过。 */

import { pathToFileURL } from "node:url";

/* 红→绿对照用：TAR_BG 指到另一份 background.js 的绝对路径（该文件必须与自己的 shared/
   目录同级，background.js 是按相对路径 import 的）。CI 上不设这个变量 */
const BG = process.env.TAR_BG
  ? pathToFileURL(process.env.TAR_BG).href
  : new URL("../../tab-auto-refresh/background.js", import.meta.url).href;
let importSeq = 0;

export function makeEnv() {
  const store = { local: {}, sync: {}, session: {} };
  const calls = {
    syncGet: 0,
    localGet: 0,
    /* 写入也要能数：只比"落盘后的内容"是比不出"没写"的——set 是 Object.assign 合并，
       写一份与现状完全相同的值，前后 JSON 一样。凡是断言"这条路径不该写盘"的用例
       都需要这里记一笔键列表 */
    localSet: [],
    syncSet: [],
    notifCreated: [],
    notifCleared: [],
    tabsActivated: [],
    windowsFocused: [],
    alarmsCreated: [],
    /* 清掉的是哪几条也要记：只数创建历史比不出"该清的两条一条也没清"，
       也比不出"任务还没搬动却先把定时器清了" */
    alarmsCleared: [],
    badge: [],
    executeScript: [],
    reloaded: [],
    navigated: [],
    messagesSent: [],
    /* getAll 的查询参数也要记：备份越界与否看的正是"查了哪几层域"，
       只记写入结果等于放过了查询面（A2） */
    cookieGet: [],
    cookieSet: [],
    /* 每条外发请求都记下来：请求形状（Range 的写法、credentials、redirect）本身就是门禁对象 */
    fetch: [],
    /* 防休眠锁的调用序列：request 与 release 都记，形状与 alarmsCleared 同形。
       "一个 SW 生命周期最多 request 一次""释放那一头无条件"这两条判据只能靠序列断言，
       数总量数不出来（E3 之前这里是两个空函数，applyKeepAwake 整段零覆盖） */
    keepAwake: []
  };
  const listeners = {
    changed: [],
    message: [],
    alarm: [],
    updated: [],
    removed: [],
    notifClicked: [],
    startup: [],
    installed: [],
    command: [],
    idle: [],
    winFocused: [],
    menuClicked: []
  };
  const tabs = new Map();
  const alarms = new Map();
  /* 焦点窗口：null 表示此刻没有窗口有焦点（用户在别的应用里），与 Chrome 的
     WINDOW_ID_NONE 同义。lastFocusedWindow 要单独记一笔——真实 Chrome 在浏览器退到后台
     之后 getLastFocused() 仍返回最后聚焦的那个窗口，只有"一个窗口都没有"才 reject。
     早先桩件把这两件事合成一件（无焦点即抛），于是 isTabOnScreen 里"回退去问一次"那条
     路径在测试里压根不存在，它误判"人在看着这页"也就看不见（见 alarm-gate 的"浏览器退到后台"） */
  let focusedWindow = null;
  let lastFocusedWindow = null;
  /* executeScript 的返回钩子：后台自己调 executeScript，用例没法往参数里塞标记，
     所以改结果只能靠这一层钩子（见 env.onScript） */
  let scriptHook = null;
  /* contextMenus.create 的登记表，用来断言 buildMenus 的结构 */
  const menuItems = [];
  /* cookies 桩件的数据源：备份采集与还原都要在真数据上跑，恒返回 [] 等于没测 */
  const cookieJar = [];

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  /* fetch 桩件。真实 MV3 service worker 里 fetch 一定在，而桩件里没有——于是静默心跳、
     postWebhook、postWechat 三条外发链路一进 fetch 就 ReferenceError，被各自外层的 try
     吞掉，主体分支从来没被执行过，用例照样全绿（A6 第 9 条）。
     建模的规矩，每条都决定某段代码是"看着对"还是"真对"：
       - ok 由 status 推出来，绝不恒真：心跳侧的错误页暂停、掉线信号、静默自愈全看状态码
       - url 是**跟随重定向之后**的最终地址（looksLikeLoginPage 判的就是它），
         用例用 { url: "..." } 表达"心跳被踢到登录页"
       - 网络失败与超时是 reject：把 Error 当作应答值即可
       - 应答可以是数组：按调用次序逐条给，用完之后重复最后一条（416 重试、令牌重取都靠它）
       - 应答可以是**一个由用例握着的 promise**（E3 补的）：await 它，这段挂起就是
         "外发还没回来时后台在做什么"的现场本身。A15 结案时是靠每条用例自己覆写
         globalThis.fetch 绕过去的，那是一次性的局部绕法，现在收回桩件
       - init.signal 要真兑现：后台三处外发各自上着 15 秒 AbortController，桩件不认 signal
         就等于"到点也不会 abort"，超时那一支仍然测不出。未决的请求列在 env.pendingFetch()，
         句柄上的 abort() 手动打断，形状与真实被 abort 的 fetch 一样（reject AbortError），
         用例因此不必真等 15 秒 */
  let responder = null;
  const pendingFetches = [];
  const abortError = () =>
    Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  const toResponse = (spec, url) => {
    const s = spec || {};
    const status = s.status === undefined ? 200 : s.status;
    return {
      ok: status >= 200 && status <= 299,
      status,
      url: s.url === undefined ? url : s.url,
      json: async () => clone(s.json === undefined ? {} : s.json),
      text: async () => (typeof s.text === "string" ? s.text : "")
    };
  };
  const fetchStub = async (resource, init) => {
    const url = typeof resource === "string" ? resource : String((resource && resource.url) || "");
    const entry = { url, init: init || {} };
    calls.fetch.push(entry);
    const signal = entry.init.signal;
    /* 出发之前信号就已经取消：真实 fetch 一个字节都不发出去，直接 reject */
    if (signal && signal.aborted) throw abortError();
    let spec = typeof responder === "function"
      ? responder(url, entry.init, calls.fetch.length - 1)
      : responder;
    if (Array.isArray(spec)) spec = spec[Math.min(calls.fetch.length - 1, spec.length - 1)];
    let answered = false;
    let kick;
    const gate = new Promise((_, reject) => {
      kick = reject;
    });
    const abort = () => {
      /* 只在还没应答时才打断：应答之后再 reject 这个 gate 就是无人接手的 rejection */
      if (!answered) {
        answered = true;
        kick(abortError());
      }
    };
    const handle = { url, abort };
    pendingFetches.push(handle);
    if (signal && signal.addEventListener) signal.addEventListener("abort", abort, { once: true });
    let value;
    try {
      value = await Promise.race([
        Promise.resolve(spec).then((v) => {
          answered = true;
          return v;
        }),
        gate
      ]);
    } finally {
      const i = pendingFetches.indexOf(handle);
      if (i >= 0) pendingFetches.splice(i, 1);
      if (signal && signal.removeEventListener) signal.removeEventListener("abort", abort);
    }
    if (value instanceof Error) throw value;
    return toResponse(value, url);
  };

  const area = (name) => ({
    async get(keys) {
      if (name === "sync") calls.syncGet++;
      if (name === "local") calls.localGet++;
      const s = store[name];
      if (keys == null) return Object.assign({}, s);
      if (typeof keys === "string") return keys in s ? { [keys]: clone(s[keys]) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in s) out[k] = clone(s[k]);
        return out;
      }
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in s ? clone(s[k]) : keys[k];
      return out;
    },
    async set(obj) {
      /* 深拷贝写入：真实存储不会让调用方持有的对象引用继续影响已存值 */
      if (name === "local") calls.localSet.push(Object.keys(obj));
      if (name === "sync") calls.syncSet.push(Object.keys(obj));
      Object.assign(store[name], clone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[name][k];
    },
    async clear() {
      store[name] = {};
    }
  });

  /* 真实 Chrome 的每个事件对象都有 removeListener，桩件也要有：只给 addListener 的话，
     后台里任何"临时挂监听、完事摘掉"的写法（等待窗口就是这样）会在测试里抛
     not a function，而且是定时器回调里抛，表现为整条用例莫名失败 */
  const eventSink = (list) => ({
    addListener: (f) => list.push(f),
    removeListener: (f) => {
      const i = list.indexOf(f);
      if (i >= 0) list.splice(i, 1);
    }
  });
  /* 派发只取本次 boot 之后注册的那一段，而不是数组末尾一个：
     后台自己会临时挂监听（如等待窗口），末尾那个恰恰可能是它，取 at(-1) 就把
     模块常驻的 onUpdated 处理器整个跳过了。同一 env 重复 boot 时上一实例的也不派。 */
  const bootFrom = {};
  const dispatch = (name) => listeners[name].slice(bootFrom[name] || 0);
  const chrome = {
    storage: {
      local: area("local"),
      sync: area("sync"),
      session: area("session"),
      onChanged: eventSink(listeners.changed)
    },
    alarms: {
      async create(name, info) {
        /* 真实 Chrome 会把首次触发时刻算好放在 scheduledTime 上，而 background.js:300-324 的
           idle 重挂整段就是按这个字段判"已过期"。桩件不给它，那条路径就永远走"没过期"分支，
           用例看着在测自愈、实际什么都没测 */
        const now = Date.now();
        const first =
          info && typeof info.when === "number"
            ? info.when
            : now + ((info && info.delayInMinutes) || 0) * 60000;
        alarms.set(name, { name, info: clone(info) || {}, first });
        calls.alarmsCreated.push([name, info]);
      },
      async clear(name) {
        calls.alarmsCleared.push(name);
        alarms.delete(name);
      },
      getAll: async () =>
        [...alarms.values()].map((a) =>
          Object.assign({ name: a.name, scheduledTime: a.first }, clone(a.info))
        ),
      onAlarm: eventSink(listeners.alarm)
    },
    tabs: {
      async get(id) {
        const t = tabs.get(Number(id));
        if (!t) throw new Error("No tab with id: " + id);
        return clone(t);
      },
      async update(id, props) {
        const t = tabs.get(Number(id));
        if (!t) throw new Error("No tab with id: " + id);
        if (props && props.url) {
          t.url = props.url;
          calls.navigated.push([Number(id), props.url]);
        }
        if (props && props.active) calls.tabsActivated.push(Number(id));
        return clone(t);
      },
      async create(props) {
        const id = ++nextTabId;
        tabs.set(id, { id, url: props.url, windowId: props.windowId || 1, active: false });
        return clone(tabs.get(id));
      },
      async reload(id) {
        calls.reloaded.push(Number(id));
      },
      async query(q) {
        /* 原先无条件返回全部：那意味着任何依赖 active / currentWindow 过滤的后台路径
           都写不出用例——桩件会给出不符条件的标签页，测出来的"对"是假的。
           currentWindow 按当前焦点窗口解释，与弹窗语境同义 */
        const query = q || {};
        let list = [...tabs.values()];
        if (query.active !== undefined) list = list.filter((t) => !!t.active === !!query.active);
        if (query.discarded !== undefined) {
          list = list.filter((t) => !!t.discarded === !!query.discarded);
        }
        if (query.windowId !== undefined) {
          const ids = [].concat(query.windowId);
          list = list.filter((t) => ids.includes(t.windowId));
        }
        if (query.currentWindow) list = list.filter((t) => t.windowId === focusedWindow);
        return list.map(clone);
      },
      async sendMessage(id, msg) {
        calls.messagesSent.push([id, msg]);
        return {};
      },
      onUpdated: eventSink(listeners.updated),
      onRemoved: eventSink(listeners.removed)
    },
    windows: {
      WINDOW_ID_NONE: -2,
      async update(id, props) {
        if (props && props.focused) calls.windowsFocused.push(Number(id));
        focusedWindow = Number(id);
        lastFocusedWindow = Number(id);
        return { id };
      },
      async getLastFocused() {
        /* 真实 Chrome 的两个不同情形要能分别造出来：
           还有窗口、但焦点在别的应用 → 照常返回最后聚焦的那个（env.focusWindow(null)）
           一个窗口都没有 → reject（env.closeAllWindows()）
           原先两者合一（无焦点即抛），background 里"回退去问一次"这条路径就无从测试 */
        if (lastFocusedWindow === null) throw new Error("No current window");
        return { id: lastFocusedWindow };
      },
      onFocusChanged: eventSink(listeners.winFocused)
    },
    idle: { onStateChanged: eventSink(listeners.idle) },
    runtime: {
      onStartup: eventSink(listeners.startup),
      onInstalled: eventSink(listeners.installed),
      onMessage: eventSink(listeners.message),
      lastError: null
    },
    contextMenus: {
      removeAll: (cb) => {
        menuItems.length = 0;
        if (cb) cb();
      },
      create: (item) => menuItems.push(clone(item)),
      /* 原先登记表是一个外部拿不到的空数组，菜单点击无处派发，右键起停任务整段零覆盖。
         现在进 listeners.menuClicked，用例用 env.fire.menuClicked(info, tab) 派发 */
      onClicked: eventSink(listeners.menuClicked)
    },
    commands: { onCommand: eventSink(listeners.command) },
    scripting: {
      async executeScript(opts) {
        /* 记下每次调用的参数：注入面（target / allFrames / world）本身就是要断言的东西，
           只数次数等于没管过它 */
        calls.executeScript.push(opts);
        /* 默认"注入成功、没命中"（[{result:false}]）。这个默认值让关键词命中链的命中分支
           与验证墙的暂停分支在测试里永远走不到，所以用例要能改口：env.onScript((opts) => ...)
           按调用点返回结果，返回 undefined 表示"这次不改口"。
           原先这里是靠 opts.__fixture 判的，那是够不着的——executeScript 由后台自己调用，
           用例没法往 opts 里塞字段，所以那条路从写下起就没人用得起 */
        if (scriptHook) {
          const injected = scriptHook(opts);
          if (injected !== undefined) return injected;
        }
        return [{ result: false }];
      }
    },
    notifications: {
      async create(id, options) {
        calls.notifCreated.push([id, options]);
        return id;
      },
      async clear(id) {
        calls.notifCleared.push(id);
        return true;
      },
      onClicked: eventSink(listeners.notifClicked)
    },
    action: {
      async setBadgeText(d) {
        calls.badge.push(["text", d.text]);
      },
      async setBadgeBackgroundColor(d) {
        calls.badge.push(["color", d.color]);
      }
    },
    cookies: {
      async getAll(q) {
        /* 真实语义：domain 命中"等于该域或其子域"的 cookie。原先恒返回 []，
           于是备份采集、hostOnly 还原分支、200 条封顶全都在空数据上跑 */
        calls.cookieGet.push(q && q.domain !== undefined ? String(q.domain) : null);
        const list = cookieJar;
        if (!q || q.domain === undefined) return clone(list);
        const d = String(q.domain).toLowerCase();
        return clone(
          list.filter((c) => {
            const cd = String(c.domain || "").toLowerCase().replace(/^\./, "");
            return cd === d || cd.endsWith("." + d);
          })
        );
      },
      async set(c) {
        calls.cookieSet.push(clone(c));
        const key = (c.domain || "") + "|" + c.name + "|" + c.path;
        const at = cookieJar.findIndex((x) => (x.domain || "") + "|" + x.name + "|" + x.path === key);
        if (at >= 0) cookieJar[at] = c;
        else cookieJar.push(c);
        return clone(c);
      },
      async remove() {
        return {};
      }
    },
    power: {
      /* 真实 API 是同步的（可选回调），这里也同步返回 undefined，只多记一笔序列 */
      requestKeepAwake: (type) => {
        calls.keepAwake.push(["request", type]);
      },
      releaseKeepAwake: () => {
        calls.keepAwake.push(["release"]);
      }
    },
    i18n: {
      getMessage: (key, subs) => (subs ? key + ":" + [].concat(subs).join(",") : key),
      getUILanguage: () => "zh-CN"
    }
  };

  let nextTabId = 100;

  const env = {
    chrome,
    store,
    calls,
    listeners,
    /* bootBackground 在 import 前调用，记录每张监听表当时的长度 */
    markBoot() {
      for (const k of Object.keys(listeners)) bootFrom[k] = listeners[k].length;
    },
    /* 放一个标签页进登记表：windowId 可选，缺省 1，点击跳转要用它 */
    putTab(id, url, extra) {
      tabs.set(Number(id), Object.assign({ id: Number(id), url, windowId: 1, active: false }, extra));
      return tabs.get(Number(id));
    },
    dropTab(id) {
      tabs.delete(Number(id));
    },
    /* 改焦点窗口并通知监听器。
       focusWindow(1)   → 窗口 1 有焦点，getLastFocused 也返回它
       focusWindow(null)→ 浏览器退到后台：焦点事件给 WINDOW_ID_NONE，但窗口还在，
                          真实 Chrome 的 getLastFocused() 仍返回最后聚焦的那个
       closeAllWindows()→ 一个窗口都没有，这时 getLastFocused() 才 reject */
    focusWindow(id) {
      if (id === null) focusedWindow = null;
      else {
        focusedWindow = Number(id);
        lastFocusedWindow = Number(id);
      }
      for (const f of listeners.winFocused) f(id === null ? -2 : Number(id));
    },
    closeAllWindows() {
      focusedWindow = null;
      lastFocusedWindow = null;
    },
    /* 改 executeScript 的返回结果：fn 收到本次调用的 opts，返回 undefined 表示不改口
       （仍走默认的"没命中"）。命中链与验证墙暂停这两条分支靠它才执行得到 */
    onScript(fn) {
      scriptHook = fn;
    },
    /* 右键菜单的登记表（buildMenus 的产物），只读 */
    get menuItems() {
      return menuItems;
    },
    /* 往 cookie 罐子里放数据，备份采集与还原都要在真数据上跑 */
    setCookies(list) {
      cookieJar.length = 0;
      cookieJar.push(...(list || []));
    },
    /* 交给 bootBackground 装到 globalThis 上（后台是裸调 fetch 的） */
    fetch: fetchStub,
    /* 改 fetch 的应答：{status,url,json} 一个对象、一组按次序的对象（最后一条重复用）、
       一个 Error（reject）、一个**由用例握着的 promise**（挂住不回，直到用例自己放开或
       从 env.pendingFetch() 打断），或 (url, init, 第几笔) => 上述任意一种 */
    reply(spec) {
      responder = spec;
    },
    /* 此刻还挂在外发上的请求（按发起次序，句柄只有 url 与 abort）。abort() 打断它
       ——等价于后台那 15 秒 AbortController 到点。挂住的那一路不解除就会拖着事件循环 */
    pendingFetch() {
      return pendingFetches.slice();
    },
    get fetchCalls() {
      return calls.fetch;
    },
    send(msg, sender) {
      return new Promise((resolve, reject) => {
        const ret = dispatch("message").at(-1)(msg, sender || {}, resolve);
        /* 处理器必须 return true 才保住异步 sendResponse。删掉它的话弹窗拿到的是 undefined，
           而现在这条 Promise 会一直挂着到超时——报出来的是"某个用例莫名超时"，
           看不出真正丢了什么。所以在这里把它钉住 */
        if (ret !== true) {
          reject(new Error("onMessage 处理器没有 return true，异步应答会被截断: " + msg.type));
        }
      });
    },
    fire: {
      async onChanged(changes, areaName) {
        for (const f of dispatch("changed")) await f(changes, areaName);
      },
      async notifClicked(id) {
        for (const f of dispatch("notifClicked")) await f(id);
      },
      async tabUpdated(tabId, changeInfo, tab) {
        for (const f of dispatch("updated")) await f(tabId, changeInfo, tab || tabs.get(Number(tabId)));
      },
      async alarm(name) {
        for (const f of dispatch("alarm")) await f({ name });
      },
      /* 真实 Chrome 派发 onRemoved 时那张页已经不在登记表里了，所以先 drop 再派。
         不 drop 的话后台的 chrome.tabs.get(旧 id) 照样成功，测出来的是真实现场之外的形状。
         注意 onRemoved 的监听器是同步函数里裸调异步函数、不把 promise 交回来，
         await 到这里只走完派发那一圈，用例随后要自己排一轮宏任务才能看到结果 */
      async tabRemoved(tabId, isWindowClosing) {
        tabs.delete(Number(tabId));
        for (const f of dispatch("removed")) await f(tabId, { isWindowClosing: !!isWindowClosing });
      },
      /* 睡眠唤醒自愈那段判的是"scheduledTime 比现在早就重挂"。造过期闹钟不需要假时钟：
         用例直接 await env.chrome.alarms.create(name, { when: Date.now() - 1000 })，
         getAll 就会把它报成已过期的那一个 */
      async idle(state) {
        for (const f of dispatch("idle")) await f(state || "idle");
      },
      async menuClicked(info, tab) {
        for (const f of dispatch("menuClicked")) await f(info, tab);
      },
      async command(name) {
        for (const f of dispatch("command")) await f(name);
      },
      /* onStartup / onInstalled 的处理器是 async 且不回 promise，这里直接 await 注册者，
         才能测到 prune 跑完之后的存储状态。派发范围同样按 boot 切：本 env 只 boot 一个实例，
         与 [0]/at(-1) 的旧写法在既有用例上等价 */
      async startup() {
        for (const f of dispatch("startup")) await f();
      },
      async installed() {
        for (const f of dispatch("installed")) await f({ reason: "install" });
      }
    }
  };
  return env;
}

/* 加查询串强制每次 import 都新实例化一个模块（等价于 service worker 回收后重启）。
   共享的 shared/config.js 与 shared/logic.js 不随查询串重建，那里全是常量与纯函数 */
export async function bootBackground(env) {
  globalThis.chrome = env.chrome;
  /* 与 chrome 同一时机装：后台裸调 fetch，应答与被记下的那笔都要归当前这个 env */
  globalThis.fetch = env.fetch;
  env.markBoot();
  await import(BG + "?seq=" + ++importSeq);
}

/* E3：凡是"把一笔请求挂住、再叫停、然后等链路落定"的用例都要经过这里。
   上限是必需的：后台三个出口各带一笔 15 秒 AbortController 计时器，桩件句柄的 abort()
   不生效时计时器照样会在 15 秒后把请求推落定——用例于是"等得到结果"，只是每次慢 15 秒，
   红不出来（实跑对照 H5 就是这个形状：红 0 条、心跳 15.7 秒 / 外发 30.3 秒）。
   拒绝也算落定：这几条链路的外层 catch 会把失败吞成静默，判的是"有没有结束" */
export const settles = (p, ms = 500) =>
  Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);
