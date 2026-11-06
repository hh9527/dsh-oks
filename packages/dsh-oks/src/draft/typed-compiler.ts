import {DraftSyntaxError} from './pipeline.ts';
import type {N} from './typed-syntax.ts';
import {typeOf,common,scalar,record,optional,present,known,unbox,show,rowType,TypeRuleError,UpstreamTypeUnavailable,type Ty} from './typed-types.ts';
import type {SqlColumn} from './sql.ts';
import {isRecord} from '../host.ts';
import {DiagnosticCollector} from './diagnostics.ts';
export type V={type:Ty;known:boolean;value?:any;sql?:string;fields?:Record<string,V>;items?:V[];column?:boolean;rows?:boolean;presence?:string;open?:boolean};
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const accessPath=(n:N):string|undefined=>{if(n.k==='ref')return n.name;if(n.k!=='get'||!n.input)return undefined;const base=accessPath(n.input);if(!base)return undefined;return base+(typeof n.key==='string'&&/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n.key)?(n.optional?'?.':'.')+n.key:'['+JSON.stringify(n.key)+']');};
const nullable=(t:Ty)=>t.kind==='null'||'nullable' in t&&t.nullable;
const scalarType=(t:Ty):t is Extract<Ty,{kind:'scalar'}>=>t.kind==='scalar';
const numeric=(t:Ty)=>scalarType(t)&&['Int','Float'].includes(t.name);
const argumentBounds:Record<string,[number,number]>={case_when:[3,3],round:[2,2],concat:[1,64],count:[1,1],sum:[1,1],avg:[1,1],min:[1,1],max:[1,1],is_some:[1,1],is_none:[1,1],lookup:[2,2]};
export function fail(n:N,m:string):never{throw new DraftSyntaxError(m,n.s);}
export class TypedCompiler{
 readonly bindings:unknown[]=[];
 readonly diagnostics:DiagnosticCollector;
 readonly captures:Record<string,unknown>;readonly hints:Record<string,Ty>;readonly checking:boolean;
 constructor(captures:Record<string,unknown>,hints:Record<string,Ty>={},checking=false,diagnostics=new DiagnosticCollector()){this.captures=captures;this.hints=hints;this.checking=checking;this.diagnostics=diagnostics;}
 param(v:unknown):string{this.bindings.push(v);return '?'+this.bindings.length;}
 bind(type:Ty,value:unknown):V{
  const k=value!==undefined&&known(value),raw=k?unbox(value):undefined;
  if(type.kind==='record'){const fields:Record<string,V>={};for(const [key,t]of Object.entries(type.fields))fields[key]=this.bind(t,k&&raw!==null?raw[key]:undefined);return {type,known:k,value:raw,fields};}
  if(type.kind==='array'){return {type,known:k,value:raw,...(k?{items:raw.map((x:unknown)=>this.bind(type.element,x))}:{})};}
  return {type,known:k,value:raw};
 }
 sql(v:V,n:N):string{if(v.type.kind==='error'&&this.checking)return 'NULL';if(v.sql!==undefined)return v.sql;if(!v.known&&this.checking&&v.type.kind==='scalar')return this.param(null);if(!v.known)fail(n,'Value is runtime-only without a SQL binding');if(v.type.kind!=='scalar'&&v.type.kind!=='null')fail(n,'Expected scalar, got '+show(v.type));return this.param(v.value);}
 env():Record<string,V>{return Object.fromEntries(Object.entries(this.captures).map(([k,v])=>[k,this.bind(typeOf(v,this.hints[k]),v)]));}
 compile(n:N,env=this.env()):V{
  try{return this.expr(n,env);}catch(e){
   if(!(e instanceof DraftSyntaxError)&&!(e instanceof TypeRuleError))throw e;
   const error=e instanceof DraftSyntaxError?e:new DraftSyntaxError(e.message,n.s);
   if(!this.checking)throw error;
   const entries=error.diagnostics.length?error.diagnostics:[{stage:'type',message:error.message,span:error.span}];
   for(const diagnostic of entries)this.diagnostics.report(diagnostic);
   return {type:{kind:'error'},known:false};
  }
 }
 throwIfErrors(){const findings=this.diagnostics.list(),errors=findings.filter(d=>d.severity!=='warning');if(errors.length)throw new DraftSyntaxError(errors[0].message,errors[0].span,findings);}
 rethrowWithDiagnostics(error:unknown):never{
  if(!this.checking||!(error instanceof DraftSyntaxError)||!this.diagnostics.hasErrors())throw error;
  const incoming=error.diagnostics.length?error.diagnostics:[{stage:'type',message:error.message,span:error.span}];
  this.diagnostics.reportAll(incoming);
  const combined=this.diagnostics.list(),first=combined.find(d=>d.severity!=='warning')!;throw new DraftSyntaxError(first.message,first.span,combined);
 }
 expr(n:N,env:Record<string,V>):V{
  if(n.k==='template_presence'){
   const input=this.compile(n.input!,env);
   if(input.type.kind==='error')return input;
   if(!nullable(input.type)||input.type.kind==='null')return this.errorValue(n,'if let Some requires Option with a known inner type');
   return {type:scalar('Bool'),known:input.known,...(input.known?{value:input.value!==null}:{})};
  }
  if(n.k==='template_scope'){
   const input=this.compile(n.a![0],env),f=n.a![1];
   if(input.type.kind==='error'){if(this.checking)this.compile(f.body!,{...env,[f.params![0]]:input});return input;}
   if(!nullable(input.type)||input.type.kind==='null'){const invalid=this.errorValue(n,'if let Some requires an Option with a known inner type');if(this.checking)this.compile(f.body!,{...env,[f.params![0]]:invalid});return invalid;}
   // Check the body with a present binding even when the runtime value is absent.
   const inner={...input,type:present(input.type),known:input.known&&input.value!==null};
   const checker=input.known&&input.value===null&&!this.checking?new TypedCompiler({}, {}, true):this;
   const out=checker.compile(f.body!,{...env,[f.params![0]]:inner});
   if(out.type.kind==='error')return out;
   if(n.op==='condition'){
    if(out.type.kind!=='scalar'||out.type.name!=='Bool'||out.type.nullable)return this.errorValue(f.body!,'if condition requires Bool, got '+show(out.type));
    return {type:scalar('Bool'),known:input.known&&(input.value===null||out.known),...(input.known?{value:input.value===null?false:out.value}:{})};
   }
   return {type:optional(out.type),known:input.known&&(input.value===null||out.known),...(input.known?{value:input.value===null?null:out.value}:{})};
  }
  if(n.k==='lit'){const type=typeOf(n.v);if(!this.validNumber(n.v,type,n))return {type:{kind:'error'},known:false};return {type,known:true,value:n.v};}
  if(n.k==='ref'){if(!Object.hasOwn(env,n.name!))return this.errorValue(n,'Unknown binding '+n.name);return env[n.name!];}
  if(n.k==='object'){const fields=Object.fromEntries(n.entries!.map(e=>[e.key,this.compile(e.value,env)]));const k=Object.values(fields).every(v=>v.known);return {type:record(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.type]))),known:k,fields,...(k?{value:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]))}:{})};}
  if(n.k==='array'){
   const items=n.a!.map(x=>this.compile(x,env));let element:Ty={kind:'never'},invalid=false,knownRecordFields:Record<string,Ty>|undefined;
   const mergeKnown=(left:Ty,right:Ty,node:N):Ty=>{
    if(left.kind==='error')return right;if(right.kind==='error')return left;
    if(left.kind==='record'&&right.kind==='record'&&Object.keys(left.fields).join('\0')===Object.keys(right.fields).join('\0'))return record(Object.fromEntries(Object.entries(right.fields).map(([name,type])=>[name,mergeKnown(left.fields[name],type,node.k==='object'?node.entries!.find(entry=>entry.key===name)?.value??node:node)])),left.nullable||right.nullable);
    try{return common(left,right);}catch(error){if(!(error instanceof TypeRuleError))throw error;this.reportFailure(node,error.message);return {kind:'error'};}
   };
   for(const [i,item] of items.entries()){
    if(item.type.kind==='error'){invalid=true;continue;}
    if(this.checking&&element.kind==='record'&&item.type.kind==='record'&&Object.keys(element.fields).join('\0')===Object.keys(item.type.fields).join('\0')){
     const fields:Record<string,Ty>={};
     for(const [name,current] of Object.entries(item.type.fields)){
      if(current.kind==='error'){fields[name]={kind:'error'};continue;}
      const node=n.a![i],field=node.k==='object'?node.entries!.find(entry=>entry.key===name)?.value??node:node;
      const known=knownRecordFields?.[name],merged=known?mergeKnown(known,current,field):current;if(knownRecordFields)knownRecordFields[name]=merged;fields[name]=element.fields[name].kind==='error'?{kind:'error'}:merged;
     }
     element=record(fields,element.nullable||item.type.nullable);continue;
    }
    try{element=common(element,item.type);if(this.checking&&element.kind==='record'&&!knownRecordFields)knownRecordFields=Object.fromEntries(Object.entries(element.fields).filter(([,type])=>type.kind!=='error'));}catch(error){
     if(!this.checking||!(error instanceof TypeRuleError))throw error;
     this.reportFailure(n.a![i],error.message);invalid=true;
    }
   }
   if(invalid)element={kind:'error'};
   const k=items.every(v=>v.known);return {type:{kind:'array',element,length:items.length,nullable:false},known:k,items,...(k?{value:items.map(v=>v.value)}:{})};
  }
  if(n.k==='get'){
   const input=this.compile(n.input!,env),t=input.type;
   if(t.kind==='error')return input;
   if(t.kind==='table')return this.errorValue(n,'A Table has columns, not object fields; use a select row parameter');
   if(t.kind==='array'){if(typeof n.key!=='number')return this.errorValue(n,'Array projection requires a numeric index');if(t.length!==undefined&&n.key>=t.length)return this.errorValue(n,'Array index out of bounds');if(!input.items){if(this.checking)return this.bind(t.element,undefined);return this.errorValue(n,'Use a statically known array');}return input.items[n.key];}
   if(t.kind!=='record')return this.errorValue(n,'Cannot project '+String(n.key)+' from '+show(t));
   if(t.nullable&&!n.optional)return this.errorValue(n,'Use ?. to project from '+show(t));
   if(!Object.hasOwn(t.fields,n.key!)){if(input.open&&this.checking)return {type:{kind:'error'},known:false};const keys=Object.keys(t.fields),path=accessPath(n.input!);return this.errorValue(n,'Unknown field '+String(n.key)+(path?' on '+path:'')+'; available fields (examples, up to 8 of '+keys.length+'): '+(keys.slice(0,8).map(k=>JSON.stringify(k)).join(', ')||'(none)'));}
   let v=input.fields?.[n.key!]??this.bind(t.fields[n.key!],input.known&&input.value!==null?input.value[n.key!]:undefined);
   if(n.optional&&t.nullable)v={...v,type:optional(v.type),known:input.known?true:v.known,...(input.known&&input.value===null?{value:null}:{})};
   return v;
  }
  if(n.k==='unary'){const a=this.compile(n.input!,env);if(a.type.kind==='error')return a;if(n.op==='!'){if(!scalarType(a.type)||a.type.name!=='Bool'||a.type.nullable)return this.errorValue(n,'! requires Bool');return {type:scalar('Bool'),known:a.known,...(a.known?{value:!a.value}:{sql:'(NOT '+this.sql(a,n)+')'}),column:a.column};}if(!numeric(a.type))return this.errorValue(n,'Unary - requires a number');return {...a,...(a.known?{value:a.value===null?null:-a.value}:{sql:'(-'+this.sql(a,n)+')'})};}
  if(n.k==='binary'){
   const a=this.compile(n.left!,env),b=this.compile(n.right!,env),op=n.op!,k=a.known&&b.known,column=a.column||b.column;
   if(a.type.kind==='error'||b.type.kind==='error')return {type:{kind:'error'},known:false};
   if(op==='??'){if(!nullable(a.type))return this.errorValue(n,'?? requires an optional value');const type=this.commonType(present(a.type),b.type,n);if(type.kind==='error')return {type,known:false};return {type,known:k,column,...(k?{value:a.value??b.value}:{sql:'COALESCE('+this.sql(a,n)+','+this.sql(b,n)+')'})};}
   if(['&&','||'].includes(op)){for(const x of [a,b])if(!scalarType(x.type)||x.type.name!=='Bool'||x.type.nullable)return this.errorValue(n,'Boolean operators require Bool, handle Option(Bool) explicitly');return {type:scalar('Bool'),known:k,column,...(k?{value:op==='&&'?a.value&&b.value:a.value||b.value}:{sql:'('+this.sql(a,n)+(op==='&&'?' AND ':' OR ')+this.sql(b,n)+')'})};}
   if(['+','-','*','/','%'].includes(op)){
    if(!numeric(a.type)||!numeric(b.type))return this.errorValue(n,'Arithmetic requires numbers, got '+show(a.type)+' and '+show(b.type));
    if(op==='%'&&([a.type,b.type]as any[]).some(t=>t.name!=='Int'))return this.errorValue(n,'% requires Int');
    const name=op==='/'?'Float':(a.type as any).name==='Float'||(b.type as any).name==='Float'?'Float':'Int';const type=scalar(name,nullable(a.type)||nullable(b.type)||op==='/'||op==='%');
    if(k){let value;if(a.value===null||b.value===null||['/','%'].includes(op)&&b.value===0)value=null;else value=op==='+'?a.value+b.value:op==='-'?a.value-b.value:op==='*'?a.value*b.value:op==='/'?a.value/b.value:a.value%b.value;if(!this.validNumber(value,type,n))return {type:{kind:'error'},known:false};return {type,known:true,value,column};}
    return {type,known:false,column,sql:op==='/'?'(1.0*'+this.sql(a,n)+'/NULLIF('+this.sql(b,n)+',0))':'('+this.sql(a,n)+op+this.sql(b,n)+')'};
   }
   if(['==','!=','<','>','<=','>='].includes(op)){
    if(a.type.kind==='null'||b.type.kind==='null'){if(!['==','!='].includes(op))return this.errorValue(n,'Use == None or != None');const v=a.type.kind==='null'?b:a;return {type:scalar('Bool'),known:k,column,...(k?{value:op==='=='?v.value===null:v.value!==null}:{sql:'('+this.sql(v,n)+(op==='=='?' IS NULL)':' IS NOT NULL)')})};}
    if(this.commonType(a.type,b.type,n).kind==='error')return {type:{kind:'error'},known:false};if(!scalarType(a.type)||!scalarType(b.type))return this.errorValue(n,'Comparison requires scalar operands');const type=scalar('Bool',a.type.nullable||b.type.nullable);
    const value=k?(a.value===null||b.value===null?null:op==='=='?a.value===b.value:op==='!='?a.value!==b.value:op==='<'?a.value<b.value:op==='>'?a.value>b.value:op==='<='?a.value<=b.value:a.value>=b.value):undefined;
    return {type,known:k,column,...(k?{value}:{sql:'('+this.sql(a,n)+(op==='=='?'=':op==='!='?'<>':op)+this.sql(b,n)+')'})};
   }
   fail(n,'Unsupported operator '+op);
  }
  if(n.k==='call'){
   const name=n.name!,args=n.a!;
   if(name==='map_opt'){
    if(args.length!==2||args[1].k!=='lambda'||args[1].params?.length!==1){
     if(!this.checking)fail(n,'map_opt requires (optional, (value) => expression)');
     for(const arg of args)if(arg.k==='lambda')this.compile(arg.body!,{...env,...Object.fromEntries((arg.params??[]).map(p=>[p,{type:{kind:'error'} as Ty,known:false}]))});else this.compile(arg,env);
     return this.errorValue(n,'map_opt requires (optional, (value) => expression)');
    }
    const a=this.compile(args[0],env);if(a.type.kind==='error'){if(this.checking)this.compile(args[1].body!,{...env,[args[1].params![0]]:a});return a;}if(!nullable(a.type)){const invalid=this.errorValue(args[0],'map_opt requires Option');if(this.checking)this.compile(args[1].body!,{...env,[args[1].params![0]]:invalid});return invalid;}
    const value:V={...a,type:present(a.type),known:a.known&&a.value!==null};const out=this.compile(args[1].body!,{...env,[args[1].params![0]]:value});
    if(out.type.kind==='record')return {type:optional(out.type),known:a.known&&(a.value===null||out.known),...(a.known?{value:a.value===null?null:out.value}:{})};
    return {type:optional(out.type),known:a.known&&(a.value===null||out.known),...(a.known&&a.value===null?{value:null}:a.known&&out.known?{value:out.value}:{sql:'(CASE WHEN '+this.presence(a,n)+' IS NULL THEN NULL ELSE '+this.sql(out,n)+' END)'})};
   }
   const a=args.map(x=>this.compile(x,env));
   const expected=argumentBounds[name];if(expected&&(a.length<expected[0]||a.length>expected[1]))return this.errorValue(n,'Invalid argument count for '+name);
   if(name==='case_when'){
    let invalid=a.some(x=>x.type.kind==='error');
    if(a[0].type.kind!=='error'&&(a[0].type.kind!=='scalar'||a[0].type.name!=='Bool'||a[0].type.nullable)){this.reportFailure(args[0],'case_when requires Bool');invalid=true;}
    let type:Ty={kind:'error'};
    if(a[1].type.kind!=='error'&&a[2].type.kind!=='error')try{type=common(a[1].type,a[2].type);}catch(error){if(!this.checking||!(error instanceof TypeRuleError))throw error;this.reportFailure(n,error.message);invalid=true;}
    if(invalid)return {type:{kind:'error'},known:false};
    const k=a.every(x=>x.known);return {type,known:k,...(k?{value:a[0].value?a[1].value:a[2].value}:{sql:'(CASE WHEN '+this.sql(a[0],n)+' THEN '+this.sql(a[1],n)+' ELSE '+this.sql(a[2],n)+' END)'})};
   }
   if(name==='round'){
    let invalid=a.some(x=>x.type.kind==='error');const message='round requires a numeric value and known precision 0..15';
    if(a[0].type.kind!=='error'&&!numeric(a[0].type)){this.reportFailure(args[0],message);invalid=true;}
    if(a[1].type.kind!=='error'&&(!a[1].known||!Number.isInteger(a[1].value)||a[1].value<0||a[1].value>15)){this.reportFailure(args[1],message);invalid=true;}
    if(invalid)return {type:{kind:'error'},known:false};
    const k=a.every(x=>x.known);return {type:a[0].type,known:k,column:a[0].column,...(k?{value:a[0].value===null?null:Math.sign(a[0].value)*Math.round(Math.abs(a[0].value)*10**a[1].value)/10**a[1].value}:{sql:'DARI_ROUND('+this.sql(a[0],n)+','+this.sql(a[1],n)+')'})};
   }
   if(name==='concat'){
    let invalid=a.some(x=>x.type.kind==='error');
    for(const [i,x] of a.entries())if(x.type.kind!=='error'&&(!scalarType(x.type)||x.type.name!=='String')){this.reportFailure(args[i],'concat requires String');invalid=true;}
    if(invalid)return {type:{kind:'error'},known:false};
    const k=a.every(x=>x.known);return {type:scalar('String',a.some(x=>nullable(x.type))),known:k,...(k?{value:a.some(x=>x.value===null)?null:a.map(x=>x.value).join('')}:{sql:'('+a.map(x=>this.sql(x,n)).join('||')+')'})};
   }
   if(name==='lookup'){
    const [input,mapping]=a;let invalid=a.some(x=>x.type.kind==='error');
    if(input.type.kind!=='error'&&!scalarType(input.type)&&input.type.kind!=='null'){this.reportFailure(args[0],'lookup input must be a scalar or null');invalid=true;}
    if(mapping.type.kind==='error')return {type:{kind:'error'},known:false};
    if(mapping.type.kind!=='array'||!mapping.known||!Array.isArray(mapping.value)||!mapping.value.length){this.reportFailure(args[1],'lookup requires a nonempty mapping array known at check time');return {type:{kind:'error'},known:false};}
    const pairs=mapping.value as {value:unknown;label:unknown}[];let labelType:Ty={kind:'never'};const seen=new Set<unknown>();let keyName:string|undefined;
    for(const [index,pair] of pairs.entries()){
     const at=args[1].k==='array'?args[1].a![index]:args[1];
     if(!isRecord(pair)||Object.keys(pair).length!==2||!Object.hasOwn(pair,'value')||!Object.hasOwn(pair,'label')){this.reportFailure(at,'lookup mapping entries require exactly value and label');invalid=true;continue;}
     const keyType=typeOf(pair.value),valueType=typeOf(pair.label);
     if(!scalarType(keyType)){this.reportFailure(at,'lookup mapping value must be a non-null scalar');invalid=true;}
     else{
      if(input.type.kind==='scalar'&&input.type.name!==keyType.name){this.reportFailure(at,'lookup key type must match input type '+show(present(input.type)));invalid=true;}
      if(keyName!==undefined&&keyName!==keyType.name){this.reportFailure(at,'lookup mapping keys must have one type');invalid=true;}else keyName=keyType.name;
      if(seen.has(pair.value)){this.reportFailure(at,'lookup duplicate value '+JSON.stringify(pair.value));invalid=true;}seen.add(pair.value);
     }
     if(!scalarType(valueType)&&valueType.kind!=='null'){this.reportFailure(at,'lookup label must be a scalar or null');invalid=true;}
     else try{labelType=common(labelType,valueType);}catch(error){if(!this.checking||!(error instanceof TypeRuleError))throw error;this.reportFailure(at,error.message);invalid=true;}
    }
    if(invalid)return {type:{kind:'error'},known:false};
    const type=labelType.kind==='null'?labelType:optional(labelType);
    if(input.known)return {type,known:true,column:input.column,value:input.value===null?null:pairs.find(p=>p.value===input.value)?.label??null};
    const sql='(CASE '+this.sql(input,n)+pairs.map(p=>' WHEN '+this.param(p.value)+' THEN '+this.param(p.label)).join('')+' ELSE NULL END)';
    return {type,known:false,column:input.column,sql};
   }
   if(a.some(x=>x.type.kind==='error'))return {type:{kind:'error'},known:false};
   if(['count','sum','avg','min','max'].includes(name)){
    const x=a[0];if(!x.column&&!x.rows)return this.errorValue(n,name+' requires a grouped Column or rows');if(x.rows&&name!=='count')return this.errorValue(n,name+' requires a Column');
    if(['sum','avg'].includes(name)&&!numeric(x.type))return this.errorValue(n,name+' requires a numeric Column');
    const type=name==='count'?scalar('Int'):name==='avg'?scalar('Float',true):optional(x.type);
    return {type,known:false,sql:name.toUpperCase()+'('+(x.rows?'*':this.sql(x,n))+')'};
   }
   if(name==='is_some'||name==='is_none'){const x=a[0];if(!nullable(x.type))return this.errorValue(n,name+' requires Option');return {type:scalar('Bool'),known:x.known,...(x.known?{value:name==='is_some'?x.value!==null:x.value===null}:{sql:'('+this.presence(x,n)+(name==='is_some'?' IS NOT NULL)':' IS NULL)')}),column:x.column};}
   return this.errorValue(n,'Function is not available in this expression: '+name);
  }
  return fail(n,'Invalid typed expression '+n.k);
 }
 validNumber(value:any,type:Ty,n:N){if(value!==null&&typeof value==='number'&&(!Number.isFinite(value)||type.kind==='scalar'&&type.name==='Int'&&!Number.isSafeInteger(value))){this.reportFailure(n,'Numeric result is outside the supported range');return false;}return true;}
 relational(n:N){
  const spec=n.a![0];if(spec.k!=='object')fail(n,'Expected select specification');const entries=Object.fromEntries(spec.entries!.map(e=>[e.key,e.value]));for(const key of Object.keys(entries))if(!['from','joins','where','fields','group_by','having','order_by','limit'].includes(key))this.reportFailure(entries[key],'Unknown select option '+key);
  const captures=this.env(),tables:Record<string,unknown>={},scope:Record<string,V>=Object.create(null),joins:string[]=[];let sourceCount=0,unavailableSource=false,openScope=false;let baseBounds:{minRows?:number;maxRows?:number}={};
  const source=(s:N,left=false):string=>{
   if(s.k!=='object'||s.entries!.length!==1)fail(s,'Expected one source alias');const {key:alias,value:ref}=s.entries![0];const v=this.compile(ref,captures);if(Object.hasOwn(scope,alias)){this.reportFailure(s,'Duplicate table alias '+alias);if(v.type.kind!=='table'&&v.type.kind!=='error')this.reportFailure(ref,'Expected Table, got '+show(v.type));scope[alias]={type:{kind:'error'},known:false};unavailableSource=true;return '(SELECT 1) a'+sourceCount++;}
   if(v.type.kind!=='table'){
    if(v.type.kind!=='error')this.reportFailure(ref,'Expected Table, got '+show(v.type));
    if(!this.checking)throw new UpstreamTypeUnavailable();
    unavailableSource=true;scope[alias]={type:{kind:'error'},known:false};return '(SELECT 1) a'+sourceCount++;
   }
   const inputKey='source'+sourceCount,sqlAlias='a'+sourceCount++;tables[inputKey]=this.captures[ref.name!];const columns=v.type.columns;if(sourceCount===1)baseBounds=v.type;let presence='__dari_present';while(columns.some(c=>c.name===presence))presence+='_';
   scope[alias]={type:rowType(columns),known:false,presence:sqlAlias+'.'+q(presence),fields:Object.fromEntries(columns.map(c=>[c.name,{type:scalar(c.type,c.nullable),known:false,sql:sqlAlias+'.'+q(c.name)}]))};
   return '(SELECT *,1 AS '+q(presence)+' FROM '+q('t_'+inputKey)+') '+sqlAlias;
  };
  let from:string;
  if(!entries.from){this.reportFailure(n,'select requires from');openScope=true;unavailableSource=true;from='(SELECT 1) a'+sourceCount++;}
  else from=source(entries.from);
  if(entries.joins){if(entries.joins.k!=='array')fail(entries.joins,'joins must be an array');for(const j of entries.joins.a!){if(j.k!=='object')fail(j,'Expected join object');const p=Object.fromEntries(j.entries!.map(e=>[e.key,e.value]));for(const key of Object.keys(p))if(!['kind','source','on'].includes(key))this.reportFailure(p[key],'Unknown join option '+key);if(!p.source){this.reportFailure(j,'join requires kind,source,on');openScope=true;unavailableSource=true;if(p.on){const predicate=this.callback(p.on,[{type:record(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,v.type]))),known:false,fields:{...scope},open:true}],captures);this.bool(predicate,p.on);}continue;}const validKind=!!p.kind&&p.kind.k==='lit'&&['inner','left'].includes(p.kind.v);if(!validKind||!p.on)this.reportFailure(j,'join requires kind,source,on');const sql=source(p.source);const predicate=p.on?this.callback(p.on,[{type:record(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,v.type]))),known:false,fields:{...scope},open:openScope}],captures):undefined;const valid=predicate?this.bool(predicate,p.on):false;joins.push((p.kind?.v==='left'?' LEFT':' INNER')+' JOIN '+sql+' ON '+(valid?this.sql(predicate!,p.on):'NULL'));const alias=p.source.entries![0].key;if(!validKind){scope[alias]={type:{kind:'error'},known:false};unavailableSource=true;}else if(p.kind.v==='left')scope[alias]={...scope[alias],type:optional(scope[alias].type)};}}
  const row:V={type:record(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,v.type]))),known:false,fields:scope,open:openScope};
  const limit=entries.limit?this.compile(entries.limit,captures):undefined;let invalidLimit=false;
  if(limit&&limit.type.kind!=='error'&&(!limit.known||!Number.isSafeInteger(limit.value)||limit.value<0)){this.reportFailure(entries.limit,'limit requires a known nonnegative Int');invalidLimit=true;}
  const where=entries.where?this.callback(entries.where,[row],captures):undefined;const whereValid=where?this.bool(where,entries.where):false;
  let groups:V|undefined;if(entries.group_by){groups=this.callback(entries.group_by,[row],captures);if(groups.type.kind!=='record'&&groups.type.kind!=='error'){this.reportFailure(entries.group_by,'group_by requires a key record');groups={type:{kind:'error'},known:false};}for(const [name,v] of Object.entries(groups.fields??{}))if(v.type.kind!=='scalar'&&v.type.kind!=='null'&&v.type.kind!=='error'){
   this.reportFailure(this.fieldNode(entries.group_by,name),'Group key '+name+' must be scalar');
   const errorType:Ty={kind:'error'};groups.fields![name]={type:errorType,known:false};if(groups.type.kind==='record')groups.type={...groups.type,fields:{...groups.type.fields,[name]:errorType}};
  }}
  const asColumns=(v:V):V=>({...v,column:v.type.kind==='scalar'?true:v.column,...(v.fields?{fields:Object.fromEntries(Object.entries(v.fields).map(([k,v])=>[k,asColumns(v)]))}:{})});
  if(!entries.fields)this.reportFailure(n,'select requires fields');
  let values:V=entries.fields?this.callback(entries.fields,groups?[groups,{...asColumns(row),rows:true}]:[row],captures):{type:{kind:'error'},known:false};let unavailableOutput=false;
  if(values.type.kind!=='record'||!values.fields||!Object.keys(values.fields).length){if(values.type.kind!=='error')this.reportFailure(entries.fields,'fields requires a nonempty record');unavailableOutput=true;values={type:record({}),known:false,fields:{}};}
  const valueFields=values.fields!;
  const outputFields:Record<string,V>={};const columns:SqlColumn[]=[];
  for(const [name,v] of Object.entries(valueFields)){
   if(v.type.kind==='error'){outputFields[name]=v;continue;}
   if(v.type.kind!=='scalar'||v.column){this.reportFailure(this.fieldNode(entries.fields,name),v.column?'Column must be aggregated: '+name:'Table field '+name+' must have an inferred scalar type, got '+show(v.type));outputFields[name]={type:{kind:'error'},known:false};continue;}
   columns.push({name,type:v.type.name,nullable:v.type.nullable});outputFields[name]={type:v.type,known:false,sql:q(name)};
  }
  let projection=Object.entries(valueFields).map(([name,v])=>(outputFields[name].type.kind==='error'?'NULL':this.sql(v,entries.fields))+' AS '+q(name)).join(',');
  const names=Object.keys(valueFields);if(new Set(names.map(name=>name.toLowerCase())).size!==names.length)this.reportFailure(entries.fields,'Output column names must be distinct ignoring case for SQLite lowering');
  if(groups?.type.kind==='record'&&Object.keys(groups.fields??{}).length===0&&!/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/.test(projection))projection+=',COUNT(*) AS "__dari_global_anchor"';
  let inner='SELECT '+projection+' FROM '+from+joins.join('')+(where?' WHERE '+(whereValid?this.sql(where,entries.where):'NULL'):'');
  if(groups){const keys=Object.values(groups.fields??{});if(keys.length)inner+=' GROUP BY '+keys.map(v=>v.type.kind==='scalar'||v.type.kind==='null'?this.sql(v,entries.group_by):'NULL').join(',');}
  const output:V=unavailableOutput?{type:{kind:'error'},known:false}:{type:record(Object.fromEntries(Object.entries(outputFields).map(([name,v])=>[name,v.type]))),known:false,fields:outputFields};
  if(entries.having&&!groups)this.reportFailure(entries.having,'having requires group_by');
  let sql='SELECT '+columns.map(c=>q(c.name)).join(',')+' FROM ('+inner+')';if(entries.having&&(groups||this.checking)){const p=this.callback(entries.having,[output],captures);const valid=this.bool(p,entries.having);if(groups)sql+=' WHERE '+(valid?this.sql(p,entries.having):'NULL');}
  if(entries.order_by){const f=entries.order_by;if(f.k!=='lambda'||f.params?.length!==1||f.body?.k!=='array'){
   if(this.checking){
    if(f.k==='lambda'){
     const env:Record<string,V>={...captures,...Object.fromEntries((f.params??[]).map((p,i)=>[p,i===0?output:{type:{kind:'error'} as Ty,known:false}]))};
     if(f.body?.k==='array')for(const item of f.body.a??[]){if(item.k==='call'&&['asc','desc'].includes(item.name!))for(const arg of item.a??[])this.compile(arg,env);else this.compile(item,env);}
     else if(f.body)this.compile(f.body,env);
    }else this.compile(f,captures);
   }
   this.reportFailure(f,'order_by requires (out) => [asc/desc(...)]');
  }else{const env={...captures,[f.params![0]]:output};const order=f.body.a!.map(item=>{
   if(item.k!=='call'||!['asc','desc'].includes(item.name!)||![1,2].includes(item.a!.length)){if(this.checking){if(item.k==='call')for(const arg of item.a??[])this.compile(arg,env);else this.compile(item,env);}this.reportFailure(item,'Expected asc or desc');return 'NULL ASC NULLS LAST';}
   const value=this.compile(item.a![0],env),option=item.a![1]?this.compile(item.a![1],env):undefined;let valid=true,nulls='last';
   if(value.type.kind==='error')valid=false;else if(value.type.kind!=='scalar'){this.reportFailure(item,'Ordering requires a scalar');valid=false;}
   if(option){if(option.type.kind==='error')valid=false;else if(!option.known||!isRecord(option.value)||Object.keys(option.value).some(k=>k!=='nulls')||!['first','last'].includes(String(option.value.nulls))){this.reportFailure(item,'Ordering options must be {nulls:"first"|"last"}');valid=false;}else nulls=String(option.value.nulls);}
   return valid?this.sql(value,item)+' '+item.name!.toUpperCase()+' NULLS '+nulls.toUpperCase():'NULL ASC NULLS LAST';
  });if(!order.length)this.reportFailure(f,'order_by must not be empty');else sql+=' ORDER BY '+order.join(',');}}
  const unavailableGroups=groups?.type.kind==='error',globalGroup=groups?.type.kind==='record'&&Object.keys(groups.fields??{}).length===0;
  let minRows=globalGroup&&!entries.having?1:!unavailableSource&&!groups&&!entries.where&&!joins.length?(baseBounds.minRows??0):0,maxRows:number|undefined=unavailableGroups?undefined:globalGroup?1:!unavailableSource&&!joins.length?baseBounds.maxRows:undefined;
  if(limit&&limit.type.kind!=='error'&&!invalidLimit){if(limit.value>0&&!entries.order_by&&maxRows!==1&&(!unavailableSource||maxRows!==undefined)&&!unavailableGroups)this.reportFailure(entries.limit,'limit requires order_by');maxRows=Math.min(maxRows??Infinity,limit.value);minRows=Math.min(minRows,limit.value);sql+=' LIMIT '+limit.value;}
  this.throwIfErrors();
  if(unavailableSource||unavailableOutput||unavailableGroups||limit?.type.kind==='error')throw new UpstreamTypeUnavailable();
  if(n.name==='select_one')sql='SELECT * FROM ('+sql+') LIMIT 2';
  return {sql,tables,columns,type:n.name==='select_one'?optional(rowType(columns)):{kind:'table',columns,minRows,...(maxRows===undefined?{}:{maxRows})} as Ty,minRows,maxRows,guard:n.name==='select_one'&&(maxRows===undefined||maxRows>1)};
 }
 presence(v:V,n:N):string{if(v.presence)return v.presence;if(v.type.kind==='record')return this.param(v.known?(v.value===null?null:1):null);return this.sql(v,n);}
 fieldNode(callback:N,name:string):N{const body=callback.k==='lambda'?callback.body:undefined;return body?.k==='object'?body.entries?.find(entry=>entry.key===name)?.value??callback:callback;}
 callback(n:N,args:V[],env:Record<string,V>):V{
  if(n.k!=='lambda'||n.params?.length!==args.length){
   if(this.checking){if(n.k==='lambda')this.compile(n.body!,{...env,...Object.fromEntries((n.params??[]).map((p,i)=>[p,args[i]??{type:{kind:'error'},known:false}]))});else this.compile(n,env);}
   return this.errorValue(n,'Expected a row function with '+args.length+' parameter(s)');
  }
  return this.compile(n.body!,{...env,...Object.fromEntries(n.params!.map((p,i)=>[p,args[i]]))});
 }
 reportFailure(n:N,message:string){if(!this.checking)fail(n,message);this.diagnostics.report({stage:'type',message,span:n.s});}
 errorValue(n:N,message:string):V{this.reportFailure(n,message);return {type:{kind:'error'},known:false};}
 commonType(a:Ty,b:Ty,n:N):Ty{try{return common(a,b);}catch(error){if(!this.checking||!(error instanceof TypeRuleError))throw error;this.reportFailure(n,error.message);return {kind:'error'};}}
 bool(v:V,n:N):boolean{if(v.type.kind==='error'&&this.checking)return false;if(v.type.kind!=='scalar'||v.type.name!=='Bool'||v.type.nullable||v.column){this.reportFailure(n,'Predicate must return Bool; use ?? False for Option(Bool)');return false;}return true;}
}
