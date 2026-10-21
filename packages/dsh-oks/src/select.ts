import type { JsonValue } from './project.ts';

type Step = {kind:'field';key:string} | {kind:'op';name:'len'|'keys'} | {kind:'slice';start:number;end:number} | {kind:'group';paths:Step[][]};
type Selected = {kind:'leaf';value:JsonValue} | {kind:'object';fields:Map<string,Selected>};
const object = (value:JsonValue):value is Record<string,JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value:JsonValue):JsonValue => object(value) ? Object.keys(value).sort() : null;
const len = (value:JsonValue):number|null => Array.isArray(value) ? value.length : object(value) ? Object.keys(value).length : null;
const leaf = (value:JsonValue):Selected => ({kind:'leaf',value});
const materialize = (node:Selected):JsonValue => node.kind==='leaf' ? node.value : Object.fromEntries([...node.fields].map(([key,value])=>[key,materialize(value)]));
const merge = (a:Selected,b:Selected,path:string):Selected => {
  if(a.kind!=='object'||b.kind!=='object')throw new Error(`select result conflict at ${path}`);
  for(const [key,value] of b.fields){
    const previous=a.fields.get(key);
    a.fields.set(key,previous ? merge(previous,value,path+'.'+key) : value);
  }
  return a;
};

/** Parse a bounded path language; no JavaScript evaluation or dynamic property access. */
export function createSelector(source:unknown):(input:JsonValue)=>JsonValue {
  if(typeof source!=='string'||!source.trim())throw new Error('select must be a nonempty rule string');
  if(source.length>16384)throw new Error('select exceeds 16384 characters');
  let cursor=0, count=0;
  const fail=(message:string):never=>{throw new Error(`select at ${cursor+1}: ${message}`);};
  const space=()=>{while(/\s/.test(source[cursor]??'')&&cursor<source.length)cursor++;};
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
      while(cursor<source.length&&!/[\s.,{}\[\]:']/.test(source[cursor]))cursor++;
      key=source.slice(start,cursor);if(!key)fail('expected a field or quoted key');
      if(!/^[\p{L}\p{N}_$-]+$/u.test(key))fail('use a quoted key for punctuation');
    }
    return {kind:'field',key};
  };
  const integer=()=>{space();const match=/^-?\d+/.exec(source.slice(cursor));if(!match)fail('expected an integer slice bound');cursor+=match![0].length;const value=Number(match![0]);if(!Number.isSafeInteger(value))fail('slice bound must be a safe integer');return value;};
  const paths=(depth:number,closing=false):Step[][]=>{
    if(depth>64)fail('nesting exceeds 64');
    const result:Step[][]=[];
    for(;;){
      if(++count>1024)fail('too many selection paths');
      const steps:Step[]=[];space();
      if(source[cursor]!=='['&&source[cursor]!==':')steps.push(field());
      for(;;){
        space();const ch=source[cursor];
        if(ch===':'){
          cursor++;space();const match=/^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor));
          if(!match)fail('expected an operator');cursor+=match![0].length;
          const name=match![0];if(name!=='len'&&name!=='keys')fail(`unknown operator ${name}`);
          steps.push({kind:'op',name:name as 'len'|'keys'});
        }else if(ch==='['){
          cursor++;const start=integer();space();if(source.slice(cursor,cursor+2)!=='..')fail('expected ..');cursor+=2;
          const end=integer();space();if(source[cursor++]!==']')fail('expected ]');steps.push({kind:'slice',start,end});
        }else if(ch==='.'){
          cursor++;space();
          if(source[cursor]==='{'){
            cursor++;steps.push({kind:'group',paths:paths(depth+1,true)});
          }else steps.push(field());
        }else break;
      }
      if(steps.length>256)fail('path exceeds 256 steps');
      result.push(steps);space();
      if(source[cursor]===','){cursor++;continue;}
      if(closing){if(source[cursor++]!=='}')fail('expected }');}
      else if(cursor!==source.length)fail(`unexpected ${source[cursor]}`);
      return result;
    }
  };
  const parsed=paths(0);
  const evaluate=(value:JsonValue,steps:Step[],path:string):Selected=>{
    if(!steps.length)return leaf(value);
    const [step,...rest]=steps;
    if(step.kind==='field'){
      if(!object(value)||!Object.hasOwn(value,step.key))throw new Error(`select missing field ${path}.${JSON.stringify(step.key)}`);
      let selected=value[step.key],label=step.key,index=0;
      while(index<rest.length&&(rest[index].kind==='op'||rest[index].kind==='slice')){
        const operation=rest[index++];selected=apply(selected,operation,path+'.'+step.key);
        label+=operation.kind==='op'?':'+operation.name:`[${(operation as {start:number}).start}..${(operation as {end:number}).end}]`;
      }
      return {kind:'object',fields:new Map([[label,evaluate(selected,rest.slice(index),path+'.'+label)]])};
    }
    if(step.kind==='group'){
      let combined:Selected={kind:'object',fields:new Map()};
      for(const branch of step.paths)combined=merge(combined,evaluate(value,branch,path),path);
      return rest.length?evaluate(materialize(combined),rest,path):combined;
    }
    return evaluate(apply(value,step,path),rest,path);
  };
  const apply=(value:JsonValue,step:Step,path:string):JsonValue=>{
    if(step.kind==='slice'){
      if(!Array.isArray(value)&&typeof value!=='string')throw new Error(`select slice requires array or string at ${path}`);
      return value.slice(step.start,step.end) as JsonValue;
    }
    if(step.kind!=='op')throw new Error('Invalid select operation');
    if(step.name==='len')return len(value);
    if(step.name==='keys')return keys(value);
    throw new Error('Invalid select operator');
  };
  return input=>{
    if(parsed.length===1)return materialize(evaluate(input,parsed[0],'$'));
    let output:Selected={kind:'object',fields:new Map()};
    for(const path of parsed)output=merge(output,evaluate(input,path,'$'),'$');
    return materialize(output);
  };
}
