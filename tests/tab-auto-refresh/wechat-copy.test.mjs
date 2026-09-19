/* A10 的门禁：微信文案内部自相矛盾——同一个数字两处不一样、同一个冒号两处口径不一样。
   这类毛病 validate.mjs 管不着（它只查两边的键齐不齐平，不看内容），代码也不会报错，
   受伤的是照着教程做的人：读到两个数字怀疑自己漏看，或按"换成英文冒号再试"把唯一合规的
   写法改坏。所以这里钉四件事：

   1. 凭据集合的大小从代码算（DEFAULT_SETTINGS 里的 wechat* 字段数），文案不许说小
   2. 集合与来源不许混：测试号页面上只有 N-1 项，第 N 项（模板 ID）是建模板时生成的
   3. 冒号只有一种口径：提到英文冒号的子句必须是否定句（"不要改用英文冒号"），
      出现"换成英文 :"这种把它当兜底建议的写法即红
   4. 给用户抄的模板示范只有一个来源——wechat-setup.html 的 <pre> 块，
      而它的变量名又来自 logic.js 的 WECHAT_TEMPLATE_KEYS。文案里每一处 {{x.DATA}}
      都必须带「关键词：」前缀（裸变量正是平台整行丢弃的那种写法）

   第 4 条是原先 _code-review/verify-wechat-template-doc.mjs 的入库替身：那份门禁不入库，
   新 clone 里没有它，示范跑偏无人拦。

   数字词由 N 现推（ZH_NUM / EN_NUM），将来真加第五项凭据时这里不会误报，要改的是教程文案。 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { DEFAULT_SETTINGS } from "../../tab-auto-refresh/shared/config.js";
import { WECHAT_TEMPLATE_KEYS } from "../../tab-auto-refresh/shared/logic.js";

const load = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const loadMessages = (rel) => {
  const raw = JSON.parse(load(rel));
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v.message || "");
  return out;
};

const LOCALES = {
  zh_CN: loadMessages("../../tab-auto-refresh/_locales/zh_CN/messages.json"),
  en: loadMessages("../../tab-auto-refresh/_locales/en/messages.json")
};
const SETUP_HTML = load("../../tab-auto-refresh/wechat-setup.html");
const POPUP_SRC = load("../../tab-auto-refresh/popup.js");

const ZH_NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const EN_NUM = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/* 凭据字段：wechatEnabled 是开关，不算凭据 */
const CRED_KEYS = Object.keys(DEFAULT_SETTINGS).filter(
  (k) => /^wechat[A-Z]/.test(k) && k !== "wechatEnabled"
);
const N = CRED_KEYS.length;
const PAGE_N = N - 1;

/* 扫到的文案量本身要够，否则"没找到违规"只是路径写错了 */
function wechatCopy(locale) {
  const hit = Object.entries(LOCALES[locale]).filter(
    ([k, v]) => /^wechat/.test(k) || /^guide/.test(k) || /WeChat/.test(v)
  );
  assert.ok(hit.length >= 30, `${locale} 只切出 ${hit.length} 条微信文案，needle 失效了，本文件是空跑`);
  return hit;
}

/* ---------- 事实本身 ---------- */

