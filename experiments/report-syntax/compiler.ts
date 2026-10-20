/** Feasibility spike only. Not registered as a production draft format. */
import { SourceFile } from './source.ts';
import type { SourceFragment } from './source.ts';
import { DraftSyntaxError, parsePipeline } from '../../packages/dsh-oks/src/draft/pipeline.ts';
import type { Position, Span } from '../../packages/dsh-oks/src/draft/pipeline.ts';
import { checkAuthorXhtml } from '../../packages/dsh-oks/src/report/xhtml.ts';

type Reference = { source:string; binding:string; path:(string|number)[]; span:Span };
type Attribute = { kind:'text'; value:string; span:Span } | ({kind:'reference'} & Reference);
type Element = { name:string; attrs:Map<string,Attribute>; children:(Element|string)[]; span:Span };
export type Compilation = {
  markdown:string;
  fragments:SourceFragment[];
  references:Reference[];
  generated:{name:string;operator:'render_figure'|'render_html';bindings:string[];span:Span}[];
};

export function compileReport(source:string,file='draft.dari'):Compilation {
  if(Buffer.byteLength(source)>256*1024)throw new Error('Report exceeds 256 KiB');
  const original=new SourceFile(file,source);
  const pos=(offset:number):Position=>original.position(offset);
  const fragments:SourceFragment[]=[];
  let at=0;
  const span=(start:number,end=at):Span=>({start:pos(start),end:pos(end)});
  const fail=(message:string,start=at,end=Math.min(source.length,at+1)):never=>{throw new DraftSyntaxError(message,span(start,end));};
  const whitespace=()=>{while(/\s/.test(source[at]??'')&&at<source.length)at++;};
  const expect=(text:string)=>{if(!source.startsWith(text,at))fail(`Expected ${text}`);at+=text.length;};
  const name=()=>{const match=/^[A-Za-z_$][A-Za-z0-9_$:-]*/.exec(source.slice(at));if(!match)return fail('Expected a name');at+=match[0].length;return match[0];};
  const references:Reference[]=[];
  const reference=():Attribute=>{
    const start=at;expect('{');whitespace();const begin=at;
    const binding=name();if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding))fail('Expected a pipeline binding',begin);
    const path:(string|number)[]=[];
    while(true){
      whitespace();
      if(source[at]==='.'){
        at++;whitespace();const key=name();if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))fail('Expected a static field');path.push(key);
      } else if(source[at]==='['){
        at++;whitespace();
        if(source[at]==='"'){
          const keyStart=at;at++;while(at<source.length&&source[at]!=='"'){if(source[at]==='\\')at++;at++;}
          if(source[at]!=='"')fail('Unterminated projection string',keyStart);
          at++;let key:string;try{key=JSON.parse(source.slice(keyStart,at));}catch{return fail('Invalid projection string',keyStart);}
          path.push(key);
        }else{
          const index=/^(0|[1-9][0-9]*)/.exec(source.slice(at));
          if(!index||!Number.isSafeInteger(Number(index[0])))fail('Projection requires a static string or safe array index');
          path.push(Number(index![0]));at+=index![0].length;
        }
        whitespace();expect(']');
      }else break;
    }
    const end=at;
    if(source[at]!=='}')fail('Template expressions allow only a pipeline binding and static projections',start);
    at++;const ref={source:source.slice(begin,end).trim(),binding,path,span:span(start)};references.push(ref);
    return {kind:'reference',...ref};
  };
  const open=()=>{
    const start=at;expect('<');const tag=name();const attrs=new Map<string,Attribute>();
    while(true){
      whitespace();if(source.startsWith('/>',at)){at+=2;return {tag,attrs,start,selfClosing:true};}
      if(source[at]==='>'){at++;return {tag,attrs,start,selfClosing:false};}
      if(at>=source.length)fail('Unterminated opening tag',start);
      const keyStart=at;const key=name();if(attrs.has(key))fail(`Duplicate attribute ${key}`,keyStart);
      whitespace();expect('=');whitespace();
      if(source[at]==='{')attrs.set(key,reference());
      else{
        expect('"');const begin=at;while(at<source.length&&source[at]!=='"'&&source[at]!=='\n')at++;
        if(source[at]!=='"')fail('Unterminated attribute string',begin-1);const value=source.slice(begin,at);at++;
        attrs.set(key,{kind:'text',value,span:span(keyStart)});
      }
    }
  };
  const close=(tag:string)=>{expect('</');const start=at;const actual=name();if(actual!==tag)fail(`Expected </${tag}>, got </${actual}>`,start);whitespace();expect('>');};
  const literal=(attrs:Map<string,Attribute>,key:string,required=true)=>{
    const attr=attrs.get(key);if(!attr){if(required)fail(`Missing ${key} attribute`);return undefined;}
    if(attr.kind!=='text')fail(`${key} must be a static string`,attr.span.start.offset,attr.span.end.offset);
    return (attr as Extract<Attribute,{kind:'text'}>).value;
  };
  const only=(attrs:Map<string,Attribute>,allowed:string[])=>{for(const [key,attr]of attrs)if(!allowed.includes(key))fail(`Unknown attribute ${key}`,attr.span.start.offset,attr.span.end.offset);};
  const raw=(tag:string)=>{
    const begin=at;const end=new RegExp(`^[ \\t]*</${tag}>[ \\t]*(?=\\r?$)`,'gm');end.lastIndex=at;const match=end.exec(source);
    if(!match)fail(`Missing standalone </${tag}>`,begin);
    at=match!.index;const body=source.slice(begin,at);whitespace();close(tag);return {body,begin};
  };
  const element=(depth=0):Element=>{
    if(depth>128)fail('Template nesting exceeds 128');const header=open();
    if(header.tag==='script'||header.tag==='pipeline'||header.tag==='template'||header.tag==='report')fail(`Unexpected template element ${header.tag}`,header.start);
    const children:(Element|string)[]=[];
    if(!header.selfClosing){
      while(!source.startsWith('</',at)){
        if(at>=source.length)fail(`Missing </${header.tag}>`,header.start);
        if(source.startsWith('<!--',at)){
          const begin=at;const end=source.indexOf('-->',at+4);if(end<0)fail('Unterminated comment',begin);at=end+3;children.push(source.slice(begin,at));
        }else if(source[at]==='<')children.push(element(depth+1));
        else{const begin=at;while(at<source.length&&source[at]!=='<'){if(source[at]==='{')fail('Place pipeline references in Value/Figure attributes');at++;}children.push(source.slice(begin,at));}
      }
      close(header.tag);
    }
    return {name:header.tag,attrs:header.attrs,children,span:span(header.start)};
  };
  whitespace();const root=open();if(root.tag!=='report'||root.selfClosing)fail('Expected a report root',root.start);only(root.attrs,['title']);const title=literal(root.attrs,'title',false)??'Report';
  let pipeline:{body:string;begin:number}|undefined;
  const assets=new Map<string,string>();const templates:{name:string;element:Element;span:Span}[]=[];
  while(true){
    whitespace();if(source.startsWith('</',at))break;const header=open();
    if(header.selfClosing)fail('Report blocks require a body',header.start);
    if(header.tag==='pipeline'){
      only(header.attrs,[]);if(pipeline)fail('Duplicate pipeline',header.start);pipeline=raw('pipeline');
    }else if(header.tag==='script'){
      only(header.attrs,['type','name']);if(literal(header.attrs,'type')!=='jq')fail('Only jq script assets are supported',header.start);
      const asset=literal(header.attrs,'name')!;if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.jq$/.test(asset))fail('Expected a single-file .jq asset name',header.start);
      if(assets.has(asset))fail(`Duplicate asset ${asset}`,header.start);const fragment=raw('script');assets.set(asset,fragment.body);fragments.push(original.fragment(asset,'jq',fragment.begin,fragment.begin+fragment.body.length));
    }else if(header.tag==='template'){
      only(header.attrs,['name']);const templateName=literal(header.attrs,'name')!;
      if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(templateName))fail('Template name must be a binding identifier',header.start);
      if(templates.some(t=>t.name===templateName))fail(`Duplicate template ${templateName}`,header.start);
      whitespace();const tree=element();if(tree.name!=='article')fail('Template root must be article',tree.span.start.offset);
      whitespace();close('template');templates.push({name:templateName,element:tree,span:span(header.start)});
    }else fail(`Unknown report block ${header.tag}`,header.start);
  }
  close('report');whitespace();if(at!==source.length)fail('Unexpected content after report');
  if(!pipeline)fail('Missing pipeline',root.start);
  const pipelineFragment=original.fragment('pipeline','pipeline',pipeline!.begin,pipeline!.begin+pipeline!.body.length);
  fragments.push(pipelineFragment);
  const nodes=parsePipeline(pipelineFragment.text,original.position(pipelineFragment.start));
  const names=new Set(nodes.flatMap(n=>n.statement.kind==='binding'?[n.statement.name]:[]));
  for(const ref of references)if(!names.has(ref.binding))fail(`Undefined pipeline binding ${ref.binding}`,ref.span.start.offset,ref.span.end.offset);
  for(const node of nodes)for(const asset of node.assets)if(asset.language!=='jq'||!assets.has(asset.name))fail(`Missing jq asset ${asset.name}`,asset.span.start.offset,asset.span.end.offset);
  const generated:Compilation['generated']=[];const extra:string[]=[];const xhtmlAssets=new Map<string,string>();let next=0;
  const fresh=()=>{let candidate:string;do{candidate=`__report_${++next}`;}while(names.has(candidate));names.add(candidate);return candidate;};
  const requiredRef=(el:Element,key:string)=>{
    const attr=el.attrs.get(key);if(attr?.kind!=='reference')fail(`${el.name}.${key} requires a pipeline reference`,el.span.start.offset,el.span.end.offset);
    return attr as Extract<Attribute,{kind:'reference'}>;
  };
  for(const template of templates){
    if(names.has(template.name))fail(`Template name conflicts with binding ${template.name}`,template.span.start.offset);
    names.add(template.name);const inputs:string[]=[];const templateBindings=new Set<string>();
    const render=(el:Element):string=>{
      if(el.name==='Value'){
        only(el.attrs,['data']);if(el.children.length)fail('Value must be empty',el.span.start.offset);
        const ref=requiredRef(el,'data');const alias=fresh();inputs.push(`${alias}:${ref.source}`);templateBindings.add(ref.binding);
        return `<span data-oks-ref="${alias}" />`;
      }
      if(el.name==='Figure'){
        only(el.attrs,['spec','data','nodes']);const spec=requiredRef(el,'spec'),data=requiredRef(el,'data');const nodeRef=el.attrs.has('nodes')?requiredRef(el,'nodes'):undefined;
        const alias=fresh();extra.push(`let ${alias}=render_figure(${spec.source},{data:${data.source}${nodeRef?`,nodes:${nodeRef.source}`:''}});`);
        generated.push({name:alias,operator:'render_figure',bindings:[...new Set([spec.binding,data.binding,...nodeRef?[nodeRef.binding]:[]])],span:el.span});
        inputs.push(alias);templateBindings.add(alias);
        return `<figure data-oks-ref="${alias}">${el.children.map(child=>typeof child==='string'?child:render(child)).join('')}</figure>`;
      }
      const attrs=[...el.attrs].map(([key,attr])=>{
        if(attr.kind!=='text')fail('Ordinary XHTML attributes must be static strings',attr.span.start.offset,attr.span.end.offset);
        return ` ${key}="${(attr as Extract<Attribute,{kind:'text'}>).value}"`;
      }).join('');
      if(['br','hr'].includes(el.name)){if(el.children.length)fail(`${el.name} must be empty`,el.span.start.offset);return `<${el.name}${attrs} />`;}
      return `<${el.name}${attrs}>${el.children.map(child=>typeof child==='string'?child:render(child)).join('')}</${el.name}>`;
    };
    const xhtml=render(template.element);const checked=checkAuthorXhtml(xhtml);
    if(checked.errors.length)fail(checked.errors.map(e=>e.message).join('; '),template.span.start.offset,template.span.end.offset);
    const asset=`${template.name.replaceAll('$','_')}.xhtml`;if(xhtmlAssets.has(asset))fail('Generated asset name conflict',template.span.start.offset);
    xhtmlAssets.set(asset,xhtml);extra.push(`let ${template.name}=render_html(${JSON.stringify(asset)},{${inputs.join(',')}});`);
    generated.push({name:template.name,operator:'render_html',bindings:[...templateBindings],span:template.span});
  }
  // Markdown is a temporary adapter to the unchanged runtime, not the proposed IR.
  const fence=(body:string)=>'`'.repeat(Math.max(3,...[...body.matchAll(/`+/g)].map(m=>m[0].length+1)));
  const pipelineSource=pipeline!.body+'\n'+extra.join('\n');const marker=fence(pipelineSource);
  const parts=[`# ${title}`,'## pipeline',marker+'js',pipelineSource,marker,'## assets'];
  for(const [asset,body]of [...assets,...xhtmlAssets]){const f=fence(body);parts.push(`${f}${asset.endsWith('.jq')?'jq':'xhtml'} name="${asset}"`,body,f);}
  return {markdown:parts.join('\n'),fragments,references,generated};
}
