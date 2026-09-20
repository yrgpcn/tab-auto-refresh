/* 2026-09-19 审计 A23 的门禁：README 顶部那两张弹窗截图由 scripts/screenshot-popup.mjs
   渲染，而它那份 chrome mock 是弹窗用面的手抄副本。抄漏一面的表现不是报错，
   是"截图看着挺好、其实那一块根本没渲染"——改前的 mock 完全没有 storage.session，
   而弹窗从 A12 起每秒读一次 `rt:skip:<tabId>`，于是新加的那句"上次跳过：你在操作"
   在截图上永远出不来；另一张 popup-wechat.png 更是没有任何脚本产出它，只能手工截一次，
   之后各自漂移。
   两头各钉一条：弹窗用到的 chrome 面必须全部出现在 mock 里（少一条就红，点名是哪条）；
   README 引用的图片必须由脚本产出（引用一张脚本不写的图就红）。
   再加两条形状守卫：扫描本身不许空转（正向见证），以及每个场景必须给全 DEFAULT_SETTINGS
   的每一个键——少给一个不会报错，只会让那个开关在图上看起来是关的。

   红→绿对照的实跑结果记在文件末尾。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { DEFAULT_SETTINGS } from "../../tab-auto-refresh/shared/config.js";

/* 红→绿对照用：这三个变量指到仓库外副本里的对应文件。CI 上不设 */
const POPUP_PATH = process.env.TAR_POPUP_SRC
  ? process.env.TAR_POPUP_SRC
  : new URL("../../tab-auto-refresh/popup.js", import.meta.url);
const SHOT_PATH = process.env.TAR_SCREENSHOT
  ? process.env.TAR_SCREENSHOT
  : new URL("../../scripts/screenshot-popup.mjs", import.meta.url);
const README_PATH = process.env.TAR_README
  ? process.env.TAR_README
  : new URL("../../README.md", import.meta.url);

const read = (url) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");
const POPUP_SRC = read(POPUP_PATH);
const SHOT_SRC = read(SHOT_PATH);
const README_SRC = read(README_PATH);

/* runtime.lastError 是属性不是方法：真 Chrome 在没出错时它就是 undefined，
   mock 里也不该有一个假对象等着被读成"有错" */
const NOT_AN_API = new Set(["runtime.lastError"]);

/* 从 from 起按花括号配对切出整个对象字面量（含首尾花括号）。
   字符串要整体跳过，正则字面量要把里面的 `[` `]` 与引号挡在外面——mock 里那条
   /\$(\w+)\$/g 就是一个：不认正则的话它内部的字符会被当成字符串起点，后面全切歪 */
function sliceObject(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`源码里找不到 ${marker}`);
  const start = src.indexOf("{", at);
  const end = closeBrace(src, start);
  if (end < 0) throw new Error(`${marker} 的花括号没闭合`);
  return src.slice(start, end + 1);
}

function closeBrace(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(src, i, c);
    else if (c === "/") {
      const n = src[i + 1];
      if (n === "/") i = skipLine(src, i);
      else if (n === "*") i = skipBlock(src, i);
      else i = skipRegex(src, i);
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function skipString(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === quote) return j;
  }
  throw new Error("字符串没闭合");
}

function skipLine(src, i) {
  const nl = src.indexOf("\n", i);
  return nl < 0 ? src.length - 1 : nl - 1;
}

function skipBlock(src, i) {
  const end = src.indexOf("*/", i + 2);
  if (end < 0) throw new Error("块注释没闭合");
  return end + 1;
}

/* `/` 之后一路吃到未转义的 `/`；字符类里的 `[...]` 会藏住结束斜杠，要先跳过 */
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    else if (c === "\n") throw new Error("正则字面量里出现换行，切歪了");
  }
  if (j >= src.length) throw new Error("正则字面量没闭合");
  return j;
}

