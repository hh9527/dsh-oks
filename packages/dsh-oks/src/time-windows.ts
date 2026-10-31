import {Temporal} from '@js-temporal/polyfill';
import {isRecord} from './host.ts';
export const TIME_WINDOWS_VERSION=2;
type Unit='year'|'quarter'|'month'|'week'|'day';
export type TimeWindowOptions={unit:Unit;count:number;mode:'complete'|'current'|'rolling'};
export function timeWindowOptions(raw:unknown):TimeWindowOptions {
 if(!isRecord(raw)||Object.keys(raw).some(k=>!['unit','count','mode'].includes(k)))throw new Error('time_windows options are {unit,count,mode}');
 if(typeof raw.unit!=='string'||!['year','quarter','month','week','day'].includes(String(raw.unit)))throw new Error('time windows unit must be year/quarter/month/week/day');
 if(!Number.isSafeInteger(raw.count)||Number(raw.count)<1||Number(raw.count)>50)throw new Error('time windows count must be 1..50');
 if(typeof raw.mode!=='string'||!['complete','current','rolling'].includes(String(raw.mode)))throw new Error('time windows mode must be complete/current/rolling');
 return raw as TimeWindowOptions;
}
/** Calendar arithmetic is host JS. The captured clock and explicit IANA zone are the only inputs. */
export function timeWindows(context:unknown,raw:unknown){
 const a=timeWindowOptions(raw);
 if(!isRecord(context)||!isRecord(context.utc)||!Number.isSafeInteger(context.utc.epochMillis))throw new Error('time windows requires safe integer context utc.epochMillis');
 const zone=(context as any).tz?.client?.id;
 if(typeof zone!=='string'||!zone||/^[+-]/.test(zone))throw new Error('time windows requires context tz.client.id (IANA timezone)');
 const now=Temporal.Instant.fromEpochMilliseconds(context.utc.epochMillis as number).toZonedDateTimeISO(zone);
 let date=now.toPlainDate();
 if(a.unit==='year')date=date.with({month:1,day:1});
 if(a.unit==='quarter')date=date.with({month:Math.floor((date.month-1)/3)*3+1,day:1});
 if(a.unit==='month')date=date.with({day:1});
 if(a.unit==='week')date=date.subtract({days:date.dayOfWeek-1});
 const duration=(n:number)=>a.unit==='year'?{years:n}:a.unit==='quarter'?{months:n*3}:a.unit==='month'?{months:n}:a.unit==='week'?{weeks:n}:{days:n};
 const shifted=(n:number)=>a.mode==='rolling'?now.add(duration(n),{overflow:'constrain'}):date.add(duration(n),{overflow:'constrain'}).toZonedDateTime(zone);
 const local=(z:Temporal.ZonedDateTime)=>z.toPlainDateTime().toString({fractionalSecondDigits:z.millisecond?3:0})+z.offset;
 const boundary=(z:Temporal.ZonedDateTime)=>({epochMillis:z.epochMilliseconds,dateTimeUtc:z.toInstant().toString({fractionalSecondDigits:3}),rfc3339:local(z)});
 return Array.from({length:a.count},(_,i)=>{
  const n=i-a.count+(a.mode==='current'?1:0),start=shifted(n),end=shifted(n+1);
  if(start.epochMilliseconds>=end.epochMilliseconds)throw new Error('time_windows interval has no elapsed time in timezone '+zone+'; choose another calendar range');
  const label=a.mode==='rolling'?local(start):a.unit==='year'?String(start.year).padStart(4,'0'):a.unit==='quarter'?`${start.year}-Q${Math.floor((start.month-1)/3)+1}`:a.unit==='month'?start.toPlainDate().toString().slice(0,7):start.toPlainDate().toString();
  return {label,zone,start:boundary(start),end:boundary(end)};
 });
}
