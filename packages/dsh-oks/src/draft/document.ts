import {validateMarkdownAnswer} from '../report/markdown-answer.ts';
import {parseDomDraft} from './dom.ts';
import { projectionCode } from './projection.ts';
import type { DariAuthoring } from './archive.ts';
import { componentKind } from './components.ts';
/** Located DARI data, figure and report compiler. */
import { SourceFile } from './source.ts';
import { DraftSyntaxError } from './pipeline.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import type { Expr, PipelineNode, Span, SourceDiagnostic } from './pipeline.ts';
import { compileReport,element as reportElement,serializeReport,validateAuthorText,PUBLIC_AUTHOR_ATTRIBUTES,type ReportNode,type ReportProgram } from '../report/structure.ts';

export type Reference = { source:string; binding:string; path:(string|number)[]; optional?:number[]; code?:string; span:Span };
export type Attribute = { kind:'text'; value:string; span:Span } | ({kind:'reference'} & Reference);
export type Element = { empty:boolean;name:string; attrs:Map<string,Attribute>; children:(Element|string)[]; span:Span };
export type DraftAsset = { title?:string;format?:'markdown';program?:ReportProgram;figurePlacement?:'before-caption';name:string;source:string;span:Span;references?:Record<string,{kind:'value'|'figure'|'report'|'condition';span:Span;code?:string}> };
export type DraftDocument = {declarations?:Map<string,'data'|'figure'|'report'|'answer'>;authoring?:DariAuthoring;title?:string;nodes:PipelineNode[];assets:Map<string,DraftAsset>;pipeline:Span;answers:string[];file:string;diagnostics?:SourceDiagnostic[]};

export function parseDraft(source:string,file='draft.dari'):DraftDocument {
  const document=parseDraftForValidation(source,file);
  if(document.diagnostics?.length){const first=document.diagnostics[0];throw new DraftSyntaxError(first.message,first.span,document.diagnostics);}
  return document;
}

