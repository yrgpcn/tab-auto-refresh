/* 引用面的抽取，纯函数、不碰文件系统——给 scripts/validate.mjs 用，也给
   tests/tab-auto-refresh/validate-refs.test.mjs 直接喂字符串断言。
   为什么单独一个文件：这几条判据全是正则，"扫到了什么"必须能被单测直接钉住，
   而不是靠读 validate.mjs 的执行器推断（AGENTS.md 改法纪律第 1 条对工具脚本同样适用）。
   validate.mjs 自己从前没有任何门禁，正则写坏一处就静默变成"什么都没引用、什么都没缺"。
   五条通道各自独立：manifest 的 __MSG_、HTML 的本地 src/href、HTML 的 data-i18n*、
   JS 里 getMessage 的第一个实参、以及 JS 里别名包装的第一个实参（弹窗与微信教程页
   各有一个 msg(key)，键是从这里递给 getMessage 的——第四条看不见它，A26 补的就是这一条）。
   后两条只认字面量与三元里的字面量；写成变量的键由
   validate.mjs 那头"每个语言包键都得有人引用"的反向判据兜住——两头一夹，拼错键名
   要么"引用了不存在的键"红，要么"这个键没人用"红，两条路各堵一半。
   反向判据兜不住的是"语言包里根本没有的键"：它不在集合里，反向无账可查，正向这一头
   又因为走的是别名而看不见，于是一笔都不红。第五通道堵的正是这个洞
   第六判据是另一根轴（A27）：localePlaceholderFacts 从语言包量出"这句要几个替换值"，
   jsMessageCalls 从调用点量出"这次给了几个"，validate.mjs 把两边对上。前五条通道问的
   都是"键在不在"，位数对不上时它们全绿——键明明存在，Chrome 却把没填上的占位符原样
   吐进界面。抽取器一律判不了时表现也是不报错，所以那边配了数量下限 */

const LITERAL_RE = /"([^"\\\n]*)"|'([^'\\\n]*)'/g;
const MSG_RE = /__MSG_([A-Za-z0-9_]+)__/g;
/* 属性值单双引号都认：HTML 两种都合法，只认一种就是漏掉那条引用（假阴性，不报错但永远不校验） */
const ATTR_RE = /data-i18n(?:-[a-z]+)*\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const REF_RE = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/* 两种函数声明的形状，本仓库各存在一处，见 i18nAliases 的注释 */
const FUNC_DECL_RE =
  /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
const ARROW_DECL_RE =
  /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][A-Za-z0-9_$]*))\s*=>/g;
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

/* 一次调用被传进去的实参文本清单（按顶层逗号切开，括号与方括号与花括号都算一层）。
   前一个字符是标识符字符（含 $）的不算命中——那叫 anotherMsg( 与 setMsg(，
   是别的名字，把它们当成 msg( 会把无关字面量报成键名（假报警）。
   `chrome.i18n.getMessage(` 的前一个字符是点，那是真调用，要收。
   调用文本不完整也收：i18nAliases 喂进来的函数体是切出来的片段，右括号常常不在里面 */
function callArgsList(src, name) {
  const out = [];
  const needle = name + "(";
  let at = 0;
  while ((at = src.indexOf(needle, at)) >= 0) {
    const prev = at === 0 ? "" : src[at - 1];
    if (/[A-Za-z0-9_$]/.test(prev)) {
      at += needle.length;
      continue;
    }
    let i = at + needle.length;
    let depth = 1;
    const args = [];
    let arg = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) {
        args.push(arg);
        arg = "";
        continue;
      }
      arg += c;
    }
    args.push(arg);
    out.push(args);
    /* 扫描点只推进到本次调用名的左括号之后，不跳到右括号：实参里嵌套的同名调用
       （msg("a", msg("b"))）也是真调用，跳过去就静默少收一条 */
    at = at + needle.length;
  }
  return out;
}

function firstArgs(src, name) {
  return callArgsList(src, name).map((args) => args[0]);
}

/* 默认认 getMessage 这条直写通道；第二参数传别名可以把同一个抽取器指向包装函数 */
export function jsMessageKeys(src, fnName = "getMessage") {
  const out = [];
  for (const arg of firstArgs(src, fnName)) out.push(...stringLiterals(branchesOf(arg)));
  return out;
}

/* 一个实参文本里有几个替换值：数组字面量数顶层逗号（空数组 0 个），
   非空的其它写法在 Chrome 里就是"一个替换值"（getMessage(key, "x") 合法），
   但变量与展开给不了保证——数组还是字符串静态不知道，这种一律回 null 表示判不了。
   判不了不报错是可以的，判不了却被当成"对得上"不行，所以调用方要把 null 单独算一类 */
