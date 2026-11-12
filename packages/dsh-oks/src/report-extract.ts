import {lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import type {ApprovalService,ToolDefinition,ToolExec} from './host.ts';
import {isRecord} from './host.ts';
import type {Knowledge} from './knowledge.ts';
import type {FilePolicyService} from './remove-file.ts';
import {OBJECT_OUTPUT} from './response.ts';
import {readReportPage} from './report-archive.ts';

export function extractDariSource(html:string):string {
 const archive=readReportPage(html);
 if('error' in archive)throw new Error(archive.error);
 // Line comments keep arbitrary archived strings (including */) inert.
 const metadata=JSON.stringify(archive.context,null,2).split('\n').map(line=>'# '+line).join('\n');
 return '# Report execution metadata (historical; rerunning uses a new context)\n'+metadata+'\n\n'+archive.source;
}
export function reportExtractDariTool(options:{knowledge:Knowledge;approval?:()=>ApprovalService|undefined;filePolicy?:()=>FilePolicyService|undefined}):ToolDefinition {
 const extension='.dari';
 return {
  name:'report_extract_dari',
  description:'Extract archived analysis source from a local HTML report into a new workspace '+extension+' file. Prepends historical execution context, captured context values, model identity and execution timestamps as comments. Does not execute queries. sink is the exact new filename; existing files are never overwritten.',
  parameters:{type:'object',properties:{src:{type:'string',description:'Local HTML report path inside the workspace.'},sink:{type:'string',description:'Exact new '+extension+' file path inside the workspace; parent directory must exist.'}},required:['src','sink'],additionalProperties:false},
  output:{schema:OBJECT_OUTPUT,render:(_args:never,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(raw:unknown,exec:ToolExec){
   if(!isRecord(raw)||Object.keys(raw).length!==2||!['src','sink'].every(k=>typeof raw[k]==='string'&&raw[k].trim()&&!raw[k].includes('\0')&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw[k])))throw new Error('report_extract_dari requires local src and sink paths');
   const root=realpathSync(options.knowledge.ensureWorkspace(exec).root),src=resolve(root,raw.src as string),sink=resolve(root,raw.sink as string);
   const inside=(base:string,path:string)=>{const r=relative(base,path);return !!r&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
   const noLinks=(path:string)=>{let p=root;for(const part of relative(root,path).split(sep)){p=resolve(p,part);if(lstatSync(p).isSymbolicLink())throw new Error('report_extract_dari does not accept symbolic links');}};
   const validate=()=>{
    exec.signal?.throwIfAborted();
    const policy=options.filePolicy?.()?.resolve({session:exec.agent?.session});
    if(!policy||!['workspace-write','danger-full-access'].includes(policy.mode))throw new Error('report_extract_dari requires a writable host workspace');
    const boundary=realpathSync(policy.workspaceRoot);
    if(![src,sink].every(p=>inside(root,p)&&inside(boundary,p)))throw new Error('report_extract_dari paths must be inside the workspace');
    if(!sink.endsWith(extension))throw new Error('report_extract_dari sink must end in '+extension);
    noLinks(src);if(dirname(sink)!==root)noLinks(dirname(sink));
    if(!lstatSync(src).isFile())throw new Error('report_extract_dari src must be a regular file');
    if(!lstatSync(dirname(sink)).isDirectory())throw new Error('report_extract_dari sink parent must exist');
    try{lstatSync(sink);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    throw new Error('report_extract_dari sink already exists');
   };
   validate();
   const approval=options.approval?.();if(!approval||!exec.agent)throw new Error('report_extract_dari requires host approval service and a caller');
   const decision=await approval.request({agent:exec.agent,toolName:'report_extract_dari',callId:exec.callId,reason:'提取分析稿 → '+relative(root,sink),signal:exec.signal});
   if(decision!=='allowed-once')throw new Error('report_extract_dari was not approved');
   validate();const source=extractDariSource(readFileSync(src,'utf8'));writeFileSync(sink,source,{encoding:'utf8',flag:'wx'});
   return {src:relative(root,src),sink:relative(root,sink),bytes:Buffer.byteLength(source)};
  },
 };
}
