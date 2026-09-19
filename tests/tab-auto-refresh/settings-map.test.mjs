/* 2026-09-19 审计 A31 的门禁：设置这本账的五段，原先一段都没人对过账。
   这本账有五个名字要互相指认：config.js 的 DEFAULT_SETTINGS 键 ↔ 弹窗 saveSettings 发出的载荷键
   ↔ popup.html 里能填值的控件 ↔ 插件源码里的读写点 ↔ NOTIFY_EVENTS 与弹窗那四个事件格。
   原先只有两头有人核：弹窗内部「保存读到的控件」与「回流铺的控件」必须同源
   （popup-settings-sync.test.mjs 的清单同源那条），以及「popup.js 取的 id 在 HTML 里存在」
   （popup-repopulate.test.mjs，A29）。中间那几段——键名对不对得上、控件有没有人取、
   取值方式对不对得上控件类型、事件清单齐不齐——一个判据都没有。

   为什么这类漂移不会自己出声，每一条都有一个具体的静默形状：
   ① 载荷里多出一个 DEFAULT_SETTINGS 没有的键：save-settings 进后台第一站就是
      pickKnownSettings(msg.settings, DEFAULT_SETTINGS)，未知键**丢弃**。于是用户点那个开关
      当场看着是生效的（弹窗控件已改），下一笔读盘又回到默认值，后台一个字节都不报错。
   ② 键在 defaults 里、源码再没人读它：存盘里躺着一个不生效的开关，还跟着 sync 漫游到
      用户别的设备、占 8KB 配额（AGENTS.md 记着这正是"只管键不管值"那道闸的理由，
      可它只管外来键，不管自家 defaults 里长出来的死键）。
   ③ 键没有任何写入点：新装用户永远取默认值，弹窗里也没有一格能改它——读得到却没人写得出来。
   ④ popup.html 里摆着一个 input，popup.js 一处都不取它：用户看得见、点得动，
      但那一格从不进载荷，重开弹窗就回到旧值。A29 那条判据是单向的（"取的控件在不在"），
      反方向在它自己文件末尾记成 N8 并且**刻意判绿**——它守的不是这一头。
   ⑤ 用 .checked 去读一个 type="text" 的框：undefined 进载荷，JSON 序列化时整个键消失，
      于是"这一格永远存不下去"；反过来用 .value 读复选框，拿到的是 "on"，
      存下去的是一个永远真值的开关。两者都不抛错。
   ⑥ 事件清单漂一格：NOTIFY_EVENTS 加第五项而弹窗没有格，用户就永远关不掉那一类通知；
      弹窗格子里的事件名拼错一个字母，那一格勾选等于没勾（出口比的是 includes(event)），
      表现是"我明明勾了关键词命中，命中了却不发通知"；反方向同样静默——后台写一处
      notifyOut("新名字") 而清单里没有它，任何勾选组合都匹配不上，那一类通知一条都发不出去。

   判据形状：①②③⑥ 双向都判（多一个、少一个都要人来对账），④⑤ 只判"HTML 有格却没人取"
   与"取的方式不对"这一头——反方向（popup.js 取了 HTML 里没有的 id）是当场崩的那一类：
   $(id) 返回 undefined，.checked 立刻 TypeError，弹窗整页白，A29 已把它钉在渲染通道上，
   这里不重复钉，只在下面边界里记一句谁钉着它。

   ①⑤⑥ 跑的是**真实源码**：把 saveSettings 整段切出来、注入假 $ 与假 send 真跑一次，
   载荷键与事件数组是求值求出来的，不是正则数出来的。理由与 A18 那批一样——正则数出来的是
   "源码长什么样"，求值求出来的才是"发出去的是什么"，而这两处会分叉（把某个键挪进 notifyEvents
   那种嵌套结构里，正则的缩进判据就会数歪；popup-settings-sync 钉的正是那个数出来的 15）。
   ②③④ 只能扫源码，扫法与 A30 同规：注释行不算证据——popup.js 的注释里满是设置键名，
   把它们当读点等于"功能删了、注释留着"也算有人在用。

   今天五段账全对得上：defaults 16 个键，弹窗载荷 15 个（差的 lastIntervalSec 由后台
   patchSettings 写，快捷键与右键「开始」都记它），16 个键在 config.js 之外各有读点与写点，
   HTML 里 22 个能填值的控件全被 popup.js 取用，用 .checked 读的 9 个全是复选框、
   用 .value 读的 5 个全不是，事件清单五处名字（清单、弹窗格子、载荷数组、notifyOut 调用点、
   格子类型）一一对齐。这张门禁钉的就是"对得上"这四个字。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTIFY_EVENTS } from "../../tab-auto-refresh/shared/logic.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = join(ROOT, "tab-auto-refresh");
const read = (f) => readFileSync(join(PLUGIN_DIR, f), "utf8").replace(/\r\n/g, "\n");
const POPUP_SRC = read("popup.js");
const HTML_SRC = read("popup.html");
const CONFIG_SRC = read("shared/config.js");

/* DEFAULT_SETTINGS 的键：按两格缩进的对象字面量切。config.js 里这个形状只此一处
   （PRESETS 是数组、里面的对象是两格缩进带 key/seconds，被下面的排除项挡掉） */
