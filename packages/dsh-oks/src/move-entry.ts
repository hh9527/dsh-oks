import {lstatSync,realpathSync,renameSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import type {ApprovalService,ToolDefinition,ToolExec} from './host.ts';
import {isRecord} from './host.ts';
import type {Knowledge} from './knowledge.ts';
import type {FilePolicyService} from './remove-file.ts';
import {OBJECT_OUTPUT} from './response.ts';

/** Rename one file or directory to an exact destination; never interpret sink as a container. */
export function moveEntryTool(options:{knowledge:Knowledge;approval?:()=>ApprovalService|undefined;filePolicy?:()=>FilePolicyService|undefined}):ToolDefinition {
  return {
    name:'move_entry',
    description:'Move or rename one file or directory within the workspace. src and sink are exact entry paths including their final names, not containing directories. sink must not exist and its parent must exist; nothing is overwritten or merged. Symbolic links, wildcards and batches are rejected. Uses host sandbox and approval policy.',
    parameters:{type:'object',properties:{src:{type:'string',description:'Exact existing file or directory path.'},sink:{type:'string',description:'Exact new path including the final name; not an existing destination directory.'}},required:['src','sink'],additionalProperties:false},
    output:{schema:OBJECT_OUTPUT,render:(_args:never,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(raw:unknown,exec:ToolExec){
      if(!isRecord(raw)||Object.keys(raw).length!==2||!['src','sink'].every(key=>typeof raw[key]==='string'&&raw[key].trim()&&!/[\0*?\[\]]/.test(raw[key])&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw[key])&&!['','.','..'].includes(raw[key].split(sep).at(-1)!)))
        throw new Error('move_entry requires exactly src and sink as literal paths including final names');
      const root=realpathSync(options.knowledge.ensureWorkspace(exec).root);
      const src=resolve(root,raw.src as string),sink=resolve(root,raw.sink as string);
      const inside=(base:string,path:string)=>{const r=relative(base,path);return r!==''&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
      if(!inside(root,src)||!inside(root,sink))throw new Error('move_entry paths must be entries inside the workspace');
      if(src===sink||inside(src,sink))throw new Error('move_entry sink must differ from src and cannot be inside it');
      const noLinks=(path:string)=>{
        let current=root;
        for(const part of relative(root,path).split(sep)){
          current=resolve(current,part);
          if(lstatSync(current).isSymbolicLink())throw new Error('move_entry does not accept symbolic links');
        }
      };
      const validate=()=>{
        exec.signal?.throwIfAborted();
        const policy=options.filePolicy?.()?.resolve({session:exec.agent?.session});
        if(!policy)throw new Error('move_entry requires the host sandbox policy');
        if(!['workspace-write','danger-full-access'].includes(policy.mode))throw new Error('move_entry denied under read-only mode');
        const boundary=realpathSync(policy.workspaceRoot);
        if(!inside(boundary,src)||!inside(boundary,sink))throw new Error('move_entry path is outside the host workspace');
        noLinks(src);
        const parent=dirname(sink);
        if(parent!==root)noLinks(parent);
        if(!lstatSync(parent).isDirectory())throw new Error('move_entry sink parent must be an existing directory');
        try{lstatSync(sink);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return sourceStat();}
        throw new Error('move_entry sink already exists; provide the exact new name without overwriting');
      };
      const sourceStat=()=>{
        const stat=lstatSync(src);
        if(!stat.isFile()&&!stat.isDirectory())throw new Error('move_entry src must be a regular file or directory');
        return stat;
      };
      const before=validate();
      const approval=options.approval?.();
      if(!approval||!exec.agent)throw new Error('move_entry requires host approval service and a caller');
      const decision=await approval.request({agent:exec.agent,toolName:'move_entry',callId:exec.callId,reason:`移动 ${relative(root,src)} → ${relative(root,sink)}`,signal:exec.signal});
      if(decision!=='allowed-once')throw new Error('move_entry was not approved');
      const after=validate();
      if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
        throw new Error('move_entry src changed while awaiting approval; retry');
      renameSync(src,sink);
      return {moved:true,src:relative(root,src),sink:relative(root,sink)};
    },
  };
}
