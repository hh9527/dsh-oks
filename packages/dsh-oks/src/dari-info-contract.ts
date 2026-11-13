import {show,type Type} from '@hh9527/dari-core';
import type {ModelPort} from '@hh9527/dari-core';

export type InfoPoint={id:string;kind:string;dataset?:string;dimension?:string;measure?:string;relation?:string;type?:string;variant?:string;datasets?:string[];members?:{id:string;kind:string}[]};
/** Resolve exact knowledge identities against published contracts, never derive symbols from IDs. */
export function infoContracts(model:ModelPort,points:InfoPoint[]){
 const datasets=Object.values(model.datasets),relations=Object.values(model.relations??{});
 const typeContract=(type:Type):any=>{
  const nullable=type.kind==='option',base=nullable?type.inner!:type;
  const names=Object.entries(model.types??{}).filter(([,t])=>t===base).map(([name])=>name).sort((a,b)=>a.length-b.length||a.localeCompare(b));
  const symbol=names[0];
  return {type:nullable?'Option('+(symbol??show(base))+')':symbol??show(base),...(symbol?{typeSymbol:symbol}:{}),...(base.semantic?{semantic:base.semantic}:{}),...(base.presentation?{presentation:base.presentation}:{}),...(base.codec?.operations?{calculations:base.codec.operations}:{}),...(symbol&&base.codec?.variants?{variants:base.codec.variants.map(name=>symbol+'::'+name)}:{})};
 };
 const memberContract=(m:any)=>({symbol:m.symbol,kind:m.kind,...typeContract(m.type)});
 return Object.fromEntries(points.map(point=>{
  const dataset=datasets.find(d=>d.id===point.dataset);
  let value:unknown;
  if(point.relation)value=relations.find(r=>r.id===point.relation);
  else if(dataset){
   const id=point.dimension??point.measure;
   if(id!==undefined){const member=Object.values(dataset.members).find(m=>m.id===id&&m.kind===(point.dimension?'dimension':'measure'));if(member)value={dataset:dataset.symbol,...memberContract(member)};}
   else if(point.kind==='Field'&&point.members)value={dataset:dataset.symbol,members:Object.values(dataset.members).filter(m=>point.members!.some(p=>p.kind===m.kind&&p.id===m.id)).map(memberContract)};
   else if(point.kind==='Dataset')value={dataset:dataset.symbol,members:Object.values(dataset.members).map(memberContract),relations:relations.filter(r=>r.from===dataset.id||r.to===dataset.id)};
  }else if(point.datasets)value={datasets:point.datasets.flatMap(id=>datasets.filter(d=>d.id===id).map(d=>({id:d.id,symbol:d.symbol})))};
  else if(point.type){const type=Object.values(model.types??{}).find(t=>t.name===point.type);if(type){const c=typeContract(type);if(point.variant){if(type.codec?.variants?.includes(point.variant)&&c.typeSymbol)value={symbol:c.typeSymbol+'::'+point.variant,type:c.type};}else value=c;}}
  return [point.id,value??{available:false}];
 }));
}