const DEFAULT_KEYS = [
  ...CONFIG_SRC.slice(CONFIG_SRC.indexOf("export const DEFAULT_SETTINGS = {"))
    .matchAll(/^  ([A-Za-z0-9_]+):/gm)
]
  .map((m) => m[1])
  .filter((k) => k !== "key" && k !== "seconds");

/* ---------- 一、真跑一次 saveSettings，拿它实际发出去的载荷 ---------- */

function sliceFunction(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`源码里找不到 ${header}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${header} 的花括号没闭合`);
}

const SAVE_SRC = sliceFunction(POPUP_SRC, "async function saveSettings(");

/* 每个控件回一个"看得出取值方式"的对象：checked 恒真、value 是 id 本身，
   于是事件的条数与顺序都来自真实表达式，而不是这张表里的常量 */
const $stub = (id) => ({ checked: true, value: id });

let sent = null;
await new Function("$", "send", `${SAVE_SRC}\nreturn saveSettings;`)(
  $stub,
  async (m) => {
    sent = m;
  }
)();
const PAYLOAD_KEYS = Object.keys(sent.settings);

/* ---------- 二、HTML 侧的账：能填值的控件与它们的类型 ---------- */

const CONTROLS = [...HTML_SRC.matchAll(/<(?:input|select)\b[^>]*>/g)]
  .map((m) => ({
    id: (m[0].match(/\bid="([A-Za-z0-9_]+)"/) || [])[1] || null,
    type: (m[0].match(/\btype="([a-z]+)"/) || [])[1] || "text"
  }))
  .filter((c) => c.id && c.type !== "hidden");
const typeOf = new Map(CONTROLS.map((c) => [c.id, c.type]));
const CHECKISH = new Set(["checkbox", "radio"]);

/* popup.js 用 $() 取过的 id（全文，不只 saveSettings） */
const TAKEN = new Set([...POPUP_SRC.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]));

/* 载荷里每个键的取值方式：key: $("id").checked / .value  */
const ACCESS = new Map();
for (const m of SAVE_SRC.matchAll(/(\w+):\s*\$\("([A-Za-z0-9_]+)"\)\.(checked|value)\b/g)) {
  if (!ACCESS.has(m[2])) ACCESS.set(m[2], new Set());
  ACCESS.get(m[2]).add(m[3]);
}
/* 事件格子藏在数组字面量里：$("webhookEvSession").checked && "session-lost" */
const EVENT_FROM_CHECK = new Map();
for (const m of SAVE_SRC.matchAll(/\$\("([A-Za-z0-9_]+)"\)\.checked\s*&&\s*"([a-z-]+)"/g)) {
  EVENT_FROM_CHECK.set(m[1], m[2]);
}

/* ---------- 三、源码读写点 ---------- */

const CODE = new Map();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".js")) {
      CODE.set(
        relative(PLUGIN_DIR, full).replace(/\\/g, "/"),
        readFileSync(full, "utf8")
          .split("\n")
          .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
          .join("\n")
      );
    }
  }
})(PLUGIN_DIR);
const OUTSIDE_CONFIG = [...CODE].filter(([f]) => f !== "shared/config.js");

/* 读点 = 属性访问 X.key，或解构/简写里的 { key } / , key,
   写点 = 对象字面量里的 key:（花括号、圆括号、方括号、逗号之后） */
const has = (re, list) => list.filter(([f, v]) => re.test(v)).map(([f]) => f);
const readsOf = (key) =>
  has(new RegExp(`[A-Za-z0-9_$]\\.${key}\\b|[{,]\\s*${key}\\s*[,}]`), OUTSIDE_CONFIG);
const writesOf = (key) => has(new RegExp(`[{,([]\\s*${key}\\s*[:=]`), OUTSIDE_CONFIG);

