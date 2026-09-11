/* keep-alive 内容脚本：由后台按标签页注入（executeScript），承担两类可独立开关的职责：
   1. heartbeat（设置 keepAlive）：派发模拟鼠标/键盘事件，延缓"按用户交互心跳计时"的服务器端会话过期。
      事件派发到 document：冒泡覆盖 document 与 window 两级监听器（挂 window 只覆盖一级，严格更差）。
      已知边界：校验 event.isTrusted 的站点无效；document.hidden 时暂停心跳的站点无效；
      挂在 document.body 或具体元素上的监听器覆盖不到（冒泡不向下）。
   2. activityWatch（设置 skipOnActivity）：监听 isTrusted===true 的真人操作并节流上报，
      后台据此在 60 秒内跳过该页刷新。与 heartbeat 正交——合成事件 isTrusted 恒为 false，
      不会被误判成真人；真人操作也不依赖心跳是否在跑。
   配置来自启动时 keepalive-query 一问一答 + 后续 keepalive-config 推送；
   keepalive-off（任务停止）无条件全停。 */

(() => {
  /* 守卫是"可重启"语义：window.__tarKeepAlive 存的是上一实例的全停函数。
     重复注入（start→stop→start 不重载页面）时先全停旧实例再起新实例 */
  if (typeof window.__tarKeepAlive === "function") {
    try {
      window.__tarKeepAlive();
    } catch (e) {
      /* 旧实例清理失败不阻断新实例 */
    }
  }

  let hbStopped = true;
  let hbTimer = null;
  let awActive = false;
  let lastReport = 0;

  function tick() {
    try {
      const x = Math.round(Math.random() * 800) + 100;
      const y = Math.round(Math.random() * 600) + 100;
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Shift", code: "ShiftLeft", keyCode: 16
      }));
      document.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true, cancelable: true, key: "Shift", code: "ShiftLeft", keyCode: 16
      }));
    } catch (e) {
      /* 个别页面环境异常时静默，不影响下次心跳 */
    }
  }

  /* 首个 tick 提前到 12~20 秒：短刷新周期下页面被反复重载，慢心跳永远来不及触发；
     之后回到 45~75 秒慢节奏 */
  function schedule(first) {
    const delay = first
      ? 12000 + Math.random() * 8000
      : 45000 + Math.random() * 30000;
    hbTimer = setTimeout(() => {
      if (hbStopped) return;
      tick();
      schedule(false);
    }, delay);
  }

  function startHeartbeat() {
    if (!hbStopped) return;
    hbStopped = false;
    schedule(true);
  }

  function stopHeartbeat() {
    hbStopped = true;
    if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
  }

  /* ---- 真人活动上报：5 秒节流，事件种类覆盖常见 idle 库的探测面 ---- */
  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];

  function onRealActivity(e) {
    if (!e.isTrusted) return; /* 保活合成事件绝不算真人 */
    const now = Date.now();
    if (now - lastReport < 5000) return;
    lastReport = now;
    try {
      chrome.runtime.sendMessage({ type: "user-activity" }).catch(() => {});
    } catch (e2) { /* 上下文失效：随页面销毁 */ }
  }

  function startActivityWatch() {
    if (awActive) return;
    awActive = true;
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onRealActivity, { capture: true, passive: true });
    }
  }

  function stopActivityWatch() {
    if (!awActive) return;
    awActive = false;
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, onRealActivity, { capture: true });
    }
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    if (cfg.heartbeat) startHeartbeat(); else stopHeartbeat();
    if (cfg.activityWatch) startActivityWatch(); else stopActivityWatch();
  }

  function teardownAll() {
    stopHeartbeat();
    stopActivityWatch();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (e) { /* 上下文失效无需清理 */ }
    if (window.__tarKeepAlive === teardownAll) delete window.__tarKeepAlive;
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "keepalive-config") applyConfig(msg);
    else if (msg.type === "keepalive-off") teardownAll();
  }

  window.__tarKeepAlive = teardownAll;

  try {
    chrome.runtime.onMessage.addListener(onMessage);
    /* 启动先向后台要一次配置快照；问不到（SW 未就绪）保持全停，等下一次推送。
       带回调调用仍会返回 Promise，显式吞掉 lastError 防未处理拒绝 */
    const pending = chrome.runtime.sendMessage({ type: "keepalive-query" }, (resp) => {
      if (resp) applyConfig(resp);
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (e) {
    /* 上下文失效时页面即将销毁，无需工作 */
  }
})();
