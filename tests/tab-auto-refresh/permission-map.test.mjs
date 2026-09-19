/* 2026-09-19 审计 A30 的门禁：权限账另外几头没人核的地方。
   这本账有四段：AGENTS.md 的权限清单 ↔ manifest ↔ 源码里的真实调用点 ↔ 共享桩件暴露的表面，
   外加 host_permissions 一段。原先只有第一、二段之间有人核——AGENTS.md 那句"权限：a / b / c"
   与 manifest 的 permissions 数组齐不齐，由 doc-numbers.test.mjs 钉着（它的对照 D8 就是
   "往 permissions 加一项，只红那一条"）。名字对了不等于账对了，剩下这几头都没人核：
     ① 源码里每个 chrome.<api> 调用点，manifest 真给到它要的权限了吗
     ② manifest 里每一项权限，源码还有人在用吗（白要的那一类）
     ③ 共享桩件暴露的 chrome 表面，有没有宽到 manifest 之外
     ④ host_permissions 的 <all_urls> 由谁背书——源码里"按任意网址干活"的两类调用点
   ③ 是前两条为什么必须钉在这里、而不是"读代码相信"的原因：桩件那份 chrome 对象是人手抄的，
   抄的是代码当时用到了什么，不是代码被允许用什么。于是"新增一处 API 用法、忘了配权限"在真机上
   是 chrome.<api> 为 undefined → TypeError，而这类调用点多数带 .catch(() => {}) 或包在 try 里，
   表现是"这个功能就是不生效"；测试里桩件什么都给，全套照绿。这句不是推理：把 manifest 的
   "power" 删掉、连 AGENTS.md 那行权限清单一起改掉，本文件之外的整套 500 条全绿（对照 M1c），
   也就是说"缺权限"这个 bug 类在第十二轮之前整个仓库没有一面门拦得住。

   判据单向：调用点要权限、权限要有调用点，两个方向都致命于"静默"，所以都判。反过来
   "桩件比代码用得窄"不判——那种情况 import 期就抛 TypeError，是响的，不需要门禁（对照 M10：
   桩件删掉一个命名空间，整套 189 条红）。

   今天两边的账刚好对上：源码用到 14 个命名空间，其中 5 个不需要权限（action / commands /
   i18n / runtime / windows），剩下 9 个需要，与 manifest 那 9 项一一对应，无多无少。
   这张门禁钉的就是"无多无少"这四个字。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { makeEnv } from "../helpers/background-harness.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("../../tab-auto-refresh/", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
const GRANTED = new Set(MANIFEST.permissions || []);

/* 平台事实：哪个 API 要哪一项权限（Chrome 的 API 参考里每个命名页顶上的 Permissions 一段）。
   这里刻意不复制 manifest 的清单——那会变成第二份真相来源；null 表示该 API 不需要任何权限。
   表里的行比源码用到的多是故意的：多出来的这些正是"下一步最容易顺手加的 API"，
   而源码里出现表外的命名空间会红，逼人来查、来加行，不是逼人来放宽判据 */
const API_PERMISSION = {
  action: null,
  alarms: "alarms",
  bookmarks: "bookmarks",
  browsingData: "browsingData",
  commands: null,
  contextMenus: "contextMenus",
  cookies: "cookies",
  debugger: "debugger",
  downloads: "downloads",
  extension: null,
  history: "history",
  i18n: null,
  idle: "idle",
  management: null,
  notifications: "notifications",
  power: "power",
  runtime: null,
  scripting: "scripting",
  storage: "storage",
  tabGroups: "tabGroups",
  tabs: "tabs",
  topSites: "topSites",
  webNavigation: "webNavigation",
  webRequest: "webRequest",
  windows: null
};

/* ---------- 一、把插件源码的调用点收齐 ---------- */

function pluginJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pluginJs(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

/* 注释行不算证据。反向那条判据（"这项权限还有人用吗"）一旦被注释里的字样满足，
   "功能删了、注释留着"就成了永久白要一项权限，而且没人会知道——正是要防的那类静默。
   本仓库的注释一律整行成块（// 单独一行、/* 起一行、续行以 * 开头），按行筛就够；
   将来谁写进行尾块注释，这里会多算证据而不是漏算，表现是多绿一条、不会假红 */
function codeOnly(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const SOURCES = new Map();
for (const file of pluginJs(PLUGIN_DIR)) {
  SOURCES.set(relative(PLUGIN_DIR, file).replace(/\\/g, "/"), codeOnly(readFileSync(file, "utf8")));
}

/* ns -> 用到它的文件清单 */
const USED = new Map();
for (const [file, src] of SOURCES) {
  for (const m of src.matchAll(/(?<![\w.$])chrome\.([a-z][a-zA-Z0-9]*)\b/g)) {
    if (!USED.has(m[1])) USED.set(m[1], new Set());
    USED.get(m[1]).add(file);
  }
}
const whereUsed = (ns) => [...(USED.get(ns) || [])].sort().join("、");

/* 需要权限的那 9 个（今天）命名空间，倒推成"权限 demanded 集" */
const DEMANDED = new Set(
  [...USED.keys()].filter((ns) => ns in API_PERMISSION).map((ns) => API_PERMISSION[ns]).filter(Boolean)
);

/* ---------- 二、调用点 → 权限 ---------- */

test("源码里每一处 chrome.<api> 调用点，manifest 都要给到它要的权限", () => {
  assert.ok(USED.size >= 12, `只从插件源码切出 ${USED.size} 个 chrome 命名空间，扫描失效了，本条是空跑`);
  const unknown = [...USED.keys()].filter((ns) => !(ns in API_PERMISSION)).sort();
  assert.deepEqual(
    unknown,
    [],
    `源码用了 ${unknown.map((ns) => "chrome." + ns).join("、")}，这张表里没有这一行。` +
      `先去 Chrome 的 API 文档查它要哪一项权限、把行加进 API_PERMISSION，别直接放宽判据，也别只改 manifest 就完事`
  );
  const lacking = [...USED.keys()]
    .filter((ns) => API_PERMISSION[ns] && !GRANTED.has(API_PERMISSION[ns]))
    .sort();
  assert.deepEqual(
    lacking,
    [],
    lacking
      .map(
        (ns) =>
          `${whereUsed(ns)} 里的 chrome.${ns} 要 "${API_PERMISSION[ns]}" 权限，manifest 里没有——` +
          `真机上 chrome.${ns} 是 undefined，测试里桩件照给（桩件抄的是代码用法，不是权限）`
      )
      .join("；")
  );
});

test("manifest 里每一项权限，源码要有一处真实调用点为它背书", () => {
  /* 空跑风险在这一条最隐蔽：demanded 集切空了，"多要权限"就永远查不出来吗？不——那时
     GRANTED 里的每一项都成了多余的，整条红。真正要防的是切歪成"少切一个命名空间"，
     那会让一项本来在用的权限看起来没人用（假红，响）。所以下限按今天的事实给：
     9 项权限一项都不能少背书，命名空间 14 个 */
  assert.ok(DEMANDED.size >= 9, `只倒推出 ${DEMANDED.size} 项权限，调用点扫描切歪了，本条是空跑`);
  const stale = [...GRANTED].filter((p) => !DEMANDED.has(p)).sort();
  assert.deepEqual(
    stale,
    [],
    `manifest 声明了 ${stale.map((p) => `"${p}"`).join("、")}，插件源码里却一处都没用到它。` +
      `权限要么在 AGENTS.md 的清单与 README 的安全说明里点名、要么就是白要——去掉它，` +
      `连同那三处说明一起改（纪律 2）；若是调用点换了形状，去补 API_PERMISSION 那张表`
  );
});

/* ---------- 三、host_permissions 与需要它的两类调用点 ---------- */

/* 只数两类"确实要 host 权限"的形状：service worker 里裸调 fetch（MV3 下跨源请求要 host 权限）、
   scripting.executeScript 注进任意页面。cookies.getAll 不列进来——它要的是 cookies 权限本身，
   归上面那条管，把它算成 host 权限的证据是猜的 */
const SHAPES = {
  fetch: [...SOURCES.values()].reduce((n, src) => n + [...src.matchAll(/(^|[^.\w])fetch\s*\(/g)].length, 0),
  executeScript: [...SOURCES.values()].reduce(
    (n, src) => n + [...src.matchAll(/chrome\.scripting\.executeScript\s*\(/g)].length,
    0
  )
};

test("host_permissions 必须正好是 <all_urls>：两类按任意网址干活的调用点在源码里", () => {
  assert.ok(
    SHAPES.fetch >= 3 && SHAPES.executeScript >= 3,
    `裸 fetch ${SHAPES.fetch} 处、executeScript ${SHAPES.executeScript} 处，比预期少：` +
      `真把这两类都删干净了，<all_urls> 就是白要，那要连着 AGENTS.md 那条"试过按需申请、硬伤是夺焦点"的决定一起重看，` +
      `不是把本条的下限调小`
  );
  assert.deepEqual(
    [...(MANIFEST.host_permissions || [])].sort(),
    ["<all_urls>"],
    `host_permissions 现在是 ${JSON.stringify(MANIFEST.host_permissions)}。` +
      `收窄成按站点清单会让静默心跳、webhook 与注入对没列进去的网址直接失败；` +
      `改成按需申请则回到 AGENTS.md 记着的那个老问题（授权框夺焦点、任务不自动续跑）`
  );
});

/* ---------- 四、桩件暴露的表面 ---------- */

test("共享桩件的 chrome 表面不许宽到 manifest 之外", () => {
  /* 这一条是整个门禁里最要紧的一条：它守的不是插件，是"这套测试看不看得见缺权限"这件事本身。
     桩件多一个 API，代码就敢多用一个 API，而 manifest 没给——从此缺权限这类 bug 结构性不可测。
     桩件少一个 API 不判：background.js 在 import 期就会 TypeError，是当场崩的 */
  const stubbed = Object.keys(makeEnv().chrome).sort();
  assert.ok(stubbed.length >= 14, `桩件只暴露 ${stubbed.length} 个命名空间，本条是空跑`);
  const beyond = stubbed
    .filter((k) => API_PERMISSION[k] && !GRANTED.has(API_PERMISSION[k]))
    .sort();
  assert.deepEqual(
    beyond,
    [],
    `桩件里有 ${beyond.map((k) => "chrome." + k).join("、")}，而 manifest 没给对应权限：` +
      `用例在桩件上跑得通、真机上那一块根本不存在。要么补权限（并逐条记账），要么把这段桩件删掉`
  );
});

/* 红→绿对照（整仓副本放仓库外，别污染 validate.mjs 的全仓扫描；脚本
   D:/Github/_tar_ctl_r12/run.mjs，一轮只改坏一处，needle 命中数不对就地报错）。
   基线：副本里本文件 4 条全绿；整套 504 条全绿。

   2026-09-19 实跑结果（13 处，红名单是跑出来的、不是推的）：
     M1  manifest 删掉 "power"（chrome.power 三处调用点留着）→ 红 2 条：
         「调用点要权限」+「桩件宽于 manifest」。两条一起红不是冗余——后一条正是前一条
         在本轮之前看不见的原因（桩件给着 power，代码就敢用，测试就照绿）
     M1b 同上，但把本文件删掉 = 改前的世界 → 整套 499 绿 / 1 红，唯一那条红是
         doc-numbers 的「对账 35：AGENTS.md 的权限清单」：它红的是"文档与 manifest 名字对不上"，
         不是"这个 API 没权限"
     M1c 把 M1b 那处改坏做得更体面：连 AGENTS.md 那行清单一起删掉 power → 整套 500 绿 / 0 红。
         **这一处才是本轮的账**：一次"权限与文档同步改掉"的删除，在改前的世界里零反应
     M1d 同 M1c 但留着本文件 → 红 2 条（同 M1），名字层面的对账闭嘴也拦不住调用点这头
     M2  manifest 加一项没人用的 "bookmarks" → 红 2 条：本文件「每项权限要有调用点背书」
         +「对账 35」。一条管名字一条管调用点，两头各堵一半
     M3  桩件 chrome 对象里多一个 bookmarks（代码还没用它）→ 只红「桩件宽于 manifest」。
         这一处是结构性的：不拦这一步，将来代码用上它时 M1 那一类 bug 就再次不可测
     M4  插件源码的筛法改成一个不存在的后缀 → 红 3 条，三条下限全响。
         「扫不到东西」在这一面门里必须是红而不是绿
     M5  host_permissions 整个删掉 → 只红 host 那条（裸 fetch 与 executeScript 都还在源码里）
     M6  host_permissions 收窄成 ["https://*.example.com/*"] → 同上红 1 条
     M7  popup.js 注释里提一句 chrome.bookmarks + manifest 声明 bookmarks → 红「每项权限要有
         调用点背书」：注释不算证据，功能删了注释留着就是白要一项权限
     M8  反向：只有那句注释、不声明权限 → 4 条全绿。同一处过滤的两个方向都验过，
         判据不是"提到 chrome. 就红"
     M9  background.js 插一行用 chrome.tts（表外 API）→ 红「调用点要权限」，走的是"表里没有
         这一行"那一支：新 API 必须先来查权限、加表行，不许直接在 manifest 里加一项就完事
     M10 反向（另一头不判）：桩件删掉 commands，比代码用得窄 → 整套 315 绿 / 189 红，
         全是 import 期 TypeError。这就是这一头不需要门禁的意思：它是当场崩的那一类

   已知边界（别当成已覆盖）：
   - 表里那些"源码还没用到"的行是按 Chrome 文档抄的，本轮只逐条核过真用到的那 14 行。
     抄错一行的表现是：那项 API 一旦用上，判据要么假绿要么假红，不会自己承认抄错了
   - host 权限那条只认两类形状（service worker 裸 fetch、scripting.executeScript）。将来出现
     第三种需要 host 权限的调用点（如 tabs.query 带 url 过滤），本条不受影响；反过来若那两类
     都被删干净，本条会假红一次——那时该重看的是 <all_urls> 这项授权本身还该不该留
     （AGENTS.md 记着按需申请为什么试过又回退），而不是把下限数字调小
   - 钉的是"权限给了没有"，不钉 API 的版本门槛（30 秒 alarms 依赖 minimum_chrome_version 120
     那一类事实仍在 AGENTS.md 与 manifest 里，没有像素级判据）
   - 桩件与真实 Chrome 的形状差异不在本文件射程内：桩件给了 chrome.tabs.get 但少返回一个字段，
     那是背景桩件自己的账（见其文件头与 A6 那一串） */
