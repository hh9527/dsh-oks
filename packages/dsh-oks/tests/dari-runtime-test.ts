import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'dari-pinned-runtime-'));
try{
 const plugin=join(root,'plugin');
 cpSync(join(repo,'dist/dsh-oks/lib'),join(plugin,'lib'),{recursive:true});
 cpSync(join(repo,'dist/dsh-oks/dari-runtime'),join(plugin,'dari-runtime'),{recursive:true});
 const revision=JSON.parse(readFileSync(join(plugin,'dari-runtime/source.json'),'utf8'));
 assert.equal(revision.commit,execFileSync('git',['-C',join(repo,'vendors/dari'),'rev-parse','HEAD'],{encoding:'utf8'}).trim());
 assert(existsSync(join(plugin,'lib/model-worker.mjs')));
 const integration=join(root,'integration.mjs');
 writeFileSync(integration,'import {dariHost} from "./plugin/lib/index.mjs";export function createIntegration(){return {options:{host:dariHost}};}');
 const database=join(root,'test.sqlite');new DatabaseSync(database).close();
 const source='data rows=table([{name:"A",n:1},{name:"B",n:2}]);data top=query! {let a=from(rows);let output=a |> project({name:a.name,n:a.n});output |> order_by(desc(output.n)) |> take(1)};answer tree! {Answer [BarChart(data=top,spec={category:$.name,value:$.n})]};';
 const service=join(plugin,'dari-runtime/node_modules/@hh9527/dari/dist/service.js');
 const child=spawn(process.execPath,[service,'--integration',integration,'--database',database],{cwd:root});
 let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try{
  child.stdin.end([JSON.stringify({id:1,method:'check',source}),JSON.stringify({id:2,method:'resolve',source})].join('\n')+'\n');
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,errors);const results=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(results.length,2,output);for(const result of results)assert(!result.error,result.error);
  assert.match(results[1].result.answer,/chart_1.svg/);assert.match(results[1].result.dataDocument,/B,2/);
 }finally{clearTimeout(timer);child.kill();}
 console.log('Pinned DARI runtime: revision, isolated plugin imports, SQL pipeline, charts and data receipt passed');
}finally{rmSync(root,{recursive:true,force:true});}
