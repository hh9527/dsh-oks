import type {Row} from './shared.ts';

/** CSV preserves column order; empty strings are quoted, missing values are empty cells. */
function csv(rows:Row[]):string {
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  const cell=(value:unknown):string=>{
    if(value===null||value===undefined)return '';
    const text=typeof value==='object'?JSON.stringify(value):String(value);
    return text===''||/[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
  };
  return [columns.map(cell).join(','),...rows.map(row=>columns.map(key=>cell(row[key])).join(','))].join('\n');
}

/** Non-rendering chart inputs for reading Answer figures; no provenance or source code. */
export function embedFigureCsv(svg:string,data:{rows:Row[];nodeRows?:Row[];spec?:unknown}):string {
  const block=(id:string,rows:Row[])=>`<metadata id="${id}" data-format="csv">\n${csv(rows).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}\n</metadata>`;
  const spec=data.spec===undefined?'':`<metadata id="dari-spec" data-format="json">${JSON.stringify(data.spec).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</metadata>`;
  const metadata=spec+block('dari-data',data.rows)+(data.nodeRows?block('dari-nodes',data.nodeRows):'');
  return svg.replace(/<svg[^>]*>/,open=>open+metadata);
}