/** Collect independent section diagnostics; an invalid container still prevents reliable section recovery. */
export function parseDraftForValidation(source:string,file='draft.dari'):DraftDocument {

  const prepared=parseDomDraft(source,file);
  const diagnostics=new DiagnosticCollector();
  let stage='container',unit:string|undefined;
  const collect=(run:()=>void)=>{try{run();}catch(error){if(!(error instanceof DraftSyntaxError))throw error;diagnostics.reportAll((error.diagnostics.length?error.diagnostics:[{file,stage,message:error.message,span:error.span}]).map(d=>({...d,stage:d.stage==='container'?stage:d.stage,...(unit?{asset:unit}:{})})));}};
  const original=new SourceFile(file,source);
  const span=(start:number,end=start):Span=>original.span(start,end);
  const fail=(message:string,start=0,end=Math.min(source.length,start+1)):never=>{const location=span(start,end);throw new DraftSyntaxError(message,location,[{file,stage,message,span:location}]);};
  const literal=(attrs:Map<string,Attribute>,key:string,required=true)=>{
    const attr=attrs.get(key);if(!attr){if(required)fail(`Missing ${key} attribute`);return undefined;}
    if(attr.kind!=='text')fail(`${key} must be a static string`,attr.span.start.offset,attr.span.end.offset);
    return (attr as Extract<Attribute,{kind:'text'}>).value;
  };
  const only=(attrs:Map<string,Attribute>,allowed:string[])=>{for(const [key,attr]of attrs)if(!allowed.includes(key))fail(`Unknown attribute ${key}`,attr.span.start.offset,attr.span.end.offset);};
  const {childSpans,references,title,figures,templates,nodes}=prepared;
  const assets=new Map<string,DraftAsset>();
  const names=new Set(nodes.flatMap(n=>n.statement.kind==='binding'?[n.statement.name]:[]));
  for(const ref of references)if(!names.has(ref.binding))collect(()=>fail(`Undefined pipeline binding ${ref.binding}`,ref.span.start.offset,ref.span.end.offset));
  const refExpr=(ref:Reference):Expr=>{
    if(ref.optional?.length||(ref.path.length&&nodes.some(n=>n.typed))){
      let n:import('./typed-syntax.ts').N={k:'ref',name:ref.binding,s:ref.span};
      ref.path.forEach((key,i)=>{n={k:'get',input:n,key,optional:ref.optional?.includes(i)??false,s:ref.span};});
      return {kind:'call',operator:'typed_value',args:[{kind:'literal',value:JSON.stringify(n),span:ref.span},{kind:'object',entries:[{key:ref.binding,value:{kind:'ref',name:ref.binding,span:ref.span}}],span:ref.span}],span:ref.span};
    }
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
  const answers:string[]=[];
  for(const node of nodes)if(node.statement.kind==='binding'&&node.statement.value.kind==='call'&&node.statement.value.operator==='render_report')answers.push(node.statement.name);
  const authoring:DariAuthoring={source,title,
    reports:Object.fromEntries(templates.map(template=>[template.name,source.slice(template.element.span.start.offset,template.element.span.end.offset)])),
    figures:Object.fromEntries([...figures].map(([name,chart])=>[name,{binding:name,code:source.slice(chart.span.start.offset,chart.span.end.offset)}])),
  };
  stage='figure';
  for(const [key,chart]of figures){
    unit=key;collect(()=>{
    const kind=componentKind(chart.name)!;
    only(chart.attrs,kind==='graph'?['name','spec','data','nodes']:['name','spec','data']);
    if(!chart.empty)fail(`${chart.name} must be empty`,chart.span.start.offset);
    const spec=requiredRef(chart,'spec'),data=requiredRef(chart,'data');
    const nodeRef=chart.attrs.has('nodes')?requiredRef(chart,'nodes'):undefined;
    const location=chart.span;const name=key;
    const value:Expr={kind:'call',operator:'render_figure',figureKind:kind,args:[refExpr(spec),objectExpr([{key:'data',value:refExpr(data)},...nodeRef?[{key:'nodes',value:refExpr(nodeRef)}]:[]],location)],span:location};
    nodes.push({statement:{kind:'binding',name,value,span:location,motivation:''},bindings:[...new Set([spec.binding,data.binding,...nodeRef?[nodeRef.binding]:[]])]});
    });
  }
  stage='template';
  for(const template of templates){
    unit=template.name;collect(()=>{
    names.add(template.name);answers.push(template.name);
    const inputs:{key:string;value:Expr}[]=[];const bindings=new Set<string>();
    const refs:NonNullable<DraftAsset['references']>={};
    const figureAliases=new Map<string,string>();const figureNumbers=new Map<string,string>();
    let chartNumber=0,tableNumber=0;
    const scan=(el:Element):void=>{
      if(el.name==='UseFigure'){
        only(el.attrs,['ref','caption']);if(!el.empty)fail('UseFigure must be empty',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;const chart=figures.get(key);
        if(!chart)fail(`Unknown figure ${key}`,el.span.start.offset);
        if(!figureNumbers.has(key))figureNumbers.set(key,componentKind(chart!.name)==='table'?`表 ${++tableNumber}`:`图 ${++chartNumber}`);
      }
      for(const child of el.children)if(typeof child!=='string')scan(child);
    };scan(template.element);
    const figureInput=(key:string,location:Span)=>{
      if(!figures.has(key))fail(`Unknown figure ${key}`,location.start.offset);
      let alias=figureAliases.get(key);
      if(!alias){alias=`named_figure_${figureAliases.size+1}`;figureAliases.set(key,alias);const name=key;
        inputs.push({key:alias,value:{kind:'ref',name,span:location}});bindings.add(name);refs[alias]={kind:'figure',span:location,code:name};}
      return alias;
    };
    const decoded=(value:string,location:Span)=>validateAuthorText(value,(message,offset)=>fail(message,Math.min(location.start.offset+offset,source.length)));
    const attrsOf=(el:Element)=>Object.fromEntries([...el.attrs].map(([key,attr])=>{
      if(!PUBLIC_AUTHOR_ATTRIBUTES.includes(key))fail(`Unsupported report attribute ${key}`,attr.span.start.offset,attr.span.end.offset);
      if(attr.kind!=='text')fail('Ordinary report attributes must be static strings',attr.span.start.offset,attr.span.end.offset);
      return [key,decoded((attr as Extract<Attribute,{kind:'text'}>).value,attr.span)];
    }));
    const textNode=(raw:string,location:Span):ReportNode=>{
      return {kind:'text',text:decoded(raw,location),span:location};
    };
    const childrenOf=(el:Element):ReportNode[]=>el.children.map((child,i)=>typeof child==='string'?textNode(child,childSpans.get(el)?.get(i)??el.span):lower(child));
    const lower=(el:Element):ReportNode=>{
      if(el.name==='#if'){
        const ref=requiredRef(el,'condition'),alias='condition_'+(inputs.length+1);
        inputs.push({key:alias,value:refExpr(ref)});bindings.add(ref.binding);
        refs[alias]={kind:'condition',span:ref.span,code:ref.source};
        return reportElement('#if',{'data-oks-ref':alias},childrenOf(el),el.span);
      }
      if(el.name==='#branch')return reportElement('#branch',{},childrenOf(el),el.span);
      if(el.name==='UseReport'){
        if(template.format!=='markdown')fail('UseReport is only supported inside Answer',el.span.start.offset);
        only(el.attrs,['ref']);if(!el.empty)fail('UseReport must be empty',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;
        const target=templates.find(t=>t.name===key&&t.format!=='markdown');
        if(!target)fail('Unknown report '+key,el.span.start.offset);
        const alias=`report_${inputs.length+1}`;
        inputs.push({key:alias,value:{kind:'ref',name:key,span:el.span}});bindings.add(key);
        refs[alias]={kind:'report',code:key,span:el.span};
        return reportElement('a',{'data-oks-ref':alias,href:'#'},[],el.span);
      }
      if(el.name==='FigureRef'){
        only(el.attrs,['ref']);if(!el.empty)fail('FigureRef must be empty',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;const number=figureNumbers.get(key);
        if(!number)fail(`FigureRef ${key} requires a UseFigure in this Report`,el.span.start.offset);
        return {...reportElement('span',{'data-oks-lit':''},[{kind:'text',text:number!,span:el.span}],el.span),figureReference:figureInput(key,el.span)};
      }
      if(el.name==='Lit'){
        only(el.attrs,[]);
        if(el.children.some(child=>typeof child!=='string'))fail('Lit accepts only literal text children',el.span.start.offset,el.span.end.offset);
        return reportElement('span',{'data-oks-lit':''},childrenOf(el),el.span);
      }
      if(el.name==='Value'){
        const attr='data';
        only(el.attrs,[attr]);if(el.children.some(child=>typeof child!=='string'||child.trim()!==''))fail('Value must be empty',el.span.start.offset);
        const ref=requiredRef(el,attr);const alias=`value_${inputs.length+1}`;
        inputs.push({key:alias,value:refExpr(ref)});bindings.add(ref.binding);refs[alias]={kind:'value',span:ref.span,code:ref.code??ref.path.reduce<string>((code,key,i)=>code+(ref.optional?.includes(i)?'?':'')+projectionCode('',[key]),ref.binding)};
        return reportElement('span',{'data-oks-ref':alias},[],el.span);
      }
      if(el.name==='UseFigure'){
        only(el.attrs,['ref','caption']);
        if(!el.empty)fail('UseFigure must be empty',el.span.start.offset);
        const key=literal(el.attrs,'ref')!;const alias=figureInput(key,el.span);
        const captionAttr=el.attrs.get('caption');
        const caption=literal(el.attrs,'caption',false);
        const captionNode=reportElement('figcaption',{},caption===undefined?[]:[textNode(caption,captionAttr!.span)],el.span);
        return {...reportElement('figure',{'data-oks-ref':alias},[captionNode],el.span),figureKind:componentKind(figures.get(key)!.name)==='table'?'table':'chart'};
      }
      if(['Figure','figure','figurecaption','figcaption','table','caption','thead','tbody','tfoot','tr','td','th'].includes(el.name))
        fail(`Unsupported report element ${el.name}; use UseFigure(ref = name, caption = "...") with a declared chart or Table`,el.span.start.offset,el.span.end.offset);
      if(componentKind(el.name)!==undefined)fail(`${el.name} must be declared with a figure binding and referenced with UseFigure`,el.span.start.offset,el.span.end.offset);
      if(/^[A-Z]/.test(el.name))fail(`Unknown DARI component ${el.name}`,el.span.start.offset,el.span.end.offset);
      if(['br','hr'].includes(el.name)&&!el.empty)fail(`${el.name} must be empty`,el.span.start.offset);
      return reportElement(el.name,attrsOf(el),childrenOf(el),el.span);
    };
    const tree=lower(template.element);
    if(tree.kind!=='element')fail('Report requires an article',template.span.start.offset);
    const program=compileReport(tree as import('../report/structure.ts').ReportElement);
    const markdown='format' in template&&template.format==='markdown';
    if(markdown)validateMarkdownAnswer(program);
    if(program.errors.length){
      const errors=program.errors.map(error=>{const offset=original.lines[error.line-1]+error.column-1;return {file,stage:'template',message:error.message,span:original.span(offset,offset)};});
      throw new DraftSyntaxError(errors[0].message,errors[0].span,errors);
    }
    const name=`@report/${template.name}`;
    assets.set(name,{...(markdown?{format:'markdown' as const}:{}),...(template.title?{title:template.title}:{}),program,figurePlacement:'before-caption',name,source:serializeReport(tree),span:template.span,references:refs});
    const value:Expr={kind:'call',operator:'render_report',args:[literalExpr(name,template.span),objectExpr(inputs,template.span)],span:template.span};
    nodes.push({statement:{kind:'binding',name:template.name,value,span:template.span,motivation:''},bindings:[...bindings]});
    });
  }
  unit=undefined;stage='container';
  if(nodes.length>1024||assets.size>128)fail('DARI exceeds node or asset budget',0);
  const findings=diagnostics.list();
  return {declarations:prepared.declarations,authoring,title,nodes,assets,pipeline:original.span(0,source.length),answers,file,...(findings.length?{diagnostics:findings}:{})};
}
