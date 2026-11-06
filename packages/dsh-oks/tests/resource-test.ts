import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTools} from '../src/tools.ts';
import {guidedTools} from '../src/guided-tools.ts';
import {readDariSource} from '../src/results.ts';
const root=mkdtempSync(join(tmpdir(),'dari-resources-'));
const outside=mkdtempSync(join(tmpdir(),'dari-outside-'));
const knowledge={ensureWorkspace:()=>({root,modelHash:'test',settings:{workspaceRoot:root}})} as any;
const definitions=createTools({knowledge,ka:{} as any,timeContext:{zones:new Map()} as any,log(){},config:undefined});
const tools=guidedTools(definitions,knowledge),exec={agent:{session:{id:'resources'}}} as any;
const call=async(name:string,args:unknown)=>tools.find(t=>t.name===name)!.execute(args as never,exec) as Promise<any>;
try {
 assert.deepEqual(tools.map(t=>t.name).sort(),['report_extract_dari','move_entry','remove_file','ka_ask','oks_search','oks_routes','oks_info','oks_read','dari_check','dari_resolve','dari_renew_context'].sort());
 const index=await call('oks_read',{path:'oks://help/'});
 const paths=index.lines.map((line:any)=>line.text);
 for(const path of ['oks://help/workflow.md','oks://help/dari.md','oks://help/rules.md','oks://help/figure-line.md'])assert(paths.includes(path));
 for(const path of paths){const manual=await call('oks_read',{path});assert(manual.lines.length);}
 for(const path of ['analysis.dari',join(root,'analysis.dari'),'.work/a.dari','oks://help/../x','oks://knowledge'])await assert.rejects(call('oks_read',{path}),/built-in manuals/);
 mkdirSync(join(root,'reports'));
 const local=join(root,'reports/a.dari');writeFileSync(local,'data a = 1; answer tree! { Answer [p [Value(data=a)]] };');
 for(const path of ['reports/a.dari','./reports/a.dari',local])assert.equal(readDariSource(root,path,'test').file,'reports/a.dari');
 symlinkSync(local,join(root,'alias.dari'));assert.equal(readDariSource(root,'alias.dari','test').file,'reports/a.dari');
 writeFileSync(join(outside,'escape.dari'),'data a = 1;');symlinkSync(outside,join(root,'escape'));
 for(const path of [join(outside,'escape.dari'),'../escape.dari','escape/escape.dari','.work/a.dari'])assert.throws(()=>readDariSource(root,path,'test'));
 await assert.rejects(call('dari_check',{src:'reports/a.dari',answer:'a'}),/Expected only src/);
 assert.equal((await call('dari_check',{src:'reports/a.dari'})).ok,true);
 await assert.rejects(call('dari_resolve',{answer:false,src:'reports/a.dari',data:['a'],refresh:true}),/Expected only/);
 const result=await call('dari_resolve',{src:local});assert.equal(result.answer.embedded,'1');
 assert.equal((await call('dari_resolve',{src:'reports/a.dari'})).counts.executed,0);
 console.log('Public tools: exact ten-tool surface, built-in manuals, local file boundaries, canonical cache identity and rejected retired parameters passed');
} finally {definitions.dispose();rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
