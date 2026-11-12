import {readDariSource} from './source-file.ts';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {PluginConfig} from './config.ts';
import type {Knowledge} from './knowledge.ts';
import type {AttachmentsService,ToolDefinition,ToolExec} from './host.ts';
import type {TimeContext} from './time-context.ts';

// The model proof and runtime service execute outside the agent process.
export function createDariTools(options:{config:PluginConfig['dari'];knowledge:Knowledge;timeContext:TimeContext;attachments?:()=>AttachmentsService|undefined}){
 const workers=new Map<string,{child:ChildProcessWithoutNullStreams;request:(value:unknown)=>Promise<any>}>();
 const contexts=new Map<string,{now:string;epochMillis:number;timeZone:string|null}>();
 let closed=false;
 function worker(database:string){
  let w=workers.get(database);if(w)return w;
  if(closed)throw Error('DARI tools disposed');
  const c=options.config;
  if(!c)throw Error('Configure dari.service, dari.model and dari.runner for model type proof and execution');
  const child=spawn(process.execPath,[c.service,c.model,c.runner,database,c.hostModule??fileURLToPath(new URL('./index.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],detached:true});
  let stderr='',sequence=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  const fail=(error:Error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();workers.delete(database);};
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});
  child.stdin.on('error',fail);child.on('error',fail);child.on('exit',code=>fail(Error('DARI service exited '+code+': '+stderr)));
  createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line),p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);if(v.error)p.reject(Error(v.error));else p.resolve(v.result);}catch(e){fail(e instanceof Error?e:Error(String(e)));stop();}});
  w={child,request:(value:any)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{fail(Error('DARI request timed out'));stop();},65000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({...value,id})+'\n');})};
  workers.set(database,w);return w;
 }
 const output={schema:{type:'object',additionalProperties:true},render:(_args:unknown,value:any)=>[{type:'text',text:value.text}]};
 const source=(root:string,raw:unknown)=>readDariSource(root,raw,'DARI').text;
 function environment(exec:ToolExec){
  exec.signal?.throwIfAborted();const entry=options.knowledge.ensureWorkspace(exec);
  if(!entry.settings.dataFile)throw Error('DARI requires the workspace dataFile');
  const session=exec.agent?.session;if(!session?.id)throw Error('DARI requires a session');
  const key=JSON.stringify([entry.root,session.id]);
  let context=contexts.get(key);
  if(!context){const epochMillis=Date.now(),zone=options.timeContext.zones.get(session);context={epochMillis,now:new Date(epochMillis).toISOString(),timeZone:zone?.kind==='resolved'?zone.timeZone:null};if(contexts.size>=128)contexts.delete(contexts.keys().next().value!);contexts.set(key,context);}
  return {entry,key,context,host:worker(entry.settings.dataFile)};
 }
 const tools:ToolDefinition[]=[...(['check','resolve'] as const).map(method=>({
  name:'dari_'+method,description:method==='check'?'Check the complete .dari file without reading business rows. Uses external model type proof for query_remote! and internal proof for query!/tree!. Accepts only src.':'Check and execute a .dari file, publish its artifacts and deliver the unique Answer as a visible conversation message. Accepts only src. Do not repeat the delivered Answer. If delivery is unavailable, forward the returned Answer verbatim; add observations separately.',
  parameters:{type:'object',properties:{src:{type:'string'}},required:['src'],additionalProperties:false},output,
  async execute(args:{src:string},exec:ToolExec){
   if(Object.keys(args).some(k=>k!=='src'))throw Error('Only src is accepted');
   const env=environment(exec);
   if(method==='resolve'&&env.entry.settings.requireRunApproval)throw Error('DARI execution is unavailable when requireRunApproval is enabled');
   const result=await env.host.request({method,source:source(env.entry.root,args.src),context:env.context,contextContractId:'dari-context/v2'});exec.signal?.throwIfAborted();
   if(method==='check')return {text:'Succeed\n-------\n'+result.types.map((t:any)=>'- '+t.name+': '+t.type).join('\n')};
   const links=new Map<string,string>(),artifacts=result.artifacts as Record<string,string>;
   const publish=async(name:string,content:string)=>{const attachments=options.attachments?.();if(!attachments)throw Error('Attachments service unavailable');const file=await attachments.saveFile({name,data:Buffer.from(content)});const path=attachments.fileHostPath(file);if(!path)throw Error('Attachment has no displayable path');links.set(name,encodeURI(path).replaceAll('(','%28').replaceAll(')','%29').replaceAll('#','%23').replaceAll('?','%3F'));};
   for(const [name,content]of Object.entries(artifacts))if(name.endsWith('.svg'))await publish(name,content);
   for(const [name,content]of Object.entries(artifacts))if(name.endsWith('.html')){let html=content;for(const [file,url]of links)html=html.replaceAll('src="'+file+'"','src="'+url.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"');await publish(name,html);}
   let answer=result.answer as string;for(const [file,url]of links)answer=answer.replaceAll(']('+file+')',']('+url+')');
   const agent=exec.agent as {inject?:(message:unknown)=>void}|undefined;
   if(typeof agent?.inject!=='function')return {text:'Answer delivery unavailable; forward the following Markdown verbatim:\n\n'+answer};
   const messageId=randomUUID();agent.inject({id:messageId,role:'user',source:{kind:'push-to-user',label:'dsh-oks'},content:[{type:'text',text:answer}]});
   return {text:'Succeed\n-------\n- answer message: '+messageId+'\nThe Answer is delivered; do not repeat it. Add commentary only when useful.'};
  }
 })),{
  name:'dari_renew_context',description:'Start a fresh context time snapshot for this session. Takes src, a local .dari file. Subsequent resolve reads current data with the fresh snapshot.',parameters:{type:'object',properties:{src:{type:'string'}},required:['src'],additionalProperties:false},output,
  async execute(args:{src:string},exec){const env=environment(exec);source(env.entry.root,args.src);contexts.delete(env.key);return {text:'Succeed\n-------\nContext renewed'};}
 }];
 return {tools,async infoContracts(points:any[],exec:ToolExec){
  exec.signal?.throwIfAborted();const entry=options.knowledge.ensureWorkspace(exec);
  const result=await worker(entry.settings.dataFile??'').request({method:'info_contracts',points});exec.signal?.throwIfAborted();return result;
 },dispose(){closed=true;for(const {child}of workers.values()){child.stdin.end();const timer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}},2000);timer.unref();child.once('exit',()=>clearTimeout(timer));}workers.clear();contexts.clear();}};
}
