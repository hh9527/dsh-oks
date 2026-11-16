import {DatabaseSync} from 'node:sqlite';
import {registerCalendarFunctions} from '@hh9527/dari-core';
import type {ModelCheckPort,ModelExecutionPort,Type} from '@hh9527/dari-core';
import {openModel} from './telora-model.ts';
import {dariHost} from './dari-host.ts';
import {infoContracts} from './dari-info-contract.ts';
/** Trusted integration loaded by the independent DARI service/LSP, never by draft source. */
export async function createIntegration(options:{model?:string;database?:string}){
 if(!options.model)throw Error('DARI ontology integration requires model');
 const bridge=await openModel(options.model);
 const checker:ModelCheckPort=bridge.model;
 let db:DatabaseSync|undefined;
 const executor:ModelExecutionPort={contractId:checker.contractId,implementationId:checker.implementationId,execute(plan,parameters){
  if(!options.database)throw Error('Remote IC execution requires a database path');
  if(!db){db=new DatabaseSync(options.database,{readOnly:true});registerCalendarFunctions({registerFunction:(name,options,fn)=>db!.function(name,options,fn)});}
  const query=bridge.bind(plan,parameters);
  return {rows:db.prepare(query.sql).all(...query.bindings),columns:query.columns,max_rows:query.max_rows};
 }};
 const scalar=(name:string):Type=>({kind:'scalar',name});
 return {checker,executor,options:{host:dariHost,contextContractId:'dari-context/v2',contextType:{kind:'schema',fields:{now:scalar('DateTimeUtc'),epochMillis:scalar('EpochMillis'),timeZone:{kind:'option',inner:scalar('String')}}}},inspect:(points:unknown)=>{
  if(!Array.isArray(points))throw Error('inspect expects a list of knowledge points');return infoContracts(bridge.model,points);
 },close:async()=>{db?.close();await bridge.close();}};
}