/* ---------- 判据 ---------- */

test("空跑守卫：载荷、控件、读写点、两张控件表都切到真数量", () => {
  assert.equal(sent.type, "save-settings", "切出来的 saveSettings 发的不是 save-settings");
  assert.ok(PAYLOAD_KEYS.length >= 15, `载荷只 ${PAYLOAD_KEYS.length} 个键，判据 ① 是空跑`);
  assert.ok(DEFAULT_KEYS.length >= 16, `只从 config.js 切出 ${DEFAULT_KEYS.length} 个默认键`);
  assert.ok(CONTROLS.length >= 20, `只认出 ${CONTROLS.length} 个能填值的控件，HTML 扫描失效`);
  assert.ok(TAKEN.size >= 40, `popup.js 只认出 ${TAKEN.size} 个 $() 用法，扫描失效`);
  assert.ok(ACCESS.size >= 13, `取值方式表只认出 ${ACCESS.size} 个控件，正则切歪，⑤ 是空跑`);
  assert.ok(EVENT_FROM_CHECK.size >= 4, "事件格子只认出 " + EVENT_FROM_CHECK.size + " 个");
  assert.ok(OUTSIDE_CONFIG.length >= 5, `config.js 之外只切出 ${OUTSIDE_CONFIG.length} 个源文件`);
});

test("① 弹窗发出的每个设置键，都要在 DEFAULT_SETTINGS 里登记过", () => {
  const unknown = PAYLOAD_KEYS.filter((k) => !DEFAULT_KEYS.includes(k)).sort();
  assert.deepEqual(
    unknown,
    [],
    `saveSettings 发了 ${unknown.join("、")}，config.js 的 DEFAULT_SETTINGS 里没有这一项。` +
      `后台第一站是 pickKnownSettings，它把这个键整个丢掉：用户点了看着生效，落盘时一个字都没存，` +
      `后台也不报错。要么把键补进 DEFAULT_SETTINGS（连带默认值与文档，纪律 2 与 3），要么这格本来就不该发`
  );
});

test("②③ 每个设置键在 config.js 之外都要有读取点，也要有写入点", () => {
  const noRead = DEFAULT_KEYS.filter((k) => readsOf(k).length === 0);
  assert.deepEqual(
    noRead,
    [],
    `DEFAULT_SETTINGS 里的 ${noRead.join("、")} 在 config.js 之外没有任何一处读它。` +
      `没人读的开关会跟着 sync 漫游到用户其它设备、占 8KB 配额，在存盘里也永远改不掉任何行为——` +
      `功能删了就把它从 DEFAULT_SETTINGS 一起拿掉（连同 AGENTS.md 的清单，纪律 2）；` +
      `功能还在的话去补读点，别只留一个默认值`
  );
  const noWrite = DEFAULT_KEYS.filter((k) => writesOf(k).length === 0);
  assert.deepEqual(
    noWrite,
    [],
    `DEFAULT_SETTINGS 里的 ${noWrite.join("、")} 没有任何一处写它：这个键永远只能取默认值，` +
      `弹窗里也没有一格能改它。要么给它一条写入路径，要么整个删掉（同纪律 2）`
  );
});

test("④ popup.html 里每个能填值的控件，popup.js 要至少取它一次", () => {
  const dead = CONTROLS.map((c) => c.id).filter((id) => !TAKEN.has(id)).sort();
  assert.deepEqual(
    dead,
    [],
    `#${dead.join("、#")} 摆在弹窗里、用户点得动，popup.js 却一处都没有 $() 它。` +
      `那一格既不进 saveSettings 的载荷、也不被回流同步铺回去：它从来没生效过，重开弹窗就回到旧值。` +
      `接上去，或者把格子删掉（A29 只管反方向，这一头由本条钉）`
  );
});

test("⑤ 取值方式与控件类型对得上：.checked 只对复选框，.value 不对复选框", () => {
  const bad = [];
  for (const [id, kinds] of [...ACCESS].sort()) {
    const type = typeOf.get(id);
    assert.ok(type, `#${id} 被 saveSettings 取值，HTML 的能填值控件清单里却没有它`);
    if (kinds.has("checked") && !CHECKISH.has(type)) {
      bad.push(`#${id} 用 .checked 读，HTML 里却是 type="${type}"（存进去的是 undefined，序列化时整个键消失）`);
    }
    if (kinds.has("value") && CHECKISH.has(type)) {
      bad.push(`#${id} 用 .value 读，HTML 里却是 type="${type}"（拿到的是 "on"，是一个永远真值的开关）`);
    }
  }
  assert.deepEqual(bad, [], `取值方式与控件类型对不上：\n   ${bad.join("\n   ")}`);
});

