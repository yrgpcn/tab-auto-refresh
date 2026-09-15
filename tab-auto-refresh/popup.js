import { PREFIX, PRESETS, DEFAULT_SETTINGS } from "./shared/config.js";
import {
  DEFAULT_INTERVAL_SEC,
  RESTRICTED_URL,
  clampInterval,
  formatCountdown,
  formatInterval,
  getTaskKeywords,
  normalizeStoredSettings,
  normalizeWebhookUrl,
  notifyEventsOf,
  parseKeywords,
  wechatConfigState
} from "./shared/logic.js";

const $ = (id) => document.getElementById(id);

/* 微信配置项的 label 键：缺项提示要点名，不能只说"配置不完整" */
const WECHAT_FIELD_LABEL_KEYS = {
  appId: "wechatAppIdLabel",
  secret: "wechatSecretLabel",
  openId: "wechatOpenIdLabel",
  templateId: "wechatTplLabel"
};

let currentTab = null;
let tasks = {};
let settings = Object.assign({}, DEFAULT_SETTINGS);
let pausedAll = false;
let alarmsMap = {};
let msgTimer = null;
let renderSeq = 0;
/* 最近一次微信推送结果（后台写 storage.local），用于"静默失败也要看得见" */
let wechatLast = null;

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

function fmtClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function setMsg(text) {
  $("msg").textContent = text || "";
  if (msgTimer) clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { $("msg").textContent = ""; }, 4000);
}

