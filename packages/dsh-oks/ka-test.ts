import assert from 'node:assert/strict';
import test from 'node:test';
import { createKaRuntime, renderAsk, CONSULT_TIMEOUT_MS } from './src/ka.ts';
import { installKnowledgeHelper, resetKnowledgeContext } from './src/ka-helper.ts';
const caller = (id = 'parent') => ({ id, ctx: { tools: { restrict() {} } }, session: { id, header: { cwd: '/workspace' } } }) as any;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(options:any={}){
 const starts:any[]=[],sends:any[]=[],effects:any[]=[],disposed:string[]=[];const handlers=new Map<string,any[]>();const runs=new Map<string,(value:any)=>void>();
 const settled=(id:string,stopReason='completed',text='助手答案')=>{
  const output=text?[{type:'text',text}]:[];runs.get(id)?.({stopReason,output});runs.delete(id);
  for(const f of handlers.get('subagent/end')??[])f({id,stopReason,lastAssistantMessage:output});
 };
 const service={listChildren:async()=>options.children??[],async startActivation(spec:any){
  starts.push(spec);if(options.fail)throw Error('admission failure');spec.signal.throwIfAborted();
  const result=new Promise(resolve=>runs.set(spec.childId,resolve));if(!options.manual)queueMicrotask(()=>settled(spec.childId));
  return{childId:spec.childId,messageId:'initial',result,async dispose(){disposed.push(spec.childId);settled(spec.childId,'aborted','')}};
 },async sendMessage(parent:any,childId:string,prompt:any,request:any){sends.push({parent,childId,prompt,...request});request.signal.throwIfAborted();if(!options.manual)queueMicrotask(()=>settled(childId));return 'followup-'+sends.length},async drainChildren(_p:any,ids:string[]){for(const id of ids){disposed.push(id);settled(id,'aborted','')}}};
 const runtime=createKaRuntime({ctx:{get:()=>options.missing?undefined:service,on(n:string,f:any){handlers.set(n,[...(handlers.get(n)??[]),f]);return()=>{}},effect(f:any){effects.push(f())}} as any,config:options.config,vocabulary:options.vocabulary,log(){}});
 return{runtime,starts,sends,settled,disposed,handlers,unload:()=>effects.forEach(f=>f())};
}
test('首次 caller delivery 等待答案，续问复用子会话并返回完整答案',async()=>{
 const h=harness({manual:true}),parent=caller();let returned=false;
 const first=h.runtime.ask(parent,'parent','问题').then(v=>{returned=true;return v});await flush();assert(!returned);assert.equal(h.starts[0].delivery,'caller');
 h.settled(h.starts[0].childId);const a=await first;assert.equal(a.answer,'助手答案');assert.equal(renderAsk({},a)[0].text,'助手答案');
 const second=h.runtime.ask(parent,'parent','续问');await flush();assert.equal(h.sends.length,1);h.settled(a.helper,'completed','续问答案');
 const b=await second;assert.equal(b.helper,a.helper);assert.equal(b.answer,'续问答案');assert.equal(h.starts.length,1);
});
test('同问合并，不同问题等待前一答案完成后才投递',async()=>{
 const h=harness({manual:true}),parent=caller();const a=h.runtime.ask(parent,'p','A'),same=h.runtime.ask(parent,'p','A'),b=h.runtime.ask(parent,'p','B');await flush();assert.equal(h.starts.length,1);assert.equal(h.sends.length,0);
 h.settled(h.starts[0].childId);assert.deepEqual(await a,await same);await flush();assert.equal(h.sends.length,1);h.settled(h.starts[0].childId);await b;
});
test('恢复持久子会话，消费重复通知但保留其他消息',async()=>{
 const h=harness({children:[{mode:'continuable',id:'session-ka-existing',label:'知识助手'}]}),parent=caller();const r=await h.runtime.ask(parent,'p','恢复');assert.equal(r.helper,'session-ka-existing');assert.equal(h.starts.length,0);
 const duplicate={source:{kind:'subagent-settled',senderSessionId:r.helper}},other={source:{kind:'user'}};
 const hook=h.handlers.get('agent/pre-step')![0];const decision=await hook({agent:parent,messages:[duplicate,other]},async()=>({kind:'enter',messages:[duplicate,other]}));assert.deepEqual(decision.messages,[other]);
 assert.equal((await hook({agent:parent,step:1,messages:[duplicate]},async()=>({kind:'enter',messages:[duplicate]}))).kind,'reject');
});
test('取消清理执行，后续咨询仍可复用会话',async()=>{
 const h=harness({manual:true}),parent=caller(),abort=new AbortController();const run=h.runtime.ask(parent,'p','取消',abort.signal);await flush();abort.abort(Error('cancelled'));await assert.rejects(run,/cancelled/);assert.equal(h.disposed.length,1);
 const retry=h.runtime.ask(parent,'p','重试');await flush();h.settled(h.starts[0].childId);assert.equal((await retry).answer,'助手答案');
});
test('错误、空答案、卸载及提交失败都不会当作成功答案',async()=>{
 for(const [reason,text,pattern] of [['error','失败',/未完成/],['completed','',/没有返回答案/]] as const){const h=harness({manual:true});const p=h.runtime.ask(caller(),'p','问题');await flush();h.settled(h.starts[0].childId,reason,text);await assert.rejects(p,pattern)}
 const h=harness({manual:true});const run=h.runtime.ask(caller(),'p','卸载');await flush();h.unload();await assert.rejects(run,/卸载/);assert.equal(h.disposed.length,1);
 await assert.rejects(harness({missing:true}).runtime.ask(caller(),'p','问题'),/subagents/);
 await assert.rejects(harness({fail:true}).runtime.ask(caller(),'p','问题'),/admission failure/);
 await assert.rejects(harness().runtime.ask(caller(),'p','问题',AbortSignal.abort()));
});
test('推理档位按当前路由继承，只有 DeepSeek 默认 off',async()=>{
 for(const [model,effort] of [['deepseek-flash','off'],['qwen',undefined]]){const h=harness(),p=caller();p.session.requestHeader=()=>({config:{model}});await h.runtime.ask(p,'p','问题');assert.deepEqual(h.starts[0].request.agentOptions,effort?{reasoningEffort:effort}:undefined)}
 const custom=harness({config:{kaPreset:'custom',kaReasoningEffort:'low'}});await custom.runtime.ask(caller(),'p','问题');assert.equal(custom.starts[0].request.agentPreset,'custom');assert.deepEqual(custom.starts[0].request.agentOptions,{reasoningEffort:'low'});
});
test('助手装配按当前工作区提供完整词表，空工具面与逐字文本',async()=>{
 let assemble:any;const sections:any[]=[],restrictions:any[]=[],policies:any[]=[],seen:string[]=[];
 const ctx={systemPrompt:{section:(s:any)=>sections.push(s)},tools:{restrict:(v:any)=>restrictions.push(v)},
 on(name:string,fn:any){if(name==='system-prompt/assemble')assemble=fn;return()=>{};},effect(fn:any){fn();}};
 const knowledge={ensureWorkspace({agent}:any){seen.push(agent.session.header.cwd);return {settings:{domain:agent.session.header.cwd}};},
 async ensureIndex(entry:any){const root=entry.settings.domain;return{knowledge:{entities:{[root]:{}},datasets:{},relations:{},items:[]},terms:[{key:'k',name:root+'$&',aliases:['{{literal}}'],doc:'说明'}]};}};
 installKnowledgeHelper({ctx,knowledge,log(){},config:{vocabularyHelper:true}} as any);assert.deepEqual(restrictions,[]);assert.match(sections[0].text,/词汇助手/);
 const p=caller();p.session.append=(...args:any[])=>policies.push(args);
 const next=async()=>({sections:[{name:'platform',text:'platform'}],tools:[],variables:{}});
 const first=await assemble({},{agent:p},next);await assemble({},{agent:p},next);
 const other=caller('two');other.session.header.cwd='/other';other.session.append=()=>{};const second=await assemble({},{agent:other},next);
 assert.ok(first.sections[1].text.includes('/workspace$&'));assert.ok(first.sections[1].text.includes('{{literal}}'));assert.equal(first.sections[1].interpolate,false);
 assert.ok(second.sections[1].text.includes('/other$&'));assert.equal(first.sections.filter((s:any)=>s.name==='oks:knowledge-assistant').length,1);
 assert(!first.sections[1].text.includes('# 全局领域摘要'));
 assert(first.sections[1].text.includes('领域词典'));
 assert(!second.sections[1].text.includes('/workspace'));
 assert(!first.sections[1].text.includes('ColumnChart'));
 const again=await assemble({},{agent:p},async()=>first);
 assert.equal(again.sections.filter((s:any)=>s.name==='oks:knowledge-assistant').length,1);
 assert.equal(again.sections.at(-1).text,first.sections[1].text);
 assert.deepEqual(policies.map(v=>v[0]),['sandbox/mode','approval/policy']);assert.deepEqual(await assemble({},{},next),await next());assert.equal(seen.length,4);
 await assert.rejects(assemble({},{agent:p,signal:AbortSignal.abort()},next));
});

