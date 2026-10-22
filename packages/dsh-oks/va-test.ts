import assert from 'node:assert/strict';
import test from 'node:test';
import { createVaRuntime, renderAsk } from './src/va.ts';
import { installVocabularyHelper, resetVocabularyContext } from './src/va-helper.ts';
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
  const runtime = createVaRuntime({ ctx: {
    get: () => options.missing ? undefined : service,
    on: (_event: string, fn: any) => { end = fn; return () => {}; },
    effect: (fn: any) => effects.push(fn()),
  } as any, config: options.config, log() {} });
  return { runtime, starts, sends, settled, unload: () => effects.forEach(fn => fn()) };
}

test('官方宿主首次创建、后续 sendMessage，工具只返回投递确认', async () => {
  const h = harness(), parent = caller();
  const first = await h.runtime.ask(parent, 'parent', '丢包');
  const next = await h.runtime.ask(parent, 'parent', '端口');
  assert.equal(first.accepted, true); assert.equal(first.helper, next.helper);
  assert.equal(h.starts.length, 1); assert.equal(h.sends.length, 1);
  assert.equal(h.starts[0].delivery, 'parent'); assert.equal(h.starts[0].request.parent, parent);
  assert.equal(h.starts[0].request.agentPreset, 'oks-vocabulary');
  assert.deepEqual(h.starts[0].request.agentOptions, { reasoningEffort: 'off' });
  assert.equal(h.sends[0].parent, parent); assert.equal(h.sends[0].childId, first.helper);
  assert.deepEqual(h.sends[0].prompt, [{ type: 'text', text: '端口' }]);
  assert.match(renderAsk({}, first)[0].text!, /answer will arrive as a subagent message/);
});
test('从父会话持久目录恢复已有词汇子会话', async () => {
  const h = harness({ children: [{ mode: 'continuable', id: 'session-va-existing', label: '词汇助手' }] });
  const result = await h.runtime.ask(caller(), 'parent', '恢复后的问题');
  assert.equal(result.helper, 'session-va-existing'); assert.equal(h.starts.length, 0);
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
    const custom = harness({ config: { vaPreset: 'custom', vaReasoningEffort: effort } });
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
 const knowledge={ensureWorkspace({agent}:any){seen.push(agent.session.header.cwd);return agent.session.header.cwd;},
 async ensureIndex(root:string){return{terms:[{key:'k',name:root+'$&',aliases:['{{literal}}'],doc:'说明'}]};}};
 installVocabularyHelper({ctx,knowledge,log(){}} as any);assert.deepEqual(restrictions,[{allow:[]}]);assert.match(sections[0].text,/词汇助手/);
 const p=caller();p.session.append=(...args:any[])=>policies.push(args);
 const next=async()=>({sections:[{name:'platform',text:'platform'}],tools:[],variables:{}});
 const first=await assemble({},{agent:p},next);await assemble({},{agent:p},next);
 const other=caller('two');other.session.header.cwd='/other';other.session.append=()=>{};const second=await assemble({},{agent:other},next);
 assert.ok(first.sections[1].text.includes('/workspace$&'));assert.ok(first.sections[1].text.includes('{{literal}}'));assert.equal(first.sections[1].interpolate,false);
 assert.ok(second.sections[1].text.includes('/other$&'));assert.equal(first.sections.filter((s:any)=>s.name==='oks:vocabulary').length,1);
 assert.deepEqual(policies.map(v=>v[0]),['sandbox/mode','approval/policy']);assert.deepEqual(await assemble({},{},next),await next());assert.equal(seen.length,3);
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
  resetVocabularyContext(session as any);
  assert.equal(nodes.length,2);assert.equal(nodes[0],0);
  assert.deepEqual(events[nodes[1]].data.content,[{type:'text',text:'（上文问答已收起）'}]);
  const count=events.length;resetVocabularyContext(session as any);assert.equal(events.length,count);
 }
 assert.equal(events.filter(e=>e.type==='user/message' && e.data.content?.[0]?.text.startsWith('问题 ')).length,100);
 assert.equal(events.filter(e=>e.type==='assistant/message').length,100);
});
