/* 第二十三轮审计（`BACKLOG.md` A41）的门禁：一页的 class 名单三本账有没有齐平。
   三本账是 CSS 定义了哪些类、HTML 用到位的是哪些、JS 运行时写进去的是哪些。

   立论是量出来的，不是推出来的：改前全套对 class 名字唯一的账是 `popup-repopulate.test.mjs`
   那一条"两个颜色类在 CSS 里真的存在"（只管 `.wx-state.ok` / `.error` 两个），`popup.css` 那四十三
   个类名里其余四十一、以及 `wechat-setup.css` 那八个，一条判据都没有——把 `.task-sub` 在 CSS 里
   改个名、或把 JS 那句 `className = "task-sub"` 改个名，全套照样零红（见文件末尾的实测表）。
   同轮探路还抓到一处真死类：
   `popup.html` 的「发送测试」按钮挂着 `wx-test`，而 CSS 与 JS 两边都不认识它（全仓库只有一处
   出现），本轮把它删掉。

   判据分三头，缺一头就是另一种静默：
   1. 正向：HTML 用到的、JS 写出的每个类名，都要在同页 CSS 里有定义
      —— 漏了不报错，只是那个状态/那一块永远长这样（用户看不到"这里本该是红的"）
   2. 反向：CSS 里定义的每个类名，都要被同页 HTML 或 JS 提到
      —— 这一头挡的是"改了一头忘了另一头"的另一半：JS 把类名改拼错时，旧名字在这里红
   3. 形状：抽取器先要有自己的见证（合成样例 + 条数下限 + 三条写类通道各自非空），
      否则三本账可以在对着空集合绿

   页面清单、类名一律从目录与源码现推；本文件里手写的只有合成样例、条数下限、以及
   "每页都要登记一组下限"那张表（同 `message-gate.test.mjs` 的 `POPUP_ONLY`：它是输入清单，
   不是值抄本）。新增一个带样式的页面，没登记下限就直接红。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* 根目录按本文件自己的位置现推，不写死：红→绿对照跑在仓库外的整仓副本上，写死就把副本指回仓库了 */
const EXT = join(ROOT, "tab-auto-refresh");
const read = (name) => readFileSync(join(EXT, name), "utf8").replace(/\r\n/g, "\n");

/* ---------- 一、从目录现推"有哪些页" ---------- */

function pages() {
  return readdirSync(EXT)
    .filter((f) => f.endsWith(".css"))
    .map((f) => f.slice(0, -4))
    .sort();
}
const PAGES = pages();

/* 每页三本账的条数下限：加类不红，删到地板以下才红（挡"对着空集合绿"）。
   wechat-setup.js 今天一个类都不写，那一格刻意是 0——它是登记的事实，不是缺口 */
const FLOORS = {
  popup: { css: 35, html: 25, js: 12 },
  "wechat-setup": { css: 6, html: 6, js: 0 },
};

/* ---------- 二、抽取 ---------- */

/* 注释里的字面量不算写法：`className = "…"` 原样抄在注释里就会伪造出一条归属（第十五轮
   在 i18n 那本账上踩过同一个形状）。也不能"整行去 // 之后的东西"——源码里
   `"https://…"` 这种串会把行尾吃掉。所以走一个小扫描器：认 ' " ` 三种串与两种注释 */
function withoutComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out.push(" ");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out.push(c);
      i++;
      while (i < n) {
        if (src[i] === "\\") { out.push(src[i], src[i + 1] ?? ""); i += 2; continue; }
        out.push(src[i]);
        if (src[i] === q) { i++; break; }
        if (q !== "`" && src[i] === "\n") { i++; break; }
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

const CLASS_SHAPE = /^[A-Za-z][\w-]*$/;

/* 一个"类名字符串"拆成 token：先去掉模板插值（`${x}` 不是类名），再按空白切。
   切出来不像类名的东西一律抛——那是抽取器认错形状，静默少收才是本文件最怕的事 */
function tokensOf(text, where) {
  return text
    .replace(/\$\{[^}]*\}/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      if (!CLASS_SHAPE.test(t)) {
        throw new Error(`${where}：抽到一个不像类名的 token「${t}」——这一路的写法本文件认不了，` +
          `去上面那张 JS_SOURCES 补一条，别让它静默漏收`);
      }
      return t;
    });
}

