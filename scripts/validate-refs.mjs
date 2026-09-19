/* 引用面的抽取，纯函数、不碰文件系统——给 scripts/validate.mjs 用，也给
   tests/tab-auto-refresh/validate-refs.test.mjs 直接喂字符串断言。
   为什么单独一个文件：这几条判据全是正则，"扫到了什么"必须能被单测直接钉住，
   而不是靠读 validate.mjs 的执行器推断（AGENTS.md 改法纪律第 1 条对工具脚本同样适用）。
   validate.mjs 自己从前没有任何门禁，正则写坏一处就静默变成"什么都没引用、什么都没缺"。
   四条通道各自独立：manifest 的 __MSG_、HTML 的本地 src/href、HTML 的 data-i18n*、
   JS 里 getMessage 的第一个实参。第四条只认字面量与三元里的字面量；写成变量的键由
   validate.mjs 那头"每个语言包键都得有人引用"的反向判据兜住——两头一夹，拼错键名
   要么"引用了不存在的键"红，要么"这个键没人用"红，两条路各堵一半。 */

const LITERAL_RE = /"([^"\\\n]*)"|'([^'\\\n]*)'/g;
const MSG_RE = /__MSG_([A-Za-z0-9_]+)__/g;
/* 属性值单双引号都认：HTML 两种都合法，只认一种就是漏掉那条引用（假阴性，不报错但永远不校验） */
const ATTR_RE = /data-i18n(?:-[a-z]+)*\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const REF_RE = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const quoted = (m) => (m[1] === undefined ? m[2] : m[1]);

/* 一段文本里出现的所有字符串字面量（单双引号都认，跨行的模板字面量不认：
   那种写法在本仓库目前为零处，真出现时它落不进任何键，会由反向判据报出来）。
   它同时是给反向判据当"提到过"的全集：HTML 的属性值也是引号包着的，所以一条
   data-i18n 或 src/href 引用天然也算"提到过"。是"提到过"不是"取用过"——注释里手打的
   "keyName" 带引号同样算数，所以反向判据挡不住"删了引用、注释里还留着键名"那一种，
   宁可漏报也不去写一套认不出注释的切分 */
export function stringLiterals(src) {
  const out = [];
  let m;
  LITERAL_RE.lastIndex = 0;
  while ((m = LITERAL_RE.exec(src))) out.push(m[1] === undefined ? m[2] : m[1]);
  return out;
}

/* manifest 里任意一处 __MSG_key__：不只 name 与 description。
   action.default_title 与 commands.*.description 同样会被 Chrome 解析，
   键名拼错不会报错，只会让右键/悬停出现一块空白 */
export function manifestMsgKeys(manifest) {
  const out = [];
  const deep = (value, path) => {
    if (typeof value === "string") {
      let m;
      MSG_RE.lastIndex = 0;
      while ((m = MSG_RE.exec(value))) out.push({ path, key: m[1] });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => deep(v, path + "[" + i + "]"));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) deep(v, path ? path + "." + k : k);
    }
  };
  deep(manifest, "");
  return out;
}

/* HTML 里指向本目录文件的 src/href。绝对地址、协议相对、页内锚点都不算引用：
   插件只能加载自己目录里的文件，外链坏了不打包也不报错 */
export function htmlLocalRefs(src) {
  const out = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(src))) {
    const raw = quoted(m).trim();
    if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//") || raw.startsWith("#")) continue;
    out.push(raw.split(/[?#]/)[0]);
  }
  return out;
}

/* HTML 上那些 data-i18n 系列属性：值就是一个键（本仓库实测每个属性只放一个，
   仍然按空白拆开，多塞一个键也不会漏）。popup.js 与 wechat-setup.js 拿它去
   调 getMessage(变量)，所以这些键在 JS 那头扫不到——只能从这里进 */
export function htmlI18nKeys(src) {
  const out = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(src))) out.push(...quoted(m).trim().split(/\s+/).filter(Boolean));
  return out;
}

/* JS 里 getMessage 的**第一个实参**：字面量收下，三元表达式里的两个分支也收下，
   变量与模板字面量不猜。只取第一个实参是刻意的——第二个实参是 subs，那里的字面量
   是文案要填进去的值，不是键名，拿它去比对语言包必然假报警 */
export function jsMessageKeys(src) {
  const out = [];
  const needle = "getMessage(";
  let at = 0;
  while ((at = src.indexOf(needle, at)) >= 0) {
    let i = at + needle.length;
    let depth = 1;
    let arg = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) break; /* 第一个实参到此为止 */
      arg += c;
    }
    out.push(...stringLiterals(branchesOf(arg)));
    at = i;
  }
  return out;
}

/* 三元表达式里只有两个分支是键，条件那一侧的字面量是拿去比值的——不剥掉就假报警
   （第一次实跑正是被 background.js 的 p.reason === "captcha" 咬到，"captcha" 不是键）。
   只在最外层切第一刀，切点后的两截都当分支收下来。
   已知边界：条件里带 `?` 的字符串字面量会让这一刀切早，本仓库目前没有这种写法 */
function branchesOf(arg) {
  let depth = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "?" && depth === 0 && arg[i + 1] !== "?" && arg[i - 1] !== ".") return arg.slice(i + 1);
  }
  return arg;
}
