import {formatTime,temporal,type TimeFormat} from './time-display.ts';
export type Type={kind:string;name?:string;semantic?:string;inner?:Type;fields?:Record<string,Type>;presentation?:{multiplier:number;suffix:string;precision?:number}};
export function precision(value:unknown):number|undefined {
 if(value===undefined)return;
 if(!Number.isInteger(value)||Number(value)<0||Number(value)>12)throw Error('precision requires an integer 0..12');
 return Number(value);
}
export function formatValue(type:Type|undefined,value:unknown,override?:number,timeFormat?:TimeFormat):unknown {
 if(value===null||value===undefined)return value;
 if(type?.kind==='option')return formatValue(type.inner,value,override,timeFormat);
 if(temporal(type))return formatTime(type,value,timeFormat);
 if(typeof value!=='number')return value;
 let base=type,policy=type?.presentation;
 while(base?.inner){base=base.inner;policy??=base.presentation;}
 if(!policy&&base?.name==='Int')return String(value);
 const digits=precision(override??policy?.precision)??2;
 const text=new Intl.NumberFormat('en-US',{useGrouping:false,maximumFractionDigits:digits}).format(value*(policy?.multiplier??1));
 return (text==='-0'?'0':text)+(policy?.suffix??'');
}
