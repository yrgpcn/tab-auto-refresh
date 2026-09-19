import { PREFIX, PRESETS, DEFAULT_SETTINGS, SKIP_RT_PREFIX } from "./shared/config.js";
import {
  ALARM_SKIP_REASONS,
  ALARM_SKIP_UNKNOWN_KEY,
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

/* 走 settings 的文本框。绑事件时一视同仁：一边打一边重算状态行，写盘延后一拍（见 scheduleSave）。
   凭据四项 + webhook 地址，全是"填完不点别处就可能直接关窗"的那种输入 */
const TEXT_SETTING_INPUT_IDS = [
  "webhookUrlInput",
  "wechatAppIdInput",
  "wechatSecretInput",
  "wechatOpenIdInput",
  "wechatTplInput"
];

let currentTab = null;
let tasks = {};
let settings = Object.assign({}, DEFAULT_SETTINGS);
let pausedAll = false;
let alarmsMap = {};
let msgTimer = null;
let renderSeq = 0;
/* 最近一次微信推送结果（后台写 storage.local），用于"静默失败也要看得见" */
let wechatLast = null;
/* 同一个理由的第三份：webhook 原先连状态码都不看，投递失败在这台机器上不留任何痕迹 */
let webhookLast = null;
/* tabId（字符串）→ {reason, at}：上一拍到点被跳过的理由，后台 onAlarm 写进会话态。
   没有痕迹就一句都不显示，所以"正常刷新"与"从没到过点"这两种情况长得一样，
   那是刻意的：只有真跳过才需要解释 */
let skipMap = {};

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
  await syncSkipTraces();
}

/* 跳过痕迹只按在场任务读，所以后台漏清一个键也不会显示出来。跟着 alarm 列表每秒重拉：
   alarm 周期触发不触发 storage.onChanged（上面那段同步 alarm 的注释是同一条理由），
   只在打开时读一遍的话，弹窗开着的时候这一行永远停在打开那一刻 */
async function syncSkipTraces() {
  const ids = Object.keys(tasks);
  skipMap = {};
  if (!ids.length) return;
  const data = await chrome.storage.session.get(ids.map((id) => SKIP_RT_PREFIX + ":" + id));
  for (const id of ids) {
    const e = data[SKIP_RT_PREFIX + ":" + id];
    /* 形状不认就当没有：会话态里可能是上一版留下的别的形状，读侧宁可少一行解释 */
    if (e && typeof e.at === "number" && typeof e.reason === "string") skipMap[id] = e;
  }
}

/* 任务行那句解释。理由表住在 shared/logic.js（与 decideAlarmAction 挨着），
   认不出的理由走兜底键——给用户看 "skipReasonFoo" 等于把内部枚举名当文案 */
function skipChipText(tabId) {
  const e = skipEntry(tabId);
  if (!e) return "";
  return msg("skipChip", [skipChipReason(e.reason)]);
}

/* 时刻只放在悬停提示里：可见版面已经有一条倒计时和两枚 chip，400px 宽放不下第三个字段 */
function skipChipTitle(tabId) {
  const e = skipEntry(tabId);
  if (!e) return "";
  return msg("skipChipTitle", [skipChipReason(e.reason), fmtClock(e.at)]);
}

/* 痕迹在，但这两种情况下同一行已经自己说清楚了，重复一遍反而像显示坏了：全局暂停时
   倒计时那个位置就写着"已暂停"，自动暂停时有红字 chip 加橙色角标。
   只查模块级状态，因为 renderCountdowns 每秒跑一次、手上没有标签页对象。
   文字与悬停提示都走这里，两者不可能一个显一个不显 */
function skipEntry(tabId) {
  const e = skipMap[tabId];
  if (!e || pausedAll) return null;
  const task = tasks[tabId];
  if (task && task.autoPaused) return null;
  return e;
}

function skipChipReason(reason) {
  return msg(ALARM_SKIP_REASONS[reason] || ALARM_SKIP_UNKNOWN_KEY);
}

