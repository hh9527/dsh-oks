import assert from 'node:assert/strict';
import test from 'node:test';
import { createKaRuntime, renderAsk } from './src/ka.ts';
import { installKnowledgeHelper, resetKnowledgeContext } from './src/ka-helper.ts';
const caller = (id = 'parent') => ({ id, session: { id, header: { cwd: '/workspace' } } }) as any;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(options: any = {}) {
  const starts: any[] = [], sends: any[] = [], effects: any[] = [];
  let end: any;
  const settled = (id: string) => end({ id, stopReason: 'completed' });
  const service = {
    listChildren: async () => options.children ?? [],
    async startActivation(spec: any) {
      starts.push(spec);
      if (options.fail) throw Error('fixture admission failure');
      spec.signal.throwIfAborted();
      if (!options.manual) queueMicrotask(() => settled(spec.childId));
      return { childId: spec.childId, messageId: 'initial', result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose() { throw Error('execution belongs to host'); } };
    },
    async sendMessage(parent: any, childId: string, prompt: any, request: any) {
      sends.push({ parent, childId, prompt, ...request });
      request.signal.throwIfAborted();
      if (!options.manual) queueMicrotask(() => settled(childId));
      return 'followup-' + sends.length;
    },
  };
  const runtime = createKaRuntime({ ctx: {
    get: () => options.missing ? undefined : service,
    on: (_event: string, fn: any) => { end = fn; return () => {}; },
    effect: (fn: any) => effects.push(fn()),
  } as any, config: options.config, vocabulary: options.vocabulary, log() {} });
  return { runtime, starts, sends, settled, unload: () => effects.forEach(fn => fn()) };
}

