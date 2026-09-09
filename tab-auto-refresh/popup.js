import { PREFIX, PRESETS } from "./shared/config.js";
import {
  DEFAULT_INTERVAL_SEC,
  clampInterval,
  formatCountdown,
  formatInterval
} from "./shared/logic.js";

const $ = (id) => document.getElementById(id);

const RESTRICTED = /^(chrome|edge|devtools|about|chrome-extension|moz-extension):/i;

let currentTab = null;
let tasks = {};
let settings = { bypassCache: true, skipDiscarded: false };
let pausedAll = false;
let alarmsMap = {};
let msgTimer = null;
let renderSeq = 0;

function msg(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

function fmtInterval(sec) {
  return formatInterval(sec, {
    hours: msg("unitHours"),
    minutes: msg("unitMinutes"),
    seconds: msg("unitSeconds")
  });
}

function setMsg(text) {
  $("msg").textContent = text || "";
  if (msgTimer) clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { $("msg").textContent = ""; }, 4000);
}

function applyI18n() {
  document.title = msg("extName");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  }
}

async function syncAlarms() {
  const list = await chrome.alarms.getAll();
  alarmsMap = {};
  for (const a of list) {
    if (a.name.startsWith(PREFIX)) {
      alarmsMap[a.name.slice(PREFIX.length)] = a;
    }
  }
}

async function refreshState() {
  let data = await chrome.storage.sync.get("settings");
  if (!data.settings) {
    /* 鍏煎 1.1.0 鍙婁箣鍓嶅瓨鍦?local 閲岀殑璁剧疆 */
    data = await chrome.storage.local.get("settings");
  }
  const local = await chrome.storage.local.get(["tasks", "pausedAll"]);
  tasks = local.tasks || {};
  settings = Object.assign(
    { bypassCache: true, skipDiscarded: false, lastIntervalSec: DEFAULT_INTERVAL_SEC },
    data.settings || {}
  );
  pausedAll = !!local.pausedAll;
  await syncAlarms();
}

function renderPauseAll() {
  const btn = $("pauseAllBtn");
  btn.textContent = pausedAll ? msg("resumeAll") : msg("pauseAll");
  btn.classList.toggle("active", pausedAll);
}

function renderCurrentTab() {
  const favicon = $("tabFavicon");
  if (currentTab && currentTab.favIconUrl) {
    favicon.src = currentTab.favIconUrl;
    favicon.hidden = false;
  } else {
    favicon.removeAttribute("src");
    favicon.hidden = true;
  }
  $("tabTitle").textContent = currentTab ? currentTab.title || msg("untitledTab") : "";
  $("tabUrl").textContent = currentTab && currentTab.url ? currentTab.url : "";
  $("restrictHint").hidden = !(currentTab && RESTRICTED.test(currentTab.url || ""));

  const running = !!(currentTab && tasks[currentTab.id]);
  const btn = $("toggleBtn");
  btn.textContent = running ? msg("btnStop") : msg("btnStart");
  btn.classList.toggle("stop", running);
  const count = Object.keys(tasks).length;
  $("globalStatus").textContent = pausedAll
    ? msg("statusPaused")
    : count > 0 ? msg("statusTabs", [String(count)]) : "";
  renderPauseAll();
}

function buildTaskItem(tabId, task, tab) {
  const li = document.createElement("li");

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const title = document.createElement("div");
  title.className = "task-title";
  if (tab) {
    title.textContent = tab.title || tab.url || msg("taskTitleFallback", [String(tabId)]);
    title.title = tab.url || "";
    title.addEventListener("click", async () => {
      try {
        await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
        window.close();
      } catch (e) { /* 鏍囩椤靛彲鑳藉垰琚叧闂?*/ }
    });
  } else {
    const invalid = document.createElement("span");
    invalid.className = "invalid";
    invalid.textContent = msg("taskInvalid");
    title.appendChild(invalid);
  }
  meta.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "task-sub";
  const base = msg("perInterval", [fmtInterval(task.intervalSec)]);
  const alarm = alarmsMap[String(tabId)];
  if (tab && alarm && alarm.scheduledTime) {
    sub.textContent = base;
    const next = document.createElement("span");
    next.className = "next";
    next.dataset.tab = String(tabId);
    sub.appendChild(next);
  } else {
    sub.textContent = base;
  }
  meta.appendChild(sub);
  li.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "task-actions";
  if (tab) {
    const now = document.createElement("button");
    now.className = "mini";
    now.textContent = msg("actionNow");
    now.addEventListener("click", async () => {
      const res = await send({ type: "reload-now", tabId });
      if (!res.ok) setMsg(msg("errRefresh", [res.error || msg("errUnknown")]));
    });
    actions.appendChild(now);
  }
  const cancel = document.createElement("button");
  cancel.className = "mini danger";
  cancel.textContent = msg("actionCancel");
  cancel.addEventListener("click", async () => {
    await send({ type: "stop", tabId });
    await refreshState();
    renderAll();
  });
  actions.appendChild(cancel);
  li.appendChild(actions);

  return li;
}

