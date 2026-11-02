import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeFileTool} from './src/remove-file.ts';
const root=mkdtempSync(join(tmpdir(),'oks-remove-')),outside=mkdtempSync(join(tmpdir(),'oks-outside-'));
let mode='workspace-write',decision='allowed-once',approvals=0;
let onApproval=()=>{};
const exec={agent:{session:{id:'remove-test'}}} as any;
const options={knowledge:{ensureWorkspace:()=>({root})} as any,filePolicy:()=>({resolve:()=>({mode,workspaceRoot:root})}),approval:()=>({async request(){approvals++;onApproval();return decision;}}) as any};
const tool=removeFileTool(options);
const call=(args:unknown)=>tool.execute(args as never,exec);
try{
 mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested/a.txt'),'a');
 assert.deepEqual(await call({path:'nested/a.txt'}),{removed:true,path:'nested/a.txt'});
 assert(!existsSync(join(root,'nested/a.txt')));
 writeFileSync(join(root,'a.txt'),'a');writeFileSync(join(outside,'keep.txt'),'outside');
 symlinkSync(outside,join(root,'escape'));symlinkSync(join(root,'a.txt'),join(root,'alias'));
 const count=approvals;
 for(const path of ['.','nested','missing','../keep.txt',join(outside,'keep.txt'),'escape/keep.txt','alias','*.txt','oks://work/a.txt','a.txt\0'])
  await assert.rejects(call({path}));
 for(const args of [{path:['a.txt']},{path:'a.txt',extra:true},{paths:['a.txt']},{path:''}])await assert.rejects(call(args));
 assert.equal(approvals,count);assert(existsSync(join(root,'a.txt')));assert(existsSync(join(outside,'keep.txt')));
 mode='read-only';await assert.rejects(call({path:'a.txt'}),/read-only/);assert.equal(approvals,count);
 mode='workspace-write';decision='rejected';await assert.rejects(call({path:'a.txt'}),/not approved/);assert(existsSync(join(root,'a.txt')));
 decision='allowed-once';onApproval=()=>writeFileSync(join(root,'a.txt'),'changed');
 await assert.rejects(call({path:'a.txt'}),/target changed/);assert(existsSync(join(root,'a.txt')));
 onApproval=()=>{};
 const abort=new AbortController();abort.abort();await assert.rejects(tool.execute({path:'a.txt'} as never,{...exec,signal:abort.signal}));
 await assert.rejects(removeFileTool({...options,filePolicy:undefined}).execute({path:'a.txt'} as never,exec),/sandbox policy/);
 assert.deepEqual(await call({path:join(root,'a.txt')}),{removed:true,path:'a.txt'});
 console.log('remove_file: single-file deletion, sandbox/approval, rejection, cancellation, path/symlink boundaries and changed-target guard passed');
}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