test("⑥ 事件清单五处名字一一对齐：清单、弹窗格子、真跑出的载荷、notifyOut 调用点、控件类型", () => {
  /* 复选框全勾时发出的数组：来自真跑，不是手抄 */
  assert.deepEqual(
    sent.settings.notifyEvents,
    NOTIFY_EVENTS.slice(),
    `全勾时发的是 ${JSON.stringify(sent.settings.notifyEvents)}，NOTIFY_EVENTS 是 ${JSON.stringify(NOTIFY_EVENTS)}：` +
      `名字漂一格，出口那句 includes(event) 就永远不认这一格，用户勾了却一条都收不到`
  );
  const named = [...EVENT_FROM_CHECK.values()];
  assert.deepEqual(
    [...named].sort(),
    [...NOTIFY_EVENTS].sort(),
    `弹窗格子里写的事件名是 ${named.join("、")}，NOTIFY_EVENTS 是 ${NOTIFY_EVENTS.join("、")}：` +
      `清单里多出来那项用户永远关不掉，格子里多出来那个等于死勾`
  );
  /* 调用点这头才是"这一格到底发不发得出去"的账。刻意不拿"字符串在哪个文件出现过"当证据：
     logic.js 里 NOTIFY_EVENTS 的声明本身就含这四个字面量，那样判据是自证（对照 T6c 第一次跑） */
  const EMITTED = new Map();
  for (const m of (CODE.get("background.js") || "").matchAll(/notifyOut\(\s*"([a-z-]+)"/g)) {
    EMITTED.set(m[1], (EMITTED.get(m[1]) || 0) + 1);
  }
  assert.ok(EMITTED.size >= 4, `后台只认出 ${EMITTED.size} 个 notifyOut 事件字面量，扫描切歪`);
  const neverSent = NOTIFY_EVENTS.filter((ev) => !EMITTED.has(ev));
  assert.deepEqual(
    neverSent,
    [],
    `${neverSent.join("、")} 在清单里、弹窗里有格子，后台却没有一处 notifyOut("…") 发它：` +
      `那一格勾与不勾都一样，而且没人会知道（发不出去不是错误，是一条都不发）`
  );
  const unlisted = [...EMITTED.keys()].filter((ev) => !NOTIFY_EVENTS.includes(ev)).sort();
  assert.deepEqual(
    unlisted,
    [],
    `background.js 里 notifyOut("${unlisted.join("、")}") 发的是清单外的名字：` +
      `出口的 includes(event) 对任何勾选组合都为假，那条通知永久发不出去。` +
      `「发送测试」不走 notifyOut（它直接调两个出口并带 ignoreToggle），所以它不算在这里`
  );
  /* 事件格子那几处不走 ACCESS 的形状（藏在数组字面量里），类型单独核一遍 */
  for (const [id, ev] of [...EVENT_FROM_CHECK].sort()) {
    assert.ok(
      CHECKISH.has(typeOf.get(id)),
      `#${id} 是事件 "${ev}" 的格子，HTML 里却不是复选框（type="${typeOf.get(id)}"）`
    );
  }
});

/* 红→绿对照（整仓副本放仓库外，别污染 validate.mjs 的全仓扫描；脚本
   D:/Github/_tar_ctl_r13/run.mjs，一轮只改坏一处，needle 命中数不对就地报错。
   needle 一律挑单行：helpers/background-harness.mjs 与部分文件是 CRLF，多行 needle 会命中 0 次。

   基线：副本里本文件 6 条全绿；整套 510 条全绿（本文件之前是 504）。
   *_old_world 那几处把本文件删掉、跑整套，看的就是"改前的世界"有没有反应。

   2026-09-19 实跑结果（18 处，红名单是跑出来的、不是推的）：
     T1  载荷里新增一个 defaults 没有的 junkSwitch → 红「① 载荷键要登记过」
     T1_old_world 同上但删掉本文件 → 整套 503 绿 / 1 红，红的是 popup-settings-sync 的
         「控件清单同源」（它数出键数从 15 变 16）。那是计数守卫，不是对账：它说不出
         "这个键会被 pickKnownSettings 丢掉"，见下面 T1c
     T1c 把新增改成改名（keepAlive → keepAliveV2，键数仍是 15）→ 红 2 条：① 与 ②③
     T1c_old_world 同上但删掉本文件 → **整套 504 绿 / 0 红**。用户点"后台保活"这个开关
         从此永远存不下去，改前的世界一个字都不会说。这一处是本轮的账
     T2  defaults 里长出一个没人读也没人写的 legacyNag → 红「②③ 读写点」
     T2c 同上，但把 AGENTS.md 的默认关清单一起改掉、并删掉本文件 → 整套 503 绿 / 1 红，
         红在 screenshot-mock 的「每个场景给全 DEFAULT_SETTINGS 的每一个键」。这一处要老实记下：
         "死键"这一类旧世界并非全盲，但那面门钉的是"场景清单齐不齐"，把新键补进场景清单它就闭嘴，
         没人读写这件事它始终看不见
     T4  默认藏着的微信二级视图里摆一格 popup.js 从不取的复选框 → 红「④ 控件要有人取」。
         刻意放在二级视图：A28 的高度那条与 doc-numbers 的开关格数那条都不该被惊动，
         那两条红了对本轮反而是噪音
     T4_old_world 同上但删掉本文件 → 整套 504 绿 / 0 红
     T5  cookieBackupCheck 的 type 从 checkbox 改成 text → 红「⑤ 取值方式对得上类型」
     T5_old_world 同上但删掉本文件 → 整套 504 绿 / 0 红
     T5b 反过来：wechatEnabled 改用 .value 读复选框（拿到 "on"，一个永远真值的开关）→ 红 ⑤
     T6  NOTIFY_EVENTS 加第五项、弹窗没有格 → 红 ⑥（用户永远关不掉那一类通知）
     T6b 格子里的事件名拼错一个字母（keyword → keywrod）→ 红 ⑥（勾了那一格等于没勾）
     T6c 第五个事件五处全接上、只漏后台的 notifyOut 调用点 → 红 ⑥（这一格永远发不出去）
     T6d 反方向：后台 notifyOut("keyword") 改成 notifyOut("keyword-hit") → 红 ⑥
         （清单外的名字对任何勾选组合都匹配不上，那条通知一条都发不出去）
     T7  反向（不该红）：HTML 里多一个没人取的 div → 6 条全绿。④ 只管能填值的控件
     T8  反向（不该红）：五处一起加第五个事件、连 popup-settings-sync 的夹具一起补上 →
         6 条全绿。判据钉的是"五处对齐"，不是"四项"这个数字
     T9  把 config.js 里一个键的缩进改掉（DEFAULT_KEYS 少切一个）→ 红 2 条：
         空跑守卫 + ①。"切不出东西"在这一面门里必须是红而不是绿

   两处实跑出来的教训：
   1) T6c 第一次跑是**绿的**。原先那条判据拿"事件字符串在 config.js 之外还出现在哪个文件"
      当证据，而 logic.js 里 NOTIFY_EVENTS 的声明本身就含这五个字面量——判据在自证。
      换成"background.js 必须有一处 notifyOut("事件名") 调用点"之后 T6c 才红。
      这与 A30 记的"桩件抄的是代码用法、不是代码权限"是同一类错：出现在别处不等于被用
   2) T1 与 T1c 的分工不是冗余：新增键那一头旧世界有个计数守卫会响（响的那一类不需要门禁），
      真正静默的是改名——所以本轮把账钉在"发出的键 ↔ defaults 的键"这件事本身，
      而不是"载荷有 15 个键"

   已知边界（别当成已覆盖）：
   - 写点认的是对象字面量里的 key: 与赋值 key =；计算键（s[k] = ...、Object.fromEntries）
     不算证据。将来出现那种写法时 ③ 会假红一次（响的），不会假绿
   - 读点认 X.key 与解构 { key }；settings["key"] 这种字符串下标不算，同样是假红那一侧
   - ④ 只管 input 与 select（type="hidden" 除外）。HTML 里多一个没人取的 div / a / button 不判
     （T7 已验），按钮"有没有绑事件"是另一本账（A29 与 popup-repopulate 只管 id 取得到）
   - ① 与 A18 的「控件清单同源」重叠而不重复：那条钉"保存读的控件＝回流铺的控件"，
     本条钉"发出的键＝defaults 登记过的键"，两头各堵一半
   - 钉的是"键与控件对不对得上"，不钉值的形状：一个开关存进去的是字符串 "true" 还是布尔，
     由读侧的 normalizeStoredSettings 负责，那一头归 logic.test.mjs
   - 弹窗控件与 i18n 标签键的对齐、以及占位符位数，分别由 A27/A28 那两轮钉着，不在本文件射程内 */
