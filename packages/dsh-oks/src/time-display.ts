import type {Type} from './display-values.ts';
/** Presentation only: never changes a field's value, type, or ordering. */
export type TimeFormat={time_zone?:string;date_style?:'Date'|'DateTime'|'Time'};
export const timeSemantic=(type:Type|undefined):string|undefined=>type?.semantic??(type?.inner?timeSemantic(type.inner):type?.name==='Rfc3339'?'DateTimeUtc':type?.name);
export const temporal=(type:Type|undefined)=>['EpochMillis','DateTimeUtc','DateTimeTz','LocalDate'].includes(timeSemantic(type)??'');
const zones=new Set<string>();
export function validateTimeFormat(type:Type|undefined,format:TimeFormat):void {
 if(!temporal(type))throw Error('Time format requires EpochMillis, DateTimeUtc, DateTimeTz or LocalDate');
 if(!format||typeof format!=='object'||Array.isArray(format)||Object.keys(format).some(k=>!['time_zone','date_style'].includes(k)))throw Error('Time format accepts only time_zone and date_style');
 if(format.date_style!==undefined&&!['Date','DateTime','Time'].includes(format.date_style))throw Error('date_style requires DateStyle::Date, DateStyle::DateTime or DateStyle::Time');
 if(timeSemantic(type)==='LocalDate'){
  if(format.time_zone!==undefined||format.date_style!==undefined&&format.date_style!=='Date')throw Error('LocalDate has no instant or time zone; use DateStyle::Date without time_zone');
 }else if(format.time_zone!==undefined){
  if(typeof format.time_zone!=='string'||!format.time_zone||/^[+-]/.test(format.time_zone))throw Error('time_zone requires an IANA TimeZone');
  if(!zones.has(format.time_zone)){new Intl.DateTimeFormat('en',{timeZone:format.time_zone});if(zones.size>=64)zones.delete(zones.values().next().value!);zones.add(format.time_zone);}
 }
}
export function embeddedTimeZone(value:unknown):string|undefined {return typeof value==='string'?/\[([^\]]+)\]$/.exec(value)?.[1]:undefined;}
const cache=new Map<string,Intl.DateTimeFormat>();
export function formatTime(type:Type|undefined,value:unknown,format:TimeFormat={}):unknown {
 validateTimeFormat(type,format);
 if(value===null||value===undefined)return value;
 const role=timeSemantic(type);
 if(role==='LocalDate')return value;
 const zone=format.time_zone??(role==='DateTimeTz'?embeddedTimeZone(value):undefined)??'UTC';
 const style=format.date_style??'DateTime';
 let formatter=cache.get(zone);
 if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,calendar:'iso8601',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(zone,formatter);}
 const ms=typeof value==='number'?value:Date.parse(String(value).replace(/\[[^\]]+\]$/,''));
 if(!Number.isFinite(ms))throw Error('Invalid time value for presentation');
 const f=Object.fromEntries(formatter.formatToParts(ms).map(p=>[p.type,p.value]));
 const date=f.year.padStart(4,'0')+'-'+f.month+'-'+f.day,time=f.hour+':'+f.minute+':'+f.second;
 return style==='Date'?date:style==='Time'?time:date+' '+time+' '+(f.timeZoneName==='GMT'?'+00:00':f.timeZoneName.replace(/^GMT/,''))+' ['+zone+']';
}
