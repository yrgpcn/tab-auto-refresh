/* 第十六轮审计（A34）：第十五轮留下的边界第 2 条——"只管名字，不管内容"。
   那一轮钉的是文案键怎么被取到，这一轮钉的是取到之后装不装得下。

   微信平台有一条硬限制写在 `logic.js` 的注释里也写在教程页里：模板消息单个字段不超过
   20 个字、不支持换行，超长由平台直接去掉、不留提示。插件的做法是自己先截（`clipOneLine`），
   于是超预算不会报错，只会让卡片少半句话。第十五轮的实测是：把 `wechatEvSessionShort`
   从"会话掉线"改成 26 个汉字，`validate.mjs` 与当时全套 525 条一条不红——改完每条掉线卡片
   的标题变成"会话掉线测试站点很长很长测试站点很…"，站点名永远不再出现，而这正是短事件名
   存在的理由（`AGENTS.md`：标题要和站点一起挤在 20 字里，英文长标签会把预算吃光）。

   为什么这台机器是瞎的：函数那一头其实钉得很死。`logic.test.mjs` 在任意预算下真跑
   `wechatTitleOf`，验过"事件名一个字不少""站点要么是 label 边界上的后缀、要么整段不要"
   "绝不越过 20 字"，用例里的标签是 `"keyword"`、`"任务自动停止"` 这些测试自己写的字符串。
   语言包改成什么样，它一个字都不知道。也就是说这根轴上的账是：
   算术有门禁，喂进算术的那两个加数没有门禁。

   加数有两个来源，都在 `background.js` 里，都不写死在本文件：
   - 事件标签：`WECHAT_EVENT_TITLE_KEYS` 的表值，加上 `postWechat` 里 `getMessage` 实参位置
     出现的字面量（含 `|| "wechatEvKeywordShort"` 那个兜底）
   - 站点与分隔符：标题 = 事件 + 分隔符 + 站点，分隔符 `wechatTitleSep` 也是语言包里的值，
     它占几个字是排版决定（zh " · " 三个、en "·" 一个），所以它也进预算账
   正文那一格同理会从 `WECHAT_BODY_KEYS` 与 `buildWechatContent` 的 `getMessage` 实参取值。

   两条地板一律从 `logic.js` 现推，不在本文件里抄第二个数：
   - 站点地板：`wechatTitleOf` 源码里那句 `if (budget < 4)`——余量小于它，代码对任何域名
     都整段丢掉站点，等于每张卡片的站点名永久消失
   - "看得见站点"的标准：`clipHostTail` 注释里那个例子（`a.b.c.example.com → …example.com`），
     用真跑的方式喂进去：带站点的事件，标题末尾要真出现 `example.com`

   分工，别把同一条判据记两遍：
   - `logic.test.mjs` 管 `wechatTitleOf` / `clipHostTail` / `clipOneLine` 的算术（合成输入、任意预算）
   - `wechat-copy.test.mjs` 管微信那一片文案的字面内容（冒号口径、三项/四项、示范与变量名同源），
     它一个字都不数
   - `i18n-indirection.test.mjs` 管键名通道（那个键存不存在、有没有人递它）
   - 本文件只管内容 vs 容量：这批文案的实际字数，过了那套算术之后还剩多少给站点、给占位符的值
   - `doc-numbers.test.mjs` 钉 `WECHAT_FIELD_MAX` 这个数在文档里没写错；它不量文案

   形状：常量与函数直接 import 真源码（`logic.js` 是纯模块，不需要 chrome 桩件），
   表与实参位置的字面量按文本切。与第十五轮相反，这里刻意要跑真函数：判据问的是
   "这两串文案相加之后还剩几个字"，那是求值的结果，扫源码扫不出来。
   本文件不出现任何一条文案的字面内容；判据里也不抄平台的字数上限与站点地板那两个数
   （前者 import `logic.js` 的真值，后者从它源码里那句 `if (budget < …)` 现推）。
   末尾对照表里为了描述现场提到过这两个数的值，那是记录，不是判据。

   实跑红→绿对照与已知边界记在文件末尾。 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTIFY_EVENTS,
  WECHAT_FIELD_MAX,
  WECHAT_TITLE_MAX,
  wechatTitleOf,
} from "../../tab-auto-refresh/shared/logic.js";
import {
  declarationBody,
  functionBody,
  getMessageArgs,
  objectPairs,
} from "../helpers/source-tables.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = join(repoRoot, "tab-auto-refresh");

const read = (rel) => readFileSync(join(pluginRoot, rel), "utf8").replace(/\r\n/g, "\n");
const cps = (s) => Array.from(String(s)).length;
const uniq = (list) => [...new Set(list)];

/* ---------- 一、取值原语：拿不到就抛，绝不静默少一条 ---------- */

