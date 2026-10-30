import {DraftSyntaxError} from './pipeline.ts';
import type {N} from './typed-syntax.ts';
import {typeOf,common,scalar,record,optional,present,known,unbox,show,rowType,type Ty} from './typed-types.ts';
import type {SqlColumn} from './sql.ts';
import {isRecord} from '../host.ts';
export type V={type:Ty;known:boolean;value?:any;sql?:string;fields?:Record<string,V>;items?:V[];column?:boolean;rows?:boolean;presence?:string};
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const nullable=(t:Ty)=>t.kind==='null'||'nullable' in t&&t.nullable;
const scalarType=(t:Ty):t is Extract<Ty,{kind:'scalar'}>=>t.kind==='scalar';
const numeric=(t:Ty)=>scalarType(t)&&['Int','Float'].includes(t.name);
export function fail(n:N,m:string):never{throw new DraftSyntaxError(m,n.s);}
export class TypedCompiler{
 readonly bindings:unknown[]=[];
 readonly captures:Record<string,unknown>;readonly hints:Record<string,Ty>;readonly checking:boolean;
 constructor(captures:Record<string,unknown>,hints:Record<string,Ty>={},checking=false){this.captures=captures;this.hints=hints;this.checking=checking;}
 param(v:unknown):string{this.bindings.push(v);return '?'+this.bindings.length;}
 bind(type:Ty,value:unknown):V{
  const k=value!==undefined&&known(value),raw=k?unbox(value):undefined;
  if(type.kind==='record'){const fields:Record<string,V>={};for(const [key,t]of Object.entries(type.fields))fields[key]=this.bind(t,k&&raw!==null?raw[key]:undefined);return {type,known:k,value:raw,fields};}
  if(type.kind==='array'){return {type,known:k,value:raw,...(k?{items:raw.map((x:unknown)=>this.bind(type.element,x))}:{})};}
  return {type,known:k,value:raw};
 }
 sql(v:V,n:N):string{if(v.sql!==undefined)return v.sql;if(!v.known&&this.checking&&v.type.kind==='scalar')return this.param(null);if(!v.known)fail(n,'Value is runtime-only without a SQL binding');if(v.type.kind!=='scalar'&&v.type.kind!=='null')fail(n,'Expected scalar, got '+show(v.type));return this.param(v.value);}
 env():Record<string,V>{return Object.fromEntries(Object.entries(this.captures).map(([k,v])=>[k,this.bind(typeOf(v,this.hints[k]),v)]));}
 compile(n:N,env=this.env()):V{
  try{return this.expr(n,env);}catch(e){if(e instanceof DraftSyntaxError)throw e;return fail(n,e instanceof Error?e.message:String(e));}
 }
 expr(n:N,env:Record<string,V>):V{
  if(n.k==='lit'){const type=typeOf(n.v);this.validNumber(n.v,type,n);return {type,known:true,value:n.v};}
  if(n.k==='ref'){if(!Object.hasOwn(env,n.name!))fail(n,'Unknown binding '+n.name);return env[n.name!];}
  if(n.k==='object'){const fields=Object.fromEntries(n.entries!.map(e=>[e.key,this.compile(e.value,env)]));const k=Object.values(fields).every(v=>v.known);return {type:record(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.type]))),known:k,fields,...(k?{value:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]))}:{})};}
  if(n.k==='array'){const items=n.a!.map(x=>this.compile(x,env));const element:Ty=items.length?items.slice(1).reduce((t,v)=>common(t,v.type),items[0].type):{kind:'never'};const k=items.every(v=>v.known);return {type:{kind:'array',element,length:items.length,nullable:false},known:k,items,...(k?{value:items.map(v=>v.value)}:{})};}
  if(n.k==='get'){
   const input=this.compile(n.input!,env),t=input.type;
   if(t.kind==='table')fail(n,'A Table has columns, not object fields; use a select row parameter');
   if(t.kind==='array'){if(typeof n.key!=='number')fail(n,'Array projection requires a numeric index');if(t.length!==undefined&&n.key>=t.length)fail(n,'Array index out of bounds');if(!input.items)fail(n,'Use a statically known array');return input.items[n.key];}
   if(t.kind!=='record')fail(n,'Cannot project '+String(n.key)+' from '+show(t));
   if(t.nullable&&!n.optional)fail(n,'Use ?. to project from '+show(t));
   if(!Object.hasOwn(t.fields,n.key!))fail(n,'Unknown field '+String(n.key)+'; available fields: '+Object.keys(t.fields).join(', '));
   let v=input.fields?.[n.key!]??this.bind(t.fields[n.key!],input.known&&input.value!==null?input.value[n.key!]:undefined);
   if(n.optional&&t.nullable)v={...v,type:optional(v.type),known:input.known?true:v.known,...(input.known&&input.value===null?{value:null}:{})};
   return v;
  }
  if(n.k==='unary'){const a=this.compile(n.input!,env);if(n.op==='!'){if(!scalarType(a.type)||a.type.name!=='Bool'||a.type.nullable)fail(n,'! requires Bool');return {type:scalar('Bool'),known:a.known,...(a.known?{value:!a.value}:{sql:'(NOT '+this.sql(a,n)+')'}),column:a.column};}if(!numeric(a.type))fail(n,'Unary - requires a number');return {...a,...(a.known?{value:a.value===null?null:-a.value}:{sql:'(-'+this.sql(a,n)+')'})};}
  if(n.k==='binary'){
   const a=this.compile(n.left!,env),b=this.compile(n.right!,env),op=n.op!,k=a.known&&b.known,column=a.column||b.column;
   if(op==='??'){if(!nullable(a.type))fail(n,'?? requires an optional value');const type=common(present(a.type),b.type);return {type,known:k,column,...(k?{value:a.value??b.value}:{sql:'COALESCE('+this.sql(a,n)+','+this.sql(b,n)+')'})};}
   if(['&&','||'].includes(op)){for(const x of [a,b])if(!scalarType(x.type)||x.type.name!=='Bool'||x.type.nullable)fail(n,'Boolean operators require Bool, handle Option(Bool) explicitly');return {type:scalar('Bool'),known:k,column,...(k?{value:op==='&&'?a.value&&b.value:a.value||b.value}:{sql:'('+this.sql(a,n)+(op==='&&'?' AND ':' OR ')+this.sql(b,n)+')'})};}
   if(['+','-','*','/','%'].includes(op)){
    if(!numeric(a.type)||!numeric(b.type))fail(n,'Arithmetic requires numbers, got '+show(a.type)+' and '+show(b.type));
    if(op==='%'&&([a.type,b.type]as any[]).some(t=>t.name!=='Int'))fail(n,'% requires Int');
    const name=op==='/'?'Float':(a.type as any).name==='Float'||(b.type as any).name==='Float'?'Float':'Int';const type=scalar(name,nullable(a.type)||nullable(b.type)||op==='/'||op==='%');
    if(k){let value;if(a.value===null||b.value===null||['/','%'].includes(op)&&b.value===0)value=null;else value=op==='+'?a.value+b.value:op==='-'?a.value-b.value:op==='*'?a.value*b.value:op==='/'?a.value/b.value:a.value%b.value;this.validNumber(value,type,n);return {type,known:true,value,column};}
    return {type,known:false,column,sql:op==='/'?'(1.0*'+this.sql(a,n)+'/NULLIF('+this.sql(b,n)+',0))':'('+this.sql(a,n)+op+this.sql(b,n)+')'};
   }
   if(['==','!=','<','>','<=','>='].includes(op)){
    if(a.type.kind==='null'||b.type.kind==='null'){if(!['==','!='].includes(op))fail(n,'Use == null or != null');const v=a.type.kind==='null'?b:a;return {type:scalar('Bool'),known:k,column,...(k?{value:op==='=='?v.value===null:v.value!==null}:{sql:'('+this.sql(v,n)+(op==='=='?' IS NULL)':' IS NOT NULL)')})};}
    common(a.type,b.type);if(!scalarType(a.type)||!scalarType(b.type))fail(n,'Comparison requires scalar operands');const type=scalar('Bool',a.type.nullable||b.type.nullable);
    const value=k?(a.value===null||b.value===null?null:op==='=='?a.value===b.value:op==='!='?a.value!==b.value:op==='<'?a.value<b.value:op==='>'?a.value>b.value:op==='<='?a.value<=b.value:a.value>=b.value):undefined;
    return {type,known:k,column,...(k?{value}:{sql:'('+this.sql(a,n)+(op==='=='?'=':op==='!='?'<>':op)+this.sql(b,n)+')'})};
   }
   fail(n,'Unsupported operator '+op);
  }
  if(n.k==='call'){
   const name=n.name!,args=n.a!;
   if(name==='map_opt'){
    if(args.length!==2||args[1].k!=='lambda'||args[1].params?.length!==1)fail(n,'map_opt requires (optional, (value) => expression)');
    const a=this.compile(args[0],env);if(!nullable(a.type))fail(n,'map_opt requires Option');
    const value:V={...a,type:present(a.type),known:a.known&&a.value!==null};const out=this.compile(args[1].body!,{...env,[args[1].params![0]]:value});
    if(out.type.kind==='record')return {type:optional(out.type),known:a.known&&(a.value===null||out.known),...(a.known?{value:a.value===null?null:out.value}:{})};
    return {type:optional(out.type),known:a.known&&(a.value===null||out.known),...(a.known&&a.value===null?{value:null}:a.known&&out.known?{value:out.value}:{sql:'(CASE WHEN '+this.presence(a,n)+' IS NULL THEN NULL ELSE '+this.sql(out,n)+' END)'})};
   }
   const a=args.map(x=>this.compile(x,env));const arity=(lo:number,hi=lo)=>{if(a.length<lo||a.length>hi)fail(n,'Invalid argument count for '+name);};
   if(['count','sum','avg','min','max'].includes(name)){
    arity(1);const x=a[0];if(!x.column&&!x.rows)fail(n,name+' requires a grouped Column or rows');if(x.rows&&name!=='count')fail(n,name+' requires a Column');
    if(['sum','avg'].includes(name)&&!numeric(x.type))fail(n,name+' requires a numeric Column');
    const type=name==='count'?scalar('Int'):name==='avg'?scalar('Float',true):optional(x.type);
    return {type,known:false,sql:name.toUpperCase()+'('+(x.rows?'*':this.sql(x,n))+')'};
   }
   if(name==='is_some'||name==='is_none'){arity(1);const x=a[0];if(!nullable(x.type))fail(n,name+' requires Option');return {type:scalar('Bool'),known:x.known,...(x.known?{value:name==='is_some'?x.value!==null:x.value===null}:{sql:'('+this.presence(x,n)+(name==='is_some'?' IS NOT NULL)':' IS NULL)')}),column:x.column};}
   if(name==='round'){arity(2);if(!numeric(a[0].type)||!a[1].known||!Number.isInteger(a[1].value)||a[1].value<0||a[1].value>15)fail(n,'round requires a numeric value and known precision 0..15');const k=a.every(x=>x.known);return {type:a[0].type,known:k,column:a[0].column,...(k?{value:a[0].value===null?null:Math.sign(a[0].value)*Math.round(Math.abs(a[0].value)*10**a[1].value)/10**a[1].value}:{sql:'DARI_ROUND('+this.sql(a[0],n)+','+this.sql(a[1],n)+')'})};}
   if(name==='case_when'){arity(3);if(a[0].type.kind!=='scalar'||a[0].type.name!=='Bool'||a[0].type.nullable)fail(n,'case_when requires Bool');const type=common(a[1].type,a[2].type),k=a.every(x=>x.known);return {type,known:k,...(k?{value:a[0].value?a[1].value:a[2].value}:{sql:'(CASE WHEN '+this.sql(a[0],n)+' THEN '+this.sql(a[1],n)+' ELSE '+this.sql(a[2],n)+' END)'})};}
   if(name==='concat'){arity(1,64);for(const x of a)if(!scalarType(x.type)||x.type.name!=='String')fail(n,'concat requires String');const k=a.every(x=>x.known);return {type:scalar('String',a.some(x=>nullable(x.type))),known:k,...(k?{value:a.some(x=>x.value===null)?null:a.map(x=>x.value).join('')}:{sql:'('+a.map(x=>this.sql(x,n)).join('||')+')'})};}
   fail(n,'Function is not available in this expression: '+name);
  }
  return fail(n,'Invalid typed expression '+n.k);
 }
 validNumber(value:any,type:Ty,n:N){if(value!==null&&typeof value==='number'&&(!Number.isFinite(value)||type.kind==='scalar'&&type.name==='Int'&&!Number.isSafeInteger(value)))fail(n,'Numeric result is outside the supported range');}
 relational(n:N){
  const spec=n.a![0];if(spec.k!=='object')fail(n,'Expected select specification');const entries=Object.fromEntries(spec.entries!.map(e=>[e.key,e.value]));for(const key of Object.keys(entries))if(!['from','joins','where','fields','group_by','having','order_by','limit'].includes(key))fail(entries[key],'Unknown select option '+key);
  const captures=this.env(),tables:Record<string,unknown>={},scope:Record<string,V>=Object.create(null),joins:string[]=[];let sourceCount=0;let baseBounds:{minRows?:number;maxRows?:number}={};
  const source=(s:N,left=false):string=>{
   if(s.k!=='object'||s.entries!.length!==1)fail(s,'Expected one source alias');const {key:alias,value:ref}=s.entries![0];if(Object.hasOwn(scope,alias))fail(s,'Duplicate table alias '+alias);const v=this.compile(ref,captures);if(v.type.kind!=='table')fail(ref,'Expected Table, got '+show(v.type));
   const inputKey='source'+sourceCount,sqlAlias='a'+sourceCount++;tables[inputKey]=this.captures[ref.name!];const columns=v.type.columns;if(sourceCount===1)baseBounds=v.type;let presence='__dari_present';while(columns.some(c=>c.name===presence))presence+='_';
   scope[alias]={type:rowType(columns),known:false,presence:sqlAlias+'.'+q(presence),fields:Object.fromEntries(columns.map(c=>[c.name,{type:scalar(c.type,c.nullable),known:false,sql:sqlAlias+'.'+q(c.name)}]))};
   return '(SELECT *,1 AS '+q(presence)+' FROM '+q('t_'+inputKey)+') '+sqlAlias;
  };
  if(!entries.from)fail(n,'select requires from');const from=source(entries.from);
  if(entries.joins){if(entries.joins.k!=='array')fail(entries.joins,'joins must be an array');for(const j of entries.joins.a!){if(j.k!=='object')fail(j,'Expected join object');const p=Object.fromEntries(j.entries!.map(e=>[e.key,e.value]));for(const key of Object.keys(p))if(!['kind','source','on'].includes(key))fail(p[key],'Unknown join option '+key);if(!p.kind||p.kind.k!=='lit'||!['inner','left'].includes(p.kind.v)||!p.source||!p.on)fail(j,'join requires kind,source,on');const sql=source(p.source);const predicate=this.callback(p.on,[{type:record(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,v.type]))),known:false,fields:{...scope}}],captures);this.bool(predicate,p.on);joins.push((p.kind.v==='left'?' LEFT':' INNER')+' JOIN '+sql+' ON '+this.sql(predicate,p.on));if(p.kind.v==='left'){const alias=p.source.entries![0].key;scope[alias]={...scope[alias],type:optional(scope[alias].type)};}}}
  const row:V={type:record(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,v.type]))),known:false,fields:scope};
  const where=entries.where?this.callback(entries.where,[row],captures):undefined;if(where)this.bool(where,entries.where);
  let groups:V|undefined;if(entries.group_by){groups=this.callback(entries.group_by,[row],captures);if(groups.type.kind!=='record')fail(entries.group_by,'group_by requires a key record');for(const v of Object.values(groups.fields!))if(v.type.kind!=='scalar'&&v.type.kind!=='null')fail(entries.group_by,'Group keys must be scalar');}
  const asColumns=(v:V):V=>({...v,column:v.type.kind==='scalar'?true:v.column,...(v.fields?{fields:Object.fromEntries(Object.entries(v.fields).map(([k,v])=>[k,asColumns(v)]))}:{})});
  if(!entries.fields)fail(n,'select requires fields');
  const values=this.callback(entries.fields,groups?[groups,{...asColumns(row),rows:true}]:[row],captures);
  if(values.type.kind!=='record'||!values.fields||!Object.keys(values.fields).length)fail(entries.fields,'fields requires a nonempty record');
  const columns:SqlColumn[]=Object.entries(values.fields).map(([name,v])=>{if(v.type.kind!=='scalar')fail(entries.fields,'Table field '+name+' must have an inferred scalar type, got '+show(v.type));if(v.column)fail(entries.fields,'Column must be aggregated');return {name,type:(v.type as any).name,nullable:(v.type as any).nullable};});
  let projection=Object.entries(values.fields).map(([name,v])=>this.sql(v,entries.fields)+' AS '+q(name)).join(',');
  if(new Set(columns.map(c=>c.name.toLowerCase())).size!==columns.length)fail(entries.fields,'Output column names must be distinct ignoring case for SQLite lowering');
  if(groups&&Object.keys(groups.fields!).length===0&&!/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/.test(projection))projection+=',COUNT(*) AS "__dari_global_anchor"';
  let inner='SELECT '+projection+' FROM '+from+joins.join('')+(where?' WHERE '+this.sql(where,entries.where):'');
  if(groups){const keys=Object.values(groups.fields!);if(keys.length)inner+=' GROUP BY '+keys.map(v=>this.sql(v,entries.group_by)).join(',');}
  const output:V={type:rowType(columns),known:false,fields:Object.fromEntries(columns.map(c=>[c.name,{type:scalar(c.type,c.nullable),known:false,sql:q(c.name)}]))};
  if(entries.having&&!groups)fail(entries.having,'having requires group_by');
  let sql='SELECT '+columns.map(c=>q(c.name)).join(',')+' FROM ('+inner+')';if(entries.having){const p=this.callback(entries.having,[output],captures);this.bool(p,entries.having);sql+=' WHERE '+this.sql(p,entries.having);}
  if(entries.order_by){const f=entries.order_by;if(f.k!=='lambda'||f.params?.length!==1||f.body?.k!=='array')fail(f,'order_by requires (out) => [asc/desc(...)]');const env={...captures,[f.params![0]]:output};const order=f.body.a!.map(item=>{if(item.k!=='call'||!['asc','desc'].includes(item.name!)||![1,2].includes(item.a!.length))fail(item,'Expected asc or desc');const value=this.compile(item.a![0],env);if(value.type.kind!=='scalar')fail(item,'Ordering requires a scalar');let nulls='last';if(item.a![1]){const option=this.compile(item.a![1],env);if(!option.known||!isRecord(option.value)||Object.keys(option.value).some(k=>k!=='nulls')||!['first','last'].includes(String(option.value.nulls)))fail(item,'Ordering options must be {nulls:"first"|"last"}');nulls=String(option.value.nulls);}return this.sql(value,item)+' '+item.name!.toUpperCase()+' NULLS '+nulls.toUpperCase();});if(!order.length)fail(f,'order_by must not be empty');sql+=' ORDER BY '+order.join(',');}
  let minRows=groups&&Object.keys(groups.fields!).length===0&&!entries.having?1:!groups&&!entries.where&&!joins.length?(baseBounds.minRows??0):0,maxRows:number|undefined=groups&&Object.keys(groups.fields!).length===0?1:!joins.length?baseBounds.maxRows:undefined;
  if(entries.limit){const v=this.compile(entries.limit,captures);if(!v.known||!Number.isSafeInteger(v.value)||v.value<0)fail(entries.limit,'limit requires a known nonnegative Int');if(v.value>0&&!entries.order_by&&maxRows!==1)fail(entries.limit,'limit requires order_by');maxRows=Math.min(maxRows??Infinity,v.value);minRows=Math.min(minRows,v.value);sql+=' LIMIT '+v.value;}
  if(n.name==='select_one')sql='SELECT * FROM ('+sql+') LIMIT 2';
  return {sql,tables,columns,type:n.name==='select_one'?optional(rowType(columns)):{kind:'table',columns,minRows,...(maxRows===undefined?{}:{maxRows})} as Ty,minRows,maxRows,guard:n.name==='select_one'&&(maxRows===undefined||maxRows>1)};
 }
 presence(v:V,n:N):string{if(v.presence)return v.presence;if(v.type.kind==='record')return this.param(v.known?(v.value===null?null:1):null);return this.sql(v,n);}
 callback(n:N,args:V[],env:Record<string,V>):V{if(n.k!=='lambda'||n.params?.length!==args.length)fail(n,'Expected a row function with '+args.length+' parameter(s)');return this.compile(n.body!,{...env,...Object.fromEntries(n.params!.map((p,i)=>[p,args[i]]))});}
 bool(v:V,n:N){if(v.type.kind!=='scalar'||v.type.name!=='Bool'||v.type.nullable||v.column)fail(n,'Predicate must return Bool; use ?? false for Option(Bool)');}
}
