// 最终工具出口的容量回归：使用真实 renderer，无模型、服务或构建依赖。
import assert from 'node:assert/strict';
import { PAYLOAD_MAX_BYTES, withOutputLimit } from './src/payload.ts';
import { renderJqResult, renderValue } from './src/response.ts';
import type { ToolDefinition } from './src/host.ts';

const definition = (name = 'oks_project', render: ToolDefinition['output']['render'] = renderJqResult): ToolDefinition => ({
  name, description: '', parameters: {}, output: { schema: {}, render }, async execute() {},
});
const render = (value: unknown, tool = definition(), args: unknown = {}) => {
  const text = withOutputLimit(tool).output.render(args as never, value as never).map(block => block.text).join('');
  assert.ok(Buffer.byteLength(text) <= PAYLOAD_MAX_BYTES, '实际进入上下文的文本受预算约束');
  return text;
};
const result = (data: unknown) => ({ ok: true, execution: { method: 'project' }, data });

// Overflow describes the business value, before wrappers, indentation or UTF-8 encoding.
for(const data of [Array.from({length:8000},(_,i)=>i),{fact:'x'.repeat(18000)},'中'.repeat(9000),'😀'.repeat(9000),{business:{ok:true,data:'x'.repeat(18000)}}, {['long'.repeat(5000)]:null}]) {
 const raw=JSON.stringify(data);
 const overflow=JSON.parse(render(result(data)));
 assert.deepEqual(overflow,{error:'payload_too_large',repr:raw.slice(0,4096),reprLength:raw.length,
   len:typeof data==='string'||Array.isArray(data)?data.length:Object.keys(data).length});
 assert.equal(overflow.repr.length,4096);
}
for(const data of [null,false,0,'',[],{}, {ok:true,data:{business:'value'}}])assert.equal(render(result(data)),renderJqResult({},result(data))[0].text);
// Text reads own their 50 KiB window, independent of the structured-result budget.
const readText='中'.repeat(14000);
assert.equal(withOutputLimit(definition('oks_read',(_args)=>[{type:'text',text:readText}])).output.render({},null)[0].text,readText);
// Generic tools retain their existing bounded diagnostics.
const blocks:ToolDefinition['output']['render']=(_args,value)=>value;
for(const size of [PAYLOAD_MAX_BYTES-1,PAYLOAD_MAX_BYTES])assert.equal(render([{type:'text',text:'x'.repeat(size)}],definition('probe',blocks)),'x'.repeat(size));
assert.equal(JSON.parse(render([{type:'text',text:'x'.repeat(PAYLOAD_MAX_BYTES+1)}],definition('probe',blocks))).error.actualBytes,PAYLOAD_MAX_BYTES+1);
console.log('payload: exact representation length, business len, Unicode previews, read windows and generic budgets passed');

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