async function renderTasks() {
  const seq = ++renderSeq;
  const ul = $("taskList");
  ul.textContent = "";
  const ids = Object.keys(tasks).map(Number).sort((a, b) => tasks[a].createdAt - tasks[b].createdAt);
  $("taskCount").textContent = ids.length > 0 ? msg("taskCountUnit", [String(ids.length)]) : "";
  $("emptyHint").hidden = ids.length > 0;

  const tabResults = await Promise.all(ids.map((tabId) => chrome.tabs.get(tabId).catch(() => null)));
  /* 并发渲染时只保留最新一次，避免列表重复追加 */
  if (seq !== renderSeq) return;
  ids.forEach((tabId, index) => {
    ul.appendChild(buildTaskItem(tabId, tasks[tabId], tabResults[index]));
  });
}

function renderCountdowns() {
  const nodes = document.querySelectorAll(".next[data-tab]");
  for (const node of nodes) {
    if (pausedAll) {
      node.textContent = msg("pausedHint");
      continue;
    }
    const alarm = alarmsMap[node.dataset.tab];
    if (alarm && alarm.scheduledTime) {
      node.textContent = msg("nextIn", [formatCountdown(alarm.scheduledTime - Date.now())]);
    }
  }
}

async function renderAll() {
  renderCurrentTab();
  await renderTasks();
  renderCountdowns();
}

function initPresetSelect() {
  const sel = $("presetSelect");
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = String(p.seconds);
    opt.textContent = msg(p.key);
    sel.appendChild(opt);
  }
  const preferred = clampInterval(settings.lastIntervalSec).seconds;
  const preferredPreset = PRESETS.find((p) => p.seconds === preferred);
  if (preferredPreset) {
    sel.value = String(preferred);
    $("customInput").value = "";
  } else {
    sel.value = String(DEFAULT_INTERVAL_SEC);
    $("customInput").value = String(preferred);
  }
}

async function saveSettings() {
  await send({
    type: "save-settings",
    settings: {
      bypassCache: $("bypassCheck").checked,
      skipDiscarded: $("skipDiscardedCheck").checked
    }
  });
}

async function init() {
  applyI18n();
  /* 后台异步清理失效任务，结果经 storage.onChanged 回填，不阻塞首屏渲染 */
  send({ type: "prune-now" });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  await refreshState();
  initPresetSelect();
  $("bypassCheck").checked = settings.bypassCache !== false;
  $("skipDiscardedCheck").checked = !!settings.skipDiscarded;
  await renderAll();

  $("toggleBtn").addEventListener("click", async () => {
    if (!currentTab) return;
    if (tasks[currentTab.id]) {
      await send({ type: "stop", tabId: currentTab.id });
      setMsg(msg("msgStopped"));
    } else {
      const custom = parseInt($("customInput").value, 10);
      let seconds;
      let clamped = false;
      if (custom > 0) {
        const c = clampInterval(custom);
        seconds = c.seconds;
        clamped = c.clamped;
      } else {
        seconds = parseInt($("presetSelect").value, 10);
      }
      const res = await send({ type: "start", tabId: currentTab.id, seconds });
      if (!res.ok) {
        setMsg(msg("errStart", [res.error || msg("errUnknown")]));
      } else if (clamped) {
        setMsg(msg("msgClamped"));
      } else {
        setMsg(msg("msgSet", [fmtInterval(res.intervalSec)]));
      }
    }
    await refreshState();
    await renderAll();
  });

  $("bypassCheck").addEventListener("change", saveSettings);
  $("skipDiscardedCheck").addEventListener("change", saveSettings);

  $("pauseAllBtn").addEventListener("click", async () => {
    await send({ type: "toggle-pause-all" });
    await refreshState();
    await renderAll();
  });

  /* alarm 鍛ㄦ湡瑙﹀彂浼氭洿鏂?scheduledTime 浣嗕笉瑙﹀彂 storage.onChanged锛?
     姣忕鍚屾涓€娆℃墠鑳借鍊掕鏃跺湪褰掗浂鍚庣户缁粴鍔?*/
  setInterval(async () => {
    await syncAlarms();
    renderCountdowns();
  }, 1000);

  chrome.storage.onChanged.addListener(async () => {
    await refreshState();
    await renderAll();
  });
}

document.addEventListener("DOMContentLoaded", init);
