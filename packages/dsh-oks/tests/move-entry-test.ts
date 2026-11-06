import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {moveEntryTool} from '../src/move-entry.ts';
const root=mkdtempSync(join(tmpdir(),'oks-move-')),outside=mkdtempSync(join(tmpdir(),'oks-move-out-'));
let mode='workspace-write',decision='allowed-once',approvals=0;
let onApproval=()=>{};
const options={knowledge:{ensureWorkspace:()=>({root})} as any,filePolicy:()=>({resolve:()=>({mode,workspaceRoot:root})}),approval:()=>({async request(){approvals++;onApproval();return decision;}}) as any};
const tool=moveEntryTool(options),exec={agent:{session:{id:'move-test'}}} as any;
const call=(args:unknown)=>tool.execute(args as never,exec);
try{
 writeFileSync(join(root,'a'),'original');mkdirSync(join(root,'target'));
 await assert.rejects(call({src:'a',sink:'target'}),/sink already exists/);
 assert(!existsSync(join(root,'target/a')));
 assert.deepEqual(await call({src:'a',sink:'target/renamed'}),{moved:true,src:'a',sink:'target/renamed'});
 assert(!existsSync(join(root,'a')));assert.equal(readFileSync(join(root,'target/renamed'),'utf8'),'original');
 assert.deepEqual(await call({src:join(root,'target'),sink:join(root,'renamed-dir')}),{moved:true,src:'target',sink:'renamed-dir'});
 assert.equal(readFileSync(join(root,'renamed-dir/renamed'),'utf8'),'original');
 writeFileSync(join(root,'keep'),'keep');symlinkSync(outside,join(root,'escape'));symlinkSync(join(root,'keep'),join(root,'alias'));
 const n=approvals;
 for(const args of [
  {src:'keep',sink:'keep'},{src:'renamed-dir',sink:'renamed-dir/child'},
  {src:'.',sink:'new'},{src:'keep',sink:'../outside'},{src:'keep',sink:'missing/child'},
  {src:'missing',sink:'new'},{src:'alias',sink:'new'},{src:'keep',sink:'alias'},
  {src:'keep',sink:'escape/new'},{src:'escape/x',sink:'new'},{src:'keep',sink:'name/'},
  {src:['keep'],sink:'new'},{src:'keep',sink:'*.txt'},{src:'keep',sink:'oks://work/new'},
  {src:'keep',sink:'new',extra:true},
 ])await assert.rejects(call(args));
 assert.equal(approvals,n);assert.equal(readFileSync(join(root,'keep'),'utf8'),'keep');
 mode='read-only';await assert.rejects(call({src:'keep',sink:'new'}),/read-only/);assert.equal(approvals,n);
 mode='workspace-write';decision='rejected';await assert.rejects(call({src:'keep',sink:'new'}),/not approved/);
 decision='allowed-once';onApproval=()=>writeFileSync(join(root,'new'),'concurrent destination');
 await assert.rejects(call({src:'keep',sink:'new'}),/sink already exists/);
 assert.equal(readFileSync(join(root,'new'),'utf8'),'concurrent destination');
 onApproval=()=>writeFileSync(join(root,'keep'),'changed');
 await assert.rejects(call({src:'keep',sink:'next'}),/src changed/);
 assert(!existsSync(join(root,'next')));
 onApproval=()=>{};const abort=new AbortController();abort.abort();
 await assert.rejects(tool.execute({src:'keep',sink:'next'} as never,{...exec,signal:abort.signal}));
 await assert.rejects(moveEntryTool({...options,filePolicy:undefined}).execute({src:'keep',sink:'next'} as never,exec),/sandbox policy/);
 console.log('move_entry: exact names, file/directory rename, no overwrite/nesting, boundaries, symlinks, sandbox, approval and changed targets passed');
}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