function substitutionCount(argText) {
  const arg = String(argText || "").trim();
  if (arg === "") return 0;
  if (arg.startsWith("[")) {
    const close = arg.lastIndexOf("]");
    const inner = arg.slice(1, close === -1 ? undefined : close).trim();
    if (inner === "") return 0;
    if (/\.\.\./.test(inner)) return null; /* 展开出来的个数判不了 */
    let depth = 0;
    let n = 1;
    for (const c of inner) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) n++;
    }
    return n;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg)) return null; /* 单个标识符：可能是数组 */
  return 1;
}

/* 字面键调用点：{ key, subs }。subs 是替换值个数，null 表示静态判不了。
   与 jsMessageKeys 的分工在那儿说清楚过：那一条要"凡是像键的都收下来"（宁可多收去比语言包），
   这一条要"只认整个第一个实参就是一个键"（三元与变量都对不上具体键，比对位数就是假报警）。
   第一个实参里带引号但不是纯键的（`"a" + x`）也落不进来，那是判不了的一类，不是违规 */
export function jsMessageCalls(src, fnName = "getMessage") {
  const out = [];
  for (const args of callArgsList(src, fnName)) {
    const first = String(args[0] || "").trim();
    const m = first.match(/^(?:"([^"\\\n]*)"|'([^'\\\n]*)')$/);
    if (!m) continue;
    out.push({ key: m[1] === undefined ? m[2] : m[1], subs: substitutionCount(args[1]) });
  }
  return out;
}

/* 语言包一侧的占位符事实：每个键回 { arity, undeclared, unused }。
   arity 是要传几个替换值；undeclared 是消息里写了 $NAME$ 却没在 placeholders 里声明，
   Chrome 的原样吐出来给用户看；unused 是声明了却没人在消息里引用，填进去的值无处可去。
   名字大小写按 Chrome 的口径忽略（消息里写 $SITE$、声明里叫 site 是合法的） */
export function localePlaceholderFacts(messages) {
  const out = [];
  for (const [key, entry] of Object.entries(messages || {})) {
    const msg = String((entry && entry.message) || "");
    const block = entry && entry.placeholders && typeof entry.placeholders === "object" ? entry.placeholders : {};
    const names = Object.keys(block);
    const used = [...msg.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)].map((m) => m[1].toLowerCase());
    const positional = [...msg.matchAll(/\$(\d+)(?!\w)/g)].map((m) => Number(m[1]));
    let arity = positional.length ? Math.max(...positional) : 0;
    for (const name of names) {
      const content = String((block[name] && block[name].content) || "");
      const m = content.match(/^\$(\d+)$/);
      if (m) arity = Math.max(arity, Number(m[1]));
    }
    out.push({
      key,
      arity,
      declared: names.length,
      undeclared: [...new Set(used)].filter((n) => !names.some((d) => d.toLowerCase() === n)),
      unused: names.filter((d) => !used.includes(d.toLowerCase())),
    });
  }
  return out;
}

/* 本文件里的"别名包装"：谁把自己的入参原样递给 getMessage，谁就是 getMessage 的别名。
   名字从源码现推，不写死一张别名表——写死就是第二份真相来源：弹窗那个 `function msg`
   改天叫 `lbl`，或者第三个页面又抄一个包装，表不会跟着动，那条通道静默回到零覆盖，
   而"扫不到键"在这套判据里的表现是不报错。
   两种写法都要认，因为它们在本仓库各存在一处：
     popup.js        `function msg(key, subs) { return chrome.i18n.getMessage(key, subs) || key; }`
     wechat-setup.js `const msg = (key) => chrome.i18n.getMessage(key) || key;`
   只认前者是当前最自然的写法，实测会把教程页整页文案留在射程外 */
export function i18nAliases(src) {
  const out = [];
  const add = (name, params, body) => {
    if (name === "getMessage" || out.includes(name)) return;
    const taken = params
      .split(",")
      .map((s) => (s.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) || [""])[0])
      .filter(Boolean);
    if (firstArgs(body, "getMessage").some((arg) => taken.includes(arg.trim()))) out.push(name);
  };
  let m;
  FUNC_DECL_RE.lastIndex = 0;
  while ((m = FUNC_DECL_RE.exec(src))) {
    add(m[1], m[2], blockBody(src, m.index + m[0].length - 1));
  }
  ARROW_DECL_RE.lastIndex = 0;
  while ((m = ARROW_DECL_RE.exec(src))) {
    const params = m[2] === undefined ? m[3] : m[2];
    add(m[1], params, exprBody(src, m.index + m[0].length));
  }
  return out;
}

/* 从 open 处的 '{' 走到配对的 '}'。走不到就取到文件尾：宁可多扫一段（顶多把不相干的
   字面量算进来，而那在反向判据那头本来就算"提到过"），也不要漏掉一个别名（静默零覆盖） */
function blockBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i);
  }
  return src.slice(open);
}

/* 箭头函数那种没有花括号的函数体：走到本层深度的第一个分号或闭合括号 */
function exprBody(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return src.slice(from, i);
      depth--;
    } else if (c === ";" && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
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