async function refreshState() {
  let data = await chrome.storage.sync.get("settings");
  if (!data.settings) {
    /* 兼容 1.1.0 及之前存在 local 里的设置 */
    data = await chrome.storage.local.get("settings");
  }
  const local = await chrome.storage.local.get([
    "tasks",
    "pausedAll",
    "wechatLastResult",
    "webhookLastResult"
  ]);
  tasks = local.tasks || {};
  const stored = data.settings || {};
  /* 与后台共用同一份兼容逻辑（shared/logic.js）：1.7.0 的 webhookEvents 勾选
     接续进 notifyEvents，返回值已不带旧键，写回存盘即完成迁移清理 */
  settings = normalizeStoredSettings(stored, DEFAULT_SETTINGS);
  pausedAll = !!local.pausedAll;
  wechatLast = local.wechatLastResult || null;
  webhookLast = local.webhookLastResult || null;
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
  /* 上一拍到点被跳过的解释（A12）。节点常驻、文字与显隐按秒填，所以后台新写一条
     不必重开弹窗就能看见；空字符串的 inline 节点照样留出前后分隔，故一并管 hidden */
  const skip = document.createElement("span");
  skip.className = "skip";
  skip.dataset.tab = String(tabId);
  sub.appendChild(skip);
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
  /* 跳过解释跟着倒计时一起重算：后台新写一条痕迹不该要用户重开弹窗才看得见。
     chip 节点常驻，所以空文字时必须连 hidden 一起管，否则留一个空 span 白占宽度 */
  for (const node of document.querySelectorAll(".skip[data-tab]")) {
    const text = skipChipText(node.dataset.tab);
    node.textContent = text;
    node.hidden = !text;
    node.title = skipChipTitle(node.dataset.tab);
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

/* 当前标签页已有任务时，把任务级字段回填进输入控件。
   不回填的后果不是"少显示一行"，而是数据丢失：想改关键词只能停掉再重开，
   而重开那次读的是空框，原来那条监控就此静默消失。
   只在 init 里做一次——currentTab 是 init 里 query 出来的，弹窗活着期间不会变，
   而 storage.onChanged 会反复回流，挂在回流链上等于随时抹掉用户正在输入的字。
   设置那半边（populateSettingsFields）从 A18 起确实挂在回流链上，靠的是"焦点 + 待写盘"
   两条判据挡住抹输入；这里没有等价判据可用，而 currentTab 不会变，所以仍只跑一次，
   别顺手把它也挂上去。
   间隔的两个入口（预设下拉 / 秒数框）已由 bindIntervalInputs 做成互斥，
   这里按同一套约定写：命中预设就选它并清空框，否则下拉走"自定义"、框里放实际值 */
function populateTaskFields() {
  const task = currentTab && tasks[currentTab.id];
  if (!task) return;
  $("keywordInput").value = getTaskKeywords(task).join(",");
  $("keepWatchingCheck").checked = task.onHit === "continue";
  const sel = $("presetSelect");
  const box = $("customInput");
  const sec = clampInterval(task.intervalSec).seconds;
  const preset = PRESETS.find((p) => p.seconds === sec);
  if (preset) {
    sel.value = String(preset.seconds);
    box.value = "";
  } else {
    sel.value = "";
    box.value = String(sec);
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

/* 文本框的保存时机（A11）。原先只绑 change，而弹窗一失去焦点就整体销毁：
   打完字不按 Tab、不点别处、直接点弹窗外，这一笔输入连一次保存都没发生过。
   也不能改成逐字符立即写：一笔 sync.set 会回流成 storage.onChanged，弹窗于是每敲一个字
   就重读一遍存储、整体重绘一次，后台那份 settings 快照也跟着每次失效；
   而 chrome.storage.sync 这一族本来就带每分钟写次数上限，抛出来的错在弹窗里没人看得见。所以：
     input  → 把写盘往后推一拍（每敲一个字重新计时），状态行同步重算
     change → 立刻写（回车与失焦都是"这个字段填完了"的明确信号）
     两个「发送测试」→ 先写再测，见那两处
     关窗   → 还有没落盘的输入就补一次
   最后那条只是补救：文档正在销毁，这一笔 sendMessage 不保证来得及。
   "打完字 0.5 秒内点弹窗外"仍只能真机验，记在 BACKLOG.md V1 (e) */
const SAVE_DEBOUNCE_MS = 500;
let saveTimer = null;

function cancelScheduledSave() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

function scheduleSave() {
  cancelScheduledSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSettings();
  }, SAVE_DEBOUNCE_MS);
}

/* 测试按钮用：先落盘再发测试，所以不论有没有待写的输入都要写这一次。
   顺手把计时器摘掉，免得它稍后再写一笔一样的 */
async function saveNow() {
  cancelScheduledSave();
  await saveSettings();
}

/* 关窗用：没有待写的输入就一笔都不写，免得每次点开点外都白写一次 sync */
async function flushPendingSave() {
  if (saveTimer === null) return;
  await saveNow();
}

/* webhook 状态行，三件事按"用户当场能修的优先"排：
   地址非法 > 还没发过 > 最近一次投递的成败。
   后台对非法地址是静默忽略的（normalizeWebhookUrl → "" → 直接 return，那属于配置态而不是
   投递失败，不留痕），所以这一半只能在这儿判；投递结果那一半来自后台写的 webhookLastResult。
   地址非法时连测试按钮一起藏掉：往坏地址上点"测试"不会有任何结果，那是摆一个假按钮。
   刻意写成单个自包含函数：弹窗门禁按花括号切源码跑，拆成两个函数就要多注入一个名字 */
function renderWebhook() {
  const raw = $("webhookUrlInput").value.trim();
  const broken = !!raw && !normalizeWebhookUrl(raw);
  let st = null;
  if (raw) {
    if (broken) st = { text: msg("webhookInvalid"), cls: "error" };
    else if (!webhookLast) st = { text: msg("webhookStateIdle"), cls: "" };
    else if (webhookLast.ok) {
      st = { text: msg("webhookStateOk", [fmtClock(webhookLast.at)]), cls: "ok" };
    } else st = { text: msg(webhookLast.errorKey || "webhookErrOther"), cls: "error" };
  }
  $("webhookRow").hidden = !st;
  $("webhookTestBtn").hidden = !st || broken;
  $("webhookState").textContent = st ? st.text : "";
  $("webhookState").className = "wx-state" + (st && st.cls ? " " + st.cls : "");
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

/* 把 settings 铺回控件。init 里跑一次，另一台设备的改动经 storage.onChanged 回流时再跑一次
   （A18）。不跑的后果不是"少刷一行显示"：saveSettings 读的就是这 15 个控件，于是这台机器上
   那个"看着还开着"的旧值会被整份写回去，把另一台设备刚关掉的开关静默翻回来——弹窗开着多久，
   另一台设备的改动就被撤销多久。
   两条约束：
   ① 五个走 settings 的文本框在获得焦点、或有去抖写盘还挂在路上时一律跳过，
      而且整组一起跳、不逐框判断：凭据四项是一把钥匙的四段，按新值填三段留一段正在打的
      会拼出一个两边都不认识的组合，而它马上被去抖那一笔写进存储。
      A11 的 input 去抖是为了不抹输入，这一条是为了不被别人的值抹输入，两者必须是同一个判据。
   ② 复选框没有"正在输入"这种中间态（change 即时写盘），照常同步。
   刻意写成单个自包含函数：弹窗门禁按花括号切真实源码跑 */
function populateSettingsFields() {
  const editing =
    saveTimer !== null || TEXT_SETTING_INPUT_IDS.some((id) => $(id) === document.activeElement);
  const evs = notifyEventsOf(settings);
  $("bypassCheck").checked = settings.bypassCache !== false;
  $("skipDiscardedCheck").checked = !!settings.skipDiscarded;
  $("cookieBackupCheck").checked = !!settings.cookieBackup;
  $("keepAliveCheck").checked = !!settings.keepAlive;
  $("httpHeartbeatCheck").checked = !!settings.httpHeartbeat;
  $("skipOnActivityCheck").checked = !!settings.skipOnActivity;
  $("keepAwakeCheck").checked = !!settings.keepAwake;
  $("captchaGuardCheck").checked = settings.captchaGuard !== false;
  $("webhookEvSession").checked = evs.includes("session-lost");
  $("webhookEvKeyword").checked = evs.includes("keyword");
  $("webhookEvStopped").checked = evs.includes("task-stopped");
  $("webhookEvPaused").checked = evs.includes("task-paused");
  $("wechatEnabledCheck").checked = !!settings.wechatEnabled;
  if (!editing) {
    $("webhookUrlInput").value = settings.webhookUrl || "";
    $("wechatAppIdInput").value = settings.wechatAppId || "";
    $("wechatSecretInput").value = settings.wechatAppSecret || "";
    $("wechatOpenIdInput").value = settings.wechatOpenId || "";
    $("wechatTplInput").value = settings.wechatTemplateId || "";
  }
  /* 远程关掉微信直连时退出配置视图：那一页只为配它而存在，留在里面等于让人对着四个输入框
     继续填一个已经关上的功能，而下一次保存带的仍是 wechatEnabled: false。
     反向不成立——远程打开不该把用户从当前页面上拽走 */
  if (!settings.wechatEnabled) document.body.classList.remove("wx-mode");
  renderWebhook();
  renderWechat();
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
  /* 排在这里而不是 initPresetSelect 前面：它按 settings.lastIntervalSec 预填，
     当前标签页真正在跑的间隔要盖掉那个"最近一次手动值" */
  populateTaskFields();
  populateSettingsFields();
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
  /* 五个文本框共用一套（A11）：input 让"地址非法"的红字一边打一边出现，写盘延后一拍；
     change（回车、失焦）立刻写。原先只有 change，红字要等失焦才出现，
     而不点别处就关窗的话这次输入整条丢失 */
  for (const id of TEXT_SETTING_INPUT_IDS) {
    const el = $(id);
    el.addEventListener("input", () => {
      renderWebhook();
      renderWechat();
      scheduleSave();
    });
    el.addEventListener("change", () => {
      renderWebhook();
      renderWechat();
      saveNow();
    });
  }
  /* 弹窗失去焦点即整体销毁，change 不会再触发：还有没落盘的输入就补一次。
     这一笔不保证来得及（文档正在销毁），所以真机那条检查仍然留着 */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSave();
  });
  window.addEventListener("pagehide", () => {
    flushPendingSave();
  });
  $("webhookEvSession").addEventListener("change", saveSettings);
  $("webhookEvKeyword").addEventListener("change", saveSettings);
  $("webhookEvStopped").addEventListener("change", saveSettings);
  $("webhookEvPaused").addEventListener("change", saveSettings);
  /* webhook 的"发送测试"：与微信那条对等，配好之后不必等某个事件真发生才知道通不通 */
  $("webhookTestBtn").addEventListener("click", async () => {
    const btn = $("webhookTestBtn");
    btn.disabled = true;
    btn.textContent = msg("webhookTestSending");
    try {
      /* 与微信侧同一个时序理由，换了形状：地址可能是刚刚打完字还没落盘的（压在 input 的
         去抖计时器里），不先写一次，测试读到的就是上一个地址。saveNow 顺带把计时器摘掉，
         免得它稍后再写一笔一样的 */
      await saveNow();
      const res = await send({ type: "webhook-test" });
      if (res && res.result) {
        webhookLast = res.result;
        renderWebhook();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = msg("webhookTestBtn");
    }
  });

  /* 微信直连：开关即时保存并刷新状态行；凭据四项与 webhook 地址共用上面那段文本框绑定 */
  $("wechatEnabledCheck").addEventListener("change", () => {
    renderWechat();
    saveSettings();
  });
  $("wechatSetupBtn").addEventListener("click", () => {
    document.body.classList.add("wx-mode");
    $("wechatAppIdInput").focus();
  });
  $("wechatBackBtn").addEventListener("click", () => {
    document.body.classList.remove("wx-mode");
  });
  /* 测试消息：填完凭据立刻能验证，不用等某个事件真的发生。
     结果经后台写 storage → onChanged 回流，这里同时也用返回值即时刷新一次。
     try/finally 与 webhook 那条对齐：中途任何一次 await 抛错（SW 正好被回收就是这种时候），
     按钮不能留在 disabled +"发送中"，错误也不能被吞成"什么都没发生" */
  $("wechatTestBtn").addEventListener("click", async () => {
    const btn = $("wechatTestBtn");
    btn.disabled = true;
    btn.textContent = msg("wechatTestSending");
    try {
      /* 先保存再测试：刚打的凭据可能还压在 input 的去抖计时器里，不先写一次，
         后台读到的就是上一个值。两条消息在后台各自独立执行，而 save-settings 自己也要先
         await 一次 getSettings() 才写盘，于是 wechat-test 的 getSettings() 可能排在它前面
         落地、读到旧值：刚填完凭据点测试会得到"还缺 appID、密钥、openid、模板ID"，
         而实际发出去的微信请求数是 0。必须在这里 await，把保存和测试串成一条链 */
      await saveNow();
      const res = await send({ type: "wechat-test" });
      if (res && res.result) {
        wechatLast = res.result;
        renderWechat();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = msg("wechatTestBtn");
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

  /* 只在任务 / 暂停 / 设置变化时重绘；cookie 备份等高频键的写入不触发全量刷新。
     设置这一路还要顺手把控件按新值铺一遍（A18）：不铺的话这台机器读到的是打开弹窗那一刻的
     快照，而 saveSettings 整份覆盖，另一台设备的改动会被这里的下一次保存静默撤销 */
  chrome.storage.onChanged.addListener(async (changes) => {
    /* 推送结果也要跟着刷新，否则弹窗开着时状态永远停在打开那一刻 */
    if (changes.wechatLastResult) {
      wechatLast = changes.wechatLastResult.newValue || null;
      renderWechat();
    }
    if (changes.webhookLastResult) {
      webhookLast = changes.webhookLastResult.newValue || null;
      renderWebhook();
    }
    if (!changes.tasks && !changes.pausedAll && !changes.settings) return;
    await refreshState();
    /* 排在 refreshState 之后：它读的是那个刚重新归一化过的 settings */
    if (changes.settings) populateSettingsFields();
    await renderAll();
  });
}

document.addEventListener("DOMContentLoaded", init);
