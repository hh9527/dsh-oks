import {LIBRARY_PATH} from './src/resource-path.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,symlinkSync,utimesSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {registerHooks} from 'node:module';
import {createJaqEngine,JaqCompileError} from './src/jaq.ts';
import {createKtools} from './src/ktools.ts';
import {builtinKtoolsSource,builtinCode} from './src/knowledge-programs.ts';
import {KTOOLS_FILE,KTOOLS_INITIAL_SOURCE} from './src/ktools-path.ts';
const hooks=registerHooks({load(url,context,next){return url.endsWith('.md')?{format:'module',source:`export default ${JSON.stringify(readFileSync(new URL(url),'utf8'))}`,shortCircuit:true}:next(url,context);}});
const {createTools}=await import('./src/tools.ts');hooks.deregister();
const root=mkdtempSync(join(tmpdir(),'oks-ktools-'));
const engine=createJaqEngine(resolve(process.argv[2]??'lib/oks-wti.wasm'));
const graph={datasets:{alarm:{fields:{severity:{type:'Severity'}}}},types:{Severity:{values:{major:{}}}},relations:{},tools:{},items:[{key:'datasets/alarm',names:['告警'],doc:'Current alarms'},{key:'datasets/alarm#fields/severity',names:['级别'],doc:'Severity field'},{key:'types/Severity',names:['级别'],doc:'Value domain'},{key:'types/Severity#values/major',names:['严重'],doc:'Major'}]};
const entry={root,modelHash:'test',settings:{workspaceRoot:root,retention:{auto:{work:1,artifacts:1,materials:1}}}};
const knowledge={ensureWorkspace:()=>entry,ensureIndex:async()=>({knowledge:graph}),queryKnowledge:(_entry,source,options)=>engine.runDocument(source,graph,options)};
const libraries=createKtools(engine.checkLibrary,engine.run);
const makeTools=()=>createTools({knowledge:knowledge as any,ktools:libraries,va:{} as any,timeContext:{zones:new Map(),install(){}} as any,config:undefined,log(){}});
let tools=makeTools();const exec={agent:{session:{id:'ktools-test'}}};
const call=async(name:string,args:unknown)=>{const value=await tools.find(t=>t.name===name)!.execute(args as never,exec as never);assert.deepEqual(value,JSON.parse(JSON.stringify(value)),'tool output is lossless JSON');return value as any;};
try {
 const opts={timeoutMs:5000,programFile:KTOOLS_FILE};
 const good='# 中文注释\ndef helper($x): $x;\ndef echo($args): {"中文":helper($args)};\n';
 const parsed=await engine.checkLibrary(good,opts);
 assert.deepEqual(parsed.methods.map(m=>[m.name,m.args]),[['helper',['$x']],['echo',['$args']]]);
 assert.equal(parsed.methods[0].start,Buffer.byteLength(good.slice(0,good.indexOf('helper'))),'UTF8 source offsets');
 for(const bad of ['{}','def good($a): $a; null','import "secret" as s;','include "secret";','module {};','def x: 1; def x: 2;','def unused($a): nonexistent($a);','def broken($a): {']) {
  await assert.rejects(engine.checkLibrary(bad,opts),error=>error instanceof JaqCompileError&&error.diagnostics.some(d=>d.path===KTOOLS_FILE),bad);
 }
 await engine.checkLibrary('def nested($a): def inner: "def x: ;"; inner; # tail',opts);
 const builtin=await call('oks_read',{path:'oks://builtin/tools/ktools.lib.jq'});
 assert.equal(builtin.lines.join('\n'),builtinKtoolsSource.replace(/\n$/,''));
 assert.match(builtin.lines.join('\n'),/def search\(\$args\)/);
 assert.deepEqual((await call('oks_read',{path:KTOOLS_FILE})).lines,KTOOLS_INITIAL_SOURCE.trimEnd().split('\n'));
 assert.equal(existsSync(join(root,'memory')),false,'reading starter is side-effect free');
 // The initial file is editable without creating a scratch program.
 await call('oks_edit',{path:KTOOLS_FILE,old_string:'def datasets($args): .datasets | keys;',new_string:good});
 assert.deepEqual((await call('oks_data',{input:'oks://knowledge',method:KTOOLS_FILE+'#echo',args:{query:'告警'}})).data,{"中文":{query:'告警'}});
 const previous=readFileSync(join(root,LIBRARY_PATH),'utf8');
 for(const operation of [()=>call('oks_write',{path:KTOOLS_FILE,content:'def bad($a): missing;'}),()=>call('oks_edit',{path:KTOOLS_FILE,old_string:'helper($args)',new_string:'missing($args)'})]) {
  await assert.rejects(operation,/missing/);assert.equal(readFileSync(join(root,LIBRARY_PATH),'utf8'),previous,'invalid save preserves valid file');
 }
 await call('oks_edit',{path:KTOOLS_FILE,old_string:'helper($args)',new_string:'{changed:$args}'});
 assert.deepEqual((await call('oks_data',{input:'oks://knowledge',method:KTOOLS_FILE+'#echo',args:{n:2}})).data,{"中文":{changed:{n:2}}},'source edits invalidate cached execution');
 for(const [name,args] of [['search',{query:'告警'}],['read',{key:'datasets/alarm'}],['members',{key:'datasets/alarm'}],['references',{key:'datasets/alarm#fields/severity'}]] as const) {
  const old=builtinCode(`builtin://knowledge/${name}.jq`,args);
  const expected=await engine.runDocument(old.text,graph,{input:null,inputName:'knowledge',timeoutMs:5000,maxBytes:16384});
  assert.ok(expected.ok);
  assert.deepEqual((await call('oks_data',{input:'oks://knowledge',method:`oks://builtin/tools/ktools.lib.jq#${name}`,args})).data,expected.data);
 }
 await assert.rejects(call('oks_data',{input:'oks://knowledge',method:'oks://builtin/tools/ktools.lib.jq#search',args:{take:51}}),/1\.\.50/);
 for(const address of ['../oks://memory/tools/ktools.lib.jq#echo','memory/oks/other.jql#echo','tools/ktools.jql#echo','.work/test.jq','oks://memory/tools/ktools.lib.jq#echo|error','oks://builtin/tools/ktools.lib.jq#not_here'])await assert.rejects(call('oks_data',{input:'oks://knowledge',method:address}));
 for(const path of ['tools/other.jql','oks://builtin/tools/ktools.lib.jq'])await assert.rejects(call('oks_write',{path,content:'def ok($a): 1;'}));
 assert.ok((await call('oks_list',{})).files.some(f=>f.name===KTOOLS_FILE));
 mkdirSync(join(root,'.work'));writeFileSync(join(root,'.work/stale.jq'),'.');
 const oldTime=new Date('2020-01-01');utimesSync(join(root,LIBRARY_PATH),oldTime,oldTime);utimesSync(join(root,'.work/stale.jq'),oldTime,oldTime);
 await call('oks_delete',{path:'oks://work/stale.jq'});assert.equal(existsSync(join(root,'.work/stale.jq')),false);assert.equal(existsSync(join(root,LIBRARY_PATH)),true);
 tools.dispose();tools=makeTools();
 assert.deepEqual((await call('oks_data',{input:'oks://knowledge',method:KTOOLS_FILE+'#echo',args:{n:3}})).data,{"中文":{changed:{n:3}}},'new session reads persistent methods');
 await assert.rejects(createKtools(engine.checkLibrary,engine.run).program(root,KTOOLS_FILE+'#missing'),/exactly one/);
 const target=join(root,'protected');writeFileSync(target,'original');rmSync(join(root,LIBRARY_PATH));symlinkSync(target,join(root,LIBRARY_PATH));
 for(const [name,args] of [['oks_read',{path:KTOOLS_FILE}],['oks_write',{path:KTOOLS_FILE,content:good}],['oks_edit',{path:KTOOLS_FILE,old_string:'original',new_string:good}],['oks_delete',{path:KTOOLS_FILE}],['oks_data',{input:'oks://knowledge',method:KTOOLS_FILE+'#echo'}]] as const)await assert.rejects(call(name,args),/symlink/);
 assert.equal(readFileSync(target,'utf8'),'original');
 rmSync(join(root,'memory'),{recursive:true});mkdirSync(join(root,'alias'));symlinkSync(join(root,'alias'),join(root,'memory'));
 await assert.rejects(call('oks_write',{path:KTOOLS_FILE,content:good}),/symlink/);
 rmSync(join(root,'memory'));mkdirSync(join(root,'memory'));symlinkSync(join(root,'alias'),join(root,'memory/oks'));
 await assert.rejects(call('oks_write',{path:KTOOLS_FILE,content:good}),/symlink/);
 console.log('knowledge libraries: parser/compiler, readable builtins, methods, atomic validation, edits, persistence, retention and path boundaries passed');
} finally {tools.dispose();engine.dispose();rmSync(root,{recursive:true,force:true});}
