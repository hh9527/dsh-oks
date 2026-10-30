import {DraftSyntaxError,type Expr,type PipelineNode,type Position,type Span,type Operator} from './pipeline.ts';
export type N={k:string;s:Span;v?:any;a?:N[];entries?:{key:string;value:N}[];name?:string;input?:N;key?:string|number;optional?:boolean;params?:string[];body?:N;op?:string;left?:N;right?:N};
const calls=new Set(['query','context','time_windows','data','select','select_one','table','map','union_all','is_some','is_none','map_opt','round','case_when','concat','to_datetime_utc','to_epoch_millis','asc','desc','count','sum','avg','min','max']);
export function parseTypedPipeline(source:string,base:Position,options:{definitions?:Map<string,N>;expressionName?:string}={}):PipelineNode[]{
 let at=0;const lines=[0];for(let i=0;i<source.length;i++)if(source[i]==='\n')lines.push(i+1);
 const pos=(n:number):Position=>{let l=0;while(l+1<lines.length&&lines[l+1]<=n)l++;return {offset:base.offset+n,line:base.line+l,column:l?n-lines[l]+1:base.column+n};};
 type Tok={text:string;value?:any;start:number;end:number;kind:string;comments:string[]};
 const lex=():Tok=>{const comments:string[]=[];while(at<source.length){if(/\s/.test(source[at])){at++;continue;}if(source.startsWith('//',at)){const p=at;at+=2;const s=at;while(at<source.length&&source[at]!=='\n')at++;if(/^[ \t]*$/.test(source.slice(source.lastIndexOf('\n',p-1)+1,p)))comments.push(source.slice(s,at).trim());continue;}if(source.startsWith('/*',at)){const e=source.indexOf('*/',at+2);if(e<0)throw new DraftSyntaxError('Unterminated block comment',{start:pos(at),end:pos(source.length)});at=e+2;continue;}break;}
 const start=at;if(at===source.length)return {text:'',start,end:at,kind:'eof',comments};
 const id=/^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(at));if(id){at+=id[0].length;return {text:id[0],start,end:at,kind:'id',comments};}
 if(source[at]==='"'){at++;while(at<source.length&&source[at]!=='"'){if(source[at]==='\\')at++;at++;}at++;const text=source.slice(start,at);try{return {text,value:JSON.parse(text),start,end:at,kind:'literal',comments};}catch{throw new DraftSyntaxError('Invalid JSON string',{start:pos(start),end:pos(Math.min(at,source.length))});}}
 const num=/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));if(num){at+=num[0].length;return {text:num[0],value:Number(num[0]),start,end:at,kind:'literal',comments};}
 for(const op of ['<-','=>','?.','??','==','!=','<=','>=','&&','||'])if(source.startsWith(op,at)){at+=op.length;return {text:op,start,end:at,kind:'symbol',comments};}
 return {text:source[at++],start,end:at,kind:'symbol',comments};};
 let token=lex(),end=0;const take=()=>{const t=token;end=t.end;token=lex();return t;};
 const fail=(m:string,t=token):never=>{throw new DraftSyntaxError(m,{start:pos(t.start),end:pos(t.end)});};
 const is=(s:string)=>token.text===s;
 const eat=(s:string)=>{if(token.text!==s)fail('Expected '+JSON.stringify(s));return take();};
 const span=(start:number):Span=>({start:pos(start),end:pos(end)});
 const prec:Record<string,number>={'??':1,'||':2,'&&':3,'==':4,'!=':4,'<':5,'>':5,'<=':5,'>=':5,'+':6,'-':6,'*':7,'/':7,'%':7};
 const expr=(min=0,depth=0):N=>{if(depth>128)fail('Expression nesting exceeds 128');const start=token.start;let n:N;
  if(is('!')||is('-')){const op=take().text;n={k:'unary',op,input:expr(8,depth+1),s:span(start)};}
  else if(token.kind==='literal'||['true','false','null'].includes(token.text)){const t=take();const v=t.kind==='literal'?t.value:JSON.parse(t.text);if(typeof v==='number'&&!Number.isFinite(v))fail('Numbers must be finite',t);n={k:'lit',v,s:span(start)};}
  else if(is('(')){take();if(is(')')){take();eat('=>');n={k:'lambda',params:[],body:expr(0,depth+1),s:span(start)};}
   else{const first=expr(0,depth+1);if(is(',')||is(')')&&source.slice(token.end).trimStart().startsWith('=>')){if(first.k!=='ref')fail('Lambda parameters must be identifiers');const params=[first.name!];while(is(',')){take();if(token.kind!=='id')fail('Expected lambda parameter');params.push(take().text);}eat(')');eat('=>');if(new Set(params).size!==params.length)fail('Duplicate lambda parameter');n={k:'lambda',params,body:expr(0,depth+1),s:span(start)};}else{eat(')');n=first;}}
  }else if(is('[')){take();const a:N[]=[];while(!is(']')){a.push(expr(0,depth+1));if(!is(','))break;take();}eat(']');n={k:'array',a,s:span(start)};}
  else if(is('{')){take();const entries:{key:string;value:N}[]=[];const keys=new Set<string>();while(!is('}')){const t=take();if(t.kind!=='id'&&!(t.kind==='literal'&&typeof t.value==='string'))fail('Expected object key',t);const key=t.kind==='id'?t.text:t.value;if(keys.has(key))fail('Duplicate object key '+key,t);keys.add(key);let value:N;if(is(':')){take();value=expr(0,depth+1);}else value={k:'ref',name:key,s:{start:pos(t.start),end:pos(t.end)}};entries.push({key,value});if(!is(','))break;take();}eat('}');n={k:'object',entries,s:span(start)};}
  else if(token.kind==='id'){const name=take().text;if(is('=>')){take();n={k:'lambda',params:[name],body:expr(0,depth+1),s:span(start)};}else if(is('(')){if(!calls.has(name))fail('Unknown function '+name);take();const a:N[]=[];while(!is(')')){a.push(expr(0,depth+1));if(!is(','))break;take();}eat(')');n={k:'call',name,a,s:span(start)};}else n={k:'ref',name,s:span(start)};}
  else return fail('Expected an expression');
  while(['.','?.','['].includes(token.text)){let key:string|number,optional=false;if(is('[')){take();const t=take();if(t.kind!=='literal'||!(typeof t.value==='string'||Number.isSafeInteger(t.value)&&t.value>=0))fail('Projection requires a static key',t);key=t.value;eat(']');}else{optional=take().text==='?.';if(token.kind!=='id')fail('Expected field name');key=take().text;}n={k:'get',input:n,key,optional,s:span(start)};}
  while(prec[token.text]!==undefined&&prec[token.text]>=min){const op=take().text;const right=expr(prec[op]+1,depth+1);n={k:'binary',op,left:n,right,s:span(start)};}
  return n;
 };
 const defs=options.definitions??new Map<string,N>(),nodes:PipelineNode[]=[];
 const cloneSub=(n:N,subs:Map<string,N>):N=>{if(n.k==='ref'&&subs.has(n.name!))return subs.get(n.name!)!;if(n.k==='lambda'){const inner=new Map(subs);n.params!.forEach(p=>inner.delete(p));return {...n,body:cloneSub(n.body!,inner)};}return {...n,...(n.a?{a:n.a.map(x=>cloneSub(x,subs))}:{}),...(n.entries?{entries:n.entries.map(e=>({...e,value:cloneSub(e.value,subs)}))}:{}),...(n.input?{input:cloneSub(n.input,subs)}:{}),...(n.left?{left:cloneSub(n.left,subs)}:{}),...(n.right?{right:cloneSub(n.right,subs)}:{})};};
 const refs=(n:N,locals=new Set<string>(),out=new Set<string>()):Set<string>=>{if(n.k==='ref'&&!locals.has(n.name!))out.add(n.name!);if(n.k==='lambda'){const l=new Set([...locals,...n.params!]);refs(n.body!,l,out);}else{n.a?.forEach(a=>refs(a,locals,out));n.entries?.forEach(e=>refs(e.value,locals,out));if(n.input)refs(n.input,locals,out);if(n.left)refs(n.left,locals,out);if(n.right)refs(n.right,locals,out);}return out;};
 const arrayLength=(n:N,seen=new Set<string>()):number|undefined=>{if(n.k==='array')return n.a!.length;if(n.k==='ref'&&defs.has(n.name!)&&!seen.has(n.name!)){seen.add(n.name!);return arrayLength(defs.get(n.name!)!,seen);}if(n.k==='call'&&n.name==='time_windows'){const count=n.a?.[1]?.entries?.find(e=>e.key==='count')?.value;if(count?.k==='lit'&&Number.isInteger(count.v)&&count.v>=1&&count.v<=50)return count.v;}if(n.k==='call'&&n.name==='map')return arrayLength(n.a![0],seen);return undefined;};
 const literal=(value:any,s:Span):Expr=>({kind:'literal',value,span:s});
 const payload=(operator:string,n:N,inputs:{key:string;value:Expr}[]):Expr=>({kind:'call',operator:operator as Operator,args:[literal(JSON.stringify(n),n.s),{kind:'object',entries:inputs,span:n.s}],span:n.s});
 const lower=(n:N):Expr=>{
  if(n.k==='lit')return literal(n.v,n.s);
  if(n.k==='ref')return {kind:'ref',name:n.name!,span:n.s};
  if(n.k==='object')return {kind:'object',entries:n.entries!.map(e=>({key:e.key,value:lower(e.value)})),span:n.s};
  if(n.k==='array')return {kind:'array',values:n.a!.map(lower),span:n.s};
  if(n.k==='call'&&['query','context','time_windows','data'].includes(n.name!))return {kind:'call',operator:n.name as Operator,args:n.a!.map(lower),span:n.s};
  if(n.k==='call'&&n.name==='map'){
   if(n.a!.length!==2||n.a![1].k!=='lambda'||![1,2].includes(n.a![1].params!.length))throw new DraftSyntaxError('map requires an array and (item,index?) => expression',n.s);
   const length=arrayLength(n.a![0]);if(length===undefined||length>50)throw new DraftSyntaxError('map requires an array with a statically known length <= 50',n.s);
   const f=n.a![1];return {kind:'array',values:Array.from({length},(_,i)=>{const sub=new Map<string,N>([[f.params![0],{k:'get',input:n.a![0],key:i,s:n.s}]]);if(f.params![1])sub.set(f.params![1],{k:'lit',v:i,s:n.s});return lower(cloneSub(f.body!,sub));}),span:n.s};
  }
  if(n.k==='call'&&n.name==='table'){if(![1,2].includes(n.a!.length))throw new DraftSyntaxError('table requires rows and optional data nature',n.s);return {kind:'call',operator:'typed_table',args:[{kind:'call',operator:'data',args:n.a!.map(lower),span:n.s}],span:n.s};}
  if(n.k==='call'&&n.name==='union_all'){if(n.a!.length!==1)throw new DraftSyntaxError('union_all requires one array of tables',n.s);return {kind:'call',operator:'table_union' as Operator,args:n.a!.map(lower),span:n.s};}
  if(n.k==='call'&&['select','select_one'].includes(n.name!)){
   if(n.a!.length!==1||n.a![0].k!=='object')throw new DraftSyntaxError('select requires an object specification',n.s);
   const spec=n.a![0];const inputs:{key:string;value:Expr}[]=[];let seq=0;
   const source=(obj:N):N=>{if(obj.k!=='object'||obj.entries!.length!==1)throw new DraftSyntaxError('source must contain exactly one table alias',obj.s);const e=obj.entries![0],key='__source'+seq++;inputs.push({key,value:lower(e.value)});return {...obj,entries:[{key:e.key,value:{k:'ref',name:key,s:e.value.s}}]};};
   const entries=spec.entries!.map(e=>{if(e.key==='from')return {...e,value:source(e.value)};if(e.key==='joins'){if(e.value.k!=='array')throw new DraftSyntaxError('joins must be an array',e.value.s);return {...e,value:{...e.value,a:e.value.a!.map(j=>{if(j.k!=='object')throw new DraftSyntaxError('join must be an object',j.s);return {...j,entries:j.entries!.map(x=>x.key==='source'?{...x,value:source(x.value)}:x)};})}};}return e;});
   const plan={...n,a:[{...spec,entries}]};
   for(const name of refs(plan))if(!name.startsWith('__source'))inputs.push({key:name,value:{kind:'ref',name,span:n.s}});
   return payload(n.name==='select'?'relational':'relational_one',plan,inputs);
  }
  if(n.k==='lambda')throw new DraftSyntaxError('Functions can only appear in typed operator arguments',n.s);
  return payload('typed_value',n,[...refs(n)].map(name=>({key:name,value:{kind:'ref',name,span:n.s}})));
 };
 if(options.expressionName!==undefined){
  const n=expr();if(token.kind!=='eof')fail('Unexpected content after expression');
  const dependencies=[...refs(n)];for(const ref of dependencies)if(!defs.has(ref))throw new DraftSyntaxError('Undefined or forward data binding '+ref,n.s);
  const name=options.expressionName;defs.set(name,n);return [{typed:true,statement:{kind:'binding',name,value:lower(n),span:n.s,motivation:''},bindings:dependencies,assets:[]}];
 }
 while(token.kind!=='eof'){
  if(nodes.length>=512)fail('Pipeline is limited to 512 statements');const head=token;let name:string|undefined,n:N;
  if(is('{')){n=expr();if(is(';'))take();if(token.kind!=='eof')fail('Output must be the final statement');}
  else{if(token.kind!=='id')fail('Expected binding name');name=take().text;if(calls.has(name)||name.startsWith('__'))fail('Reserved binding name '+name,head);if(defs.has(name))fail('Duplicate binding '+name,head);eat('<-');n=expr();eat(';');}
  const dependencies=[...refs(n)];for(const ref of dependencies)if(!defs.has(ref))throw new DraftSyntaxError('Undefined or forward binding '+ref,n.s);
  const value=lower(n),s=span(head.start);nodes.push({typed:true,statement:name?{kind:'binding',name,value,span:s,motivation:head.comments.join('\n')}:{kind:'output',value,span:s,motivation:head.comments.join('\n')},bindings:dependencies,assets:[]});if(name)defs.set(name,n);
 }
 let acquisitions=0;const visit=(e:Expr)=>{if(e.kind==='call'){if(e.operator==='query')acquisitions++;e.args.forEach(visit);}else if(e.kind==='array')e.values.forEach(visit);else if(e.kind==='object')e.entries.forEach(x=>visit(x.value));else if(e.kind==='project')visit(e.input);};nodes.forEach(n=>visit(n.statement.value));if(acquisitions>128)throw new DraftSyntaxError('Pipeline exceeds 128 queries',nodes[0].statement.span);
 return nodes;
}
