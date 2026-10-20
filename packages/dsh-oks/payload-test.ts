// 最终工具出口的容量回归：使用真实 renderer，无模型、服务或构建依赖。
import assert from 'node:assert/strict';
import { PAYLOAD_MAX_BYTES, withOutputLimit } from './src/payload.ts';
import { renderJqResult, renderValue } from './src/response.ts';
import type { ToolDefinition } from './src/host.ts';

const definition = (name = 'oks_data', render: ToolDefinition['output']['render'] = renderJqResult): ToolDefinition => ({
  name, description: '', parameters: {}, output: { schema: {}, render }, async execute() {},
});
const render = (value: unknown, tool = definition(), args: unknown = {}) => {
  const text = withOutputLimit(tool).output.render(args as never, value as never).map(block => block.text).join('');
  assert.ok(Buffer.byteLength(text) <= PAYLOAD_MAX_BYTES, '实际进入上下文的文本受预算约束');
  return text;
};
const result = (data: unknown) => ({ ok: true, execution: { method: 'project' }, data });

// 复现紧凑 JSON 合法、最终缩进回执超限：摘要必须针对业务结果。
const data = {
  fact: Array.from({ length: 104 }, (_, i) => ({ tenant: `tenant_${i}`, count: i, label: 'x'.repeat(80) })),
  summary: Array.from({ length: 5 }, (_, i) => ({ count: i })),
};
const value = result(data);
const rawText = renderJqResult({}, value)[0].text;
assert.ok(Buffer.byteLength(JSON.stringify(value)) < PAYLOAD_MAX_BYTES);
assert.ok(Buffer.byteLength(rawText) > PAYLOAD_MAX_BYTES);
const error = JSON.parse(render(value));
assert.deepEqual(error.shape, { type: 'object', size: 2, keys: ['fact', 'summary'] });
assert.deepEqual(error.error, { code: 'payload_too_large', tool: 'oks_data', limitBytes: 16384,
  actualBytes: Buffer.byteLength(rawText) });
assert.deepEqual(error.fields, [
  { key: 'fact', bytes: Buffer.byteLength(JSON.stringify(data.fact)), shape: { type: 'array', size: 104 } },
  { key: 'summary', bytes: Buffer.byteLength(JSON.stringify(data.summary)), shape: { type: 'array', size: 5 } },
]);
assert.ok(!render(value).includes('tenant_0'));

// 保存只返回小回执；合法小值与引擎超限诊断原样通过。
const saved = { asset: '.oks/data/saved.tr.json', bytes: 50000, execution: { method: 'project' } };
assert.equal(render(saved, definition(), { save: {} }), renderJqResult({ save: {} }, saved)[0].text);
for (const data of [null, false, 0, '', [], {}, { ok: true, data: { business: 'value' } }]) {
  assert.equal(render(result(data)), renderJqResult({}, result(data))[0].text);
}
const engineError = { ok: false, error: { code: 'evaluation_truncated', tool: 'oks_data', limitBytes: 262144,
  actualBytes: null }, shape: { type: 'array', size: 100000 } };
assert.deepEqual(JSON.parse(render(engineError)), engineError);
const arrayError = JSON.parse(render(result(Array.from({ length: 8000 }, (_, i) => i))));
assert.deepEqual(arrayError.shape, { type: 'array', size: 8000 });
assert.ok(!('fields' in arrayError));
const business = { ok: true, data: 'PRIVATE_CONTENT'.repeat(1500) };
assert.deepEqual(JSON.parse(render(result(business))).shape, { type: 'object', size: 2, keys: ['data', 'ok'] },
  '仅剥离工具成功信封，业务数据的同名字段保持原层级');

// 按最终 UTF-8 字节数计量：恰好等于预算放行，多一个字节即拒绝。
const blocks: ToolDefinition['output']['render'] = (_args, value) => value;
for (const size of [PAYLOAD_MAX_BYTES - 1, PAYLOAD_MAX_BYTES]) {
  const blocksValue = [{ type: 'text', text: 'x'.repeat(size) }];
  assert.equal(render(blocksValue, definition('probe', blocks)), blocksValue[0].text);
}
const oversized = [{ type: 'text', text: '中'.repeat(5000) }, { type: 'text', text: 'x'.repeat(2000) }];
const multiError = JSON.parse(render(oversized, definition('probe', blocks)));
assert.equal(multiError.error.actualBytes, 17000);
assert.equal(JSON.parse(render(result('中'.repeat(6000)))).shape.size, 6000);

// 通用工具按自身结构摘要；字段数、嵌套键名与诊断文本都受约束。
const generic = JSON.parse(render({ ok: true, lines: data.fact }, definition('oks_read', renderValue)));
assert.deepEqual(generic.shape.keys, ['lines', 'ok']);
assert.equal(generic.error.tool, 'oks_read');
const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, 'PRIVATE_CONTENT'.repeat(i + 1)]));
const wideError = JSON.parse(render(result(wide)));
assert.equal(wideError.shape.size, 100);
assert.equal(wideError.fields.length, 8);
assert.equal(wideError.fields[0].key, 'field_99');
assert.ok(!JSON.stringify(wideError).includes('PRIVATE_CONTENT'));
const longKey = '长'.repeat(20000);
for (const data of [{ [longKey]: 'private' }, { nested: { [longKey]: 'private' } }]) {
  const bounded = render(result(data));
  assert.ok(Buffer.byteLength(bounded) <= 4096);
  assert.ok(!bounded.includes('private'));
  assert.equal(JSON.parse(bounded).shape.type, 'object');
}
console.log('✓ 最终回执统一计量 16 KiB、业务 shape、字段体积摘要、UTF-8 边界及有界诊断');

// 失败目录优先于普通结果预算：所有失败身份仍可见，成功数据不挤占回执。
const failures=Array.from({length:180},(_,i)=>({name:`binding${i}`,status:'failed',asset:`asset${i}.jq`,at:{line:i+1,column:1},error:'bad input',messageTruncated:false}));
const failedRun={ok:false,counts:{failed:180,blocked:0},failures,outputs:[{data:'x'.repeat(20000)}],reply:'x'.repeat(20000),omittedOutputs:0};
const diagnosticText=withOutputLimit(definition('oks_run_answer',(_args,value)=>[{type:'text',text:JSON.stringify(value)}])).output.render({},failedRun)[0].text;
const failedReceipt=JSON.parse(diagnosticText);
assert.deepEqual(failedReceipt.failures,failures);
assert.equal(failedReceipt.outputs,undefined);
assert.equal(failedReceipt.reply,undefined);
assert.equal(failedReceipt.omittedOutputs,1);
assert.ok(Buffer.byteLength(diagnosticText)>PAYLOAD_MAX_BYTES,'错误目录允许超过普通结果预算');
