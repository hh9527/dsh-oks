import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
// 独立 headless profile；使用本地确定性适配器，不访问远端 LLM。
// DSH_PACKAGE / DSH_HOME / OKS_WORKSPACE / OKS_MODEL 必须显式指定。
for(const key of ['DSH_PACKAGE','DSH_HOME','OKS_WORKSPACE','OKS_MODEL']) if(!process.env[key]) throw Error('Missing '+key);
const dsh=realpathSync(process.env.DSH_PACKAGE);
const require=createRequire(join(dsh,'package.json'));const load=n=>import(pathToFileURL(require.resolve(n)).href);
const {runProfile}=await import(pathToFileURL(join(dsh,'lib/profile-boot.js')).href);
const {loadLayeredEnv}=await load('@deepseek-ai/dsh-app-boot');const {LlmAdapter}=await load('@deepseek-ai/dsh-llm');
const home=process.env.DSH_HOME;const workspace=process.env.OKS_WORKSPACE;
const preset=(id,config)=>({id:'test-'+id,name:'@deepseek-ai/dsh-agent-preset',config:{id,name:id,plugins:[{id:'oks',name:'@local/dsh-oks',config:{domain:'ic',model:process.env.OKS_MODEL,...config}}]}});
writeFileSync(join(home,'profiles/headless/cordis.patch.yml'),JSON.stringify([{id:'session-title-llm',disabled:true},{id:'headless-startup',disabled:true},{id:'headless-runner',disabled:true},{insert:[{id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'oks'}},preset('oks',{}),preset('oks-knowledge',{knowledgeHelper:true,kaReasoningEffort:'off'}),preset('oks-vocabulary',{vocabularyHelper:true})]}]));
const requests=[];
class Local extends LlmAdapter {
 async resolveModel(provider,id){return{provider,id,name:id,reasoning:{efforts:[{id:'off',name:'Off'}]}}}
 async *stream(options){
  const names=options.tools?.map(t=>t.name)??[];
  const system=options.messages.filter(m=>m.role==='system').flatMap(m=>m.content).map(b=>b.text??'').join('\n');
  const role=system.includes('# 领域词汇对齐')?'VA':system.includes('# 领域知识导航')?'KA':'MAIN';
  if(role!=='MAIN'){
   assert(!system.includes('Prefer showing the primary results'));
   assert(!system.includes('The runtime context names the DeepSeek Harness implementation checkout'));
   assert.deepEqual(names,role==='VA'?[]:['va_ask']);
  }else{assert(names.includes('ka_ask'));assert(!names.includes('va_ask'))}
  const all=options.messages.flatMap(m=>m.content).map(b=>b.text??'').join('\n');
  assert(!all.includes('Its closing message:'),'no duplicate settlement text in model input');
  const round=[...all.matchAll(/ROUND_\d+/g)].at(-1)?.[0];assert(round,'current question must survive');
  const expected=role==='MAIN'?'KA_ROUTE:'+round:'VA_ANCHOR:'+round;
  const ready=role==='VA'||options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.text?.includes(expected)));
  requests.push({role,round,phase:ready?'answer':'ask',tools:names});assert(requests.length<30,'no repeated exploration');
  assert(!options.messages.some(m=>m.source?.kind==='subagent-settled'),'answer must arrive only through tool result');
  if(role==='VA'&&round==='ROUND_3'){
   await new Promise((_resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})});
  }
  if(!ready){
   const block={type:'tool-call',id:'call-'+requests.length,name:role==='MAIN'?'ka_ask':'va_ask',arguments:JSON.stringify({query:'咨询问题 '+round})};
   yield{type:'block-start',index:0,blockType:'tool-call'};
   yield{type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
   yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};return;
  }
  const text=(role==='VA'?'VA_ANCHOR:':role==='KA'?'KA_ROUTE:':'MAIN_ANSWER:')+round;
  yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};
  yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};
 }
}
let ctx,main;
const timeout=async predicate=>{const deadline=Date.now()+20000;while(!predicate()){if(Date.now()>deadline)throw Error('timeout '+JSON.stringify(requests));await new Promise(r=>setTimeout(r,20))}};
try{
 ({ctx}=await runProfile({profile:'headless',patchFiles:[],args:[],environment:loadLayeredEnv('dsh')}));ctx.llm.registerAdapter(['oks-test'],new Local());
 main=await ctx.agents.create({sessionId:'session-host-wait-check-'+Date.now(),meta:{cwd:workspace,agentPreset:'oks'},agentOptions:{provider:'oks-test',model:'local-fixture'},setup:async c=>{await ctx.agentPresets.mount(c,'oks')}});
 for(let i=1;i<=4;i++){
  main.agent.followup({id:'question-'+i,role:'user',source:{kind:'user'},content:[{type:'text',text:'咨询问题 ROUND_'+i}]});
  if(i===3){
   await timeout(()=>requests.some(r=>r.role==='VA'&&r.round==='ROUND_3'));
   main.agent.cancel({kind:'user'});
   await timeout(()=>main.agent.status==='idle');
   assert(!requests.some(r=>r.round==='ROUND_3'&&r.role!=='VA'&&r.phase==='answer'));
   continue;
  }
  await timeout(()=>requests.some(r=>r.role==='MAIN'&&r.round==='ROUND_'+i&&r.phase==='answer')&&main.agent.status==='idle');
  assert.deepEqual(requests.filter(r=>r.round==='ROUND_'+i).map(r=>r.role+':'+r.phase),['MAIN:ask','KA:ask','VA:answer','KA:answer','MAIN:answer']);
  if(i===2){
   const id=main.agent.id;await main.dispose();
   main=await ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'oks-test',model:'local-fixture'},setup:async c=>{await ctx.agentPresets.mount(c,'oks')}});
  }
 }
 const ka=await ctx.subagents.listChildren(main.agent.id);assert.equal(ka.length,1);assert.match(ka[0].id,/^session-ka-/);
 const va=await ctx.subagents.listChildren(ka[0].id);assert.equal(va.length,1);assert.match(va[0].id,/^session-va-/);
 assert(!ctx.agents.get(ka[0].id));assert(!ctx.agents.get(va[0].id));
 console.log('HOST_RESULT',JSON.stringify({requests:requests.map(({role,round,phase})=>({role,round,phase})),ka:ka[0].id,va:va[0].id,successfulRounds:3,cancelledRounds:1,duplicateNotices:0}));
}finally{await main?.dispose();await ctx?.fiber.dispose()}
