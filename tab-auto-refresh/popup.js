"use strict";

const $ = (id) => document.getElementById(id);

const PREFIX = "refresh-";
const PRESETS = [
  { label: "每 30 秒", seconds: 30 },
  { label: "每 1 分钟", seconds: 60 },
  { label: "每 2 分钟", seconds: 120 },
  { label: "每 5 分钟", seconds: 300 },
  { label: "每 10 分钟", seconds: 600 },
  { label: "每 30 分钟", seconds: 1800 },
  { label: "每 1 小时", seconds: 3600 }
];
const RESTRICTED = /^(chrome|edge|devtools|about|chrome-extension|moz-extension):/i;

let currentTab = null;
let tasks = {};
let settings = { bypassCache: true };
let alarmsMap = {};
let msgTimer = null;

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
  if (sec % 3600 === 0) return sec / 3600 + " 小时";
  if (sec % 60 === 0) return sec / 60 + " 分钟";
  return sec + " 秒";
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

function setMsg(text) {
  $("msg").textContent = text || "";
  if (msgTimer) clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { $("msg").textContent = ""; }, 4000);
}

async function refreshState() {
  const t = await chrome.storage.local.get(["tasks", "settings"]);
  tasks = t.tasks || {};
  settings = Object.assign({ bypassCache: true }, t.settings || {});
  alarmsMap = {};
  const list = await chrome.alarms.getAll();
  for (const a of list) {
    if (a.name.startsWith(PREFIX)) {
      alarmsMap[a.name.slice(PREFIX.length)] = a;
    }
  }
}

function renderCurrentTab() {
  $("tabTitle").textContent = currentTab ? currentTab.title || "（无标题）" : "";
  $("tabUrl").textContent = currentTab && currentTab.url ? currentTab.url : "";
  $("tabFavicon").src = (currentTab && currentTab.favIconUrl) || "";
  $("restrictHint").hidden = !(currentTab && RESTRICTED.test(currentTab.url || ""));

  const running = !!(currentTab && tasks[currentTab.id]);
  const btn = $("toggleBtn");
  btn.textContent = running ? "停止定时刷新" : "开始定时刷新当前标签页";
  btn.classList.toggle("stop", running);
  $("globalStatus").textContent =
    Object.keys(tasks).length > 0 ? Object.keys(tasks).length + " 个标签页监控中" : "";
}

function buildTaskItem(tabId, task, tab) {
  const li = document.createElement("li");

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const title = document.createElement("div");
  title.className = "task-title";
  if (tab) {
    title.textContent = tab.title || tab.url || "标签页 " + tabId;
    title.title = tab.url || "";
    title.addEventListener("click", async () => {
      try {
        await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
        window.close();
      } catch (e) { /* 标签页可能刚被关闭 */ }
    });
  } else {
    title.innerHTML = '<span class="invalid">标签页已失效</span>';
  }
  meta.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "task-sub";
  const base = "每 " + fmtInterval(task.intervalSec);
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
    now.textContent = "立即刷新";
    now.addEventListener("click", async () => {
      const res = await send({ type: "reload-now", tabId });
      if (!res.ok) setMsg("刷新失败：" + (res.error || "未知错误"));
    });
    actions.appendChild(now);
  }
  const cancel = document.createElement("button");
  cancel.className = "mini danger";
  cancel.textContent = "取消";
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
  const ul = $("taskList");
  ul.textContent = "";
  const ids = Object.keys(tasks).map(Number).sort((a, b) => tasks[a].createdAt - tasks[b].createdAt);
  $("taskCount").textContent = ids.length > 0 ? String(ids.length) + " 项" : "";
  $("emptyHint").hidden = ids.length > 0;

  for (const tabId of ids) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    ul.appendChild(buildTaskItem(tabId, tasks[tabId], tab));
  }
}

function renderCountdowns() {
  const nodes = document.querySelectorAll(".next[data-tab]");
  for (const node of nodes) {
    const alarm = alarmsMap[node.dataset.tab];
    if (alarm && alarm.scheduledTime) {
      node.textContent = " · 下次刷新 " + fmtCountdown(alarm.scheduledTime - Date.now()) + " 后";
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
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  sel.value = "300"; /* 默认 5 分钟 */
}

async function saveSettings() {
  await send({ type: "save-settings", settings: { bypassCache: $("bypassCheck").checked } });
}

async function init() {
  initPresetSelect();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  await refreshState();
  $("bypassCheck").checked = settings.bypassCache !== false;
  await renderAll();

  $("toggleBtn").addEventListener("click", async () => {
    if (!currentTab) return;
    if (tasks[currentTab.id]) {
      await send({ type: "stop", tabId: currentTab.id });
      setMsg("已停止该标签页的定时刷新");
    } else {
      const custom = parseInt($("customInput").value, 10);
      const seconds = custom > 0 ? Math.max(custom, 30) : parseInt($("presetSelect").value, 10);
      const res = await send({ type: "start", tabId: currentTab.id, seconds });
      if (!res.ok) {
        setMsg("启动失败：" + (res.error || "未知错误"));
      } else {
        setMsg("已设置每 " + fmtInterval(res.intervalSec) + " 自动刷新一次");
      }
    }
    await refreshState();
    await renderAll();
  });

  $("bypassCheck").addEventListener("change", saveSettings);

  setInterval(renderCountdowns, 1000);

  chrome.storage.onChanged.addListener(async () => {
    await refreshState();
    await renderAll();
  });
}

document.addEventListener("DOMContentLoaded", init);
