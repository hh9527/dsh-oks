import assert from 'node:assert/strict';
import {checkDesign,parseExecutableDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {SqlWorkspace} from './src/draft/sql.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';
const col=(name:string,type='Float',nullable=true)=>({name,type,nullable});
const columns=[col('server','String',false),col('cpu')];
let reads=0;
const entry={modelHash:'sql-test',settings:{domain:'test',queryMaxRows:100},runner:{async send(_m:string,{intents}:any){return {ok:{accepted:true,queries:[{sql:JSON.stringify(intents[0]),bindings:[10],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const backend=createDraftBackend({entry,file:'sql.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){reads++;return {manifest:null,executor:{async send(sql:string){const intent=JSON.parse(sql);return {columns:['server','cpu'],truncated:false,rows:intent.period==='base'?[{server:'a',cpu:30},{server:'b',cpu:null},{server:'c',cpu:50}]:[{server:'a',cpu:35},{server:'b',cpu:80},{server:'c',cpu:48}]};}}} as any;}}});
const sql=`SELECT b.server, b.cpu AS base_cpu, c.cpu AS current_cpu, c.cpu-b.cpu AS delta FROM t_base b JOIN t_current c USING(server) WHERE b.cpu IS NOT NULL AND c.cpu IS NOT NULL ORDER BY delta DESC, b.server LIMIT 3`;
const draft=(code=sql,figureColumn='delta')=>`<Dari><Pipeline>
base <-query({period:"base",limit:10});
current <-query({period:"current",limit:10});
comparison <-sql("compare.sql",{base,current});
final <-sql("final.sql",{comparison});
spec <-data({columns:["server","${figureColumn}"]});
</Pipeline>
<Asset language="sql" name="compare.sql">${code}</Asset>
<Asset language="sql" name="final.sql">SELECT server, delta FROM t_comparison ORDER BY delta DESC,server</Asset>
<Figures><Table name="comparison" data={final} spec={spec}/></Figures>
<Report name="answer"><article><figure><Figure ref="comparison"/></figure></article></Report>
</Dari>`;
let result=await checkDesign(draft(sql.replace('c.cpu-b.cpu','c.wrong_cpu-b.cpu')),'sql.dari',backend);
assert.equal(reads,0,'check must not open business database');
assert.equal(result.ok,false);assert(result.diagnostics.some(d=>/wrong_cpu/.test(d.message)),JSON.stringify(result));
result=await checkDesign(draft(),'sql.dari',backend);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(reads,0);
assert.deepEqual((result.queries.find(q=>q.binding==='final')!.columns as any[]).map(c=>c.name),['server','delta']);
assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
result=await checkDesign(draft(sql,'missing'),'sql.dari',backend);assert(result.diagnostics.some(d=>/Missing figure columns: missing/.test(d.message)),JSON.stringify(result));
const unused=await checkDesign('<Dari><Pipeline>x <-data(1);</Pipeline><Asset language="sql" name="unused.sql">SELECT FROM</Asset></Dari>','sql.dari',backend);
assert.equal(unused.ok,false);assert(unused.diagnostics.some(d=>d.asset==='unused.sql'&&d.stage==='sql'));
const runtime=new DraftRuntime(backend,{parse:parseExecutableDesign});
try{
 const run=await runtime.run(draft());assert.equal(run.status,'complete',run.error);
 assert.deepEqual(runtime.read('final',draft()).value.data.rows,[{server:'a',delta:5},{server:'c',delta:-2}]);
 const origin=runtime.read('final',draft()).value.sources[0].origin;
 assert(Object.values(origin.nodes).some((node:any)=>node.method==='sql'&&node.snip.includes('t_comparison')));
 const count=reads;const again=await runtime.run(draft());assert.equal(again.status,'complete',again.error);assert.equal(reads,count,'query and SQL cache hits');
 const edited=draft().replace('SELECT server, delta FROM','SELECT server, delta+1 AS delta FROM');
 const rerun=await runtime.run(edited);assert.equal(rerun.status,'complete',rerun.error);assert.equal(reads,count,'register cached upstream result sets in a fresh SQLite workspace');
 assert.equal(runtime.read('final',edited).value.data.rows[0].delta,6);
}finally{runtime.dispose();}
const workspace=new SqlWorkspace();
const input={x:{columns:[col('s','String')],rows:[{s:"</Asset>; O'Reilly"}],truncated:false}};
try{
 const checkedOnly=await workspace.execute('check','WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT x FROM n',{},true);
 assert.deepEqual(checkedOnly.rows,[],'prepare must not execute even an unbounded recursive query');
 const value=await workspace.execute('test','SELECT s FROM t_x',input);assert.equal(value.rows[0].s,"</Asset>; O'Reilly");
 await assert.rejects(workspace.execute('test','SELECT s FROM t_x; DELETE FROM t_x',input),/exactly one/);
 await assert.rejects(workspace.execute('test','SELECT "missing" FROM t_x',input),/missing/);
 await assert.rejects(workspace.execute('test','SELECT s FROM t_x',{x:{...input.x,truncated:true}}),/truncated/);
 const empty=await workspace.execute('test','SELECT s FROM t_x',{x:{...input.x,rows:[]}});assert.equal(empty.rows.length,0);assert.equal(empty.columns[0].name,'s');
 const parsed=await checkDesign(draft("SELECT '</Asset>' AS server, 1 AS delta -- SQL string delimiter\n"),'sql.dari',backend);assert.equal(parsed.ok,true,JSON.stringify(parsed));
}finally{await workspace.close('test');}
console.log('SQL assets: schema-only checking, SQL chaining, figure columns, runtime, cache registration, nulls, empty results and provenance passed');
