/* 2.1.0 批次 2 的门禁：页内匹配与纯函数判定必须逐条同结果。
   背景：关键词命中原先是把整页正文（截 300KB）序列化回 service worker 再匹配，
   改成在页面里匹配、只回传命中的关键词。收益有两个：跨上下文不再搬正文，以及
   "排在 300KB 之后的关键词永远检不到"这个盲区消失。
   代价是匹配逻辑现在有两份实现：background.js 的 matchInPage（注入体，必须自包含，
   不能引用任何模块作用域，所以没法直接调用 logic.js 的 keywordHit）与 logic.js 那份。
   两份实现分叉的表现是静默的：改一边、另一边照旧，检出结果随页面时序漂移。
   本文件按花括号配对从仓库源码里切出注入体的真实源码并执行它，不手抄复刻。

   红→绿对照实跑（2026-09-18，四种变异各只红在该红的地方）：
     指向 HEAD 源码（还没有 matchInPage）→ 取源码那步直接抛错，整个文件判失败，不会假绿
     注入体改成调模块作用域的 keywordHit → 红「自包含」（ReferenceError），并被级联带红 4 条
     innerText 换成 textContent            → 红「innerText 约定」+ 语料等价性
     把 slice(0, 300000) 截断加回来        → 红「深处的关键词检得到」+ 语料等价性
   2026-09-19 把「自包含」从四个名字的黑名单换成共享模块导出名的动态清单（logic.js 57 个 +
   config.js 4 个），对同一份变异副本两边各判一次：
     注入体改成调 hostOf（logic.js 的导出，旧黑名单里没有这个名字）
       → 旧的「自包含」这一条判绿——它看不见 hostOf，红只落在靠执行发现的那几条用例上，
         也就是说光读代码看不出"引用了模块作用域"，得等它在页面里炸掉；
         新清单在同一条上直接点名 hostOf，并同样级联带红那 4 条。
     踩过的坑只有四个，将来抽出去的共享函数不止四个，这就是换掉它的理由。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { keywordHit, presentOf, newlyOf } from "../../tab-auto-refresh/shared/logic.js";
/* 整个模块的导出名集合：注入体里出现任何一个都是"引用了模块作用域"，页面里 undefined */
import * as LOGIC from "../../tab-auto-refresh/shared/logic.js";
import * as CONFIG from "../../tab-auto-refresh/shared/config.js";

/* 红→绿对照用：TAR_BG_SRC 指到另一份 background.js 的路径（本文件只读它的文本，不 import）。
   CI 上不设这个变量 */
const BG_PATH = process.env.TAR_BG_SRC
  ? process.env.TAR_BG_SRC
  : new URL("../../tab-auto-refresh/background.js", import.meta.url);
const BG_SRC = readFileSync(BG_PATH, "utf8");

/* 按花括号配对切出函数源码。函数体里出现字符串字面量含花括号时会切歪，
   那样下面的 new Function 会直接抛错，是响失败不是静默假绿 */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 ${name}()`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}() 的花括号没闭合`);
}

const PAGE_SRC = sliceFunction(BG_SRC, "matchInPage");

/* 把切出来的源码装进一个以 document 为形参的闭包里执行：注入体的全部外部依赖就只有
   document，所以一个 {body:{innerText}} 的壳子足以真跑，不需要假 DOM。
   参数名故意叫 document，遮蔽 Node 侧的同名全局（Node 没有，但意图明确） */
function loadMatchInPage(src) {
  return new Function("document", `${src}; return matchInPage;`);
}

function runInPage(innerText, keywords) {
  const doc = innerText === null ? { body: null } : { body: { innerText } };
  return loadMatchInPage(PAGE_SRC)(doc)(keywords);
}

test("空跑守卫：确实切到了函数源码", () => {
  assert.ok(PAGE_SRC.length > 60, "切出来的源码过短，等于什么都没测");
  assert.match(PAGE_SRC, /^function matchInPage\(keywords\)/);
});