test('连续 100 轮收起问答后模型表面恒定，日志保留所有问答',()=>{
 const events:any[]=[];let nodes:number[]=[];
 const session={get surface(){return{nodes}},eventAt:(seq:number)=>events[seq],
  append(type:string,data:any,options:any={}){
   const event={seq:events.length,type,data,...options};events.push(event);
   if(options.surfaceOp?.op==='replace'){
    const a=nodes.indexOf(options.surfaceOp.startSeq),b=nodes.indexOf(options.surfaceOp.endSeq);
    nodes.splice(a,b-a+1,event.seq);
   }else nodes.push(event.seq);
   return event;
  }};
 session.append('system/message',{message:{role:'system',content:[{type:'text',text:'固定大词表'}]}});
 for(let i=0;i<100;i++){
  session.append('user/message',{content:[{type:'text',text:'问题 '+i}]});
  session.append('assistant/message',{message:{content:[{type:'text',text:'回答 '+i}]}});
  resetKnowledgeContext(session as any);
  assert.equal(nodes.length,2);assert.equal(nodes[0],0);
  assert.deepEqual(events[nodes[1]].data.content,[{type:'text',text:'（上文问答已收起）'}]);
  const count=events.length;resetKnowledgeContext(session as any);assert.equal(events.length,count);
 }
 assert.equal(events.filter(e=>e.type==='user/message' && e.data.content?.[0]?.text.startsWith('问题 ')).length,100);
 assert.equal(events.filter(e=>e.type==='assistant/message').length,100);
});


