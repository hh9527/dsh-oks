/** Encode fixture data as DARI source without changing JSON-looking string contents. */
export function dariLiteral(value:unknown):string {
    const json=JSON.stringify(value);
    if(json===undefined)throw new Error('A DARI fixture value must be JSON-serializable');
    return json.replace(/"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b/g,token=>
        ({true:'True',false:'False',null:'None'} as Record<string,string>)[token]??token);
}