test('官方宿主首次创建、后续 sendMessage，工具只返回投递确认', async () => {
  const h = harness(), parent = caller();
  const first = await h.runtime.ask(parent, 'parent', '丢包');
  const next = await h.runtime.ask(parent, 'parent', '端口');
  assert.equal(first.accepted, true); assert.equal(first.helper, next.helper);
  assert.equal(h.starts.length, 1); assert.equal(h.sends.length, 1);
  assert.equal(h.starts[0].delivery, 'parent'); assert.equal(h.starts[0].request.parent, parent);
  assert.equal(h.starts[0].request.agentPreset, 'oks-knowledge');
  assert.equal(h.starts[0].request.agentOptions, undefined);
  assert.equal(h.sends[0].parent, parent); assert.equal(h.sends[0].childId, first.helper);
  assert.deepEqual(h.sends[0].prompt, [{ type: 'text', text: '端口' }]);
  assert.match(renderAsk({}, first)[0].text!, /answer will arrive as a subagent message/);
});
test('默认仅 DeepSeek 关闭推理，按当前请求路由判断并尊重显式配置', async () => {
 for(const [model,expected] of [['deepseek-flash','off'],['deepseek-reasoner','off'],['qwen3.8-flash',undefined],['kimi-k3.1-pro',undefined],['unknown',undefined],['',undefined]]){
  const h=harness(),parent=caller();parent.options={provider:'gateway',model};
  await h.runtime.ask(parent,'parent','问题');
  assert.deepEqual(h.starts[0].request.agentOptions,expected?{reasoningEffort:expected}:undefined,model);
 }
 for(const [created,current,expected] of [['deepseek-flash','qwen3.8-flash',undefined],['qwen3.8-flash','deepseek-flash','off']]){
  const h=harness(),parent=caller();parent.options={model:created};parent.session.requestHeader=()=>({config:{provider:'gateway',model:current}});
  await h.runtime.ask(parent,'parent','切换后问题');
  assert.deepEqual(h.starts[0].request.agentOptions,expected?{reasoningEffort:expected}:undefined);
 }
 for(const [model,effort] of [['deepseek-flash','inherit'],['deepseek-flash','low'],['qwen3.8-flash','low']]){
  const h=harness({config:{kaReasoningEffort:effort}}),parent=caller();parent.options={model};
  await h.runtime.ask(parent,'parent','覆盖');
  assert.deepEqual(h.starts[0].request.agentOptions,effort==='inherit'?undefined:{reasoningEffort:effort});
 }
});
test('从父会话持久目录恢复已有知识子会话', async () => {
  const h = harness({ children: [{ mode: 'continuable', id: 'session-ka-existing', label: '知识助手' }] });
  const result = await h.runtime.ask(caller(), 'parent', '恢复后的问题');
  assert.equal(result.helper, 'session-ka-existing'); assert.equal(h.starts.length, 0);
  assert.equal(h.sends.length, 1);
});
test('同问并发合并，不同问题等宿主结束事件后投递', async () => {
  const h = harness({ manual: true }), parent = caller();
  const first = h.runtime.ask(parent, 'parent', '同问');
  const duplicate = h.runtime.ask(parent, 'parent', '同问');
  const second = h.runtime.ask(parent, 'parent', '另一问');
  const a = await first, b = await duplicate;
  assert.equal(a.messageId, b.messageId); assert.equal(h.starts.length, 1);
  await flush(); assert.equal(h.sends.length, 0);
  h.settled(a.helper);
  assert.equal((await second).helper, a.helper); assert.equal(h.sends.length, 1);
  h.settled(a.helper);
});
test('不同父会话独立，推理档位可覆盖或继承', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.runtime.ask(caller('a'), 'a', '问题'), h.runtime.ask(caller('b'), 'b', '问题')]);
  assert.notEqual(a.helper, b.helper);
  for (const effort of ['low', 'inherit']) {
    const custom = harness({ config: { kaPreset: 'custom', kaReasoningEffort: effort } });
    await custom.runtime.ask(caller(), 'parent', '问题');
    assert.equal(custom.starts[0].request.agentPreset, 'custom');
    assert.deepEqual(custom.starts[0].request.agentOptions, effort === 'inherit' ? undefined : { reasoningEffort: effort });
  }
});
test('已取消请求和缺失服务不创建子会话，发布失败可重试', async () => {
  const h = harness();
  await assert.rejects(h.runtime.ask(caller(), 'parent', '问题', AbortSignal.abort()));
  assert.equal(h.starts.length, 0);
  await assert.rejects(harness({ missing: true }).runtime.ask(caller(), 'parent', '问题'), /subagents/);
  await assert.rejects(h.runtime.ask({ session: { id: 'bare' } } as any, 'bare', '问题'), /cwd/);
  const failed = harness({ fail: true }), parent = caller();
  for (let i = 0; i < 2; i++) await assert.rejects(failed.runtime.ask(parent, 'parent', '问题'), /admission failure/);
  assert.equal(failed.starts.length, 2);
});
test('插件卸载拒绝排队请求，已受理子会话由宿主管理', async () => {
  const h = harness({ manual: true }), parent = caller();
  await h.runtime.ask(parent, 'parent', '首问');
  const queued = assert.rejects(h.runtime.ask(parent, 'parent', '排队'), /卸载/);
  h.unload(); await queued; assert.equal(h.sends.length, 0);
});

