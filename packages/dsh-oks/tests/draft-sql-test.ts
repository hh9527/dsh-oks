import assert from 'node:assert/strict';
import {SqlWorkspace} from '../src/draft/sql.ts';
const col=(name:string,type='Float',nullable=true)=>({name,type,nullable});
const workspace=new SqlWorkspace();
const input={x:{columns:[col('s','String')],rows:[{s:"<literal>; O'Reilly"}],truncated:false}};
try{
 const checkedOnly=await workspace.execute('check','WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT x FROM n',{},true);
 assert.deepEqual(checkedOnly.rows,[],'prepare must not execute even an unbounded recursive query');
 const value=await workspace.execute('test','SELECT s FROM t_x',input);assert.equal(value.rows[0].s,"<literal>; O'Reilly");
 await assert.rejects(workspace.execute('test','SELECT s FROM t_x; DELETE FROM t_x',input),/exactly one/);
 await assert.rejects(workspace.execute('test','SELECT "missing" FROM t_x',input),/missing/);
 await assert.rejects(workspace.execute('test','SELECT s FROM t_x',{x:{...input.x,truncated:true}}),/truncated/);
 const empty=await workspace.execute('test','SELECT s FROM t_x',{x:{...input.x,rows:[]}});assert.equal(empty.rows.length,0);assert.equal(empty.columns[0].name,'s');
}finally{await workspace.close('test');}
console.log('SQL workspace: schema-only prepare, read-only statements, typed columns, truncation and empty results passed');
