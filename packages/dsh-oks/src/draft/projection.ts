/** 静态投影的统一写法；标识符用点，其余字符串用 JSON 下标。 */
export function projectionCode(binding:string,path:readonly (string|number)[]):string {
  return binding+path.map(key=>typeof key==='number'?`[${key}]`:
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)?`.${key}`:`[${JSON.stringify(key)}]`).join('');
}

import type { Expr } from './pipeline.ts';
export function projectionPath(e:Expr):string {
  return e.kind==='ref'?e.name:e.kind==='project'?projectionCode(projectionPath(e.input),[e.key]):'value';
}
/** Structural hints only: never include business values. */
export function projectionError(value:unknown, expr:Expr):string {
  const prefix=`Invalid projection ${projectionPath(expr)}.`;
  if(Array.isArray(value))return `${prefix} Array length ${value.length}; use numeric indexes such as [0]${value.length?`, valid range 0..${value.length-1}`:''}.`;
  if(value!==null && typeof value==='object'){
    const entries=Object.entries(value).slice(0,24);
    const shape=entries.map(([k,v])=>`${JSON.stringify(k)}${v!==null&&typeof v==='object'&&!Array.isArray(v)?': {'+Object.keys(v).slice(0,12).map(k=>JSON.stringify(k)).join(', ')+'}':''}`);
    return `${prefix} Available fields: ${shape.join(', ') || '(none)'}.${Object.keys(value).length>24?' More fields omitted.':''}`;
  }
  return `${prefix} Cannot project from ${value===null?'null':typeof value}.`;
}