test('助手装配按当前工作区提供完整词表，空工具面与逐字文本',async()=>{
 let assemble:any;const sections:any[]=[],restrictions:any[]=[],policies:any[]=[],seen:string[]=[];
 const ctx={systemPrompt:{section:(s:any)=>sections.push(s)},tools:{restrict:(v:any)=>restrictions.push(v)},
 on(name:string,fn:any){if(name==='system-prompt/assemble')assemble=fn;return()=>{};},effect(fn:any){fn();}};
 const knowledge={ensureWorkspace({agent}:any){seen.push(agent.session.header.cwd);return {settings:{domain:agent.session.header.cwd}};},
 async ensureIndex(entry:any){const root=entry.settings.domain;return{knowledge:{entities:{[root]:{}},datasets:{},relations:{},items:[]},terms:[{key:'k',name:root+'$&',aliases:['{{literal}}'],doc:'说明'}]};}};
 installKnowledgeHelper({ctx,knowledge,log(){},config:{vocabularyHelper:true}} as any);assert.deepEqual(restrictions,[{allow:[]}]);assert.match(sections[0].text,/词汇助手/);
 const p=caller();p.session.append=(...args:any[])=>policies.push(args);
 const next=async()=>({sections:[{name:'platform',text:'platform'}],tools:[],variables:{}});
 const first=await assemble({},{agent:p},next);await assemble({},{agent:p},next);
 const other=caller('two');other.session.header.cwd='/other';other.session.append=()=>{};const second=await assemble({},{agent:other},next);
 assert.ok(first.sections[1].text.includes('/workspace$&'));assert.ok(first.sections[1].text.includes('{{literal}}'));assert.equal(first.sections[1].interpolate,false);
 assert.ok(second.sections[1].text.includes('/other$&'));assert.equal(first.sections.filter((s:any)=>s.name==='oks:knowledge-assistant').length,1);
 assert(!first.sections[1].text.includes('# 全局领域摘要'));
 assert(first.sections[1].text.includes('完整词汇表'));
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
 assert.deepEqual(allowed,[]);assert.equal(tools[0].name,'va_ask');
 const parent=caller();parent.session.append=()=>{};
 const result=await assemble({},{agent:parent},async()=>({sections:[]}));
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
 const step=handlers.get('agent/pre-step')![0];const agent={session};
 await step({agent},async()=>({kind:'skip'}));const before=replacements;
 await step({agent},async()=>({kind:'skip'}));assert.equal(replacements,before);
 for(const status of handlers.get('agent/status')!)status({agent,status:'idle'});
 assert.equal(replacements,before+1);
});

test('等待 VA 时空闲保留当前轮，VA 返回后完成咨询才收起',async()=>{
 const handlers=new Map<string,any[]>();let tool:any;let childId='';let replacements=0;
 const session:any={id:'session-ka-test',header:{cwd:'/workspace'},surface:{nodes:[0]},eventAt:()=>({type:'assistant/message'}),append(){replacements++}};
 const ctx={systemPrompt:{section(){}},tools:{restrict(){},register(t:any){tool=t;return()=>{}}},
 get(){return{sendMessage:async()=>'',listChildren:async()=>[],startActivation:async(s:any)=>{childId=s.childId;return{messageId:'m',result:Promise.resolve({})}}}},
 on(n:string,f:any){handlers.set(n,[...(handlers.get(n)??[]),f]);return()=>{}},effect(){}};
 installKnowledgeHelper({ctx,knowledge:{},log(){}} as any);
 const agent={session};const step=handlers.get('agent/pre-step')![0];
 await step({agent},async()=>({kind:'skip'}));const before=replacements;
 await tool.execute({query:'原始问题'},{agent});
 for(const f of handlers.get('agent/status')!)f({agent,status:'idle'});
 assert.equal(replacements,before);
 for(const f of handlers.get('subagent/end')!)f({id:childId});
 await step({agent},async()=>({kind:'skip'}));assert.equal(replacements,before);
 for(const f of handlers.get('agent/status')!)f({agent,status:'idle'});
 assert.equal(replacements,before+1);
});


test('KA/VA 只过滤宿主交付与开发 section，保留安全约束和工具定义',async()=>{
 for(const vocabularyHelper of [false,true]){
  let assemble:any;
  const ctx={systemPrompt:{section(){}},tools:{restrict(){},register(){return()=>{}}},get(){},on(n:string,f:any){if(n==='system-prompt/assemble')assemble=f;return()=>{}},effect(){}};
  const knowledge={ensureWorkspace(){return{settings:{domain:'test'}}},async ensureIndex(){return{knowledge:{},terms:[]}}};
  installKnowledgeHelper({ctx,knowledge,log(){},config:{vocabularyHelper}} as any);
  const agent=caller();agent.session.append=()=>{};
  const original={sections:[{name:'safety',text:'keep safety'},{name:'ui:deliverable-file-references',text:'Prefer showing the primary results'},{name:'harness:source',text:'source checkout'},{name:'app:web-surface',text:'web development'}],tools:[{name:'va_ask'}]};
  const result=await assemble({},{agent},async()=>original);
  assert.deepEqual(result.sections.map((s:any)=>s.name),['safety','oks:knowledge-assistant']);
  assert.equal(result.tools,original.tools);
  assert.equal(original.sections.length,4);
 }
});
