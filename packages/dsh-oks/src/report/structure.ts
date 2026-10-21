/** DARI 编译后的报告结构。渲染器只遍历结构，不解析生成的 HTML。 */
import type { Span } from '../draft/pipeline.ts';
export const AUTHOR_ELEMENTS:readonly string[]=['article','section','h1','h2','h3','p','div','span','figure','figcaption','table','caption','thead','tbody','tfoot','tr','th','td','ul','ol','li','blockquote','pre','code','strong','em','a','br','hr'];
export const AUTHOR_ATTRIBUTES:readonly string[]=['id','class','title','lang','data-oks-ref','data-oks-pick','data-oks-shrink','data-oks-lit','href','colspan','rowspan','scope'];
export type ReportNode={kind:'text';text:string;span:Span}|{kind:'comment';text:string;span:Span}|ReportElement;
export type ReportElement={kind:'element';name:string;attrs:Record<string,string>;children:ReportNode[];span:Span};
export type ReportError={code:string;message:string;line:number;column:number;element:string|null};
export type ReportProgram={root:ReportElement;errors:ReportError[];refs:string[];picks:{ref:string;pick:string|undefined}[];figures:string[];headings:{level:number;text:string;id:string|null}[];NumWithoutSource:{line:number;column:number;snippet:string}[];LitNotOnSpan:{line:number;column:number;tag:string}[]};
export const escapeText=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export const escapeAttribute=(s:string)=>escapeText(s).replace(/"/g,'&quot;');
export const attributeText=(attrs:Record<string,string>)=>Object.entries(attrs).map(([k,v])=>` ${k}="${escapeAttribute(v)}"`).join('');
export const element=(name:string,attrs:Record<string,string>,children:ReportNode[],span:Span):ReportElement=>({kind:'element',name,attrs,children,span});
export const textOf=(node:ReportNode):string=>node.kind==='comment'?'':node.kind==='text'?node.text:node.children.map(textOf).join('');
export function serializeReport(node:ReportNode):string {
  if(node.kind==='text')return escapeText(node.text);
  if(node.kind==='comment')return `<!--${node.text}-->`;
  const open=`<${node.name}${attributeText(node.attrs)}`;
  return ['br','hr'].includes(node.name)?open+' />':open+'>'+node.children.map(serializeReport).join('')+`</${node.name}>`;
}
/** 作者文本只支持五个基础实体与数值实体，错误直接定位到原始 DARI。 */
export function decodeAuthorText(raw:string,fail:(message:string,offset:number)=>never):string {
  for(let i=0;i<raw.length;i++){
    const cp=raw.codePointAt(i)!;
    if(cp===0||cp>=0xd800&&cp<=0xdfff||cp<32&&![9,10,13].includes(cp)||cp===0xfffe||cp===0xffff)fail('Invalid character in report text',i);
    if(cp>0xffff)i++;
  }
  return raw.replace(/&(?:[^;\s<&]*;)?/g,(entity,offset)=>{
    const basic:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(Object.hasOwn(basic,entity))return basic[entity];
    const numeric=/^&#(x[0-9a-fA-F]+|[0-9]+);$/.exec(entity);
    if(numeric){const n=numeric[1].startsWith('x')?parseInt(numeric[1].slice(1),16):Number(numeric[1]);
      if(Number.isSafeInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)&&!(n<32&&![9,10,13].includes(n))&&n!==0xfffe&&n!==0xffff)return String.fromCodePoint(n);}
    return fail(`Invalid entity ${entity}; use &amp;, &lt;, &gt;, &quot;, &apos; or a numeric entity`,offset);
  });
}
export function compileReport(root:ReportElement):ReportProgram {
  const out:ReportProgram={root,errors:[],refs:[],picks:[],figures:[],headings:[],NumWithoutSource:[],LitNotOnSpan:[]};
  const ids=new Set<string>();
  const error=(node:ReportNode,code:string,message:string)=>out.errors.push({code,message,line:node.span.start.line,column:node.span.start.column,element:node.kind==='element'?node.name:null});
  const walk=(node:ReportNode,quiet=false)=>{
    if(node.kind==='comment')return;
    if(node.kind==='text'){
      if(!quiet)for(const token of node.text.matchAll(/[A-Za-z0-9_.\-/]+/g))if(!/[A-Za-z]/.test(token[0])&&/\d/.test(token[0])&&node.text[(token.index??0)-1]!=='#')out.NumWithoutSource.push({...node.span.start,snippet:token[0]});
      return;
    }
    const {name,attrs}=node;
    if(!AUTHOR_ELEMENTS.includes(name))error(node,'author-element',`Unsupported report element <${name}>`);
    for(const [key,value]of Object.entries(attrs)){
      if(!AUTHOR_ATTRIBUTES.includes(key))error(node,'author-attribute',`Unsupported report attribute ${key}`);
      if(key==='id'){if(!value||ids.has(value))error(node,'author-id',`Report id must be nonempty and unique: ${value}`);ids.add(value);}
      if(key==='href'&&!/^(?:#|https?:\/\/)/.test(value))error(node,'author-link',`Unsupported link ${value}; use # or http/https`);
      if((key==='colspan'||key==='rowspan')&&!/^[1-9]\d*$/.test(value))error(node,'author-number',`${key} requires a positive integer`);
      if(key==='scope'&&!['col','row','colgroup','rowgroup'].includes(value))error(node,'author-scope',`Invalid scope ${value}`);
      if(key==='data-oks-ref'){if(!value)error(node,'author-ref','data-oks-ref must be nonempty');else out.refs.push(value);}
      if(key==='data-oks-pick'){
        if(name!=='span')error(node,'author-pick-element','data-oks-pick is only allowed on span');
        if(!attrs['data-oks-ref'])error(node,'author-pick-ref','data-oks-pick requires data-oks-ref');
        if(!/^\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/.test(value)&&value!=='.')error(node,'author-pick',`Invalid pick ${value}; 建议路径：${value.replace(/\[(\d+)\]/g,'.$1')}`);
      }
    }
    if(name==='figure'){if(!attrs['data-oks-ref'])error(node,'author-figure-ref','figure requires a compiled reference');else out.figures.push(attrs['data-oks-ref']);}
    if(name==='span'&&attrs['data-oks-ref'])out.picks.push({ref:attrs['data-oks-ref'],pick:attrs['data-oks-pick']});
    if(['h1','h2','h3'].includes(name))out.headings.push({level:Number(name[1]),text:textOf(node).trim(),id:attrs.id??null});
    if(Object.hasOwn(attrs,'data-oks-lit')&&name!=='span')out.LitNotOnSpan.push({...node.span.start,tag:name});
    for(const child of node.children)walk(child,quiet||['pre','code'].includes(name)||name==='span'&&(Object.hasOwn(attrs,'data-oks-ref')||Object.hasOwn(attrs,'data-oks-lit')));
  };
  if(root.name!=='article')error(root,'author-root','Report root must be article');
  walk(root);return out;
}
