import type { JsonValue } from './project.ts';

type Step = {kind:'field';key:string} | {kind:'op';name:'len'|'keys'} | {kind:'slice';start:number;end:number}
  | {kind:'optional'} | {kind:'group';paths:Step[][]} | {kind:'map';projection:Step[]};
type Selected = {kind:'leaf';value:JsonValue} | {kind:'object';fields:Map<string,Selected>};
const object = (value:JsonValue):value is Record<string,JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value);
const leaf = (value:JsonValue):Selected => ({kind:'leaf',value});
const materialize = (node:Selected):JsonValue => node.kind==='leaf' ? node.value : Object.fromEntries([...node.fields].map(([key,value])=>[key,materialize(value)]));
const help = '\nselect 示例：ports.rows；{rows,columns}；items[0:25]:map({id,name})；datasets:map({grain,dimensions:keys})；a?.b.{c?:len,d}。'
  +'\n路径可用 . 开头；组合投影使用 {…}；select 作用于资源或 transform 结果，不含工具外层 data 包装。'
  +'\n完整语法：oks://help/project.md';
const error = (message:string):never => {throw new Error(message+help);};
const merge = (a:Selected,b:Selected,path:string):Selected => {
  if(a.kind!=='object'||b.kind!=='object')return error(`select result conflict at ${path}`);
  for(const [key,value] of b.fields){
    const previous=a.fields.get(key);
    a.fields.set(key,previous ? merge(previous,value,path+'.'+key) : value);
  }
  return a;
};

