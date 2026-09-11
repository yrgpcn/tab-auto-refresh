/* keep-alive 内容脚本：任务开启「后台保活」时注入监控站点，
   每隔 45~75 秒派发一次模拟的鼠标/键盘事件，冒充用户在场，
   延缓"按用户交互心跳计时"的服务器端会话过期。
   事件派发到 document：DOM 事件自子向父冒泡，document 级派发能同时覆盖
   document 与 window 两级监听器；挂 window 派发只覆盖 window 一级，严格更差。
   已知边界：校验 event.isTrusted 的站点无效；document.hidden 时暂停心跳的
   站点无效；挂在 document.body 或具体元素上的监听器覆盖不到（冒泡不向下）。 */

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

  /* 首个 tick 提前到 12~20 秒：短刷新周期（30/60 秒）下页面会被反复重载，
     慢心跳永远来不及触发（复审§3.2 的互相抑制问题）；之后回到 45~75 秒慢节奏 */
  function schedule(first) {
    const delay = first
      ? 12000 + Math.random() * 8000
      : 45000 + Math.random() * 30000;
    timer = setTimeout(() => {
      if (stopped) return;
      tick();
      schedule(false);
    }, delay);
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

  schedule(true);
})();
