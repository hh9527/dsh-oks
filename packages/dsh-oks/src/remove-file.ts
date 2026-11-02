import {lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import type {ApprovalService,ToolDefinition,ToolExec} from './host.ts';
import {isRecord} from './host.ts';
import type {Knowledge} from './knowledge.ts';
import {OBJECT_OUTPUT} from './response.ts';

export interface FilePolicyService {
  resolve(request:{session:unknown}):{mode:string;workspaceRoot:string};
}

/** A deliberately narrow filesystem effect; no shell, recursion, or symlink traversal. */
export function removeFileTool(options:{knowledge:Knowledge;approval?:()=>ApprovalService|undefined;filePolicy?:()=>FilePolicyService|undefined}):ToolDefinition {
  return {
    name:'remove_file',
    description:'Delete one existing regular file inside the workspace. path is a literal local path; directories, symbolic links, wildcards and batches are rejected. Uses the host sandbox policy and approval policy.',
    parameters:{type:'object',properties:{path:{type:'string',description:'One workspace-relative or workspace-contained absolute file path.'}},required:['path'],additionalProperties:false},
    output:{schema:OBJECT_OUTPUT,render:(_args:never,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(raw:unknown,exec:ToolExec){
      if(!isRecord(raw)||Object.keys(raw).length!==1||typeof raw.path!=='string'||!raw.path.trim()||/[\0*?\[\]]/.test(raw.path)||/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.path))
        throw new Error('remove_file requires exactly one literal local path');
      const root=realpathSync(options.knowledge.ensureWorkspace(exec).root);
      const target=resolve(root,raw.path),local=relative(root,target);
      if(!local||local==='..'||local.startsWith('..'+sep)||isAbsolute(local))throw new Error('remove_file path must be a file inside the workspace');
      const validate=()=>{
        exec.signal?.throwIfAborted();
        const policy=options.filePolicy?.()?.resolve({session:exec.agent?.session});
        if(!policy)throw new Error('remove_file requires the host sandbox policy');
        if(!['workspace-write','danger-full-access'].includes(policy.mode))throw new Error('remove_file denied under read-only mode');
        const boundary=relative(realpathSync(policy.workspaceRoot),target);
        if(boundary==='..'||boundary.startsWith('..'+sep)||isAbsolute(boundary))throw new Error('remove_file path is outside the host workspace');
        let current=root;
        for(const part of local.split(sep)){
          current=resolve(current,part);
          if(lstatSync(current).isSymbolicLink())throw new Error('remove_file does not accept symbolic links');
        }
        const stat=lstatSync(target);
        if(!stat.isFile())throw new Error('remove_file only accepts a regular file');
        return stat;
      };
      const before=validate();
      const approval=options.approval?.();
      if(!approval||!exec.agent)throw new Error('remove_file requires host approval service and a caller');
      const decision=await approval.request({agent:exec.agent,toolName:'remove_file',callId:exec.callId,reason:`删除文件 ${local}`,signal:exec.signal});
      if(decision!=='allowed-once')throw new Error('remove_file was not approved');
      const after=validate();
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
        throw new Error('remove_file target changed while awaiting approval; retry');
      unlinkSync(target);
      return {removed:true,path:local};
    },
  };
}