/* JS：认四种写法。少认一种的表现是那个类只在 CSS 与"另一本账"里出现，反向当场红 */
const JS_SOURCES = [
  ["classList", /\.classList\s*\.\s*\w+\s*\(\s*(["'`])([^"'`]*)\1/g],
  ["className", /\.className\s*\+?=\s*(["'`])([^"'`]*)\1/g],
  ["cls:", /\bcls\s*:\s*(["'`])([^"'`]*)\1/g],
  ["setAttribute(class)", /setAttribute\(\s*["']class["']\s*,\s*(["'`])([^"'`]*)\1/g],
];

function grabFrom(src, entry) {
  const out = [];
  for (const m of src.matchAll(entry[1])) out.push(...tokensOf(m[2], entry[0]));
  return out;
}

function jsClassTokens(src) {
  const s = withoutComments(src);
  const out = [];
  for (const entry of JS_SOURCES) out.push(...grabFrom(s, entry));
  return new Set(out);
}

/* JS 里每条通道各抽到了什么——通道齐平比总数更严（总数 16 可以全靠一条通道撑着） */
function jsChannels(src) {
  const s = withoutComments(src);
  const only = (name) => new Set(grabFrom(s, JS_SOURCES.find((e) => e[0] === name)));
  return { classList: only("classList"), className: only("className"), cls: only("cls:") };
}

/* CSS：只在"选择器前奏"上找 `.类名`——即每个 `{` 之前那一段（`}` 与 `;` 都重置）。
   所以属性值里的 `url(a.png)`、`margin:.5rem` 都不会被当成类名。注释先剔 */
function cssClassTokens(src) {
  const s = withoutComments(src);
  const out = new Set();
  let prelude = "";
  for (const ch of s) {
    if (ch === "{") {
      for (const m of prelude.matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(m[1]);
      prelude = "";
    } else if (ch === "}" || ch === ";") prelude = "";
    else prelude += ch;
  }
  return out;
}

function htmlClassTokens(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bclass\s*=\s*(["'])([^"']*)\1/g)) {
    for (const t of tokensOf(m[2], "html")) out.add(t);
  }
  return out;
}

/* ---------- 三、真源码的三本账 ---------- */

const LEDGER = {};
for (const p of PAGES) {
  LEDGER[p] = {
    css: cssClassTokens(read(`${p}.css`)),
    html: htmlClassTokens(read(`${p}.html`)),
    js: jsClassTokens(read(`${p}.js`)),
  };
}

const missing = (a, b) => [...a].filter((x) => !b.has(x));

/* ---------- 四、判据 ---------- */

test("页面清单是现推的：每个 .css 都有同名 .html 与 .js，且那页引的就是它", () => {
  assert.ok(PAGES.length >= 2, `只认到 ${PAGES.length} 个带样式的页面：目录遍历退化了`);
  for (const p of PAGES) {
    assert.ok(FLOORS[p], `新增了一个带样式的页面 ${p}，却没在这里登记三本账的下限`);
    const html = read(`${p}.html`);
    assert.ok(new RegExp(`<link[^>]+href="${p}\\.css"`).test(html),
      `${p}.html 里没有 <link> 引 ${p}.css——那一页的 CSS 账与它的显示无关`);
    assert.ok(read(`${p}.js`).length > 0, `${p}.js 读不到`);
  }
  for (const p of Object.keys(FLOORS)) {
    assert.ok(PAGES.includes(p), `FLOORS 里还登记着一个已经不存在的页面 ${p}`);
  }
});

test("CSS 抽取的形状：组合类、伪类、注释、属性值、@media 里的嵌套规则", () => {
  const got = [...cssClassTokens(`
    /* 注释里写着 .fakeInComment 不算 */
    .alpha, .beta.gamma { color: red; }
    .delta:hover { background: url(bgtile.png); }
    .eps { margin: 0 .5rem; background-image: url(a.woff); }
    @media (max-width: 400px) { .zeta { padding: 0; } }
  `)].sort();
  assert.deepEqual(got, ["alpha", "beta", "delta", "eps", "gamma", "zeta"]);
  /* 反向见证：属性值与注释里的点号不许被当成类名 */
  assert.equal(got.includes("fakeInComment"), false);
  assert.equal(got.includes("rem"), false);
  assert.equal(got.includes("png"), false);
  assert.equal(got.includes("woff"), false);
});

test("HTML 抽取的形状：一行多个类、单双引号、空 class 不产生 token", () => {
  const got = htmlClassTokens(`<i class="a b"></i><i class='c d'></i><i class=""></i>`);
  assert.deepEqual([...got].sort(), ["a", "b", "c", "d"]);
});

test("JS 抽取的形状：四种写法都认，普通字符串不算类名，注释里的写法不算", () => {
  const src = `
    el.classList.toggle("on off", v);
    el.className = "one";
    el.className = "base" + (v ? " " + st.cls : "");
    el.className = \`card \${kind} foot\`;
    const st = { cls: "ok" };
    el.setAttribute("class", "viaAttr");
    const text = "hello world";                 // 这不是类名
    const url = "https://a.test/x";             // 串里的 // 不许吃掉下一行
    el.className = "afterUrl";
    // className = "inComment"
  `;
  const got = jsClassTokens(src);
  for (const t of ["on", "off", "one", "base", "card", "foot", "ok", "viaAttr", "afterUrl"]) {
    assert.ok(got.has(t), `漏抽 ${t}（实到 ${[...got].join(" ")}）`);
  }
  assert.equal(got.has("hello"), false, "普通字符串被当成类名了");
  assert.equal(got.has("world"), false);
  assert.equal(got.has("inComment"), false, "注释里的写法不算（第十五轮的同一个坑）");
  assert.equal(got.has("https:"), false);
});

test("抽到不像类名的东西就抛，而不是静默少收一条", () => {
  /* 判据是"形状不对说明这一路写法我认不了"，宁可炸也不漏：漏一条的对称后果是反向那一条
     点名一个真在用的类没人提，那是假报警，比在这里炸更难查 */
  assert.throws(() => jsClassTokens(`el.classList.add("ok!", v);`), /不像类名/);
  assert.throws(() => htmlClassTokens(`<i class="row 1"></i>`), /不像类名/);
  /* 而模板插值是认得的形状：剥掉之后剩下的段照算 */
  assert.deepEqual([...jsClassTokens("el.className = `card ${kind} foot`;")].sort(),
    ["card", "foot"]);
});

test("正向：HTML 用到的每个类名都在同页 CSS 里有定义", () => {
  for (const p of PAGES) {
    const { css, html } = LEDGER[p];
    const orphans = missing(html, css);
    assert.deepEqual(orphans, [],
      `${p}.html 用了 CSS 里没有的类：${orphans.join(" ")}——挂着不报错，只是那块永远不长那样`);
  }
});

test("正向：JS 写出的每个类名都在同页 CSS 里有定义", () => {
  for (const p of PAGES) {
    const { css, js } = LEDGER[p];
    const orphans = missing(js, css);
    assert.deepEqual(orphans, [],
      `${p}.js 运行时挂上 CSS 里没有的类：${orphans.join(" ")}（状态色、模式类挂空就是没样式）`);
  }
});

test("反向：CSS 定义的每个类名都被同页 HTML 或 JS 提到", () => {
  for (const p of PAGES) {
    const { css, html, js } = LEDGER[p];
    const dead = missing(css, new Set([...html, ...js]));
    assert.deepEqual(dead, [],
      `${p}.css 定义了两个来源都用不到的类：${dead.join(" ")}——多半是一头改了名而另一头没跟`);
  }
});

test("条数下限：三本账各自不许退化成空集合", () => {
  for (const p of PAGES) {
    for (const k of ["css", "html", "js"]) {
      const floor = FLOORS[p][k];
      assert.ok(LEDGER[p][k].size >= floor,
        `${p} 的 ${k} 账只有 ${LEDGER[p][k].size} 条（下限 ${floor}）——抽取退化或清单被砍`);
    }
  }
});

test("三条 JS 写类通道各自都有货：总数齐平不代表通道齐平", () => {
  const ch = jsChannels(read("popup.js"));
  assert.ok(ch.classList.has("wx-mode"), "classList 通道没抽到东西");
  assert.ok(ch.className.has("task-sub"), "className 通道没抽到东西");
  assert.ok(ch.cls.has("ok") && ch.cls.has("error"), "cls: 通道没抽到东西（状态色是拼出来的）");
});

/* ---------- 五、常驻对照：判据自己得红得出来 ---------- */

test("对照常驻：CSS 里改个名，正反两头都要红", () => {
  /* `card` 只有 HTML 用（JS 不写它），所以它同时打出正向的 HTML 那一头与反向 */
  const css = new Set(LEDGER.popup.css);
  css.delete("card");
  css.add("cardx");
  assert.ok(missing(LEDGER.popup.html, css).includes("card"), "HTML 那头的正向没红");
  assert.ok(missing(css, new Set([...LEDGER.popup.html, ...LEDGER.popup.js])).includes("cardx"),
    "反向没红：CSS 里凭空多出一个没人提的类");
  /* `task-sub` 只有 JS 写，改名打的是正向的 JS 那一头 */
  const css2 = new Set(LEDGER.popup.css);
  css2.delete("task-sub");
  assert.ok(missing(LEDGER.popup.js, css2).includes("task-sub"), "JS 那头的正向没红");
});

test("对照常驻：只改 JS 那一头，反向红在旧名字上", () => {
  const js = new Set([...LEDGER.popup.js].map((t) => (t === "task-sub" ? "taskSub" : t)));
  assert.ok(missing(LEDGER.popup.css, new Set([...LEDGER.popup.html, ...js])).includes("task-sub"),
    "只改 JS 时反向没红");
  assert.ok(missing(js, LEDGER.popup.css).includes("taskSub"), "只改 JS 时正向没红");
});

test("对照常驻：整本账换成空集合要红在下限上", () => {
  const floor = FLOORS.popup.css;
  assert.ok(new Set().size < floor, "下限写成 0 了：空集合也会绿");
});

/* ---------- 六、实测：改坏了到底谁红（红→绿对照表） ----------

   跑法：仓库外整仓副本（脚本与日志在 `D:/Github/_tar_ctl_r23/ctl23.mjs` / `ctl23.log`）。
   pre = 副本里删掉本文件（这本账是本轮新建的），post = 带着本文件；两侧都跑 validate + 全套。
   每台变异开跑前先逐台量 needle 在 pristine 里恰好命中一次。

   K0_pristine            pre 0 红 / post 0 红
   B1_css_rename_task_sub pre 0 红 / post 1 红：反向
   B2_js_rename_task_sub  pre 0 红 / post 4 红：正向(JS) | 反向 | 通道见证 | 常驻对照
   B3_html_dead_class     pre 0 红 / post 1 红：正向(HTML)
   B4_runtime_cls_drift   pre 1 红（红在 `popup-repopulate` 那条绿态用例）
                          post 2 红：正向(JS) + 那 1 条
   B5_css_unused_rule     pre 0 红 / post 1 红：反向
   B6_html_rename_shared  pre 0 红 / post 1 红：正向(HTML)
   B7_css_rename_html_only pre 0 红 / post 2 红：正向(HTML) | 反向

   怎么读这张表：
   1. 七台里六台改前全套零红。这一格的账此前只有一处：`.wx-state.ok` / `.error` 两个类在
      CSS 里存不存在（`popup-repopulate.test.mjs`），所以只有 B4 那种"改运行时状态类"在改前
      露出一点痕迹——而且露的不是归属，是那条用例自己按 `/\bok\b/` 去匹配 className 文本
   2. B1 只红一条而不是两条，因为 `task-sub` 这个类名在 `popup.css` 里出现在三条规则上
      （本体、`.task-sub .next`、`.task-sub .skip`）。改掉其中一条之后这个名字仍然"被定义着"，
      正向自然不红；红的是反向多出来的 `task-subx`。顺带说明这本账是类名级的，不是规则级
      （见下面边界第 3 条）
   3. B2 红四条里有两条是见证连带：那台把 `className = "task-sub"` 改了名，于是"通道见证"
      与"常驻对照"里指着 `task-sub` 的那两句跟着不成立。它们跟着红是对的（本文件承认的锚点变了），
      但真正的判据是前两条；条数不等于覆盖面
   4. B6 只红正向，因为 `hint` 这个类 HTML 与 JS 两边都在用：只改 HTML 那一头，反向看 JS
      仍然提到它。这正是"两边都提到"的类名改法必须连着改两处的理由，也是正向一条独立存在的价值
   5. B3 与 B5 是没有第二处的两类：往 HTML 加一个 CSS 里没有的类、往 CSS 加一条没人用的规则。
      探路实测抓到的真东西属于前一类（`wx-test`，本轮删掉）

   边界（这一根轴挡不住的）：
   1. 只认四种写类通道（`classList.*("…")`、`.className =/+= "…"`、`cls: "…"`、
      `setAttribute("class", "…")`），且串必须是字面量。`classList.add(...arr)` 这种抽不到东西
      （不抛错），后果是那几个类会在反向那一条被点名"没人提"——响的是反向，不是这里静默
   2. 类名必须整体是字面量：`className = "card " + kind` 只收到 `card`，`kind` 的值不在账上。
      今天没有这一路（探路时全仓库扫过），有了就要回来把那张取值表登记进 JS_SOURCES
   3. 类名级不是规则级：账只问"这个名字有没有定义、有没有人用"，不问"这条规则写没写对"。
      删掉整条 `.task-sub { … }` 而另外两条仍然提到 `task-sub`，本文件全绿——那是显示层的事，
      由 `scripts/screenshot-popup.mjs --measure`（高度）与 `skip-trace.test.mjs`（`.skip` 那条
      只上色不声明 display）各管一面
   4. 不核组合：`.wx-state.ok` 只要求 `wx-state` 与 `ok` 各自有着落，两个名字同时挂在一个
      元素上这件事不在账上（`popup-repopulate.test.mjs` 那一条"两个颜色类在 CSS 里真的存在"
      管的就是这一处，本文件不重复）
   5. 不核 CSS 属性值与选择器的正确性，也不核样式在真机上长什么样；`FLOORS` 是下限，
      加类不红，删到地板以下才红。新增一个带样式的页面要在这里登记一组下限，
      没登记的表现是"页面清单是现推的"那条点名它 */

