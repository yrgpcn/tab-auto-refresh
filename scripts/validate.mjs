#!/usr/bin/env node
/* 仓库级校验：JSON 可解析、JS 语法通过 node --check、manifest 与语言包键完整 */

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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

if (problems.length > 0) {
  console.error(`校验失败（${problems.length} 个问题）：`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

console.log(`校验通过：${jsFiles.length} 个 JS 文件，${jsonFiles.size} 个 JSON 文件`);
