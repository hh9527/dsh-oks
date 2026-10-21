import { projectionCode } from './projection.ts';
import type { DariAuthoring } from './archive.ts';
import { componentKind } from './components.ts';
/** DARI container and template compiler. Pipeline and jq remain independent languages. */
import { SourceFile } from './source.ts';
import type { SourceFragment } from './source.ts';
import { DraftSyntaxError, parsePipeline } from './pipeline.ts';
import type { Expr, PipelineNode, Position, Span, SourceDiagnostic } from './pipeline.ts';
import { checkAuthorXhtml } from '../report/xhtml.ts';

type Reference = { source:string; binding:string; path:(string|number)[]; span:Span };
type Attribute = { kind:'text'; value:string; span:Span } | ({kind:'reference'} & Reference);
type Element = { selfClosing:boolean;name:string; attrs:Map<string,Attribute>; children:(Element|string)[]; span:Span };
export type SourceMapping = {start:number;end:number;original:Span};
export type DraftAsset = { checkedXhtml?:ReturnType<typeof checkAuthorXhtml>;figurePlacement?:'before-caption';name:string;language:'jq'|'xhtml';source:string;span:Span;body:Position;fragment?:SourceFragment;sourceMap?:SourceMapping[];references?:Record<string,{kind:'value'|'figure';span:Span;code?:string}> };
export type DraftDocument = {authoring?:DariAuthoring;title?:string;notes?:string;nodes:PipelineNode[];assets:Map<string,DraftAsset>;pipeline:Span;answers:string[];file:string;diagnostics?:SourceDiagnostic[]};

export function parseDraft(source:string,file='draft.dari'):DraftDocument {
  const document=parseDraftForValidation(source,file);
  if(document.diagnostics?.length){const first=document.diagnostics[0];throw new DraftSyntaxError(first.message,first.span,document.diagnostics);}
  return document;
}