function grabOne(label, src, re) {
  const m = src.match(re);
  if (!m) throw new Error(`取值失败：${label}，判据 ${re}`);
  return m.slice(1);
}

const logicSrc = read("shared/logic.js");
const bgSrc = read("background.js");

/* 站点地板：代码自己对"站点值不值得显示"的判断线 */
const HOST_FLOOR = Number(grabOne("站点地板", logicSrc, /if \(budget < (\d+)\)/)[0]);

/* "站点看得见"的标准：注释里那个例子，右边就是必须完整显示的部分 */
const [EXAMPLE_HOST, EXAMPLE_TAIL] = grabOne(
  "clipHostTail 的示范域名",
  logicSrc,
  /例：([a-z0-9.-]+)\s*→\s*…([a-z0-9.-]+)/
);

/* ---------- 二、卡片两个字段的键清单，从 background.js 现切 ---------- */

const titleTable = objectPairs(declarationBody(bgSrc, "WECHAT_EVENT_TITLE_KEYS"));
const bodyTable = objectPairs(declarationBody(bgSrc, "WECHAT_BODY_KEYS"));
const titleArgs = getMessageArgs(functionBody(bgSrc, "postWechat")).join("\n");
const bodyArgs = getMessageArgs(functionBody(bgSrc, "buildWechatContent")).join("\n");
const literalsIn = (s) => [...s.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).filter((k) => /^wechat[A-Z]/.test(k));

const TITLE_KEYS = uniq([...titleTable.entries.map((e) => e.key), ...literalsIn(titleArgs)]);
/* 分隔符与正文分家：它是标题那一格的加数，不是自己的字段 */
const SEP_KEYS = TITLE_KEYS.filter((k) => /Sep$/.test(k));
const EVENT_KEYS = TITLE_KEYS.filter((k) => !/Sep$/.test(k));
const BODY_KEYS = uniq([...bodyTable.entries.map((e) => e.key), ...literalsIn(bodyArgs)]);

const EVENT_OF_KEY = new Map(titleTable.entries.map((e) => [e.key, e.label]));

const LOCALES = [
  { name: "zh_CN", messages: JSON.parse(read("_locales/zh_CN/messages.json")) },
  { name: "en", messages: JSON.parse(read("_locales/en/messages.json")) },
];

const text = (loc, key) => {
  const entry = loc.messages[key];
  if (!entry) throw new Error(`${loc.name} 语言包里没有键 ${key}`);
  return entry.message;
};

/* 带站点的事件 = 真事件（`NOTIFY_EVENTS`）；test 那一格没有站点可显示 */
const HOSTED_EVENT_KEYS = uniq(
  titleTable.entries.filter((e) => NOTIFY_EVENTS.includes(e.label)).map((e) => e.key)
);

/* ---------- 三、判据 ---------- */

test("账本非空：两张表、两处实参、两个地板锚点都切到了真东西", () => {
  assert.equal(titleTable.entries.length, titleTable.slots, "标题表条目数不等于值槽数，抽取漏了");
  assert.equal(bodyTable.entries.length, bodyTable.slots, "正文表条目数不等于值槽数，抽取漏了");
  assert.ok(EVENT_KEYS.length >= 4, `只认出 ${EVENT_KEYS.length} 个事件标签键，这一轮要量的面塌了`);
  assert.ok(BODY_KEYS.length >= 4, `只认出 ${BODY_KEYS.length} 个正文键`);
  assert.deepEqual(SEP_KEYS.length === 1 ? [] : [`认出 ${SEP_KEYS.length} 个分隔符键，判据要重看`], []);
  assert.ok(HOST_FLOOR >= 1, `站点地板取到 ${HOST_FLOOR}，不像是个字数`);
  assert.ok(EXAMPLE_TAIL.length >= 4, `示范域名尾巴只有 "${EXAMPLE_TAIL}"，太短，量不出预算`);
  for (const loc of LOCALES) {
    for (const k of [...TITLE_KEYS, ...BODY_KEYS, ...SEP_KEYS]) cps(text(loc, k));
  }
  for (const n of [WECHAT_FIELD_MAX, WECHAT_TITLE_MAX]) {
    assert.ok(Number.isInteger(n) && n > 0, `平台字数上限取到 ${n}`);
  }
});