/* 对象字面量顶层（含简写方法 `k(...) {`）的键名。只认 `k:` 一种写法会漏掉
   mock 里的 getMessage——它是简写方法，红过一次之后改成两种都认。
   成员按深度 0 的逗号切（入参已剥掉首尾花括号），再取开头的标识符；
   取到 `case` `return` 这类关键字说明切的这一块根本不是一条成员，丢掉 */
const NOT_A_KEY = new Set([
  "case", "catch", "const", "default", "delete", "do", "else", "for", "function", "if",
  "in", "instanceof", "let", "new", "of", "return", "switch", "this", "throw", "typeof",
  "var", "void", "while",
]);

function keysOf(objSrc) {
  const inner = objSrc.trim();
  const body = inner.startsWith("{") ? inner.slice(1, lastBrace(inner)) : inner;
  const keys = [];
  for (const member of splitTopLevel(body)) {
    const m = /^(?:async\s+|function\s*[*]?\s+|get\s+|set\s+|\*\s*)?([A-Za-z0-9_$]+)\s*[:=(]/.exec(member.trim());
    if (m && !NOT_A_KEY.has(m[1])) keys.push(m[1]);
  }
  return keys;
}

/* 去掉末尾那个收尾花括号；结尾是注释时不能直接 slice(-1) */
function lastBrace(src) {
  const i = src.lastIndexOf("}");
  if (i < 0) throw new Error("对象字面量没有收尾花括号");
  return i;
}

/* 只在深度 0 上按逗号切成员：字符串、注释、正则、四种括号里的分隔符都算以内。
   注释换成一个空格再进成员串——runtime 那一块的 sendMessage 前面就横着一行注释，
   留着它，成员开头就不是标识符了，键名会被认不出来 */
function splitTopLevel(src) {
  const out = [];
  let depth = 0;
  let chunk = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i, c);
      chunk += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "/") {
      const n = src[i + 1];
      let end = -1;
      if (n === "/") end = skipLine(src, i);
      else if (n === "*") end = skipBlock(src, i);
      else if (n !== "=") end = skipRegex(src, i);
      if (end >= 0) {
        chunk += n === "/" || n === "*" ? " " : src.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(chunk);
      chunk = "";
      continue;
    }
    chunk += c;
  }
  out.push(chunk);
  return out;
}

/* 弹窗真正用到的 chrome 面。取到三层：`chrome.storage.session.get` 是一整条读法，
   只切两层的正则会把这一条收成 `storage.session`，于是"弹窗把 .get 改成别的方法名"
   这种改坏在 mock 那边仍然"看着有"——而真 Chrome 里那个方法不存在，截图上那块就空了。
   runtime.lastError 是属性不是方法，连它后面的 .message 一起排除 */
function usedSurface(src) {
  const out = new Set();
  for (const m of src.matchAll(/chrome\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){1,2})/g)) {
    const path = m[1];
    if ([...NOT_AN_API].some((p) => path === p || path.startsWith(p + "."))) continue;
    out.add(path);
  }
  return out;
}

/* mock 提供的面：递归走 window.chrome 那一整块字面量，收每一条 `<命名空间>.<成员>`。
   走到底看值是对象还是方法——i18n 下面全是方法（含简写的 getMessage），storage 下面
   是三个 area 加 onChanged，两种形状都必须是"点名到方法"才算有实现，
   只到 storage.local 那一层不算：弹窗真读的是 .get */
function mockSurface(src) {
  const out = new Set();
  collect(sliceObject(src, "window.chrome = {"), "", out);
  return out;
}

