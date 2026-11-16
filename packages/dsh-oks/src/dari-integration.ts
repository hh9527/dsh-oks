import type {ModelCheckPort,Type} from '@hh9527/dari-core';
import {openModel} from './telora-model.ts';
import {dariHost} from './dari-host.ts';
import {infoContracts} from './dari-info-contract.ts';
/** Trusted integration loaded by the independent DARI service/LSP, never by draft source. */
export async function createIntegration(options:{model?:string}){
 if(!options.model)throw Error('DARI ontology integration requires model');
 const bridge=await openModel(options.model);
 const checker:ModelCheckPort=bridge.model;
 const scalar=(name:string):Type=>({kind:'scalar',name});
 return {checker,executor:bridge.model,options:{host:dariHost,contextContractId:'dari-context/v2',contextType:{kind:'schema',fields:{now:scalar('DateTimeUtc'),epochMillis:scalar('EpochMillis'),timeZone:{kind:'option',inner:scalar('String')}}}},inspect:(points:unknown)=>{
  if(!Array.isArray(points))throw Error('inspect expects a list of knowledge points');return infoContracts(bridge.model,points);
 },close:()=>bridge.close()};
}
