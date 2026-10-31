import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createTools} from './src/tools.ts';
import {guidedTools} from './src/guided-tools.ts';
const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'oks-source-resources-'));
const graph={datasets:{d:{dimensions:{},measures:{},fields:{}}},items:[{key:'datasets/d',names:['Dataset'],doc:'fixture'}]};
const entry={root,modelHash:'fixture',settings:{domain:'test',workspaceRoot:root}};
const knowledge={ensureWorkspace:()=>entry,ensureIndex:async()=>({knowledge:graph})} as any;
const definitions=createTools({knowledge,ka:{} as any,timeContext:{zones:new Map()} as any,log(){},config:undefined});
const tools=guidedTools(definitions,knowledge),exec={agent:{session:{id:'resources'}}} as any;
const call=(name:string,args:unknown)=>tools.find(t=>t.name===name)!.execute(args as never,exec) as Promise<any>;
try{
 await call('oks_write',{path:'oks://work/a.dari',content:'data a := 1;'});
 assert((await call('oks_read',{path:'oks://work/a.dari'})).lines[0].text.includes('data a'));
 await call('oks_edit',{path:'oks://work/a.dari',old_string:'1',new_string:'2'});
 assert((await call('oks_read',{path:'oks://work/a.dari'})).lines[0].text.includes('2'));
 for(const path of ['oks://memory/tools/ktools.lib.jq','oks://builtin/tools/ktools.lib.jq','oks://work/../oks.json'])await assert.rejects(call('oks_write',{path,content:'invalid'}));
 assert.equal((await call('oks_card',{id:'datasets/d'})).data.id,'datasets/d');
 assert((await call('oks_list',{path:'oks://help/'})).files.length>0);
 await call('oks_delete',{path:'oks://work/a.dari'});assert.equal((await call('oks_list',{path:'oks://work/'})).files.length,0);
 console.log('Source resources: work editing, fixed knowledge, manuals and retired library boundaries passed');
}finally{definitions.dispose();rmSync(root,{recursive:true,force:true});}
