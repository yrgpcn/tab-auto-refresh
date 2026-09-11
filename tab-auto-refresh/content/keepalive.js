/* keep-alive 内容脚本：任务开启「后台保活」时注入监控站点，
   每隔 45~75 秒派发一次模拟的鼠标/键盘事件，冒充用户在场，
   延缓"按用户交互心跳计时"的服务器端会话过期。
   已知边界：校验 event.isTrusted 的站点无效；document.hidden 时暂停心跳的站点无效。 */

(() => {
  /* 守卫是"可重启"语义：window.__tarKeepAlive 存的是上一实例的停止函数。
     重复注入（start→stop→start 不重载页面）时先停旧再起新；
     收到 keepalive-off 时自停并清除标记，让之后的注入能正常重启。 */
  if (typeof window.__tarKeepAlive === "function") {
    try {
      window.__tarKeepAlive();
    } catch (e) {
      /* 旧实例清理失败不阻断新实例 */
    }
  }

  let stopped = false;
  let timer = null;

  function tick() {
    try {
      const x = Math.round(Math.random() * 800) + 100;
      const y = Math.round(Math.random() * 600) + 100;
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Shift", code: "ShiftLeft", keyCode: 16
      }));
      window.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true, cancelable: true, key: "Shift", code: "ShiftLeft", keyCode: 16
      }));
    } catch (e) {
      /* 个别页面环境异常时静默，不影响下次心跳 */
    }
  }

  function schedule() {
    timer = setTimeout(() => {
      if (stopped) return;
      tick();
      schedule();
    }, 45000 + Math.random() * 30000);
  }

  function onMessage(msg) {
    if (msg && msg.type === "keepalive-off") stop();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (e) {
      /* 上下文失效时无需清理 */
    }
    if (window.__tarKeepAlive === teardown) delete window.__tarKeepAlive;
  }

  const teardown = stop;
  window.__tarKeepAlive = teardown;

  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch (e) {
    /* 上下文失效时定时器随页面销毁 */
  }

  schedule();
})();