function applyI18n() {
  document.title = msg("extName");
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = msg(el.dataset.i18nTitle);
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
    /* 兼容 1.1.0 及之前存在 local 里的设置 */
    data = await chrome.storage.local.get("settings");
  }
  const local = await chrome.storage.local.get(["tasks", "pausedAll", "wechatLastResult"]);
  tasks = local.tasks || {};
  const stored = data.settings || {};
  /* 与后台共用同一份兼容逻辑（shared/logic.js）：1.7.0 的 webhookEvents 勾选
     接续进 notifyEvents，返回值已不带旧键，写回存盘即完成迁移清理 */
  settings = normalizeStoredSettings(stored, DEFAULT_SETTINGS);
  pausedAll = !!local.pausedAll;
  wechatLast = local.wechatLastResult || null;
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
  $("restrictHint").hidden = !(currentTab && RESTRICTED_URL.test(currentTab.url || ""));

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
      } catch (e) { /* 标签页可能刚被关闭 */ }
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
  /* 休眠跳过是唯一不声不响的跳过，行内标出原因 */
  if (settings.skipDiscarded && tab && tab.discarded) {
    const dsp = document.createElement("span");
    dsp.className = "next";
    dsp.textContent = msg("discardedHint");
    sub.appendChild(dsp);
  }
  /* 自动暂停（错误页或验证墙）：行内标原因，并给一个恢复按钮 */
  if (task.autoPaused) {
    const ap = document.createElement("span");
    ap.className = "invalid";
    ap.textContent = msg(
      task.autoPaused.reason === "captcha" ? "pausedCaptchaChip" : "pausedErrorChip"
    );
    sub.appendChild(ap);
  }
  const kws = getTaskKeywords(task);
  if (kws.length) {
    const kw = document.createElement("span");
    kw.className = "next";
    kw.textContent =
      task.onHit === "continue"
        ? msg("keywordChipWatch", [kws.join(", ")])
        : msg("keywordChip", [kws.join(", ")]);
    sub.appendChild(kw);
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
  if (tab && task.autoPaused) {
    const resume = document.createElement("button");
    resume.className = "mini";
    resume.textContent = msg("actionResume");
    resume.addEventListener("click", async () => {
      await send({ type: "resume-task", tabId });
      await refreshState();
      renderAll();
    });
    actions.appendChild(resume);
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

/* 预设下拉和秒数框是同一个间隔的两个入口，必须互斥。
   原实现两边都没有 change/input 监听，先在秒数框填 90、再从下拉选每 5 分钟，
   就会按 90 跑：下拉显示 5 分钟、实际生效 90 秒，只有 4 秒后就消失的提示行里能看到真值。
   现在任何时刻只有一个入口持有值：
     选具体预设就清空秒数框；秒数框一有数字，下拉就切到"自定义"；
     秒数框被清空则回落到默认预设 */
function initPresetSelect() {
  const sel = $("presetSelect");
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = String(p.seconds);
    opt.textContent = msg(p.key);
    sel.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = msg("presetCustom");
  sel.appendChild(custom);

  const preferred = clampInterval(settings.lastIntervalSec).seconds;
  const preferredPreset = PRESETS.find((p) => p.seconds === preferred);
  if (preferredPreset) {
    sel.value = String(preferred);
    $("customInput").value = "";
  } else {
    sel.value = "";
    $("customInput").value = String(preferred);
  }
}

function bindIntervalInputs() {
  const sel = $("presetSelect");
  const box = $("customInput");
  sel.addEventListener("change", () => {
    if (sel.value !== "") {
      box.value = ""; /* 选了具体预设：以预设为准 */
      return;
    }
    /* 选"自定义"时预填当前生效值，免得出现"选了自定义却没填"的第三种状态，
       下面的读取逻辑也就只需要处理"框里有数"这一种情况 */
    if (box.value.trim() === "") box.value = String(clampInterval(settings.lastIntervalSec).seconds);
    box.focus();
  });
  box.addEventListener("input", () => {
    if (box.value.trim() !== "") {
      sel.value = ""; /* 框里有数字就以它为准，下拉显示"自定义" */
      return;
    }
    /* 框被清空就回落默认预设，不留"两个都说自己算数"的状态。
       sel.value 赋一个不存在的选项会变成空串，用这一点兜底 */
    sel.value = String(DEFAULT_INTERVAL_SEC);
    if (sel.value !== String(DEFAULT_INTERVAL_SEC)) sel.value = String(PRESETS[0].seconds);
  });
}

async function saveSettings() {
  await send({
    type: "save-settings",
    settings: {
      bypassCache: $("bypassCheck").checked,
      skipDiscarded: $("skipDiscardedCheck").checked,
      cookieBackup: $("cookieBackupCheck").checked,
      keepAlive: $("keepAliveCheck").checked,
      httpHeartbeat: $("httpHeartbeatCheck").checked,
      skipOnActivity: $("skipOnActivityCheck").checked,
      keepAwake: $("keepAwakeCheck").checked,
      captchaGuard: $("captchaGuardCheck").checked,
      webhookUrl: $("webhookUrlInput").value.trim(),
      /* 1.8.0 起键名 notifyEvents：webhook 与微信直连共用这一份事件清单 */
      notifyEvents: [
        $("webhookEvSession").checked && "session-lost",
        $("webhookEvKeyword").checked && "keyword",
        $("webhookEvStopped").checked && "task-stopped",
        $("webhookEvPaused").checked && "task-paused"
      ].filter(Boolean),
      wechatEnabled: $("wechatEnabledCheck").checked,
      wechatAppId: $("wechatAppIdInput").value.trim(),
      wechatAppSecret: $("wechatSecretInput").value.trim(),
      wechatOpenId: $("wechatOpenIdInput").value.trim(),
      wechatTemplateId: $("wechatTplInput").value.trim()
    }
  });
}

/* 后台对非法 webhook 地址是静默忽略的（normalizeWebhookUrl → "" → 直接 return），
   不在这里说一声，用户会以为"配好了、在发"。纯本地校验，不发任何网络请求。 */
function renderWebhookValidity() {
  const raw = $("webhookUrlInput").value.trim();
  $("webhookInvalid").hidden = !(raw && !normalizeWebhookUrl(raw));
}

/* 微信状态：优先报"配置不全"（用户能立刻修的本地问题），
   配置齐了才显示后台最近一次推送的结果。两处显示同一段文字：
   主视图那行是概览，配置视图里是详情。 */
function wechatStatus() {
  if (!$("wechatEnabledCheck").checked) return null;
  const state = wechatConfigState({
    wechatAppId: $("wechatAppIdInput").value,
    wechatAppSecret: $("wechatSecretInput").value,
    wechatOpenId: $("wechatOpenIdInput").value,
    wechatTemplateId: $("wechatTplInput").value
  });
  if (!state.ready) {
    const names = state.missing.map((k) => msg(WECHAT_FIELD_LABEL_KEYS[k])).join(msg("listSeparator"));
    return { text: msg("wechatMissing", [names]), cls: "error" };
  }
  if (!wechatLast) return { text: msg("wechatStateIdle"), cls: "" };
  if (wechatLast.ok) return { text: msg("wechatStateOk", [fmtClock(wechatLast.at)]), cls: "ok" };
  return { text: msg(wechatLast.errorKey || "wechatErrOther"), cls: "error" };
}

function renderWechat() {
  const on = $("wechatEnabledCheck").checked;
  $("wechatRow").hidden = !on;
  const st = wechatStatus();
  $("wechatState").textContent = st ? st.text : "";
  $("wechatState").className = "wx-state" + (st && st.cls ? " " + st.cls : "");
  $("wechatViewState").textContent = st ? st.text : "";
  $("wechatViewState").className = "hint" + (st && st.cls ? " " + st.cls : "");
  $("wechatViewState").hidden = !st;
}

async function init() {
  applyI18n();
  /* 后台异步清理失效任务，结果经 storage.onChanged 回填，不阻塞首屏渲染 */
  send({ type: "prune-now" });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  await refreshState();
  initPresetSelect();
  bindIntervalInputs();
  $("bypassCheck").checked = settings.bypassCache !== false;
  $("skipDiscardedCheck").checked = !!settings.skipDiscarded;
  $("cookieBackupCheck").checked = !!settings.cookieBackup;
  $("keepAliveCheck").checked = !!settings.keepAlive;
  $("httpHeartbeatCheck").checked = !!settings.httpHeartbeat;
  $("skipOnActivityCheck").checked = !!settings.skipOnActivity;
  $("keepAwakeCheck").checked = !!settings.keepAwake;
  $("captchaGuardCheck").checked = settings.captchaGuard !== false;
  $("webhookUrlInput").value = settings.webhookUrl || "";
  renderWebhookValidity();
  {
    const evs = notifyEventsOf(settings);
    $("webhookEvSession").checked = evs.includes("session-lost");
    $("webhookEvKeyword").checked = evs.includes("keyword");
    $("webhookEvStopped").checked = evs.includes("task-stopped");
    $("webhookEvPaused").checked = evs.includes("task-paused");
  }
  $("wechatEnabledCheck").checked = !!settings.wechatEnabled;
  $("wechatAppIdInput").value = settings.wechatAppId || "";
  $("wechatSecretInput").value = settings.wechatAppSecret || "";
  $("wechatOpenIdInput").value = settings.wechatOpenId || "";
  $("wechatTplInput").value = settings.wechatTemplateId || "";
  renderWechat();
  await renderAll();

  $("toggleBtn").addEventListener("click", async () => {
    if (!currentTab) return;
    if (tasks[currentTab.id]) {
      await send({ type: "stop", tabId: currentTab.id });
      setMsg(msg("msgStopped"));
    } else {
      /* 自定义优先：下拉停在"自定义"（value 为空）或框里有数，都以框为准。
         两者已经被 bindIntervalInputs 做成互斥显示，"下拉显示某个预设、实际按框里的值跑"
         这种不一致不会再出现 */
      const presetVal = $("presetSelect").value;
      const custom = parseInt($("customInput").value, 10);
      let seconds;
      let clamped = false;
      if (presetVal === "" || custom > 0) {
        const c = clampInterval(custom);
        seconds = c.seconds;
        clamped = c.clamped;
      } else {
        seconds = parseInt(presetVal, 10);
      }
      /* parseKeywords 与后台同一实现：解析 + 去重 + 限条数，保证存储里落的形状一致 */
      const keyword = parseKeywords($("keywordInput").value).join(",");
      const keepWatching = $("keepWatchingCheck").checked;
      const res = await send({ type: "start", tabId: currentTab.id, seconds, keyword, keepWatching });
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
  $("cookieBackupCheck").addEventListener("change", saveSettings);
  $("keepAliveCheck").addEventListener("change", saveSettings);
  $("httpHeartbeatCheck").addEventListener("change", saveSettings);
  $("skipOnActivityCheck").addEventListener("change", saveSettings);
  $("keepAwakeCheck").addEventListener("change", saveSettings);
  $("captchaGuardCheck").addEventListener("change", saveSettings);
  $("webhookUrlInput").addEventListener("change", () => {
    renderWebhookValidity();
    saveSettings();
  });
  $("webhookEvSession").addEventListener("change", saveSettings);
  $("webhookEvKeyword").addEventListener("change", saveSettings);
  $("webhookEvStopped").addEventListener("change", saveSettings);
  $("webhookEvPaused").addEventListener("change", saveSettings);

  /* 微信直连：开关即时保存并刷新状态行；凭据在二级视图里填，change（失焦/回车）才写盘 */
  $("wechatEnabledCheck").addEventListener("change", () => {
    renderWechat();
    saveSettings();
  });
  for (const id of ["wechatAppIdInput", "wechatSecretInput", "wechatOpenIdInput", "wechatTplInput"]) {
    $(id).addEventListener("change", () => {
      renderWechat();
      saveSettings();
    });
  }
  $("wechatSetupBtn").addEventListener("click", () => {
    document.body.classList.add("wx-mode");
    $("wechatAppIdInput").focus();
  });
  $("wechatBackBtn").addEventListener("click", () => {
    document.body.classList.remove("wx-mode");
  });
  /* 测试消息：填完凭据立刻能验证，不用等某个事件真的发生。
     结果经后台写 storage → onChanged 回流，这里同时也用返回值即时刷新一次 */
  $("wechatTestBtn").addEventListener("click", async () => {
    const btn = $("wechatTestBtn");
    btn.disabled = true;
    btn.textContent = msg("wechatTestSending");
    /* 先保存再测试：凭据输入框是失焦（change）保存的，点这个按钮必然先让输入框失焦，
       所以弹窗会先发 save-settings。两条消息在后台各自独立执行，而 save-settings 自己
       也要先 await 一次 getSettings() 才能写盘，于是 wechat-test 的 getSettings() 排在
       它前面落地、读到旧值：刚填完凭据点测试，得到的是"还缺 appID、密钥、openid、模板ID"，
       而实际发出去的微信请求数是 0。必须在这里 await，把保存和测试串成一条链 */
    await saveSettings();
    const res = await send({ type: "wechat-test" });
    btn.disabled = false;
    btn.textContent = msg("wechatTestBtn");
    if (res && res.result) {
      wechatLast = res.result;
      renderWechat();
    }
  });

  $("pauseAllBtn").addEventListener("click", async () => {
    await send({ type: "toggle-pause-all" });
    await refreshState();
    await renderAll();
  });

  /* alarm 周期触发会更新 scheduledTime 但不触发 storage.onChanged，
     每秒同步一次才能让倒计时在归零后继续滚动 */
  setInterval(async () => {
    await syncAlarms();
    renderCountdowns();
  }, 1000);

  /* 只在任务 / 暂停 / 设置变化时重绘；cookie 备份等高频键的写入不触发全量刷新 */
  chrome.storage.onChanged.addListener(async (changes) => {
    /* 推送结果也要跟着刷新，否则弹窗开着时状态永远停在打开那一刻 */
    if (changes.wechatLastResult) {
      wechatLast = changes.wechatLastResult.newValue || null;
      renderWechat();
    }
    if (!changes.tasks && !changes.pausedAll && !changes.settings) return;
    await refreshState();
    await renderAll();
  });
}

document.addEventListener("DOMContentLoaded", init);