test("标题账：事件标签自己不许越过字段上限", () => {
  const bad = [];
  for (const loc of LOCALES) {
    for (const key of EVENT_KEYS) {
      const v = text(loc, key);
      if (cps(v) > WECHAT_TITLE_MAX) bad.push(`${loc.name}/${key} = ${cps(v)} 字`);
    }
  }
  assert.deepEqual(bad, [], "标签本身就超预算：进 wechatTitleOf 之前已经被截，事件名不再完整");
});

test("标题账：标签加分隔符之后，留给站点的余量不得小于代码自己的地板", () => {
  const tight = [];
  for (const loc of LOCALES) {
    const sep = text(loc, SEP_KEYS[0]);
    for (const key of EVENT_KEYS) {
      const room = WECHAT_TITLE_MAX - cps(text(loc, key)) - cps(sep);
      if (room < HOST_FLOOR) {
        tight.push(`${loc.name}/${key} 余量 ${room} < 地板 ${HOST_FLOOR}：这个事件的卡片永远没有站点名`);
      }
    }
  }
  assert.deepEqual(tight, []);
});

test("站点看得见：带站点的事件真跑 wechatTitleOf，示范域名的注册段要完整出现", () => {
  for (const loc of LOCALES) {
    const sep = text(loc, SEP_KEYS[0]);
    for (const key of HOSTED_EVENT_KEYS) {
      const label = text(loc, key);
      const title = wechatTitleOf({ eventLabel: label, host: EXAMPLE_HOST, sep });
      assert.ok(title.includes(EXAMPLE_TAIL), `${loc.name}/${key} 的标题 ${JSON.stringify(title)} 里没有 ${EXAMPLE_TAIL}`);
      assert.ok(title.startsWith(label), `${loc.name}/${key} 的标题把事件名切掉了：${JSON.stringify(title)}`);
      assert.ok(cps(title) <= WECHAT_TITLE_MAX, `${loc.name}/${key} 的标题 ${cps(title)} 字，超上限`);
    }
  }
});

test("分隔符：不许带换行或连续空白，它占的字数就是站点的预算", () => {
  const bad = [];
  for (const loc of LOCALES) {
    const sep = text(loc, SEP_KEYS[0]);
    if (!sep.length) bad.push(`${loc.name} 的分隔符是空串`);
    if (sep !== sep.replace(/\s+/g, " ")) bad.push(`${loc.name} 的分隔符含换行或连续空白：${JSON.stringify(sep)}`);
    if (!/[^\s]/.test(sep)) bad.push(`${loc.name} 的分隔符只有空白：${JSON.stringify(sep)}`);
    if (/^\s|\s$/.test(sep) && loc.name === "en") bad.push(`${loc.name} 的分隔符两头带空格，英文事件名本来就长：${JSON.stringify(sep)}`);
  }
  assert.deepEqual(bad, []);
});

