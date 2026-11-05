/** DARI 编译后的报告结构。渲染器只遍历结构，不解析生成的 HTML。 */
import type { Span } from '../draft/pipeline.ts';
const COMPILED_ELEMENTS:readonly string[]=['article','section','h1','h2','h3','p','div','span','figure','figcaption','table','caption','thead','tbody','tfoot','tr','th','td','ul','ol','li','blockquote','pre','code','strong','em','a','br','hr'];
/** Source nodes are distinct from generated figure/caption containers. */
export const AUTHOR_ELEMENTS:readonly string[]=['Report','section','h1','h2','h3','p','div','span','ul','ol','li','blockquote','pre','code','strong','em','a','br','hr','Value','Lit','UseFigure','FigureRef'];
export const AUTHOR_ATTRIBUTES:readonly string[]=['id','class','title','lang','data-oks-ref','data-oks-shrink','data-oks-lit','href','colspan','rowspan','scope'];
/** Public authoring hides the literal marker behind Lit. */
export const PUBLIC_AUTHOR_ATTRIBUTES:readonly string[]=['id','class','title','lang','data-oks-shrink','href'];
export type ReportNode={kind:'text';text:string;span:Span}|{kind:'comment';text:string;span:Span}|ReportElement;
export type ReportElement={kind:'element';name:string;attrs:Record<string,string>;children:ReportNode[];span:Span;figureKind?:'chart'|'table';figureReference?:string};
export type ReportError={code:string;message:string;line:number;column:number;element:string|null};
export type ReportProgram={root:ReportElement;errors:ReportError[];refs:string[];valueRefs:string[];figures:string[];headings:{level:number;text:string;id:string|null}[];NumWithoutSource:{line:number;column:number;snippet:string}[]};
export const escapeText=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export const escapeAttribute=(s:string)=>escapeText(s).replace(/"/g,'&quot;');
export const attributeText=(attrs:Record<string,string>)=>Object.entries(attrs).map(([k,v])=>` ${k}="${escapeAttribute(v)}"`).join('');
export const element=(name:string,attrs:Record<string,string>,children:ReportNode[],span:Span):ReportElement=>({kind:'element',name,attrs,children,span});
export const textOf=(node:ReportNode):string=>node.kind==='comment'?'':node.kind==='text'?node.text:node.children.map(textOf).join('');
export function serializeReport(node:ReportNode):string {
  if(node.kind==='text')return escapeText(node.text);
  if(node.kind==='comment')return `<!--${node.text}-->`;
  if(node.name==='#if')return `<!-- if ${escapeText(node.attrs['data-oks-ref'])} -->`+node.children.map(serializeReport).join('<!-- else -->')+'<!-- endif -->';
  if(node.name==='#branch')return node.children.map(serializeReport).join('');
  const open=(node.figureReference?`<!-- FigureRef ${node.figureReference} -->`:'')+`<${node.name}${attributeText(node.attrs)}`;
  return ['br','hr'].includes(node.name)?open+' />':open+'>'+node.children.map(serializeReport).join('')+`</${node.name}>`;
}
/** Validate literal source text; escaping belongs to output rendering. */
export function validateAuthorText(raw:string,fail:(message:string,offset:number)=>never):string {
  for(let i=0;i<raw.length;i++){
    const cp=raw.codePointAt(i)!;
    if(cp===0||cp>=0xd800&&cp<=0xdfff||cp<32&&![9,10,13].includes(cp)||cp===0xfffe||cp===0xffff)fail('Invalid character in report text',i);
    if(cp>0xffff)i++;
  }
  return raw;
}
export function compileReport(root:ReportElement):ReportProgram {
  const out:ReportProgram={root,errors:[],refs:[],valueRefs:[],figures:[],headings:[],NumWithoutSource:[]};
  const ids=new Set<string>();
  const error=(node:ReportNode,code:string,message:string)=>out.errors.push({code,message,line:node.span.start.line,column:node.span.start.column,element:node.kind==='element'?node.name:null});
  const walk=(node:ReportNode,quiet=false)=>{
    if(node.kind==='comment')return;
    if(node.kind==='text'){
      if(!quiet)for(const token of node.text.matchAll(/[A-Za-z0-9_.\-/]+/g))if(!/[A-Za-z]/.test(token[0])&&/\d/.test(token[0])&&node.text[(token.index??0)-1]!=='#')out.NumWithoutSource.push({...node.span.start,snippet:token[0]});
      return;
    }
    const {name,attrs}=node;
    if(name==='#if'){
      out.refs.push(attrs['data-oks-ref']);
      for(const branch of node.children)walk(branch,quiet);
      return;
    }
    if(name==='#branch'){for(const child of node.children)walk(child,quiet);return;}
    if(!COMPILED_ELEMENTS.includes(name))error(node,'author-element',`Unsupported report element <${name}>`);
    for(const [key,value]of Object.entries(attrs)){
      if(!AUTHOR_ATTRIBUTES.includes(key))error(node,'author-attribute',`Unsupported report attribute ${key}`);
      if(key==='id'){if(!value||ids.has(value))error(node,'author-id',`Report id must be nonempty and unique: ${value}`);ids.add(value);}
      if(key==='href'&&!/^(?:#|https?:\/\/)/.test(value))error(node,'author-link',`Unsupported link ${value}; use # or http/https`);
      if((key==='colspan'||key==='rowspan')&&!/^[1-9]\d*$/.test(value))error(node,'author-number',`${key} requires a positive integer`);
      if(key==='scope'&&!['col','row','colgroup','rowgroup'].includes(value))error(node,'author-scope',`Invalid scope ${value}`);
      if(key==='data-oks-ref'){if(!value)error(node,'author-ref','data-oks-ref must be nonempty');else out.refs.push(value);}

    }
    if(name==='figure'){if(!attrs['data-oks-ref'])error(node,'author-figure-ref','figure requires a compiled reference');else out.figures.push(attrs['data-oks-ref']);}
    if(name==='span'&&attrs['data-oks-ref'])out.valueRefs.push(attrs['data-oks-ref']);
    if(['h1','h2','h3'].includes(name))out.headings.push({level:Number(name[1]),text:textOf(node).trim(),id:attrs.id??null});
    for(const child of node.children)walk(child,quiet||['pre','code'].includes(name)||name==='span'&&(Object.hasOwn(attrs,'data-oks-ref')||Object.hasOwn(attrs,'data-oks-lit')));
  };
  if(root.name!=='article')error(root,'author-root','Report root must be article');
  walk(root);return out;
}

/** Both branches are checked; only the selected siblings enter presentation and publication. */
export function selectReport(program:ReportProgram,values:Record<string,unknown>):ReportProgram {
  const select=(node:ReportNode):ReportNode[]=>{
    if(node.kind!=='element')return [node];
    if(node.name==='#if'){
      const ref=node.attrs['data-oks-ref'],value=values[ref];
      if(typeof value!=='boolean')throw new Error('if condition requires Bool: '+ref);
      return select(node.children[value?0:1]);
    }
    const children=node.children.flatMap(select);
    return node.name==='#branch'?children:[{...node,children}];
  };
  const root=select(program.root)[0] as ReportElement;
  const labels=new Map<string,string>();let charts=0,tables=0;
  const visit=(node:ReportNode,fn:(node:ReportElement)=>void)=>{if(node.kind==='element'){fn(node);node.children.forEach(child=>visit(child,fn));}};
  visit(root,node=>{
    if(node.name==='figure'&&node.figureKind){const ref=node.attrs['data-oks-ref'];if(!labels.has(ref))labels.set(ref,node.figureKind==='table'?'表 '+(++tables):'图 '+(++charts));}
  });
  visit(root,node=>{
    if(node.figureReference){
      const label=labels.get(node.figureReference);
      if(!label)throw new Error('FigureRef requires a UseFigure in the selected branches');
      node.children=[{kind:'text',text:label,span:node.span}];
    }
  });
  return compileReport(root);
}
/** Check transparent branches with the surrounding parent's structural rules. */
export const allBranchChildren=(node:ReportElement):ReportNode[]=>node.children.flatMap(child=>
  child.kind==='element'&&['#if','#branch'].includes(child.name)?allBranchChildren(child):[child]);