test('KA 只装配关系地图，VA 词汇独立，唯一工具为 va_ask',async()=>{
 let assemble:any;let allowed:any;const tools:any[]=[];
 const ctx={systemPrompt:{section(){}},tools:{restrict(v:any){for(const name of v.allow) if(name!=='working_directory') throw Error('unknown global tool '+name);allowed=v.allow},register(v:any){tools.push(v);return()=>{}}},get(){},on(n:string,f:any){if(n==='system-prompt/assemble')assemble=f;return()=>{}},effect(){}};
 const knowledge={ensureWorkspace(){return{settings:{domain:'test'}}},async ensureIndex(){return{knowledge:{entities:{device:{}},datasets:{metrics:{roles:{device:{entity:'entities/device'}}}},relations:{}},terms:[{key:'secret',name:'VOCABULARY_ONLY',aliases:[],doc:''}]}}};
 installKnowledgeHelper({ctx,knowledge,log(){}} as any);
 assert.equal(allowed,undefined);assert.equal(tools[0].name,'va_ask');
 const parent=caller();parent.session.append=()=>{};
 parent.ctx.tools.restrict=(v:any)=>{allowed=v.allow};
 const result=await assemble({},{agent:parent},async()=>({sections:[]}));
 assert.deepEqual(allowed,['va_ask']);
 assert.match(result.sections[0].text,/device/);assert.match(result.sections[0].text,/va_ask/);
 assert(!result.sections[0].text.includes('VOCABULARY_ONLY'));
});


