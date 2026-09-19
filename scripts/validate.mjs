#!/usr/bin/env node
/* 仓库级校验：JSON 可解析、JS 语法通过 node --check、manifest 与语言包键完整、
   文件与文案键的引用完整性（manifest / HTML / JS 三条通道，加"每条文案都有人引用"的反向判据）。
   抽取判据的正则住在 scripts/validate-refs.mjs，那边有单测钉着；这里只做遍历与报账。 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  htmlI18nKeys,
  htmlLocalRefs,
  i18nAliases,
  jsMessageKeys,
  manifestMsgKeys,
  stringLiterals,
} from "./validate-refs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function walk(dir, onFile) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, onFile);
    } else {
      onFile(full);
    }
  }
}

const jsFiles = [];
const jsonFiles = new Map();
walk(repoRoot, (path) => {
  if (path.endsWith(".js") || path.endsWith(".mjs")) {
    jsFiles.push(path);
  } else if (path.endsWith(".json")) {
    jsonFiles.set(path, null);
  }
});

for (const path of jsonFiles.keys()) {
  try {
    jsonFiles.set(path, JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    problems.push(`${path}: JSON 解析失败 (${e.message})`);
  }
}

for (const path of jsFiles) {
  /* 扩展脚本都是 ES module，复制为 .mjs 让 node --check 按模块语法检查 */
  const tmpDir = mkdtempSync(join(tmpdir(), "ext-syntax-"));
  const tmp = join(tmpDir, "check.mjs");
  try {
    copyFileSync(path, tmp);
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (res.status !== 0) {
      problems.push(`${path}: 语法检查失败\n${(res.stderr || "").trim()}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

for (const [path, manifest] of jsonFiles) {
  if (!path.endsWith(join("manifest.json")) || !manifest) continue;
  const pluginDir = dirname(path);
  if (manifest.manifest_version !== 3) {
    problems.push(`${path}: manifest_version 应为 3`);
  }
  if (!/^\d+(\.\d+){1,3}$/.test(String(manifest.version))) {
    problems.push(`${path}: version 格式无效`);
  }
  const localesDir = join(pluginDir, "_locales");
  if (!manifest.default_locale) {
    problems.push(`${path}: 缺少 default_locale`);
    continue;
  }
  const defaultMessagesPath = join(localesDir, manifest.default_locale, "messages.json");
  if (!existsSync(defaultMessagesPath)) {
    problems.push(`${path}: default_locale 语言包缺失`);
  }
  for (const field of ["name", "description"]) {
    const match = String(manifest[field] || "").match(/^__MSG_(.+)__$/);
    if (!match) continue;
    const messages = jsonFiles.get(defaultMessagesPath);
    if (messages && !(match[1] in messages)) {
      problems.push(`${path}: ${field} 引用了缺失的 i18n 键 ${match[1]}`);
    }
  }
  if (!existsSync(localesDir)) continue;
  const defaultKeySet = jsonFiles.get(defaultMessagesPath)
    ? new Set(Object.keys(jsonFiles.get(defaultMessagesPath)))
    : null;
  for (const locale of readdirSync(localesDir)) {
    const messagesPath = join(localesDir, locale, "messages.json");
    if (!existsSync(messagesPath)) {
      problems.push(`${messagesPath}: 缺少 messages.json`);
      continue;
    }
    const messages = jsonFiles.get(messagesPath);
    if (!messages) continue; /* JSON 错误已在上面记录 */
    for (const [key, value] of Object.entries(messages)) {
      if (!value || typeof value.message !== "string") {
        problems.push(`${messagesPath}: ${key} 缺少 message 字段`);
      }
    }
    /* 非默认语言包必须与默认语言包键集合完全齐平，防止新增文案漏翻译 */
    if (defaultKeySet && locale !== manifest.default_locale) {
      for (const key of defaultKeySet) {
        if (!(key in messages)) {
          problems.push(`${messagesPath}: 缺少默认语言包中的键 ${key}`);
        }
      }
      for (const key of Object.keys(messages)) {
        if (!defaultKeySet.has(key)) {
          problems.push(`${messagesPath}: 多出默认语言包中没有的键 ${key}`);
        }
      }
    }
  }
}

/* 引用完整性：manifest 与 JS 里引用到的运行时文件必须真实存在于插件目录。
   CI 从 tag 检出构建，若源码引用了未提交的文件，这里会失败拦住发布。 */
function resolveRef(pluginDir, ref) {
  const clean = ref.replace(/^\.\//, "").replace(/\\/g, "/");
  return join(pluginDir, clean);
}

for (const [path, manifest] of jsonFiles) {
  if (!path.endsWith(join("manifest.json")) || !manifest) continue;
  const pluginDir = dirname(path);
  const refs = new Set();
  if (manifest.background && manifest.background.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);
  for (const icons of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (icons && typeof icons === "object") for (const v of Object.values(icons)) refs.add(String(v));
  }
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) refs.add(f);
  }
  for (const key of ["popup", "options_page", "side_panel", "devtools_page"]) {
    if (typeof manifest[key] === "string") refs.add(manifest[key]);
  }
  for (const ref of refs) {
    if (!existsSync(resolveRef(pluginDir, ref))) {
      problems.push(`${path}: manifest 引用了不存在的文件 ${ref}`);
    }
  }
  /* JS 源码里的相对 import 与 "shared/xxx.js" "content/xxx.js" 形式的路径常量 */
  const importRe = /from\s+["'](\.[\w./-]+)["']/g;
  const pathRe = /["']((?:shared|content)\/[\w./-]+\.(?:js|css))["']/g;
  walk(pluginDir, (file) => {
    if (!/\.(js|mjs)$/.test(file)) return;
    const src = readFileSync(file, "utf8");
    const base = dirname(file);
    for (const re of [importRe, pathRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const target = m[1].startsWith(".")
          ? join(base, m[1])
          : resolveRef(pluginDir, m[1]);
        if (!existsSync(target)) {
          problems.push(`${file}: 引用了不存在的文件 ${m[1]}`);
        }
      }
    }
  });
  /* git 可用时，插件目录里不允许出现未跟踪文件：
     git archive 只打包已跟踪内容，未跟踪的运行时文件会静默缺件 */
  if (existsSync(join(repoRoot, ".git"))) {
    const res = spawnSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "--", pluginDir], { encoding: "utf8" });
    if (res.status === 0) {
      for (const untracked of res.stdout.split(/\r?\n/).filter(Boolean)) {
        problems.push(`${untracked}: 未纳入 git 跟踪，发布包会缺失该文件`);
      }
    }
  }
}

/* 名字层面的引用完整性。上面那一圈问的是"引用到的文件在不在"，这一圈问的是
   "引用到的文案键在不在"，以及反过来"语言包里的键有没有一处都没提"。
   三类失败全是静默的：键不存在时 chrome.i18n.getMessage 回空串，界面少一块而 CI 全绿；
   HTML 的 src/href 写错了浏览器只在控制台报 404，弹窗看着像缺样式。
   正向与反向是一夹：拼错键名要么"引用了没有的键"红，要么"这个键没人用"红，各堵一半 */
for (const [path, manifest] of jsonFiles) {
  if (!path.endsWith(join("manifest.json")) || !manifest) continue;
  const pluginDir = dirname(path);
  const localesDir = join(pluginDir, "_locales");
  if (!manifest.default_locale || !existsSync(localesDir)) continue;
  const messagesPath = join(localesDir, manifest.default_locale, "messages.json");
  const messages = jsonFiles.get(messagesPath);
  if (!messages) continue; /* JSON 错误与缺失已在上面记录 */
  const known = new Set(Object.keys(messages));

  const msgRefs = manifestMsgKeys(manifest);
  for (const { path: field, key } of msgRefs) {
    if (!known.has(key)) problems.push(`${path}: manifest ${field} 引用了语言包里没有的键 ${key}`);
  }

  const referenced = new Set(msgRefs.map((r) => r.key));
  walk(pluginDir, (file) => {
    if (file.startsWith(localesDir)) return;
    const isHtml = file.endsWith(".html");
    const isJs = /\.(js|mjs)$/.test(file);
    if (!isHtml && !isJs) return;
    const src = readFileSync(file, "utf8");
    for (const key of stringLiterals(src)) referenced.add(key);
    if (isHtml) {
      for (const ref of htmlLocalRefs(src)) {
        if (!existsSync(resolve(dirname(file), ref))) {
          problems.push(`${file}: 引用了不存在的文件 ${ref}`);
        }
      }
      for (const key of htmlI18nKeys(src)) {
        if (!known.has(key)) problems.push(`${file}: data-i18n 引用了语言包里没有的键 ${key}`);
      }
    }
    for (const key of jsMessageKeys(src)) {
      if (!known.has(key)) problems.push(`${file}: getMessage 引用了语言包里没有的键 ${key}`);
    }
    /* 别名通道：popup.js 与 wechat-setup.js 各有一个 msg(key) 把键递给 getMessage，
       上面那条正则看不见它们。别名名从本文件现推，不写死清单（理由见 validate-refs.mjs）。
       这一条不补，"新增一个语言包里根本没有的键"在两条判据上都不红：正向看不见别名，
       反向只查"语言包里的键有没有人提到"，而那个键压根不在语言包里。
       实测症状不致命（msg() 有 `|| key` 兜底，界面上露的是原始键名），但它是静默的 */
    for (const alias of isJs ? i18nAliases(src) : []) {
      for (const key of jsMessageKeys(src, alias)) {
        if (!known.has(key)) problems.push(`${file}: ${alias}() 引用了语言包里没有的键 ${key}`);
      }
    }
  });

  for (const key of Object.keys(messages)) {
    if (!referenced.has(key)) {
      problems.push(`${messagesPath}: 键 ${key} 在插件源码里没有一处提到`);
    }
  }
}

if (problems.length > 0) {
  console.error(`校验失败（${problems.length} 个问题）：`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

console.log(`校验通过：${jsFiles.length} 个 JS 文件，${jsonFiles.size} 个 JSON 文件`);