test("注入体与 presentOf 在同一批语料上逐条同结果", () => {
  const tail = "限量 3 台，立刻下单";
  const corpus = [
    /* 排在旧截断点之后的正文：这次改动要修的就是它 */
    "x".repeat(400000) + tail,
    "  AlreadyInStock  ",
    "价格 ¥1,299，含 emoji 🎉 与\t制表符",
    "READY",
    "no match here",
    "  ",
    ""
  ];
  const keywordSets = [
    [tail],
    ["alreadyinstock"],
    ["ALREADYINSTOCK", "  限量 3 台，立刻下单  "],
    ["emoji 🎉", "🎉", "制表符"],
    ["", "   ", null, 5, "no match"],
    ["price", "PRICE", "price"],
    []
  ];
  let compared = 0;
  for (const text of corpus) {
    for (const keywords of keywordSets) {
      assert.deepEqual(
        runInPage(text, keywords),
        presentOf(text, keywords),
        `语料分歧：text=${JSON.stringify(text.slice(0, 24))} keywords=${JSON.stringify(keywords)}`
      );
      compared++;
    }
  }
  assert.ok(compared >= 40, `只比了 ${compared} 组，覆盖面不足`);
});

test("注入体必须自包含：不得调用任何模块作用域的函数", () => {
  /* executeScript 是把函数体 toString() 后送到页面执行的，模块作用域里的东西在页面里
     全是 undefined。引了就等于线上抛 ReferenceError、被外层 catch 吞掉、检测静默失效。
     判定集合取自两个共享模块的真实导出名，不是写死的四个名字——黑名单只防已经踩过的那几个，
     以后每抽一个新共享函数都要记得回来补一行，忘了就是静默失效 */
  const shared = new Set([...Object.keys(LOGIC), ...Object.keys(CONFIG)]);
  const called = new Set(
    [...PAGE_SRC.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  );
  const leaked = [...called].filter((n) => shared.has(n));
  assert.deepEqual(leaked, [], "注入体调用了模块作用域的函数，页面里会是 undefined");
  /* 外部依赖只允许 document 一个 */
  assert.match(PAGE_SRC, /\bdocument\b/);
});

test("取文本一律 innerText，换成 textContent 会新增两类误报", () => {
  assert.match(PAGE_SRC, /\.innerText\b/, "注入体不再读 innerText");
  assert.ok(
    !/textContent/.test(PAGE_SRC),
    "textContent 会把 <script>/<style> 的源码文本和 display:none 的隐藏文字算进正文"
  );
});

test("不再有 300KB 截断，排在深处的关键词检得到", () => {
  assert.ok(!/slice\(0,/.test(PAGE_SRC), "注入体又开始了截断");
  const deep = "库存恢复";
  const text = "a".repeat(300001) + deep;
  /* 判别力守卫：这条语料若没跨过旧截断点，上面的断言就是空跑 */
  assert.deepEqual(presentOf(text.slice(0, 300000), [deep]), [], "语料没跨过 300KB，用例无判别力");
  assert.deepEqual(runInPage(text, [deep]), [deep]);
});

test("document.body 缺席时返回空数组而不是抛错", () => {
  assert.deepEqual(runInPage(null, ["anything"]), []);
});

test("回传的在场集直接喂 newlyOf，划分通知不需要正文", () => {
  const text = "命中 A 与 b，不含 D";
  const keywords = ["a", "b", "c"];
  const present = runInPage(text, keywords);
  assert.deepEqual(present, ["a", "b"]);
  assert.deepEqual(newlyOf(present, ["A"]), ["b"], "已通知集的大小写没对上");
  assert.deepEqual(newlyOf(present, ["a", "b"]), [], "全部通知过了还不该再报");
  /* 关键词消失 → 在场集收缩，检测链据此回写 notifiedKeys，下次再现才重新通知 */
  assert.deepEqual(newlyOf(runInPage("只剩 b", keywords), ["a"]), ["b"]);
});

test("presentOf 与 keywordHit 的判定口径没分叉", () => {
  assert.deepEqual(presentOf("Hello World", ["world", "", "  ", "nope"]), ["world"]);
  assert.equal(keywordHit("Hello World", " WORLD "), true);
  assert.deepEqual(presentOf(null, ["null"]), []);
  /* keywordHit 把正文按字符串化处理，presentOf 走同一个函数，这里钉住不各自演化 */
  assert.deepEqual(presentOf(undefined, ["x"]), []);
});