/** A bounded projection language. map evaluates the same grammar relative to each item/value. */
export function createSelector(source:unknown):(input:JsonValue)=>JsonValue {
  if(typeof source!=='string'||!source.trim())return error('select must be a nonempty projection string');
  if(source.length>16384)return error('select exceeds 16384 characters');
  let cursor=0,count=0;
  const fail=(message:string):never=>error(`select at ${cursor+1}: ${message}`);
  const space=()=>{while(cursor<source.length&&/\s/.test(source[cursor]))cursor++;};
  const expect=(ch:string)=>{space();if(source[cursor]!==ch)fail(`expected ${ch}`);cursor++;};
  const field=():Step=>{
    space();let key='';
    if(source[cursor]==="'"){
      cursor++;let closed=false;
      while(cursor<source.length){
        const ch=source[cursor++];
        if(ch==="'"){closed=true;break;}
        if(ch==='\\'){
          const escape=source[cursor++];
          if(escape!=="'"&&escape!=='\\')fail("quoted keys only escape ' and \\");
          key+=escape;
        }else key+=ch;
      }
      if(!closed)fail('unclosed quoted key');
    }else{
      const start=cursor;
      while(cursor<source.length&&!/[\s.,{}\[\]:()'|?]/.test(source[cursor]))cursor++;
      key=source.slice(start,cursor);if(!key)fail('expected a field, quoted key or {projection,…}');
      if(!/^[\p{L}\p{N}_$-]+$/u.test(key))fail('use a quoted key for punctuation');
    }
    return {kind:'field',key};
  };
  const integer=()=>{space();const match=/^-?\d+/.exec(source.slice(cursor));if(!match)fail('expected an integer slice bound');cursor+=match![0].length;const value=Number(match![0]);if(!Number.isSafeInteger(value))fail('slice bound must be a safe integer');return value;};
  const group=(depth:number):Step=>{
    expect('{');space();if(source[cursor]==='}')fail('projection group must contain at least one expression');
    const paths:Step[][]=[];
    for(;;){paths.push(projection(depth+1));space();if(source[cursor]!==',')break;cursor++;}
    expect('}');return {kind:'group',paths};
  };
  const projection=(depth:number):Step[]=>{
    if(depth>64)fail('nesting exceeds 64');
    if(++count>1024)fail('too many selection paths');
    const steps:Step[]=[];space();
    if(source[cursor]==='.'){cursor++;space();}
    if(source[cursor]==='{')steps.push(group(depth));
    else if(source[cursor]!==':'&&source[cursor]!=='['&&source[cursor]!=='?')steps.push(field());
    for(;;){
      space();const ch=source[cursor];
      if(ch==='?'){
        if(steps.at(-1)?.kind==='optional')fail('duplicate ? guard');
        cursor++;steps.push({kind:'optional'});
      }else if(ch===':'){
        cursor++;space();const match=/^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor));
        if(!match)fail('expected an operator');cursor+=match![0].length;
        const name=match![0];
        if(name==='map'){expect('(');steps.push({kind:'map',projection:projection(depth+1)});expect(')');}
        else if(name==='len'||name==='keys')steps.push({kind:'op',name});
        else fail(`unknown operator ${name}; use :len, :keys or :map(projection)`);
      }else if(ch==='['){
        cursor++;const start=integer();expect(':');const end=integer();expect(']');steps.push({kind:'slice',start,end});
      }else if(ch==='.'){
        cursor++;space();steps.push(source[cursor]==='{'?group(depth):field());
      }else break;
      if(steps.length>256)fail('path exceeds 256 steps');
    }
    return steps;
  };
  const parsed=projection(0);space();
  if(cursor!==source.length){
    if(source[cursor]===',')fail('multiple projections must be enclosed in {…}');
    if(source[cursor]==='|')fail('select does not support jq pipes; use a projection or transform');
    fail(`unexpected ${source[cursor]}`);
  }
  const evaluate=(value:JsonValue,steps:Step[],path:string):Selected=>{
    if(!steps.length)return leaf(value);
    const [step,...rest]=steps;
    if(step.kind==='optional')return value===null?leaf(null):evaluate(value,rest,path);
    if(step.kind==='field'){
      if(!object(value))return error(`select field requires an object at ${path}; use ? for null/absent or :map(projection) for arrays`);
      const exists=Object.hasOwn(value,step.key);
      if(!exists&&rest[0]?.kind!=='optional')return error(`select missing field ${path}.${JSON.stringify(step.key)}; inspect :keys or use ? for optional fields`);
      if(!exists)return {kind:'object',fields:new Map()};
      let selected=value[step.key],label=step.key,index=0,shortCircuited=false;
      while(index<rest.length&&(rest[index].kind==='op'||rest[index].kind==='slice'||rest[index].kind==='map'||rest[index].kind==='optional')){
        const operation=rest[index++];
        if(operation.kind==='optional'){
          if(selected===null)shortCircuited=true;
          continue;
        }
        if(!shortCircuited)selected=apply(selected,operation,path+'.'+label);
        label+=operation.kind==='op'?':'+operation.name:operation.kind==='slice'?`[${operation.start}:${operation.end}]`:':map';
      }
      return {kind:'object',fields:new Map([[label,shortCircuited?leaf(null):evaluate(selected,rest.slice(index),path+'.'+label)]])};
    }
    if(step.kind==='group'){
      if(!object(value))return error(`select group requires an object at ${path}; use ? for null/absent`);
      let combined:Selected={kind:'object',fields:new Map()};
      for(const branch of step.paths)combined=merge(combined,evaluate(value,branch,path),path);
      return rest.length?evaluate(materialize(combined),rest,path):combined;
    }
    return evaluate(apply(value,step,path),rest,path);
  };
  const apply=(value:JsonValue,step:Step,path:string):JsonValue=>{
    if(step.kind==='slice'){
      if(!Array.isArray(value)&&typeof value!=='string')return error(`select slice requires array or string at ${path}`);
      return value.slice(step.start,step.end) as JsonValue;
    }
    if(step.kind==='map'){
      if(Array.isArray(value))return value.map((item,index)=>materialize(evaluate(item,step.projection,`${path}[${index}]`)));
      if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,materialize(evaluate(item,step.projection,`${path}.${JSON.stringify(key)}`))]));
      return error(`select :map requires array or object; use ? to guard null/absent at ${path}`);
    }
    if(step.kind!=='op')return error('Invalid select operation');
    if(step.name==='len')return Array.isArray(value)?value.length:object(value)?Object.keys(value).length:null;
    return object(value)?Object.keys(value).sort():null;
  };
  return input=>materialize(evaluate(input,parsed,'$'));
}
