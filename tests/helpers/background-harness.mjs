/* 驱动真实 background.js 的 chrome 桩件，供 tests/ 下各门禁共用。
   为什么要共用：background.js 在模块顶层注册监听器，每新增一个 chrome.*.addListener
   就会让每一份手写桩件在 import 那一步直接抛错（先踩过一次：加了 notifications.onClicked
   之后 5 条无关用例全红）。桩件分散重写等于把这类失败变成"改一处、修三份"。

   用法：
     const env = makeEnv();                    // 需要初始状态就写 env.store / env.putTab()
     await bootBackground(env);                // 每个用例一套新桩件 + 新实例，别复用 env
     await env.send({ type: "..." });          // 走真实 onMessage 入口
     env.fire.onChanged(changes, "sync");      // 手工喂存储变更事件
   env.chrome 可以被测试直接改（例如把 storage.sync.get 换成可控放行的挂起读）。
   桩件的 storage.set 不做 onChanged 回流：真实 Chrome 是异步回流的，
   "写完立刻读"和"外部改动回流后再读"两条路要各自单独测，不能互相顶包。 */

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
    notifCreated: [],
    notifCleared: [],
    tabsActivated: [],
    windowsFocused: [],
    alarmsCreated: [],
    badge: [],
    executeScript: 0,
    reloaded: [],
    navigated: [],
    messagesSent: []
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
    winFocused: []
  };
  const tabs = new Map();
  const alarms = new Map();
  /* 焦点窗口：null 表示没有窗口有焦点（用户在别的应用里），与 Chrome 的
     WINDOW_ID_NONE 同义。isTabOnScreen 走 getLastFocused 时会读到它 */
  let focusedWindow = null;

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

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
      Object.assign(store[name], clone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[name][k];
    },
    async clear() {
      store[name] = {};
    }
  });

  const noop = async () => {};
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
        alarms.set(name, info);
        calls.alarmsCreated.push([name, info]);
      },
      async clear(name) {
        alarms.delete(name);
      },
      getAll: async () =>
        [...alarms.entries()].map(([name, info]) => Object.assign({ name }, clone(info))),
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
      async query() {
        return [...tabs.values()].map(clone);
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
        return { id };
      },
      async getLastFocused() {
        if (focusedWindow === null) throw new Error("No current window");
        return { id: focusedWindow };
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
      removeAll: (cb) => cb && cb(),
      create: noop,
      /* 菜单点击在测试里没人派发，登记表留空但要能挂得上 */
      onClicked: eventSink([])
    },
    commands: { onCommand: eventSink(listeners.command) },
    scripting: {
      async executeScript(opts) {
        calls.executeScript++;
        return opts && opts.__fixture ? opts.__fixture : [{ result: false }];
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
      async getAll() {
        return [];
      },
      async set() {
        return {};
      }
    },
    power: { requestKeepAwake: noop, releaseKeepAwake: noop },
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
    /* 改焦点窗口并通知监听器；null = 没有窗口有焦点 */
    focusWindow(id) {
      focusedWindow = id;
      for (const f of listeners.winFocused) f(id === null ? -2 : id);
    },
    send(msg, sender) {
      return new Promise((resolve) => {
        dispatch("message").at(-1)(msg, sender || {}, resolve);
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
      async tabRemoved(tabId, isWindowClosing) {
        for (const f of dispatch("removed")) await f(tabId, { isWindowClosing: !!isWindowClosing });
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
  env.markBoot();
  await import(BG + "?seq=" + ++importSeq);
}
