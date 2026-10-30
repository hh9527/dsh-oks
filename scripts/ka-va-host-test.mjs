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
const requests=[];class Local extends LlmAdapter{
 async resolveModel(provider,id){return{provider,id,name:id,reasoning:{efforts:[{id:'off',name:'Off'}]}}}
 async *stream(options){
  const names=options.tools?.map(t=>t.name)??[];const text=options.messages.filter(m=>m.role==='system').flatMap(m=>m.content).map(b=>b.text??'').join('\n');
  assert(!text.includes('Prefer showing the primary results'));assert(!text.includes('The runtime context names the DeepSeek Harness implementation checkout'));
  const isVA=text.includes('# 领域词汇对齐');
  assert.deepEqual(names,isVA?[]:['va_ask']);
  if(!isVA && requests.some(r=>r.role==='VA')) assert(options.messages.some(m=>m.content.some(b=>b.text?.includes('VA_ANCHOR'))),'KA must receive VA answer');
  requests.push({role:isVA?'VA':'KA',tools:names});
  yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:isVA?'VA_ANCHOR':'KA_CHECKED'};
  yield{type:'block-end',index:0,block:{type:'text',text:isVA?'VA_ANCHOR':'KA_CHECKED'}};yield{type:'finish',reason:'stop'};
 }
}
let ctx,ka,main;const timeout=async predicate=>{const deadline=Date.now()+20000;while(!predicate()){if(Date.now()>deadline)throw Error('timeout '+JSON.stringify(requests));await new Promise(r=>setTimeout(r,20))}};
try{
 ({ctx}=await runProfile({profile:'headless',patchFiles:[],args:[],environment:loadLayeredEnv('dsh')}));ctx.llm.registerAdapter(['oks-test'],new Local());
 const create=async(id,p)=>ctx.agents.create({sessionId:id,meta:{cwd:workspace,agentPreset:p},agentOptions:{provider:'oks-test',model:'local-fixture'},setup:async c=>{await ctx.agentPresets.mount(c,p)}});
 ka=await create('session-host-ka-check-'+Date.now(),'oks-knowledge');
 ka.agent.followup({id:'initial',role:'user',source:{kind:'user'},content:[{type:'text',text:'核对工具'}]});
 await timeout(()=>requests.length===1&&ka.agent.status==='idle');
 const vaTool=ctx.tools.get('va_ask',ka.agent);assert(vaTool,'KA registry missing va_ask');assert(!ctx.tools.get('ka_ask',ka.agent));
 const accepted=await vaTool.execute({query:'CPU 对应的规范名称和知识地址'},{agent:ka.agent});assert.match(accepted.helper,/^session-va-/);
 await timeout(()=>requests.some(r=>r.role==='VA')&&requests.filter(r=>r.role==='KA').length===2&&ka.agent.status==='idle');
 main=await create('session-host-main-check-'+Date.now(),'oks');assert(ctx.tools.get('ka_ask',main.agent));assert(!ctx.tools.get('va_ask',main.agent));
 console.log('HOST_RESULT',JSON.stringify({requests,helper:accepted.helper,mainHasKa:true,mainHasVa:false}));
}finally{await main?.dispose();await ka?.dispose();await ctx?.fiber.dispose()}
