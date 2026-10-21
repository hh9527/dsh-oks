/** 静态投影的统一写法；标识符用点，其余字符串用 JSON 下标。 */
export function projectionCode(binding:string,path:readonly (string|number)[]):string {
  return binding+path.map(key=>typeof key==='number'?`[${key}]`:
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)?`.${key}`:`[${JSON.stringify(key)}]`).join('');
}
