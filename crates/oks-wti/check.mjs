// oks-wti 的验收（Node，不装任何依赖）：能力清单 + 闭包性 + 报错与 trap。
//
//   cargo build --release --target wasm32-unknown-unknown
//   node crates/oks-wti/check.mjs [wasm 路径]
//
// 验收三件事：① 零 host imports —— 能力只可能来自白名单那一张表（就是 lib.rs 里的组装行）；
// ② 正面能力与行为逐个钉住（含日历语义）；③ 闭包性（同一批程序在任何宿主环境下逐字节一致）与
// 报错排版、trap 行为。跑两遍比指纹：`TZ=UTC node check.mjs > a; TZ=Asia/Shanghai FOO=1 node check.mjs > b; diff a b`。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2]
  ?? resolve(here, '../../target/wasm32-unknown-unknown/release/oks_wti.wasm');

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);
const instantiate = () => new WebAssembly.Instance(module, {}).exports;
let instance = instantiate();

const put = (exports, text) => {
  const buf = new TextEncoder().encode(text);
  const ptr = exports.alloc(buf.length);
  new Uint8Array(exports.memory.buffer, ptr, buf.length).set(buf);
  return { ptr, len: buf.length };
};

/** 跑一次：`call(程序, 输入?, 程序名?)` → { status, text }。status 0 = 结果，1 = 错误。 */
const call = (program, input = 'null', path = '') => {
  const exports = instance;
  const programBuf = put(exports, program);
  const pathBuf = put(exports, path);
  const inputBuf = put(exports, input);
  const out = exports.run(
    programBuf.ptr, programBuf.len, pathBuf.ptr, pathBuf.len, inputBuf.ptr, inputBuf.len, 0);
  const view = new DataView(exports.memory.buffer);
  const status = view.getUint8(out);
  const len = view.getUint32(out + 1, true);
  const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, out + 5, len));
  exports.dealloc(out, 5 + len);
  exports.dealloc(programBuf.ptr, programBuf.len);
  exports.dealloc(pathBuf.ptr, pathBuf.len);
  exports.dealloc(inputBuf.ptr, inputBuf.len);
  return { status, text: text.trim() };
};