/** Collect independent section diagnostics; an invalid container still prevents reliable section recovery. */
export function parseDraftForValidation(source:string,file='draft.dari'):DraftDocument {

  const diagnostics:SourceDiagnostic[]=[];
  let stage='container',unit:string|undefined;
  const collect=(run:()=>void)=>{try{run();}catch(error){if(!(error instanceof DraftSyntaxError))throw error;diagnostics.push(...(error.diagnostics.length?error.diagnostics:[{file,stage,message:error.message,span:error.span}]).map(d=>({...d,stage:d.stage==='container'?stage:d.stage,...(unit?{asset:unit}:{})})));}};
  const original=new SourceFile(file,source);
  const pos=(offset:number):Position=>original.position(offset);
  const fragments:SourceFragment[]=[];
  let at=0;
  const span=(start:number,end=at):Span=>({start:pos(start),end:pos(end)});
  const fail=(message:string,start=at,end=Math.min(source.length,at+1)):never=>{const location=span(start,end);throw new DraftSyntaxError(message,location,[{file,stage:'container',message,span:location}]);};
  if(Buffer.byteLength(source)>256*1024)fail('Report exceeds 256 KiB',0,1);
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
      whitespace();
      if(source[at]!=='=' && (key==='data-oks-shrink'||key==='data-oks-lit')){
        attrs.set(key,{kind:'text',value:'',span:span(keyStart)});
        continue;
      }
      expect('=');whitespace();
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
  const raw=(tag:string,language='pipeline')=>{
    const begin=at;const closing=`</${tag}>`;
    if(language==='text'){const end=source.indexOf(closing,at);if(end<0)return fail(`Missing </${tag}>`,begin);at=end;const body=source.slice(begin,at);close(tag);return {body,begin};}
    type Mode={kind:'code'|'string'|'line'|'block';depth?:number};
    const stack:Mode[]=[{kind:'code'}];let fallback=-1;
    while(at<source.length){
      const state=stack.at(-1)!;
      if(source.startsWith(closing,at)){
        if(stack.length===1){const body=source.slice(begin,at);close(tag);return {body,begin};}
        if(fallback<0&&/^[ \t]*$/.test(source.slice(source.lastIndexOf('\n',at-1)+1,at)))fallback=at;
      }
      const ch=source[at];
      if(state.kind==='line'){at++;if(ch==='\n')stack.pop();continue;}
      if(state.kind==='block'){if(source.startsWith('*/',at)){at+=2;stack.pop();}else at++;continue;}
      if(state.kind==='string'){
        if(ch==='\\'){
          if(language==='jq'&&source[at+1]==='('){at+=2;stack.push({kind:'code',depth:1});}
          else at+=Math.min(2,source.length-at);
        }else{at++;if(ch==='"')stack.pop();}
        continue;
      }
      if(ch==='"'){at++;stack.push({kind:'string'});continue;}
      if(language==='jq'&&ch==='#'){at++;stack.push({kind:'line'});continue;}
      if(language==='pipeline'&&source.startsWith('//',at)){at+=2;stack.push({kind:'line'});continue;}
      if(language==='pipeline'&&source.startsWith('/*',at)){at+=2;stack.push({kind:'block'});continue;}
      if(state.depth!==undefined){if(ch==='(')state.depth++;if(ch===')'&&--state.depth===0){at++;stack.pop();continue;}}
      at++;
    }
    // Let the independent compiler diagnose an unclosed string/comment before a standalone delimiter.
    if(fallback>=0){at=fallback;const body=source.slice(begin,at);close(tag);return {body,begin};}
    return fail(`Missing </${tag}>`,begin);
  };
  let elementCount=0;
  const element=(depth=0):Element=>{
    if(depth>128)fail('Template nesting exceeds 128');const header=open();
    if(++elementCount>2048)fail('Report exceeds 2048 template elements',header.start);
    if(['Asset','Pipeline','Template','Report','Figures','Dari','Notes'].includes(header.tag))fail(`Unexpected template element ${header.tag}`,header.start);
    const children:(Element|string)[]=[];
    if(!header.selfClosing){
      while(!source.startsWith('</',at)){
        if(at>=source.length)fail(`Missing </${header.tag}>`,header.start);
        if(source.startsWith('<!--',at)){
          const begin=at;const end=source.indexOf('-->',at+4);if(end<0)fail('Unterminated comment',begin);at=end+3;children.push(source.slice(begin,at));
        }else if(source[at]==='<')children.push(element(depth+1));
        else{const begin=at;while(at<source.length&&source[at]!=='<'){if(source[at]==='{')fail('Place pipeline references in Value/chart component attributes');at++;}children.push(source.slice(begin,at));}
      }
      close(header.tag);
    }
    return {selfClosing:header.selfClosing,name:header.tag,attrs:header.attrs,children,span:span(header.start)};
  };
  whitespace();const root=open();if(root.tag!=='Dari'||root.selfClosing)fail('Expected a Dari root',root.start);only(root.attrs,['title']);const title=literal(root.attrs,'title',false)??'Report';
  let pipeline:{body:string;begin:number}|undefined;let notes:string|undefined;
  const figures=new Map<string,Element>();let hasFigures=false;
  const assets=new Map<string,DraftAsset>();const templates:{legacy?:boolean;name:string;element:Element;span:Span}[]=[];
  while(true){
    whitespace();if(source.startsWith('</',at))break;const header=open();
    if(header.selfClosing)fail('Report blocks require a body',header.start);
    if(header.tag==='Pipeline'){
      stage='pipeline';unit=undefined;collect(()=>{only(header.attrs,[]);if(pipeline)fail('Duplicate pipeline',header.start);});
      const body=raw('Pipeline');if(!pipeline)pipeline=body;stage='container';
    }else if(header.tag==='Notes'){
      only(header.attrs,[]);if(notes!==undefined)fail('Duplicate notes',header.start);notes=raw('Notes','text').body;
    }else if(header.tag==='Asset'){
      only(header.attrs,['language','name']);const language=literal(header.attrs,'language');if(language!=='jq'&&language!=='xhtml')fail('Asset language must be jq or xhtml',header.start);
      const asset=literal(header.attrs,'name')!;if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(asset)||!asset.endsWith(`.${language}`))fail('Asset name must be a single filename matching its language',header.start);
      if(assets.has(asset))fail(`Duplicate asset ${asset}`,header.start);const fragment=raw('Asset',language);const located=original.fragment(asset,language as 'jq'|'xhtml',fragment.begin,fragment.begin+fragment.body.length);assets.set(asset,{name:asset,language:language as 'jq'|'xhtml',source:fragment.body,span:span(header.start),body:pos(fragment.begin),fragment:located});if(located)fragments.push(located);
    }else if(header.tag==='Figures'){
      stage='figure';unit='Figures';collect(()=>{only(header.attrs,[]);if(hasFigures)fail('Duplicate Figures',header.start);});hasFigures=true;
      while(true){
        whitespace();if(source.startsWith('</',at))break;
        const chart=element();unit=chart.attrs.get('name')?.kind==='text'?`figures.${(chart.attrs.get('name') as Extract<Attribute,{kind:'text'}>).value}`:`figure:${chart.span.start.line}:${chart.span.start.column}`;
        collect(()=>{
          const kind=componentKind(chart.name);
          if(!kind)fail('Figures requires chart components or Table',chart.span.start.offset);
          const key=literal(chart.attrs,'name')!;
          if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))fail('Figure name must be an identifier',chart.span.start.offset);
          if(figures.has(key))fail(`Duplicate figure ${key}`,chart.span.start.offset);
          figures.set(key,chart);
        });
      }
      close('Figures');stage='container';unit=undefined;
    }else if(header.tag==='Report'||header.tag==='Template'){
      whitespace();const tree=element();whitespace();close(header.tag);
      stage='template';unit=header.attrs.get('name')?.kind==='text'?`reports.${(header.attrs.get('name') as Extract<Attribute,{kind:'text'}>).value}`:`report:${pos(header.start).line}`;
      collect(()=>{
        only(header.attrs,['name']);const templateName=literal(header.attrs,'name')!;
        if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(templateName))fail(`${header.tag} name must be an identifier`,header.start);
        if(templates.some(t=>t.name===templateName))fail(`Duplicate ${header.tag} ${templateName}`,header.start);
        if(tree.name!=='article')fail(`${header.tag} root must be article`,tree.span.start.offset);
        templates.push({legacy:header.tag==='Template',name:templateName,element:tree,span:span(header.start)});
      });stage='container';unit=undefined;
    }else fail(`Unknown report block ${header.tag}`,header.start);
  }
  close('Dari');whitespace();if(at!==source.length)fail('Unexpected content after report');
  stage='pipeline';
  const missingPipeline=!pipeline;
  if(missingPipeline){collect(()=>fail('Missing pipeline',root.start));pipeline={body:'',begin:source.length};}
  const pipelineFragment=original.fragment('pipeline','pipeline',pipeline!.begin,pipeline!.begin+pipeline!.body.length);
  fragments.push(pipelineFragment);
  let nodes:PipelineNode[];
  const beforePipeline=diagnostics.length;
  nodes=[];stage='pipeline';collect(()=>{nodes=parsePipeline(pipelineFragment.text,original.position(pipelineFragment.start));});
  const pipelineValid=!missingPipeline&&diagnostics.length===beforePipeline;
  const names=new Set(nodes.flatMap(n=>n.statement.kind==='binding'?[n.statement.name]:[]));
  if(pipelineValid)for(const ref of references)if(!names.has(ref.binding))collect(()=>fail(`Undefined pipeline binding ${ref.binding}`,ref.span.start.offset,ref.span.end.offset));
  for(const node of nodes)for(const asset of node.assets)if(assets.get(asset.name)?.language!==asset.language)collect(()=>fail(`Missing ${asset.language} asset ${asset.name}`,asset.span.start.offset,asset.span.end.offset));
  const refExpr=(ref:Reference):Expr=>{
    let expr:Expr={kind:'ref',name:ref.binding,span:ref.span};
    for(const key of ref.path)expr={kind:'project',input:expr,key,span:ref.span};
    return expr;
  };
  const literalExpr=(value:string,location:Span):Expr=>({kind:'literal',value,span:location});
  const objectExpr=(entries:{key:string;value:Expr}[],location:Span):Expr=>({kind:'object',entries,span:location});
  const requiredRef=(el:Element,key:string)=>{
    const attr=el.attrs.get(key);if(attr?.kind!=='reference')fail(`${el.name}.${key} requires a pipeline reference`,el.span.start.offset,el.span.end.offset);
    return attr as Extract<Attribute,{kind:'reference'}>;
  };
  let internal=0;
  const answers:string[]=[];
  for(const node of nodes)if(node.statement.kind==='binding'&&node.statement.value.kind==='call'&&node.statement.value.operator==='render_html')answers.push(node.statement.name);
  const authoring:DariAuthoring={source,title,notes:notes??'',pipeline:pipeline!.body,
    assets:Object.fromEntries([...assets].map(([name,asset])=>[name,asset.source])),
    reports:Object.fromEntries(templates.map(template=>[template.name,source.slice(template.element.span.start.offset,template.element.span.end.offset)])),
    figures:Object.fromEntries([...figures].map(([name,chart])=>[name,{binding:`figures.${name}`,code:source.slice(chart.span.start.offset,chart.span.end.offset)}])),
  };
  stage='figure';
  for(const [key,chart]of figures){
    unit=`figures.${key}`;collect(()=>{
    const kind=componentKind(chart.name)!;
    only(chart.attrs,kind==='graph'?['name','spec','data','nodes']:['name','spec','data']);
    if(!chart.selfClosing)fail(`${chart.name} must be self-closing`,chart.span.start.offset);
    const spec=requiredRef(chart,'spec'),data=requiredRef(chart,'data');
    const nodeRef=chart.attrs.has('nodes')?requiredRef(chart,'nodes'):undefined;
    const location=chart.span;const name=`figures.${key}`;
    const value:Expr={kind:'call',operator:'render_figure',figureKind:kind,args:[refExpr(spec),objectExpr([{key:'data',value:refExpr(data)},...nodeRef?[{key:'nodes',value:refExpr(nodeRef)}]:[]],location)],span:location};
    nodes.push({statement:{kind:'binding',name,value,span:location,motivation:''},bindings:[...new Set([spec.binding,data.binding,...nodeRef?[nodeRef.binding]:[]])],assets:[]});
    });
  }
  stage='template';
  for(const template of templates){
    unit=template.legacy?template.name:`reports.${template.name}`;collect(()=>{
    if(template.legacy&&names.has(template.name))fail(`Template name conflicts with binding ${template.name}`,template.span.start.offset);
    names.add(template.name);answers.push(template.legacy?template.name:`reports.${template.name}`);
    const inputs:{key:string;value:Expr}[]=[];const bindings=new Set<string>();
    const refs:NonNullable<DraftAsset['references']>={};const mappings:SourceMapping[]=[];let xhtml='';
    const emit=(text:string,original:Span)=>{mappings.push({start:xhtml.length,end:xhtml.length+text.length,original});xhtml+=text;};
    const figureAliases=new Map<string,string>();const figureNumbers=new Map<string,string>();
    let chartNumber=0,tableNumber=0;
    const scan=(el:Element):void=>{
      if(el.name==='Figure'){
        only(el.attrs,['ref']);if(!el.selfClosing)fail('Figure must be self-closing',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;const chart=figures.get(key);
        if(!chart)fail(`Unknown figure ${key}`,el.span.start.offset);
        if(!figureNumbers.has(key))figureNumbers.set(key,componentKind(chart!.name)==='table'?`表 ${++tableNumber}`:`图 ${++chartNumber}`);
      }
      for(const child of el.children)if(typeof child!=='string')scan(child);
    };scan(template.element);
    const figureInput=(key:string,location:Span)=>{
      if(!figures.has(key))fail(`Unknown figure ${key}`,location.start.offset);
      let alias=figureAliases.get(key);
      if(!alias){alias=`named_figure_${figureAliases.size+1}`;figureAliases.set(key,alias);const name=`figures.${key}`;
        inputs.push({key:alias,value:{kind:'ref',name,span:location}});bindings.add(name);refs[alias]={kind:'figure',span:location};}
      return alias;
    };
    const render=(el:Element):void=>{
      if(el.name==='FigureRef'){
        only(el.attrs,['ref']);if(!el.selfClosing)fail('FigureRef must be self-closing',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;const number=figureNumbers.get(key);
        if(!number)fail(`FigureRef ${key} requires a Figure in this Report`,el.span.start.offset);
        emit(`<span>${number}</span>`,el.span);return;
      }

      if(el.name==='Value'){
        only(el.attrs,['data']);if(el.children.some(child=>typeof child!=='string'||child.trim()!==''))fail('Value must be empty',el.span.start.offset);
        const ref=requiredRef(el,'data');const alias=`value_${inputs.length+1}`;
        inputs.push({key:alias,value:refExpr(ref)});bindings.add(ref.binding);refs[alias]={kind:'value',span:ref.span,code:projectionCode(ref.binding,ref.path)};
        emit(`<span data-oks-ref="${alias}" />`,el.span);return;
      }
      if(el.name==='figure'){
        const children=el.children.filter(child=>typeof child!=='string'||child.trim()!=='');
        if(children[0]&&typeof children[0]!=='string'&&children[0].name==='Figure'){
          const chart=children[0];only(el.attrs,['id','class','title','lang']);
          if(children.length>2||children.length===2&&(typeof children[1]==='string'||children[1].name!=='figcaption'))fail('figure contains Figure followed by optional figcaption',el.span.start.offset);
          const key=literal(chart.attrs,'ref')!;const alias=figureInput(key,chart.span);
          emit('<figure',el.span);
          for(const [key,attr]of el.attrs){if(attr.kind!=='text')fail('figure attributes must be static strings',attr.span.start.offset);emit(` ${key}="${(attr as Extract<Attribute,{kind:'text'}>).value}"`,attr.span);}
          emit(` data-oks-ref="${alias}">`,el.span);
          if(children[1]&&typeof children[1]!=='string')render(children[1]);else emit('<figcaption></figcaption>',el.span);
          emit('</figure>',el.span);return;
        }
        if(!template.legacy)fail('Report figures reference named Figures with <Figure ref="name" />',el.span.start.offset);
        const charts=children.filter((child):child is Element=>typeof child!=='string'&&componentKind(child.name)!==undefined);
        if(charts.length!==1)fail('figure requires exactly one chart component or Table',el.span.start.offset,el.span.end.offset);
        const chart=charts[0];
        if(children[0]!==chart||children.length>2||children.length===2&&(typeof children[1]==='string'||children[1].name!=='figcaption'))fail('figure contains a chart component followed by an optional figcaption',el.span.start.offset,el.span.end.offset);
        const kind=componentKind(chart.name)!;
        only(chart.attrs,kind==='graph'?['spec','data','nodes']:['spec','data']);
        if(!chart.selfClosing)fail(`${chart.name} must be self-closing`,chart.span.start.offset,chart.span.end.offset);
        const spec=requiredRef(chart,'spec'),data=requiredRef(chart,'data');const nodeRef=chart.attrs.has('nodes')?requiredRef(chart,'nodes'):undefined;
        const name=`@figure/${++internal}`;const location=chart.span;
        const entries=[{key:'data',value:refExpr(data)},...nodeRef?[{key:'nodes',value:refExpr(nodeRef)}]:[]];
        const value:Expr={kind:'call',operator:'render_figure',figureKind:kind,args:[refExpr(spec),objectExpr(entries,location)],span:location};
        const id=el.attrs.get('id');
        const figureId=id?.kind==='text'?id.value:undefined;
        const display={template:template.name,component:chart.name,...(figureId?{figureId}:{}),
          label:`${template.name}${figureId?'#'+figureId:':'+location.start.line+':'+location.start.column}（${chart.name}）`};
        nodes.push({internal:true,display,statement:{kind:'binding',name,value,span:location,motivation:''},bindings:[...new Set([spec.binding,data.binding,...nodeRef?[nodeRef.binding]:[]])],assets:[]});
        const alias=`figure_${internal}`;inputs.push({key:alias,value:{kind:'ref',name,span:location}});bindings.add(name);refs[alias]={kind:'figure',span:location};
        only(el.attrs,['id','class','title','lang']);
        emit('<figure',el.span);
        for(const [key,attr]of el.attrs){if(attr.kind!=='text')fail('figure attributes must be static strings',attr.span.start.offset,attr.span.end.offset);emit(` ${key}="${(attr as Extract<Attribute,{kind:'text'}>).value}"`,attr.span);}
        emit(` data-oks-ref="${alias}">`,location);
        if(children[1]&&typeof children[1]!=='string')render(children[1]);
        emit('</figure>',el.span);return;
      }
      if(el.name==='Figure')fail('Figure must be a direct child of figure',el.span.start.offset);
      if(componentKind(el.name)!==undefined)fail(`${el.name} must be a direct child of figure`,el.span.start.offset,el.span.end.offset);
      if(/^[A-Z]/.test(el.name))fail(`Unknown DARI component ${el.name}`,el.span.start.offset,el.span.end.offset);
      emit(`<${el.name}`,el.span);
      for(const [key,attr]of el.attrs){
        if(attr.kind!=='text')fail('Ordinary XHTML attributes must be static strings',attr.span.start.offset,attr.span.end.offset);
        emit(` ${key}="${(attr as Extract<Attribute,{kind:'text'}>).value}"`,attr.span);
      }
      if(['br','hr'].includes(el.name)){if(el.children.length)fail(`${el.name} must be empty`,el.span.start.offset);emit(' />',el.span);return;}
      emit('>',el.span);
      for(const child of el.children)if(typeof child==='string')emit(child,el.span);else render(child);
      emit(`</${el.name}>`,el.span);
    };
    render(template.element);
    const checked=checkAuthorXhtml(xhtml);
    if(checked.errors.length){
      const generated=new SourceFile('template',xhtml);const error=checked.errors[0];
      const offset=generated.scalarOffset(error.line,error.column);
      const mapped=mappings.find(m=>m.start<=offset&&offset<m.end)?.original??template.span;
      throw new DraftSyntaxError(error.message,mapped,[{file,stage:'template',message:error.message,span:mapped}]);
    }
    const name=`@template/${template.name}.xhtml`;
    assets.set(name,{checkedXhtml:checked,figurePlacement:'before-caption',name,language:'xhtml',source:xhtml,span:template.span,body:template.span.start,sourceMap:mappings,references:refs});
    const value:Expr={kind:'call',operator:'render_html',args:[literalExpr(name,template.span),objectExpr(inputs,template.span)],span:template.span};
    nodes.push({statement:{kind:'binding',name:template.legacy?template.name:`reports.${template.name}`,value,span:template.span,motivation:''},bindings:[...bindings],assets:[{name,language:'xhtml',span:template.span}]});
    });
  }
  unit=undefined;stage='container';
  if(nodes.length>1024||assets.size>128)fail('DARI exceeds node or asset budget',0);
  return {authoring,title,notes,nodes,assets,pipeline:original.span(pipelineFragment.start,pipelineFragment.end),answers,file,...(diagnostics.length?{diagnostics}:{})};
}