function collect(objSrc, prefix, out) {
  for (const member of splitTopLevel(
    objSrc.trim().slice(1, lastBrace(objSrc.trim()))
  )) {
    const head = member.trim();
    const m = /^(?:async\s+|function\s*[*]?\s+|get\s+|set\s+|\*\s*)?([A-Za-z0-9_$]+)\s*[:=(]/.exec(head);
    if (!m || NOT_A_KEY.has(m[1])) continue;
    const path = prefix ? prefix + "." + m[1] : m[1];
    out.add(path);
    let nested;
    try {
      nested = sliceObject(head, m[1] + ": {");
    } catch {
      continue; /* 值是箭头函数/简写方法，不是子对象 */
    }
    collect(nested, path, out);
  }
}

const USED = usedSurface(POPUP_SRC);
const MOCKED = mockSurface(SHOT_SRC);

/* "有实现"= mock 里有这一整条路径。刻意不给"mock 有父对象就算覆盖"的宽松判据：
   弹窗读的是 chrome.storage.session.get，光有一个 storage.session 空对象等于没实现 */
function covered(path) {
  return MOCKED.has(path);
}

test("正向见证：两边的清单都扫得到东西，扫描不是对着空集合自嗨", () => {
  assert.ok(USED.size >= 10, `弹窗 chrome 面只扫到 ${USED.size} 条，正则或 popup.js 要一起核`);
  assert.ok(MOCKED.size >= 10, `mock 只扫到 ${MOCKED.size} 条，脚本形状变了`);
  assert.ok([...USED].some((p) => p === "storage.session" || p.startsWith("storage.session.")),
    "弹窗读会话态这条用面不见了：A12 那句跳过解释的通道断了");
});

test("弹窗用到的每一条 chrome 面，截图脚本的 mock 里都得有实现", () => {
  const missing = [...USED].filter((p) => !covered(p)).sort();
  assert.deepEqual(
    missing,
    [],
    "mock 少这一面：截图上那块不是没渲染就是静默抛错，而脚本自己不会报（改前缺的正是 storage.session）"
  );
});

test("README 引用的每张截图都由脚本产出，不存在手工截的孤图", () => {
  const cited = [...README_SRC.matchAll(/docs\/tab-auto-refresh\/([\w.-]+\.png)/g)].map((m) => m[1]);
  assert.ok(cited.length >= 2, `README 里只引用到 ${cited.length} 张图，引用面变了要回来核这条`);
  const produced = new Set(
    [...SHOT_SRC.matchAll(/file:\s*"([\w.-]+\.png)"/g)].map((m) => m[1])
  );
  assert.ok(produced.size >= 2, "脚本里一张图都没定义：SCENARIOS 的形状变了");
  const orphans = cited.filter((f) => !produced.has(f));
  assert.deepEqual(orphans, [], "README 引用了脚本不产出的图：它只能手工截一次，之后必然各自漂移");
});

test("每个场景给全 DEFAULT_SETTINGS 的每一个键，少一个就有一个开关在图上看着是关的", () => {
  const region = scenariosRegion(SHOT_SRC);
  const blocks = [...region.matchAll(/settings:\s*\{/g)];
  assert.ok(blocks.length >= 2, `只找到 ${blocks.length} 个场景的 settings 块`);
  const want = Object.keys(DEFAULT_SETTINGS);
  for (const [i, m] of blocks.entries()) {
    const keys = keysOf(sliceObject(region.slice(m.index), "{"));
    const missing = want.filter((k) => !keys.includes(k));
    assert.deepEqual(missing, [], `第 ${i + 1} 个场景的 settings 缺键`);
  }
});

/* 量高度的形状（PROBES）：给的是补丁，合并进完整场景之后才要求齐备，所以它不该进上面
   那条判据——那条管的是"截图场景必须逐键给全"。上面那条因此只扫 SCENARIOS 那一段：
   合并式 `settings: Object.assign(...)` 今天碰巧扫不中（后面不是 `{`），但那是巧合，
   改个换行就会红成"第 3 个场景缺键"，指错方向 */
function scenariosRegion(src) {
  const start = src.indexOf("const SCENARIOS = [");
  if (start < 0) throw new Error("源码里找不到 const SCENARIOS = [，上面那条判据的扫描范围要一起改");
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error("SCENARIOS 没找到收尾");
  return src.slice(start, end);
}

test("量高度的形状引用真实场景、补丁键是真实设置键（打错一个键就是白量一场）", () => {
  const produced = new Set([...SHOT_SRC.matchAll(/file:\s*"([\w.-]+\.png)"/g)].map((m) => m[1]));
  const shots = [...SHOT_SRC.matchAll(/shot:\s*"([\w.-]+\.png)"/g)].map((m) => m[1]);
  assert.ok(shots.length >= 6, `只扫到 ${shots.length} 个量高度的形状，PROBES 的形状变了`);
  assert.deepEqual(
    shots.filter((f) => !produced.has(f)),
    [],
    "形状引用的截图场景不存在：scenarioFor 就地抛错，一个形状都量不到"
  );
  const patches = [...SHOT_SRC.matchAll(/patch:\s*\{/g)];
  assert.ok(patches.length >= 3, `只扫到 ${patches.length} 个补丁，判据在对着空集合绿`);
  const want = new Set(Object.keys(DEFAULT_SETTINGS));
  const unknown = [];
  for (const m of patches) {
    for (const k of keysOf(sliceObject(SHOT_SRC.slice(m.index), "{"))) {
      if (!want.has(k)) unknown.push(k);
    }
  }
  assert.deepEqual(unknown, [], "补丁键不在 DEFAULT_SETTINGS 里：合并进去没人读，那一行根本不会出现");
});

/* 截出 `page.on("<事件>", (…) => { … })` 的回调体。用现成的花括号配对，别按 "});" 找收尾：
   回调里就有 console.error(...) 这样的调用，按字符串找会切早、于是判据对着半截代码绿 */
function handlerBody(src, event) {
  const at = src.indexOf(`page.on("${event}"`);
  if (at < 0) throw new Error(`脚本里没有 page.on("${event}") 这一条订阅`);
  const brace = src.indexOf("{", src.indexOf("=>", at));
  if (brace < 0) throw new Error(`page.on("${event}") 的回调不是块体，判据要跟着改`);
  const end = closeBrace(src, brace);
  if (end < 0) throw new Error(`page.on("${event}") 的回调花括号没闭合`);
  return src.slice(brace, end + 1);
}

test("页面报错的两条订阅都攒进同一份清单，而且这份清单决定退出码", () => {
  const nameOf = (body, event) => {
    const m = body.match(/(\w+)\.push\(/);
    assert.ok(m, `page.on("${event}") 只把报错打给终端：没有清单就没人判红，图照写、退出码照 0`);
    return m[1];
  };
  const pageErr = handlerBody(SHOT_SRC, "pageerror");
  const consoleErr = handlerBody(SHOT_SRC, "console");
  const name = nameOf(pageErr, "pageerror");
  assert.equal(nameOf(consoleErr, "console"), name, "两类错误各攒一份：判红时只会看到其中一半");
  assert.match(
    consoleErr,
    /type\(\)\s*!==\s*"error"/,
    "console 订阅不再筛类型：弹窗里一条普通 log 就能让整次运行红"
  );
  const verdict = SHOT_SRC.match(new RegExp(`if\\s*\\(\\s*${name}\\.length\\s*\\)`));
  assert.ok(verdict, `没有任何判据读这份 ${name} 清单：攒了等于没攒`);
  const brace = SHOT_SRC.indexOf("{", verdict.index);
  const body = SHOT_SRC.slice(brace, closeBrace(SHOT_SRC, brace) + 1);
  assert.match(
    body,
    /process\.exitCode\s*=\s*1|process\.exit\(1\)/,
    "清单非空却不改退出码：这脚本本机手工跑，没人会去读那行红字"
  );
});

test("favicon 由服务器回 204，所以报错清单不必按文本放行任何一条", () => {
  /* 报错文本里不含网址（实测只有 "Failed to load resource: ... 404"），没法靠字符串把
     Chrome 自己来要图标这条与真错分开。既然分不开就不放行：让那条噪音根本不会产生 */
  const at = SHOT_SRC.indexOf('"/favicon.ico"');
  assert.ok(at >= 0, "脚本不再认 favicon：Chrome 每次加载页面都会来要，于是每一次都判红");
  assert.match(SHOT_SRC.slice(at, at + 220), /writeHead\(204\)/, "认得 favicon 却回 404，那条报错照样进清单");
  assert.doesNotMatch(
    handlerBody(SHOT_SRC, "console"),
    /favicon|Failed to load/,
    "console 订阅里出现按文本放行的分支：那等于给真错留了后门"
  );
  assert.match(SHOT_SRC, /writeHead\(404\)/, "404 那条兜底被删了：缺资源不再产生报错，正是这条通道要抓的一类");
});

/* ---------- 红→绿对照（2026-09-19 实跑，D:/Github/_tar_ctl_r5/run.mjs） ----------

   做法：把 popup.js / screenshot-popup.mjs / README.md 复制到仓库外的 _base/，一次只改
   一根 needle（命中数不为 1 就地报错），再用 TAR_POPUP_SRC / TAR_SCREENSHOT / TAR_README
   指到副本跑本文件。base 那一轮先证明"复制 + 重定向"本身全绿（4 pass / 0 fail），
   否则下面任何一条红都可能是搬运造成的。

     C1 删掉 mock 里 storage.session 整块 → 红 1 条（覆盖），点名 storage.session.get。
        这就是改前的真实形状：那份 mock 压根没有 session 区域，而当时的表现是截图照出、
        只是 A12 新加的"上次跳过：你在操作"永远不出现
     C2 把第二个场景的 file 改成 popup-wechatX.png → 红 1 条，点名 popup-wechat.png。
        对应改前的另一半：那张图从来没有任何脚本写过它，只能手工截一次
     C3 从第二个场景的 settings 里删掉 wechatAppSecret → 红 1 条："第 2 个场景的 settings 缺键"
     C4 弹窗新增一块 mock 不认识的存储区域（session 改名 rtStore）→ 红 2 条：正向见证
        （会话态用面不见了）加覆盖。这两条一起红是对的，同一条断链的两个侧面
     C5 弹窗改用一个 mock 没有的面（chrome.windows.setBounds）→ 红 1 条，点名 windows.setBounds。
        只红覆盖这一条，证明 C4 那两条红不是"改哪儿都连带两条"的糊案
     C6 弹窗把会话态读取改成 mock 没有的方法名（storage.session.peek）→ 红 1 条，点名它。
        这一根是为了钉住"用面取到三层"：只切两层的话这条读法会收成 storage.session，
        而 mock 里确实有那个对象，于是方法名改坏查不出来——第一版就漏在这里
     R1 反向：往 mock 的 window.chrome 里塞一条弹窗没用到的 bookmarks.get → 全绿。
        判据刻意单向：弹窗要的必须有，mock 多给不管。留着一条没人用的方法没有代价，
        缺一条才有

   实跑红名单：C1/C2/C3/C5/C6 各红 1 条、C4 红 2 条，每处都红在预期那一条上、点名的正是
   被改坏的那个名字；base 与 R1 全绿。

   ---------- 两处第一次不合格（写下来免得又当成"守卫本来就松"） ----------

   1. 收 mock 的面第一版只认 `键: 值` 写法，而 mock 里的 getMessage 是简写方法
      （`getMessage(key, subs) {`），于是它被当成不存在，门禁对着没改坏的代码红。
      改成按顶层逗号切成员、成员开头允许 `k:` / `k(` / `k =` 三种。
   2. 切成员的分割点第一版写的是"深度 1 上的逗号"，而传进去的串还带着首尾花括号，
      结果每个对象第一个成员都被吞掉——红出来的表现是缺 i18n.getUILanguage、tabs.query
      这类"每条对象的第一个键"。改成先剥首尾花括号、在深度 0 上切。
      同一次还暴露出正则字面量要单独跳过：mock 里那条占位符正则的字符类会藏住结束斜杠，
      并把注释/引号判断一起带歪。
   两条都是"扫描器自己错"，不是被扫的源码错：所以第 1 条用例是正向见证（两边清单都非空），
   它先红过一次才说明这条用例真的在看着。

   ---------- 已知边界（别当成已覆盖） ----------

   这条门禁比的是 mock 有没有这一面，不是这一面回得对不对：少给一个 `tasks` 的字段、
   把 `runtime.sendMessage` 的应答形状回错，截图照样出、这里照样全绿。设置那一头由
   "每个场景给全 DEFAULT_SETTINGS 的键"兜住，任务与会话态的取值形状仍然只能靠人看图。
   另一半原因是弹窗没有 DOM 库可测：`popup-repopulate.test.mjs` 那类门禁切的是源码形状，
   这张图是它们唯一能"真的渲染一遍"的通道，代价是它只能查形状、查不了语义。 */

/* ---------- A28 加的那一条（第十轮）：对照与边界，2026-09-19 实跑 ----------

   脚本 `D:/Github/_tar_ctl_r10/run.mjs`：整仓复制到仓库外、不带 .git 与 _code-review，一轮只改坏
   副本里的 `scripts/screenshot-popup.mjs` 一处。跑两样：K* 跑副本的本文件（副本自己就是完整仓库，
   三个输入默认全指到副本里，不用设 TAR_*）；R1 跑副本的 `--measure`，看 exit 码与逐形状报账。
   基线：本文件 5 条全绿，`--measure` 六个形状全在 600px 内（最深 571px）。

     K1 补丁键打一个字母（webhookUrl → webhookUrlX）→ 红 1，正是新那条
     K2 形状引用的截图场景不存在（popup-wechatX.png）→ 红 1，同一条
     K3 量高度的清单被清空（`const PROBES = []`）→ 红 1（正向见证 ≥6 / ≥3）。
        这一处是这一类唯一的拦网：清单空了脚本照样跑、照样绿，只是什么都不量
     K3n 只把 `const PROBES` 改名、不改使用处 → 全绿，这一处没抓住。判据数的是 `shot:` 字面量，
        不看声明与使用还在不在一处。留着这条记录是因为它看着像"对照通过"而实际是漏：可接受的理由
        是脚本自己会 `PROBES is not defined` 抛错，那是响亮地崩，不是静默量不到
     K4 两个截图场景各删掉一个 `keepAwake` 键 → 红 1（老那条"给全键"还活着）。
        这一根是收窄的代价核对：把扫描范围从整份文件收进 SCENARIOS 那一段，容易顺手把判据弄没了
     K5 反向：把 scenarioFor 的合并式改写成多行 `settings: {` → 全绿。改前的整文件扫法会把这处
        当成"第三个场景缺键"，红指到一个不存在的场景上；收窄之后不红，这就是收窄要买的东西
     K6 反向：补丁换成另一个真实设置键（skipOnActivity）→ 全绿。判据不是"改什么都红"
     R1 上限常量 600 → 500，真渲染 → `--measure` exit 1，六个形状五个 ✖、只有二级视图那条 380px
        仍 ✔。这一处是"✔ 全在 600 内"这句话不是空话的唯一证明：数字这一头没有别的门禁，
        CI 上没有 Chrome，`node --test` 里跑不了像素

   ---------- 一处写错的口径，以及它是怎么被推翻的（2026-09-19 晚） ----------

   草稿的 CHANGELOG 与 BACKLOG 都写着"视口故意给到 400×640：视口只有 600 的话超出部分被视口
   自己切掉，量不到真实深边"。这句话是凭直觉写的，没验。实测把它推翻了：`getBoundingClientRect()`
   回的是布局盒，不被视口裁剪——同一份内容（body `max-height:600` + `overflow:hidden`，孩子累计
   640px）在视口 600 与 640 下都报最深底边 640。所以 VIEWPORT 那条高度沿用截图本来的 640 就行，
   与量得到量不到没关系；真正与 CSS 绑死的只有宽度（`popup.css` 的 body width，AGENTS.md 验证清单
   第 4 条就是这一句）。两份文档已按实测改掉，脚本量高度那处的注释也补了一句，免得下次有人以为把
   视口压回 600 会破坏测量。

   为什么没走变异对照：那条要看的是"运行时量到多少"，跟本文件的判据无关，改坏副本里 VIEWPORT 高度
   这一类编辑这次被权限策略挡了。改用一个自足的最小页面直接问 DOM（两个 div、两种视口高度、打印
   rect.bottom），一次就分出真假——这属于"验一个事实"，不需要整仓副本。

   已知边界（别当成已覆盖）：
   - 本文件钉的是形状，不是高度。`POPUP_MAX_H` 改成任何数这里都全绿，认得它的只有 `--measure`
     自己（R1 就是量这一句），所以它不进 CI 就等于没有强制——这是"只能本地跑"的固有代价，
     与截图脚本同一档
   - 形状清单与测量在同一条命令里：`--measure` 没跑过不等于形状没变，改了 UI 要回来重跑一次
   - 探针只覆盖 PROBES 列的那几种"多出一行"的形状。任务数不逐一样量，`#taskList` 那 108px
     是硬封顶加内部滚动，多开任务不会拉长整页——那是 CSS 保证的，不是这条判据保证的
   - 量的是 mock 数据下的形状：真系统的字体回退、浏览器 zoom、更长的中文站点名仍只能真机看
     （`BACKLOG.md` V1 (h) 因此收窄成这三样） */

/* ---------- A29 加的那两条（第十一轮）：对照与边界，2026-09-19 实跑 ----------

   脚本 `D:/Github/_tar_ctl_r11/run.mjs`：整仓复制到仓库外，一轮只改坏一处。N* 跑副本的
   本文件 + popup-repopulate.test.mjs（副本自己是完整仓库，TAR_* 一个都不设）；R* 跑副本的
   `--measure`，看 exit 码。基线 29 条全绿（本文件 7 + 那文件 22）。

     N2 页面报错改回"只 console.error 一行"（改前的真实形状）→ 红 1，正是"两条订阅都攒进
        同一份清单"。这一根就是本轮的起点：一条"页面死了也绿"的通道
     N3 两类错误各攒一份清单 → 红 1，同一条。判红时只看得到一半，这一半恰好是 console
     N4 读清单却不改退出码 → 红 1，还是同一条（判据最后一句就是查这个）
     N5 删掉 favicon 那一支 → 红 1，favicon 那条
     N6 给 console 订阅加一段 `if (text.includes("favicon")) return` → 红 1。这一根是 N5 的
        对偶：先把"按文本放行"这条路堵住，才谈得上"剩下的 404 都是真错"
     N7 反向：清单整体改名（9 处一起改）→ 全绿。判据拿的是 push 调用里的数组名，不绑死字面量

     R1 真渲染：副本的 popup.html 里把一个 id 的属性名改掉 → exit 1。注意它红在哪：
        抛在模块顶层的脚本连任务列表都没建起来，于是红的是 waitForSelector 超时（30 秒后抛），
        不是那句"1 条页面报错"。所以"整页白屏"这一类本来就拦得住，本轮补的不是这一类
     R2 真渲染：删掉 favicon 那一支 → 六个形状高度全部 ✔、最深仍 571px，只有末尾那句报错清单
        让它 exit 1。这一处才是新判据独有的覆盖面，也是 R1 之外必须再跑一条的理由：
        页面照建、数字照量、看着一切正常，红只可能来自清单

   为什么 R1 那种"本来就响"的还要记：不记的话下次有人会把 R1 当成"新判据的证明"，
   而它证明的是旧机制。两条对照要分开摆，一条量增量、一条量存量。

   已知边界（别当成已覆盖）：
   - 这两条钉的是"报错有没有被收集与判红"，不是"弹窗渲染得对不对"。少绑一个事件、回填错控件
     这类不会打印任何东西的错，仍然只有 popup-repopulate.test.mjs 那一头与真机看图
   - 清单只在这一次进程里有效：中途脚本自己抛（R1 就是）会跳过末尾那句统计，
     那种情况红是红，但报的是超时不是那 N 条错
   - favicon 那条判据认的是 writeHead(204) 这一种解法。换别的安静法（比如真放一个图标文件）
     要连着改判据，别只改脚本 */
