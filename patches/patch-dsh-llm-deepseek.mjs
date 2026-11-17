#!/usr/bin/env node
// 本地补丁：模型下发的工具入参不是合法 JSON 时，不再让整轮模型请求失败。
//
// 官方适配器在 message_stop 处对每个工具入参做 JSON.parse，失败就抛
// MALFORMED_RESPONSE，导致整个回合作废。而工具管线本身对非法 JSON 是宽容的
// （parseArguments 保留原文，类型化工具校验参数后抛 INVALID_ARGS，管线再把它
// 变成工具错误结果回给模型）。所以这里只把「中断」改成「跳过」，让错误走
// 已经存在的工具错误通道。
//
// 用法：
//   node patch-dsh-llm-deepseek.mjs [--root <dlx 目录>]... [--check]
// 退出码：0 已打或无需打；1 找不到可打的目标；2 目标存在但代码形状变了。

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE_PREFIX = '@deepseek-ai+dsh-llm-deepseek@';
const NEEDLE = /return malformed\("tool input is invalid JSON"\);/;
const REPLACEMENT = 'continue; /* local patch: invalid tool JSON 交给工具管线报错 */';
const MARKER = 'local patch: invalid tool JSON';

const args = process.argv.slice(2);
const roots = [];
let checkOnly = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--root') roots.push(resolve(args[++i]));
  else if (args[i] === '--check') checkOnly = true;
  else {
    console.error(`未知参数：${args[i]}`);
    process.exit(64);
  }
}
if (roots.length === 0) {
  roots.push(join(homedir(), '.cache/pnpm/dlx'), join(homedir(), '.local/share/pnpm/dlx'));
}

/** 递归收集所有 dsh-llm-deepseek 包目录。 */
function collect(dir, depth, found) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith(PACKAGE_PREFIX)) found.push(join(full, 'node_modules/@deepseek-ai/dsh-llm-deepseek'));
    else collect(full, depth + 1, found);
  }
}

const found = [];
for (const root of roots) if (existsSync(root)) collect(root, 0, found);

let patched = 0;
let already = 0;
const mismatched = [];
for (const pkg of found) {
  const file = join(pkg, 'lib/index.js');
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes(MARKER)) {
    already += 1;
    continue;
  }
  if (!NEEDLE.test(text)) {
    mismatched.push(pkg);
    continue;
  }
  if (checkOnly) {
    console.log(`would patch  ${file}`);
    patched += 1;
    continue;
  }
  const next = text.replace(NEEDLE, REPLACEMENT);
  const tmp = `${file}.patch-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
  console.log(`patched     ${file}`);
  patched += 1;
}

console.log(`\n目标包 ${found.length} 个：本次${checkOnly ? '待打' : '已打'} ${patched}，已打 ${already}，形状不符 ${mismatched.length}`);
for (const m of mismatched) console.log(`  形状不符（跳过）：${m}`);

if (patched === 0 && already === 0) {
  console.error('\n没有可用的目标：dlx 缓存里找不到预期的适配器代码。先启动一次服务让 pnpm dlx 落盘，再重跑本脚本。');
  process.exit(1);
}
if (mismatched.length > 0 && patched === 0) {
  console.error('\n所有目标代码形状都不符：适配器实现可能已变化，按新的实现重写补丁，不要强行替换。');
  process.exit(2);
}
