import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../host.ts';

export type SqlColumn={name:string;type:string;nullable:boolean};
type Table={name:string;columns:SqlColumn[];rows:Record<string,unknown>[]};
type SqlResult={columns:SqlColumn[];rows:Record<string,unknown>[];truncated:boolean};

// Prepare and run use the same isolated SQLite implementation. Checking only creates schemas.
const SOURCE=String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(workerData.database,{enableDoubleQuotedStringLiterals:false,allowExtension:false});
db.function('dari_round',{deterministic:true},(value,digits)=>value===null?null:Math.sign(value)*Math.round(Math.abs(value)*10**digits)/10**digits);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const tables=new Map();
const declaration=t=>({Int:'INTEGER',Float:'REAL',Bool:'BOOLEAN',String:'TEXT',DateTimeUtc:'DateTimeUtc TEXT',DateTime:'DateTime TEXT',EpochMillis:'EpochMillis INTEGER'}[t]||'');
const logical=t=>({INTEGER:'Int',REAL:'Float',BOOLEAN:'Bool',TEXT:'String','DateTimeUtc TEXT':'DateTimeUtc','DateTime TEXT':'DateTime','EpochMillis INTEGER':'EpochMillis'}[t]||'Unknown');
parentPort.on('message',message=>{
 try{
  db.exec('PRAGMA query_only=OFF');
  const wanted=new Set(message.tables.map(t=>t.name));
  for(const name of tables.keys())if(!wanted.has(name)){db.exec('DROP TABLE '+quote(name));tables.delete(name);}
  for(const table of message.tables){
   const signature=JSON.stringify(table);
   if(tables.get(table.name)===signature)continue;
   db.exec('DROP TABLE IF EXISTS '+quote(table.name));
   db.exec('CREATE TABLE '+quote(table.name)+' ('+table.columns.map(c=>quote(c.name)+' '+declaration(c.type)+(c.nullable?'':' NOT NULL')).join(',')+')');
   const insert=db.prepare('INSERT INTO '+quote(table.name)+' VALUES ('+table.columns.map(()=>'?').join(',')+')');
   db.exec('BEGIN');
   try{for(const row of table.rows)insert.run(...table.columns.map(c=>typeof row[c.name]==='boolean'?Number(row[c.name]):row[c.name]));db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
   tables.set(table.name,signature);
  }
  db.exec('PRAGMA query_only=ON');
  const statement=db.prepare(message.sql);
  const columns=statement.columns().map(c=>({name:c.name,type:logical(c.type),nullable:true}));
  if(!columns.length)throw new Error('SQL asset must return columns');
  if(new Set(columns.map(c=>c.name.toLowerCase())).size!==columns.length)throw new Error('SQL output column names must be unique; use AS aliases');
  const rows=[];let truncated=false;
  if(!message.check)for(const raw of statement.iterate(...(message.bindings||[]))){
   if(rows.length>=10000){truncated=true;break;}
   const row={...raw};for(const c of columns)if(c.type==='Bool'&&row[c.name]!==null)row[c.name]=!!row[c.name];
   rows.push(row);
  }
  const result={columns,rows,truncated};
  if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw new Error('SQL output exceeds 8 MiB');
  parentPort.postMessage({result});
 }catch(error){parentPort.postMessage({error:error.message});}
});
`;

/** Exactly one read-only statement. SQLite preparation catches SQL and column errors. */
function checkStatement(sql:string,parameters=false){
 let code='',quote='',comment='';
 for(let i=0;i<sql.length;i++){
  const c=sql[i],n=sql[i+1];
  if(comment==='line'){if(c==='\n'){comment='';code+=' ';}continue;}
  if(comment==='block'){if(c==='*'&&n==='/'){comment='';i++;code+=' ';}continue;}
  if(quote){if(c===quote){if(n===quote)i++;else quote='';}continue;}
  if(c==='-'&&n==='-'){comment='line';i++;continue;}
  if(c==='/'&&n==='*'){comment='block';i++;continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){quote=c==='['?']':c;code+='x';continue;}
  code+=c;
 }
 if(quote||comment==='block')throw new Error('Unterminated SQL string, identifier or comment');
 if(!/^\s*(SELECT|WITH)\b/i.test(code)||!/^[^;]*;?\s*$/.test(code))throw new Error('SQL asset requires exactly one SELECT/WITH statement');
 if((parameters?/[:@$]/:/[?:@$]/).test(code))throw new Error('SQL assets use input tables; unbound SQL parameters are not allowed');
}
function inputs(value:unknown,check:boolean):Table[]{
 if(!isRecord(value))throw new Error('sql inputs must be a named object of result sets');
 const seen=new Set<string>();
 return Object.entries(value).map(([key,result])=>{
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))throw new Error('SQL input names must be identifiers');
  const name='t_'+key;
  if(seen.has(name.toLowerCase()))throw new Error('SQL table names must be unique ignoring case');seen.add(name.toLowerCase());
  if(!isRecord(result)||!Array.isArray(result.columns)||!result.columns.length)throw new Error(`SQL input ${key} requires a result set with columns; pass the whole query/SQL result, not .rows`);
  const columns=result.columns as SqlColumn[];
  const names=new Set<string>();
  for(const col of columns){
   if(!isRecord(col)||typeof col.name!=='string'||!col.name||typeof col.type!=='string'||typeof col.nullable!=='boolean')throw new Error(`Invalid SQL input columns: ${key}`);
   if(names.has(col.name.toLowerCase()))throw new Error(`Duplicate SQL input column: ${key}.${col.name}`);names.add(col.name.toLowerCase());
  }
  const rows=check?[]:result.rows;
  if(!Array.isArray(rows))throw new Error(`SQL input ${key} has no rows`);
  if(!check&&result.truncated)throw new Error(`SQL input ${key} is truncated; refine the upstream query before postprocessing`);
  for(const row of rows){
   if(!isRecord(row))throw new Error(`Invalid SQL input row: ${key}`);
   for(const col of columns){const v=row[col.name];if(v===undefined||v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))throw new Error(`Invalid SQL cell: ${key}.${col.name}`);}
  }
  return {name,columns,rows};
 });
}

const sweptRoots=new Set<string>();
function prepareCacheRoot(root:string){
 mkdirSync(root,{recursive:true,mode:0o700});
 if(sweptRoots.has(root))return;
 sweptRoots.add(root);
 for(const entry of readdirSync(root,{withFileTypes:true})){
  const match=/^draft-sql-(\d+)-/.exec(entry.name);
  if(!entry.isDirectory()||!match)continue;
  try{process.kill(Number(match[1]),0);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')rmSync(join(root,entry.name),{recursive:true,force:true});}
 }
}
/** Each instance belongs to one session/draft. Checks use separate schema-only memory databases. */
export class SqlWorkspace{
 private workers=new Map<string,Worker>();
 private directories=new Map<string,string>();
 private idleTimer?:ReturnType<typeof setTimeout>;
 private activeRuns=new Set<string>();
 private disposed=false;
 private readonly root:string;
 private readonly idleMs:number;
 constructor(options:{root?:string;idleMs?:number}={}){
  this.root=options.root??join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'dsh-oks-sql');
  this.idleMs=options.idleMs??15*60*1000;
 }
 beginRun(run:string){
  if(this.disposed)throw new Error('SQL workspace has been disposed');
  clearTimeout(this.idleTimer);this.activeRuns.add(run);
 }
 finishRun(run:string){this.activeRuns.delete(run);this.scheduleIdle();}
 private scheduleIdle(){
  clearTimeout(this.idleTimer);
  if(this.disposed||this.activeRuns.size||!this.workers.has('draft'))return;
  this.idleTimer=setTimeout(()=>{void this.close('draft');},this.idleMs);
  this.idleTimer.unref();
 }
 clear(){clearTimeout(this.idleTimer);return Promise.all([...this.workers.keys()].map(key=>this.close(key))).then(()=>{});}
 dispose(){this.disposed=true;return this.clear();}
 private queue=new Map<string,Promise<unknown>>();
 async execute(run:string,sql:string,value:unknown,check=false,signal?:AbortSignal,bindings?:unknown[]):Promise<SqlResult>{
  checkStatement(sql,bindings!==undefined);const tables=inputs(value,check);
  if(Buffer.byteLength(JSON.stringify(tables))>8*1024*1024)throw new Error('SQL inputs exceed 8 MiB');
  if(this.disposed)throw new Error('SQL workspace has been disposed');
  const key=check?'check:'+randomUUID():'draft';
  if(!check)clearTimeout(this.idleTimer);
  const previous=this.queue.get(key)??Promise.resolve();
  const work=previous.catch(()=>{}).then(()=>this.send(key,{sql,tables,check,bindings:bindings?.map(v=>typeof v==='boolean'?Number(v):v)},signal));
  this.queue.set(key,work);
  try{return await work;}catch(error){
   if(error instanceof Error&&/no such (column|table)|ambiguous column/i.test(error.message))throw new Error(error.message+'; available columns: '+tables.map(t=>t.name+'('+t.columns.map(c=>c.name).join(', ')+')').join('; '));
   throw error;
  }finally{if(this.queue.get(key)===work)this.queue.delete(key);if(check)await this.close(key);else this.scheduleIdle();}
 }
 private send(key:string,message:unknown,signal?:AbortSignal,bindings?:unknown[]):Promise<SqlResult>{
  signal?.throwIfAborted();
  if(this.disposed)throw new Error('SQL workspace has been disposed');
  let worker=this.workers.get(key);
  if(!worker){
   let database=':memory:';
   if(key==='draft'){
    prepareCacheRoot(this.root);
    const directory=mkdtempSync(join(this.root,`draft-sql-${process.pid}-`));
    this.directories.set(key,directory);database=join(directory,'cache.sqlite');
   }
   try{worker=new Worker(SOURCE,{eval:true,workerData:{database},resourceLimits:{maxOldGenerationSizeMb:128}});this.workers.set(key,worker);worker.unref();}
   catch(error){const directory=this.directories.get(key);this.directories.delete(key);if(directory)rmSync(directory,{recursive:true,force:true});throw error;}
  }
  const target=worker;
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{target.unref();clearTimeout(timer);target.off('message',reply);target.off('error',failed);target.off('exit',exited);signal?.removeEventListener('abort',abort);};
   const failed=(error:Error)=>{cleanup();void this.close(key);reject(error);};
   const exited=(code:number)=>failed(new Error('SQL worker exited: '+code));
   const abort=()=>failed(new Error('SQL operation aborted'));
   const reply=(msg:{result:SqlResult;error?:string})=>{cleanup();if(msg.error)reject(new Error(msg.error));else resolve(msg.result);};
   const timer=setTimeout(()=>failed(new Error('SQL operation exceeded 5 seconds')),5000);
   target.once('message',reply);target.once('error',failed);target.once('exit',exited);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   target.ref();target.postMessage(message);
  });
 }
 async close(run:string){
  const key=run.startsWith('check:')?run:'draft';
  const worker=this.workers.get(key),directory=this.directories.get(key);
  this.workers.delete(key);this.directories.delete(key);
  if(key==='draft')clearTimeout(this.idleTimer);
  try{if(worker)await worker.terminate();}
  finally{if(directory)rmSync(directory,{recursive:true,force:true});}
 }
}
