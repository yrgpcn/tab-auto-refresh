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
    idle: []
  };
  const tabs = new Map();
  const alarms = new Map();

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
  const chrome = {
    storage: {
      local: area("local"),
      sync: area("sync"),
      session: area("session"),
      onChanged: { addListener: (f) => listeners.changed.push(f) }
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
      onAlarm: { addListener: (f) => listeners.alarm.push(f) }
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
      onUpdated: { addListener: (f) => listeners.updated.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) }
    },
    windows: {
      async update(id, props) {
        if (props && props.focused) calls.windowsFocused.push(Number(id));
        return { id };
      }
    },
    idle: { onStateChanged: { addListener: (f) => listeners.idle.push(f) } },
    runtime: {
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) },
      lastError: null
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: noop,
      onClicked: { addListener: noop }
    },
    commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
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
      onClicked: { addListener: (f) => listeners.notifClicked.push(f) }
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
    /* 放一个标签页进登记表：windowId 可选，缺省 1，点击跳转要用它 */
    putTab(id, url, extra) {
      tabs.set(Number(id), Object.assign({ id: Number(id), url, windowId: 1, active: false }, extra));
      return tabs.get(Number(id));
    },
    dropTab(id) {
      tabs.delete(Number(id));
    },
    send(msg, sender) {
      return new Promise((resolve) => {
        listeners.message.at(-1)(msg, sender || {}, resolve);
      });
    },
    fire: {
      async onChanged(changes, areaName) {
        await listeners.changed.at(-1)(changes, areaName);
      },
      async notifClicked(id) {
        await listeners.notifClicked.at(-1)(id);
      },
      async tabUpdated(tabId, changeInfo, tab) {
        await listeners.updated.at(-1)(tabId, changeInfo, tab || tabs.get(Number(tabId)));
      },
      async alarm(name) {
        await listeners.alarm.at(-1)({ name });
      },
      async tabRemoved(tabId, isWindowClosing) {
        await listeners.removed.at(-1)(tabId, { isWindowClosing: !!isWindowClosing });
      }
    }
  };
  return env;
}

/* 加查询串强制每次 import 都新实例化一个模块（等价于 service worker 回收后重启）。
   共享的 shared/config.js 与 shared/logic.js 不随查询串重建，那里全是常量与纯函数 */
export async function bootBackground(env) {
  globalThis.chrome = env.chrome;
  await import(BG + "?seq=" + ++importSeq);
}