let failed = 0;
const fingerprint = [];
const check = (label, ok, detail) => {
  fingerprint.push(`${label}=${detail}`);
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(34)} ${String(detail).replace(/\n/g, ' ⏎ ').slice(0, 68)}`);
};

// ① 引擎不带任何宿主能力：一个 import 都不许有。
check('host imports 为空', WebAssembly.Module.imports(module).length === 0,
  JSON.stringify(WebAssembly.Module.imports(module)));

// ② 允许的：通用纯 filter 与纯时间。
for (const [label, program, want] of [
  ['map(.+1)', '[1,2,3] | map(.+1)', '[2,3,4]'],
  ['sort', '{"b":1,"a":2} | keys_unsorted | sort', '["a","b"]'],
  ['todate（UTC）', '0 | todate', '"1970-01-01T00:00:00Z"'],
  ['fromdate 往返', '"2026-10-15T00:00:00Z" | fromdateiso8601 | todate', '"2026-10-15T00:00:00Z"'],
  ['gmtime_tz（上海）', '0 | gmtime_tz("Asia/Shanghai")', '[1970,0,1,8,0,0,4,0]'],
  ['gmtime_tz（DST 当天）', '1772928000 | gmtime_tz("America/New_York")', '[2026,2,7,19,0,0,6,65]'],
  ['墙钟数组再格式化', '1700000000 | gmtime_tz("Asia/Shanghai") | strftime("%Y-%m-%d %H:%M")', '"2023-11-15 06:13"'],
]) {
  const { status, text } = call(program);
  check(label, status === 0 && text === want, `status=${status} ${text}`);
}

// ③ 纯能力组（math / regex / format）：整组接进来，期望值是与 jaq CLI 逐条对照过的
//    （22/22 一致，连浮点打印与 scan 的语义都一样），所以这里既钉住能力、也钉住行为。
for (const [label, program, want] of [
  ['pow', 'pow(2;10)', '1024.0'],
  ['sqrt', '9 | sqrt', '3.0'],
  ['ilogb', '8 | ilogb', '3'],
  ['tgamma', '5 | tgamma', '24.0'],
  ['copysign', 'copysign(3;-1)', '-3.0'],
  ['scalbln', 'scalbln(1;10)', '1024.0'],
  ['remainder', 'remainder(10;3)', '1.0'],
  ['@base64', '"abc" | @base64', '"YWJj"'],
  ['@base64d', '"YWJj" | @base64d', '"abc"'],
  ['@html', '"<a href=\\"x\\">" | @html', '"&lt;a href=&quot;x&quot;&gt;"'],
  ['@uri', '"a b/c" | @uri', '"a%20b%2Fc"'],
  ['test', '"abc" | test("b")', 'true'],
  ['match（"g"）', '"a1b2" | [match("[0-9]"; "g") | .string]', '["1","2"]'],
  ['capture', '"2026-10-15" | capture("(?<y>[0-9]{4})").y', '"2026"'],
  ['split', '"a,b,c" | split(",")', '["a","b","c"]'],
]) {
  const { status, text } = call(program);
  check(label, status === 0 && text === want, `status=${status} ${text}`);
}

// ④ 坏输入要明确报错（错误路径是正面行为：说清哪里不对，而不是静默算错）。
const badZone = call('0 | gmtime_tz("Mars/Olympus")');
check('未知时区名明确报错', badZone.status === 1 && badZone.text.includes('time zone'), badZone.text);

// ⑤ 模块指令：这条求值路上没有文件系统，`include` / `import` 一律拒（包括"导入了但不使用"
//    ——以前那种写法会静默成功，用到时把引擎 panic 掉）；但不能误伤字段名、字符串与注释。
for (const [label, program] of [
  ['include 被拒', 'include "x"; .'],
  ['import 被拒', 'import "x" as $y; .'],
  ['import 后用 $y 也被拒（不再是 panic）', 'import "x" as $y; $y'],
  ['注释后的 include 也被拒', '# 注释\n include "x"; .'],
]) {
  const { status, text } = call(program);
  check(label, status === 1 && text.includes('没有文件系统'), `status=${status} ${text}`);
}
for (const [label, program, want] of [
  ['字段名叫 import 不误判', '{"import":1} | .import', '1'],
  ['字符串里的 import 不误判', '"import"', '"import"'],
  ['注释里的 import 不误判', '# import\n1', '1'],
  ['字段名叫 include 不误判', '(.include // 1)', '1'],
]) {
  const { status, text } = call(program);
  check(label, status === 0 && text === want, `status=${status} ${text}`);
}

// ⑥ 报错排版（与 jaq CLI 同一套，只是不上色）：要说清「文件名 + 行号 + 出错那一行」。
const syntax = call('1 |', 'null', '.work/probe.jq').text;
check('语法错：带程序名与插入符',
  syntax.includes('Error:') && syntax.includes('.work/probe.jq') && syntax.includes('1 |') && syntax.includes('┬'),
  syntax);
const inlineError = call('1 |').text;
check('语法错：不给名字时写 <inline>', inlineError.includes('<inline>'), inlineError);
const undefinedFilter = call('nope(1)', 'null', '.work/probe.jq').text;
check('未定义 filter：报出名字与位置',
  undefinedFilter.includes('undefined') && undefinedFilter.includes('nope') && undefinedFilter.includes('.work/probe.jq'),
  undefinedFilter);
check('运行时错：一句话说清（不带调试痕迹）',
  call('1 + "a"').text === 'cannot calculate 1 + "a"', call('1 + "a"').text);

// ⑦ 日历运算（受控内建）：加减按**墙钟**走、月末钳制、对齐到日历边界（周从周一）。
//    这些都是原来 time_calc 的语义，现在必须在 jq 里表达得出来。
for (const [label, program, want] of [
  ['月末钳制（1/31 + 1 月）',
    '("2026-01-31T00:00:00+08:00" | fromdateiso8601) | tzadd("month"; 1; "Asia/Shanghai") | gmtime_tz("Asia/Shanghai") | .[0:3]',
    '[2026,1,28]'],
  ['跨 DST 加一天（墙钟同点 = 23 小时）',
    '("2026-03-07T12:00:00-05:00" | fromdateiso8601) as $t | [($t | tzadd("day"; 1; "America/New_York") | gmtime_tz("America/New_York") | .[0:6]), (($t | tzadd("day"; 1; "America/New_York")) - $t)]',
    '[[2026,2,8,12,0,0],82800]'],
  ['加 24 小时（精确时长）',
    '("2026-03-07T12:00:00-05:00" | fromdateiso8601) as $t | [($t | tzadd("hour"; 24; "America/New_York") | gmtime_tz("America/New_York") | .[0:6]), (($t | tzadd("hour"; 24; "America/New_York")) - $t)]',
    '[[2026,2,8,13,0,0],86400]'],
  ['floor 周（周一起）',
    '("2026-10-15T13:45:00+08:00" | fromdateiso8601) | tzfloor("week"; "Asia/Shanghai") | gmtime_tz("Asia/Shanghai") | .[0:6]',
    '[2026,9,12,0,0,0]'],
  ['floor 季',
    '("2026-10-15T13:45:00+08:00" | fromdateiso8601) | tzfloor("quarter"; "Asia/Shanghai") | gmtime_tz("Asia/Shanghai") | .[0:6]',
    '[2026,9,1,0,0,0]'],
  ['ceil 日 = 次日 00:00',
    '("2026-10-15T13:45:00+08:00" | fromdateiso8601) | tzceil("day"; "Asia/Shanghai") | gmtime_tz("Asia/Shanghai") | .[0:6]',
    '[2026,9,16,0,0,0]'],
  ['ceil 月（1/31 → 2/1）',
    '("2026-01-31T00:00:00+08:00" | fromdateiso8601) | tzceil("month"; "Asia/Shanghai") | gmtime_tz("Asia/Shanghai") | .[0:6]',
    '[2026,1,1,0,0,0]'],
]) {
  const { status, text } = call(program);
  check(label, status === 0 && text === want, `status=${status} ${text}`);
}
const badUnit = call('0 | tzadd("fortnight"; 1; "Asia/Shanghai")');
check('非法时间单位明确报错', badUnit.status === 1 && badUnit.text.includes('不是时间单位'), badUnit.text);

// ⑦½ 时区版原生函数：`_tz` 后缀 = 原生同名函数 + 一个 zone 参数（名字与参数个数照原生那套写）。
for (const [label, program, want] of [
  ['gmtime_tz 给定时区的分解时间', '0 | gmtime_tz("Asia/Shanghai")', '[1970,0,1,8,0,0,4,0]'],
  ['gmtime_tz 与 gmtime 在 UTC 下一致', '0 | gmtime_tz("UTC") == (0 | gmtime)', 'true'],
  ['strftime_tz 数字输入', '0 | strftime_tz("%Y-%m-%dT%H:%M:%S%:z"; "Asia/Shanghai")', '"1970-01-01T08:00:00+08:00"'],
  ['strftime 仍是 UTC（原生）', '0 | strftime("%Y-%m-%dT%H:%M:%SZ")', '"1970-01-01T00:00:00Z"'],
  ['strftime_tz 数组输入（按该时区格式化）', '0 | gmtime_tz("Asia/Shanghai") | strftime_tz("%H:%M"; "Asia/Shanghai")', '"08:00"'],
]) {
  const { status, text } = call(program);
  check(label, status === 0 && text === want, `status=${status} ${text}`);
}

// ⑧ 上限：引擎自己到点就停（状态 2），并回退到最后一个换行 —— 绝不留下半个 JSON 值。
const cut = (() => {
  const exports = instance;
  const program = put(exports, '[range(1;100)] | .[]');
  const path = put(exports, '');
  const input = put(exports, 'null');
  const out = exports.run(program.ptr, program.len, path.ptr, path.len, input.ptr, input.len, 12);
  const view = new DataView(exports.memory.buffer);
  const status = view.getUint8(out);
  const len = view.getUint32(out + 1, true);
  const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, out + 5, len));
  exports.dealloc(out, 5 + len);
  exports.dealloc(program.ptr, program.len);
  exports.dealloc(path.ptr, path.len);
  exports.dealloc(input.ptr, input.len);
  return { status, text };
})();
check('到上限：状态 2 且按行边界截断',
  cut.status === 2 && cut.text.endsWith('\n') && cut.text.split('\n').filter((line) => line !== '').every((line) => {
    try { JSON.parse(line); return true; } catch { return false; }
  }), `status=${cut.status} ${JSON.stringify(cut.text)}`);

// ⑧ trap：栈溢出这类会让 wasm 实例报废，但**必须可捕获**，且新实例照常可用
//    （插件侧据此做「丢弃重建」）。
let trapped = '';
try { call('def f: 1 + f; f'); } catch (cause) { trapped = String(cause); }
check('栈溢出变成可捕获的 trap（实例报废）', trapped.includes('RuntimeError'), trapped.slice(0, 60));
instance = instantiate();
const revived = call('[1,2,3] | map(.+1)').text;
check('丢弃重建后照常可用', revived === '[2,3,4]', revived);

console.log(`\n指纹: ${createHash('sha256').update(fingerprint.join('\n')).digest('hex').slice(0, 16)}`);
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
