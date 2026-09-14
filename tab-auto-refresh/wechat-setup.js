/* 微信直连配置教程页：文案全部来自语言包（与弹窗同一套 data-i18n 机制）。
   页面本身只有结构与键名，中英文各一份不会跑偏；没有任何网络请求 */

const msg = (key) => chrome.i18n.getMessage(key) || key;

document.title = msg("guideTitle");
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll("[data-i18n]")) {
  el.textContent = msg(el.dataset.i18n);
}
/* 插图的 alt 也走语言包（data-i18n-alt）—— 写死在 HTML 里的话，
   英文界面会读出一段中文 */
for (const el of document.querySelectorAll("[data-i18n-alt]")) {
  el.alt = msg(el.dataset.i18nAlt);
}