test("凭据字段数量：代码里是四项，弹窗 label 表与设置键一一对应", () => {
  assert.deepEqual(CRED_KEYS, ["wechatAppId", "wechatAppSecret", "wechatOpenId", "wechatTemplateId"]);
  const slice = POPUP_SRC.slice(
    POPUP_SRC.indexOf("const WECHAT_FIELD_LABEL_KEYS = {"),
    POPUP_SRC.indexOf("};", POPUP_SRC.indexOf("const WECHAT_FIELD_LABEL_KEYS = {"))
  );
  assert.ok(slice.length > 40, "没切到 WECHAT_FIELD_LABEL_KEYS，本条是空跑");
  const labels = [...slice.matchAll(/:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(labels.length, N, "弹窗的微信字段 label 数与设置里的凭据数不等，教程里的数字该改了");
  for (const key of labels) {
    assert.ok(LOCALES.zh_CN[key] && LOCALES.en[key], `${key} 没有语言包条目`);
  }
});

test("第四项凭据（模板 ID）不是从测试号页抄来的，弹窗占位符自己说清楚了", () => {
  for (const locale of Object.keys(LOCALES)) {
    const text = LOCALES[locale].wechatTplPlaceholder;
    assert.ok(text, "没有 wechatTplPlaceholder");
    assert.match(text, /新增测试模板|add a test template/, `${locale} 的模板ID占位符没说明它是建出来的`);
  }
});

/* ---------- 1. 集合大小 ---------- */

test("没有哪条文案把凭据集合说成三项", () => {
  const badZh = new RegExp(`${ZH_NUM[PAGE_N]}项\\s*(凭据|字段)`);
  const badEn = new RegExp(`\\b(${EN_NUM[PAGE_N]}|${PAGE_N})\\s+credentials?\\b`, "i");
  for (const [locale, re] of [["zh_CN", badZh], ["en", badEn]]) {
    for (const [key, text] of wechatCopy(locale)) {
      assert.ok(!re.test(text), `${locale}.${key} 把集合说成三个：${text}`);
    }
  }
});

/* ---------- 2. 集合与来源 ---------- */

test("没有哪条文案说四项都在测试号页一次拿到", () => {
  /* 反面就是 A10 报的那两处：wechatIntro "可一次拿到下面四项" 与 guideStep1Title
     "拿到四项凭据" 同 guideStep1Body2 "复制三项" 打脸 */
  const badZh = new RegExp(
    `${ZH_NUM[N]}项[^。；]{0,16}一次拿到|一次拿到[^。；]{0,16}${ZH_NUM[N]}项`
  );
  const badEn = new RegExp(
    `\\ball ${EN_NUM[N]}\\b|\\b${EN_NUM[N]}\\s+(credentials?|values?)\\b[^.]{0,60}\\b(page|sandbox)\\b`,
    "i"
  );
  for (const [locale, re] of [["zh_CN", badZh], ["en", badEn]]) {
    for (const [key, text] of wechatCopy(locale)) {
      assert.ok(!re.test(text), `${locale}.${key} 把来源说成整份都在页面上：${text}`);
    }
  }
});

test("说清来源的那几条仍然在，且都点到模板 ID 是后建的", () => {
  assert.match(LOCALES.zh_CN.wechatIntro, /新建测试模板|建.*模板/);
  assert.match(LOCALES.en.wechatIntro, /template ID/i);
  assert.match(LOCALES.zh_CN.guideStep1Body2, /三项/);
  assert.match(LOCALES.en.guideStep1Body2, /\bthree\b/i);
  /* 标题不带字段名、也不带"一次拿到"，前面两条聚合规则都抓不到它——A10 的原文正是
     这两处（guideStep1Title「拿到四项凭据」、wechatGuideHint「抄四项凭据 → 建模板」），
     所以按键位直查。第一步只产出 PAGE_N 项，数字词出现 N 就是错的 */
  const zhPage = new RegExp(`${ZH_NUM[PAGE_N]}项?`);
  const zhAll = new RegExp(`${ZH_NUM[N]}项`);
  assert.match(LOCALES.zh_CN.guideStep1Title, zhPage, `zh 第一步标题没写 ${ZH_NUM[PAGE_N]} 项`);
  assert.ok(!zhAll.test(LOCALES.zh_CN.guideStep1Title), `zh 第一步标题把页面上能抄的说成了 ${ZH_NUM[N]} 项`);
  assert.match(LOCALES.en.guideStep1Title, new RegExp(`\\b${EN_NUM[PAGE_N]}\\b`, "i"), "en 第一步标题没写 three");
  assert.ok(
    !new RegExp(`\\b${EN_NUM[N]}\\b`, "i").test(LOCALES.en.guideStep1Title),
    `en 第一步标题把页面上能抄的说成了 ${EN_NUM[N]}`
  );
  assert.match(LOCALES.zh_CN.guideStep2Title, new RegExp(`第${ZH_NUM[N]}项`));
  assert.match(LOCALES.en.guideStep2Title, new RegExp(`\\b${EN_NUM[N]}th\\b`, "i"));
  /* 步骤串里"抄"与"建模板"的先后：A10 之前 en/zh 的 wechatGuideHint 都写成先抄四项再建模板 */
  for (const locale of ["zh_CN", "en"]) {
    const hint = LOCALES[locale].wechatGuideHint;
    const copyAt = hint.search(/抄|copy/i);
    const tplAt = hint.search(/建模板|模板|template/i);
    assert.ok(copyAt >= 0 && tplAt >= 0, `${locale}.wechatGuideHint 步骤串被改得认不出了：${hint}`);
    assert.ok(copyAt < tplAt, `${locale}.wechatGuideHint 里"建模板"排在"抄"之前，模板 ID 无从抄起：${hint}`);
    assert.ok(
      !/四项凭据|三个凭据|\bfour credentials?\b/i.test(hint),
      `${locale}.wechatGuideHint 说"抄"整个集合，可第四项此刻还不存在：${hint}`
    );
  }
});

/* ---------- 3. 冒号口径 ---------- */

/* 按句子切：一个子句里提到英文冒号，就必须是否定句。
   "不要改用英文冒号——微信只认中文冒号" 合规；"把中文冒号换成英文 : 再试一次" 违规。
   英文的句点也算边界（K10 实跑踩过：只按中文句读切时，整段英文成一个子句，
   前一句的 "do not omit the Chinese colon" 会给后一句的兜底建议作证） */
const ASCII_MENTION = /(英文\s*[:：]|英文冒号|换成英文|ASCII\s*colon|an?\s+English\s+colon)/i;
const NEGATION = /(不要|不能|不可|不得|无需|别|never|not\b|no\b|nor\b|avoid)/i;
const CLAUSE_SPLIT = /[。；;—！!\n]|\.(?=\s|$)/;

test("教程只教一种冒号：提到英文冒号的子句一律得是否定句", () => {
  let seen = 0;
  for (const locale of Object.keys(LOCALES)) {
    for (const [key, text] of wechatCopy(locale)) {
      for (const clause of text.split(CLAUSE_SPLIT)) {
        if (!ASCII_MENTION.test(clause)) continue;
        seen++;
        assert.match(clause, NEGATION, `${locale}.${key} 把英文冒号当成可选写法教给用户：「${clause.trim()}」`);
      }
    }
  }
  /* 修完之后仓库里只剩 guideFixTemplate 一处否定句在提英文冒号；一条都没有说明扫描本身失效了 */
  assert.ok(seen >= 1 && seen <= 4, `整份文案里提到英文冒号的子句有 ${seen} 处，扫描needle 需要复核`);
});

test("要求中文冒号的口径在两份语言包里都还在", () => {
  for (const locale of Object.keys(LOCALES)) {
    assert.match(LOCALES[locale].guideStep2Why, /中文冒号|Chinese colon/);
    assert.match(LOCALES[locale].wechatTplBody, /中文冒号|Chinese colon/);
  }
});

/* ---------- 4. 示范同源 ---------- */

function setupSampleLines() {
  const m = SETUP_HTML.match(/<pre class="code">([\s\S]*?)<\/pre>/);
  assert.ok(m, "wechat-setup.html 里没有 <pre class=\"code\"> 示范块，本条是空跑");
  const lines = m[1].split("\n").map((s) => s.trim()).filter(Boolean);
  assert.equal(lines.length, WECHAT_TEMPLATE_KEYS.length, "示范行数与模板变量数不等");
  const names = lines.map((line, i) => {
    const one = line.match(/^(.+?)：\{\{(\w+)\.DATA\}\}$/);
    assert.ok(one, `第 ${i + 1} 行示范不是「关键词：{{变量.DATA}}」形态：${line}`);
    assert.ok(one[1].length <= 6, `第 ${i + 1} 行的关键词长得不像示例：${line}`);
    return one[2];
  });
  return { lines, names };
}

test("教程页的示范合规，且变量名与 logic.js 的 WECHAT_TEMPLATE_KEYS 同源", () => {
  const { names } = setupSampleLines();
  assert.deepEqual(names, WECHAT_TEMPLATE_KEYS.slice());
});

test("文案里每一处变量引用都带「关键词：」前缀", () => {
  /* 例外只允许是刻意示范错误写法的反例句，且该句必须自己点明那是反例 */
  const COUNTER_EXAMPLE = new Set(["guideStep2Why"]);
  for (const locale of Object.keys(LOCALES)) {
    for (const [key, text] of wechatCopy(locale)) {
      const hits = [...text.matchAll(/(.?)\{\{[^{}]*\.DATA\}\}/g)];
      if (COUNTER_EXAMPLE.has(key)) {
        assert.ok(hits.length > 0, `${locale}.${key} 已不在反例名单里，把它从 COUNTER_EXAMPLE 删掉`);
        assert.match(text, /光秃秃|bare/, `${locale}.${key} 出现裸变量，却没说明那是反例`);
        continue;
      }
      for (const hit of hits) {
        assert.equal(hit[1], "：", `${locale}.${key} 里的 ${hit[0].slice(1)} 前面不是中文冒号，照抄会得到空白卡片`);
      }
    }
  }
});

test("给出模板示范的三条文案，示范与教程页逐字符一致", () => {
  const { lines } = setupSampleLines();
  for (const locale of Object.keys(LOCALES)) {
    for (const key of ["wechatTplBody", "wechatErrTemplate", "guideFixTemplate"]) {
      const text = LOCALES[locale][key];
      assert.ok(text, `缺少 ${locale}.${key}`);
      for (const line of lines) {
        assert.ok(text.includes(line), `${locale}.${key} 少了教程页那行示范「${line}」，两处会各说一套`);
      }
    }
  }
});

/* ---------- 步数 ---------- */

test("教程实际步数与 guideIntro 里说的步数一致", () => {
  const steps = [...SETUP_HTML.matchAll(/data-i18n="guideStep(\d)Title"/g)].length;
  assert.equal(steps, 4, "教程页的步骤数变了，两步口径要一起复核");
  assert.match(LOCALES.zh_CN.guideIntro, new RegExp(`${ZH_NUM[steps]}步`));
  assert.match(LOCALES.en.guideIntro, new RegExp(`(${EN_NUM[steps]}|Four)\\s+steps`, "i"));
});

/* ---------- 5. 反空跑守卫 ---------- */

test("微信文案的条目数与语言包总量对得上，扫描不是空转", () => {
  for (const locale of Object.keys(LOCALES)) {
    const hit = wechatCopy(locale);
    const keys = hit.map(([k]) => k);
    for (const must of ["wechatIntro", "wechatTplBody", "wechatErrTemplate", "guideStep2Why", "guideFixTemplate"]) {
      assert.ok(keys.includes(must), `${locale} 扫不到 ${must}，过滤条件失效了`);
    }
  }
  assert.equal(Object.keys(LOCALES.zh_CN).length, Object.keys(LOCALES.en).length, "两份语言包键数不等（validate 之外再兜一层）");
});

/* ---------- 红→绿对照（2026-09-19 实跑，node v24.21.0） ----------

   做法：把修好之后的仓库副本放在仓库外（%LOCALAPPDATA%\node-tools\ctl-a10\pristine），
   每条变异只改一处、在副本里跑本文件，记录"跑出来的"红名单。
   跑手先做 needle 预检（命中数必须恰好 1），K2/K8 第一次就是因为这个被打回：
   K2 的 from 少写了语言包里的转义反斜杠，命中 0 次；
   K8 的 from 只引了示范那半句，而 en 的 wechatTplBody 也含同一串，命中 2 次。
   两条都是把 needle 换成整行 JSON 才成立的——不是文案有问题，是对照脚本有问题。

   K1  zh wechatIntro 回退"页面一次拿到四项"   → 红 2：来源说反了、来源那组键位直查
   K2  en wechatIntro 回退 "all four values"    → 红 2：同上
   K3  zh guideStep1Title 回退"拿到四项凭据"     → 红 1：键位直查
   K4  zh guideStep2Title 去掉"拿到第四项"      → 红 1：同上
   K5  zh wechatGuideHint 回退"抄四项→建模板"    → 红 1：同上
   K6  en wechatGuideHint 回退"copy four ..."   → 红 1：同上
   K7  zh wechatErrTemplate 回退裸变量示范       → 红 2：前缀扫描、与教程页逐字符比对
   K8  en wechatErrTemplate 同上                → 红 2：同上
   K9  zh guideFixTemplate 塞回"换成英文 :"      → 红 1：冒号口径
   K10 en guideFixTemplate 塞回 "ASCII colon"    → 第一次跑是绿的。补上"英文句点也算子句
        边界"之后才红 1 条：整段英文原先算一个子句，前一句里的 do not omit the Chinese
        colon 替后一句的兜底建议作了证。否定句判据只在子句内成立，边界切错就等于放宽
   K11 教程页 <pre> 改成裸变量两行              → 红 2：示范形态与变量同源、逐字符比对
   K12 logic.js 变量名改成 title/body           → 红 1：示范与代码同源
   K13 config.js 多出第五项凭据                 → 红 3：字段数、集合大小、键位直查
        （这条是故意不给过：N 一变，教程里所有数字词都得人工重核，不许静默放行）
   K14 弹窗 label 表少一项                      → 红 1：label 数与凭据数不等
   K15 zh 反例句去掉"光秃秃"                    → 红 1：裸变量必须自带反例标记
   K16 把语言包过滤条件改坏                      → 红 5：三条扫描加一条反空跑守卫
   K17 把英文冒号 needle 改成永不命中             → 红 1：seen 下限抓到它
   K18 反向对照：改一条守卫不该管的文案（guideRisk 换说法）→ 仍全绿（12 pass）
        没有这条，上面 17 红说明不了什么——"动一个字就红"的守卫同样能拿满分 */
