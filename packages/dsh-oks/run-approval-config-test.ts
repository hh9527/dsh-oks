import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolveSettings} from './src/config.ts';
const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'oks-approval-config-'));
const workspace=(value:object)=>writeFileSync(join(root,'oks.json'),JSON.stringify({domain:'fixture',model:'model.wasm',...value}));
try{
 workspace({});assert.equal(resolveSettings(root,undefined).requireRunApproval,false);
 workspace({requireRunApproval:true});assert.equal(resolveSettings(root,undefined).requireRunApproval,true);
 assert.equal(resolveSettings(root,{requireRunApproval:false}).requireRunApproval,false);
 workspace({requireRunApproval:false});assert.equal(resolveSettings(root,{requireRunApproval:true}).requireRunApproval,true);
 workspace({requireRunApproval:'false'});assert.throws(()=>resolveSettings(root,undefined),/must be boolean/);
 workspace({});assert.throws(()=>resolveSettings(root,{requireRunApproval:'true'} as any),/must be boolean/);
 console.log('Run approval configuration: default off, workspace setting, plugin override and invalid values passed');
}finally{rmSync(root,{recursive:true,force:true});}