test("正文账：底稿（去掉占位符）不许越过字段上限，带占位符的还要给值留下字数", () => {
  const bad = [];
  for (const loc of LOCALES) {
    for (const key of BODY_KEYS) {
      const v = text(loc, key);
      const base = v.replace(/\$\w+\$/g, "");
      const room = WECHAT_FIELD_MAX - cps(base);
      if (cps(base) > WECHAT_FIELD_MAX) {
        bad.push(`${loc.name}/${key} 底稿 ${cps(base)} 字 > ${WECHAT_FIELD_MAX}：还没填值就已经被截`);
      } else if (base !== v && room < 1) {
        bad.push(`${loc.name}/${key} 底稿占满 ${WECHAT_FIELD_MAX} 字，占位符的值一个字都显示不出来`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("正文账：卡片上的文案不以省略号结尾", () => {
  /* clipOneLine 截断时补的就是省略号，它同时是"这句话被切掉了"的标记。
     文案自己以省略号结尾，用户就分不出"内容就这些"和"后面还有话" */
  const bad = [];
  for (const loc of LOCALES) {
    for (const key of [...EVENT_KEYS, ...SEP_KEYS, ...BODY_KEYS]) {
      if (text(loc, key).endsWith("…")) bad.push(`${loc.name}/${key}`);
    }
  }
  assert.deepEqual(bad, [], "以 … 结尾的卡片文案：" + bad.join("、"));
});

test("账本齐平：语言包里长得像卡片文案的键，本文件都要算到", () => {
  /* 上一轮那种"新增一张表要记得登记"的毛病，在这一轮的形态是"新增一条短标签，
     预算账上却没有它"。这里反过来从语言包的命名族推账本覆盖面：
     wechatEv*Short / wechatBody* / wechatTestBody / wechatTitleSep 都要在账上 */
  const family = /^(wechatEv\w*Short|wechatEvTest|wechatBody\w+|wechatTestBody|wechatTitleSep)$/;
  const missing = [];
  for (const loc of LOCALES) {
    for (const key of Object.keys(loc.messages)) {
      if (family.test(key) && !TITLE_KEYS.includes(key) && !BODY_KEYS.includes(key)) {
        missing.push(`${loc.name}/${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], "这些文案会上卡片却没进预算账：" + missing.join("、"));
  /* 反方向：账上的键在两份语言包里都得真存在（拿不到就抛，这里先转成点名报错） */
  const absent = [];
  for (const loc of LOCALES) {
    for (const key of [...TITLE_KEYS, ...BODY_KEYS]) {
      if (!loc.messages[key]) absent.push(`${loc.name}/${key}`);
    }
  }
  assert.deepEqual(absent, []);
});

test("参照物：这根轴上真有事可审——最紧的一处余量必须已经贴到预算边上", () => {
  const margins = [];
  for (const loc of LOCALES) {
    const sep = text(loc, SEP_KEYS[0]);
    for (const key of EVENT_KEYS) margins.push(WECHAT_TITLE_MAX - cps(text(loc, key)) - cps(sep));
    for (const key of BODY_KEYS) {
      const v = text(loc, key);
      margins.push(WECHAT_FIELD_MAX - cps(v.replace(/\$\w+\$/g, "")));
    }
  }
  const min = Math.min(...margins);
  assert.ok(min >= 1, `最紧的一处余量是 ${min}，已经有文案越过了预算，上面那几条判据该红`);
  assert.ok(
    min <= 3,
    `最紧的一处余量是 ${min} 字，这一轮的判据已经没什么可挡的了：预算账空了，本文件可以删`
  );
});

/* ================= 实测红→绿对照（第十六轮，仓库外整仓副本 D:/Github/_tar_ctl_r16） =================

   每个变异在副本上跑两台机器：`node scripts/validate.mjs` 与仓库根那条全套单测命令。
   pre = 删掉本文件（等于本轮之前的世界），post = 留着本文件。基线 pristine：
   pre 525 全绿、post 534 全绿，两侧 validate 都通过。判据编号 V1~V9 就是本文件九条 test
   的次序。"看不见" = pre validate=OK 且 pre fail=0。

   变异                             pre           post fail   本文件红在哪条
   B1  zh 短标签改成 26 字          看不见             4        V2 V3 V4 V9   ← 第十五轮 W20
   B2  en 标签加长（仍不超上限）    看不见             1        V4
   B3  en 分隔符 "·" 改成 " - "     看不见             2        V4 V5
   B4  zh 分隔符带连续空格          看不见             1        V5
   B5  zh 正文底稿正好占满 20 字    看不见             2        V6 V9
   B6  en 正文超上限                看不见             2        V6 V9
   B7  zh 正文以 … 结尾             看不见             1        V7
   B14 zh 短标签只加 3 字           看不见             1        V4
   B9  注释里的示范尾巴改短         看不见             1        V1（取值失败即红）
   B8  新增一条短标签却不接         红(孤儿) + 2       3        V8            ← overlap
   B11 平台上限改成 10              红 3 条            7        V2 V3 V4 V9   ← overlap
   B13 分隔符在代码里写死           红(孤儿) + 2       8        V1 V3 V4 V5 V8 V9 ← overlap
   B12 表值换成未定义的调用         崩 191             崩 193   V1 V8（见下）
   B12b 表值换成等值的合法表达式    0                  0        ——（正确的绿）
   B10 代码把站点地板降到 1         0                  0        —— 仍然拦不住，见下面边界第 5 条

   四点从数字里读出来的话：
   - 净新增九条，第十五轮只有三条。差别不在判据写得多严，在换了一根轴：上一轮那根轴
     （键名通道）上，拼错键名十次有七次会让旧键成孤儿，反向判据当场就红，剩下的才是增量；
     这一轮那根轴（内容 vs 容量）上，文案变长一个字都不会让任何名字变成孤儿，所以
     改前那套机器（validate + 525 条）连一条都红不出来。选轴比堆判据值钱
   - B2 与 B14 是本文件存在的理由：标签仍然装得下 20 字（V2 绿）、余量仍然不小于代码
     自己的地板（V3 绿），只有真跑一遍 `wechatTitleOf` 才发现站点名整段没了。这两格
     挡住的是"算术判据全绿而现场已经坏了"那一类，也是 V4 不复用 V3 的那个余量差额
     （示范域名的注册段 11 字 > 地板 4 字）
   - overlap 三条留着不是凑数：B11 改的是平台常量本身，pre 那三条红来自 `logic.test.mjs`
     把 20 钉死了；B13 与 B8 改的是键的通道，pre 靠的是"旧键成孤儿"。同一条文案在两根轴上
     各有一半现场，两条判据各挡一半
   - B12 是本次跑法上一个真教训，别学：把表值换成未定义的调用，`background.js` 模块加载
     当场抛错，两侧各红 191/193 条，本轮的增量（V1、V8 那两条）被完全淹掉——数不出谁是谁。
     复跑 `--post-only` 单独点名才确认是那两条。换求值结果相同的合法表达式（B12b）之后
     两侧都绿，说明本文件要的只是"值槽里能认出那个字面量"，不要求写法干净。对照红得太碎
     与红不出来是同一个毛病的两面：红条数不等于覆盖面，要能逐条点名才算

   五条边界，写清楚免得后来人以为这一层什么都管：
   1. 只管卡片两个字段的容量。弹窗那两行状态（`.wx-state`，含 `wechatErr*` 那些 21~135 字的
      句子）的容量是 CSS 与版面定的，不在这一轮；`wechatHint` / `wechatIntro` 这类长文同理
   2. 站点那一头的余量按"示范域名的注册段要完整出现"判，不承诺任意真实域名都放得下——
      `clipHostTail` 的行为本来就是"放不下整段不要"，那是 `logic.test.mjs` 的账
   3. 正文的占位符值由用户填（关键词最长到 `logic.js` 的 KW_MAX_LEN 上限），长关键词必然被截，
      本文件只钉"值至少还剩一个字的位置"，不钉"关键词显示完整"
   4. 事件标签走的是"表值 + `getMessage` 实参位置的字面量"这一条抽取。将来若改成拼接
      （`"wechatEv" + pascal(event) + "Short"`）会切不到值，`slots` 与条目数不等会先红（V1），
      不会静默少覆盖
   5. 站点地板（`wechatTitleOf` 里那句 `if (budget < …)`）本文件跟着它放宽（B10 实测两侧全绿）。
      这是刻意的：地板是代码内部的产品判断，不是平台给的外部约束，写死它就成了第二份真相来源。
      它的代价也要说清楚：把地板降到 1 之后，短域名会被切成 `…e.com` 那种半截，而全套机器
      一声不响——`logic.test.mjs` 那条"绝不给碎片"的用例跑的是自己造的标签与域名，
      预算够宽时根本走不到地板那一步。要改地板的人，请同时想清楚这一条
*/