test('VA 作为 KA 的独立子会话，复用自己的预设与前缀',async()=>{
 const h=harness({vocabulary:true});const ka=caller('session-ka-parent');
 const first=await h.runtime.ask(ka,ka.session.id,'CPU');
 assert.match(first.helper,/^session-va-/);assert.equal(h.starts[0].label,'词汇助手');
 assert.equal(h.starts[0].request.agentPreset,'oks-vocabulary');assert.equal(h.starts[0].request.parent,ka);
 assert.equal((await h.runtime.ask(ka,ka.session.id,'内存')).helper,first.helper);
});


test('同一轮工具往返保留上下文，咨询结束后收起',async()=>{
 const handlers=new Map<string,any[]>();let replacements=0;
 const session:any={id:'ka',surface:{nodes:[0,1]},eventAt:(n:number)=>n===0?{type:'system/message',data:{message:{content:[{type:'text',text:'prefix'}]}}}:{type:'assistant/message'},append(){replacements++}};
 const ctx={systemPrompt:{section(){}},tools:{restrict(){},register(){return()=>{}}},get(){},on(n:string,f:any){handlers.set(n,[...(handlers.get(n)??[]),f]);return()=>{}},effect(){}};
 installKnowledgeHelper({ctx,knowledge:{},log(){}} as any);
 const step=handlers.get('agent/pre-step')![0];const agent={session,ctx:{tools:{restrict(){}}}};
 await step({agent},async()=>({kind:'skip'}));const before=replacements;
 await step({agent},async()=>({kind:'skip'}));assert.equal(replacements,before);
 for(const status of handlers.get('agent/status')!)status({agent,status:'idle'});
 assert.equal(replacements,before+1);
});

test('KA/VA 按职责过滤宿主提示词与工具 schema，保留安全约束',async()=>{
 for(const vocabularyHelper of [false,true]){
  let assemble:any;
  const ctx={systemPrompt:{section(){}},tools:{restrict(){},register(){return()=>{}}},get(){},on(n:string,f:any){if(n==='system-prompt/assemble')assemble=f;return()=>{}},effect(){}};
  const knowledge={ensureWorkspace(){return{settings:{domain:'test'}}},async ensureIndex(){return{knowledge:{},terms:[]}}};
  installKnowledgeHelper({ctx,knowledge,log(){},config:{vocabularyHelper}} as any);
  const agent=caller();agent.session.append=()=>{};
  const original={sections:[{name:'safety',text:'keep safety'},{name:'ui:deliverable-file-references',text:'Prefer showing the primary results'},{name:'harness:source',text:'source checkout'},{name:'app:web-surface',text:'web development'}],tools:[{name:'va_ask'},{name:'bash'}]};
  const result=await assemble({},{agent},async()=>original);
  assert.deepEqual(result.sections.map((s:any)=>s.name),['safety','oks:knowledge-assistant']);
  assert.deepEqual(result.tools,vocabularyHelper?[]:[{name:'va_ask'}]);
  assert.equal(original.sections.length,4);
 }
});


test('咨询超时释放子执行，排队的取消请求不被发送',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const h=harness({manual:true}),parent=caller();const first=h.runtime.ask(parent,'p','超时');await flush();
 const abort=new AbortController();const queued=h.runtime.ask(parent,'p','取消排队',abort.signal);abort.abort(Error('cancel queued'));
 t.mock.timers.tick(CONSULT_TIMEOUT_MS+1);await assert.rejects(first,/超时/);await assert.rejects(queued,/cancel queued/);
 assert.equal(h.disposed.length,1);assert.equal(h.sends.length,0);
});
