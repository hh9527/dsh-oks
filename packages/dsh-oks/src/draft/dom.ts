import {DraftSyntaxError,type PipelineNode,type Span,type Expr,type SourceDiagnostic} from './pipeline.ts';
import {parseTypedPipeline,type N} from './typed-syntax.ts';
import {SourceFile} from './source.ts';
import {componentKind} from './components.ts';
import type {Element,Attribute,Reference} from './document.ts';

/** DOM-like source parser. It constructs the same located IR as the data compiler. */
export function parseDomDraft(source:string,file:string){
  const original=new SourceFile(file,source);
  let at=0,sequence=0,elements=0;
  const definitions=new Map<string,N>();
  const declarations=new Map<string,'data'|'figure'|'report'>();
  const nodes:PipelineNode[]=[];
  const figures=new Map<string,Element>();
  const templates:{name:string;title:string;element:Element;span:Span}[]=[];
  const references:Reference[]=[];
  const childSpans=new WeakMap<Element,Map<number,Span>>();
  let title='Report';
  const location=(start:number,end=at)=>original.span(start,end);
  const fail=(message:string,start=at,end=Math.min(source.length,start+1),details:Partial<SourceDiagnostic>={}):never=>{
    const span=location(start,end);throw new DraftSyntaxError(message,span,[{...details,file,stage:'syntax',message,span}]);
  };
  if(Buffer.byteLength(source)>256*1024)fail('Report exceeds 256 KiB',0);
  const whitespace=()=>{
    while(at<source.length){
      if(/\s/.test(source[at])){at++;continue;}
      if(source.startsWith('//',at)){while(at<source.length&&source[at]!=='\n')at++;continue;}
      if(source.startsWith('/*',at)){const end=source.indexOf('*/',at+2);if(end<0)fail('Unterminated block comment');at=end+2;continue;}
      break;
    }
  };
  const eat=(text:string)=>{whitespace();if(!source.startsWith(text,at))fail('Expected '+JSON.stringify(text),at,Math.min(source.length,at+1),{expected:text,found:source[at]??'end of input'});at+=text.length;};
  const name=(tag=false)=>{
    whitespace();const match=(tag?/^[A-Za-z_$][A-Za-z0-9_$:-]*/:/^[A-Za-z_$][A-Za-z0-9_$]*/).exec(source.slice(at));
    if(!match)return fail('Expected '+(tag?'tag or attribute':'binding')+' name');at+=match[0].length;return match[0];
  };
  const string=()=>{
    const start=at++;while(at<source.length&&source[at]!=='"'){if(source[at]==='\\')at++;at++;}
    if(at>=source.length)fail('Unterminated JSON string',start);at++;
    try{return JSON.parse(source.slice(start,at)) as string;}catch{return fail('Invalid JSON string',start,at);}
  };
  /** Delimiters inside strings, comments, object literals and lambdas do not end an expression. */
  const expression=(stops:Set<string>)=>{
    whitespace();const start=at,stack:{symbol:string;offset:number}[]=[];
    while(at<source.length){
      const ch=source[at];
      if(ch==='"'){string();continue;}
      if(source.startsWith('//',at)){while(at<source.length&&source[at]!=='\n')at++;continue;}
      if(source.startsWith('/*',at)){const end=source.indexOf('*/',at+2);if(end<0)fail('Unterminated block comment');at=end+2;continue;}
      if(!stack.length&&stops.has(ch))break;
      if('([{'.includes(ch)){stack.push({symbol:ch,offset:at});if(stack.length>128)fail('Expression nesting exceeds 128');}
      else if(')]}'.includes(ch)){const open=stack.pop();if(open?.symbol!=={')':'(',']':'[','}':'{'}[ch]){
        const expected=open?{'(':')','[':']','{':'}'}[open.symbol]:undefined;
        fail('Unmatched '+ch+(expected?'; expected '+JSON.stringify(expected):'; no opening delimiter'),at,at+1,{...(expected?{expected}:{}),found:ch,...(open?{related:[{message:'Opening '+open.symbol+' requires '+expected,span:location(open.offset,open.offset+1)}]}:{})});
      }}
      at++;
    }
    if(stack.length){
      const open=stack.at(-1)!,expected={'(':')','[':']','{':'}'}[open.symbol]!;
      fail('Unterminated expression; expected '+JSON.stringify(expected),at,at,{expected,found:'end of input',related:[{message:'Opening '+open.symbol+' requires '+expected,span:location(open.offset,open.offset+1)}]});
    }
    const end=at;if(!source.slice(start,end).trim())fail('Expected an expression',start);
    return {start,end,text:source.slice(start,end)};
  };
  const compile=(part:{start:number;end:number;text:string},binding:string,internal=false)=>{
    const result=parseTypedPipeline(part.text,original.position(part.start),{definitions,expressionName:binding})[0];
    if(internal)result.internal=true;
    nodes.push(result);return result;
  };
  const attribute=(tag:string,key:string,part:{start:number;end:number;text:string}):Attribute=>{
    const span=location(part.start,part.end);
    if((tag==='Figure'||tag==='FigureRef')&&key==='ref'){
      const symbol=part.text.trim();if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol))fail('Figure.ref requires a figure binding',part.start,part.end);
      if(declarations.get(symbol)!=='figure')fail('Undefined or forward figure binding '+symbol,part.start,part.end);
      return {kind:'text',value:symbol,span};
    }
    if(componentKind(tag)!==undefined||tag==='Value'){
      const binding='__dom'+sequence++;compile(part,binding,true);
      const ast=definitions.get(binding)!;
      // Keep direct projections canonical in provenance and reuse existing bindings.
      const path:(string|number)[]=[],optional:number[]=[];let base=ast;
      const chain:N[]=[];while(base.k==='get'){chain.unshift(base);base=base.input!;}
      if(base.k==='ref'){
        nodes.pop();definitions.delete(binding);
        for(const item of chain){if(item.optional)optional.push(path.length);path.push(item.key!);}
        const ref:Reference={source:part.text.trim(),binding:base.name!,path,optional,span};references.push(ref);
        return {kind:'reference',...ref};
      }
      // Inline records and computations are private immutable data nodes.
      const ref:Reference={source:part.text.trim(),code:part.text.trim(),binding,path:[],span};references.push(ref);
      return {kind:'reference',...ref};
    }
    const temporary='__attribute'+sequence++;
    parseTypedPipeline(part.text,original.position(part.start),{definitions,expressionName:temporary});
    const ast=definitions.get(temporary)!;definitions.delete(temporary);
    if(ast.k!=='lit')fail('Document attributes require static strings or booleans',part.start,part.end);
    let value:unknown=ast.v;
    if(typeof value==='boolean'&&['data-oks-lit','data-oks-shrink'].includes(key)){
      if(!value)fail(key+' must be true when present',part.start,part.end);value='';
    }
    if(typeof value!=='string')fail('Document attributes require static strings',part.start,part.end);
    return {kind:'text',value:value as string,span};
  };
  const element=(depth=0):Element=>{
    whitespace();const start=at;
    if(depth>128)fail('Template nesting exceeds 128');if(++elements>2048)fail('Report exceeds 2048 template elements');
    const tag=name(true),attrs=new Map<string,Attribute>();
    whitespace();if(source[at]==='('){
      at++;whitespace();while(source[at]!==')'){
        const begin=at,key=name(true);if(attrs.has(key))fail('Duplicate attribute '+key,begin);
        eat('=');const part=expression(new Set([',',')']));attrs.set(key,attribute(tag,key,part));
        whitespace();if(source[at]!==',')break;at++;whitespace();
      }eat(')');
    }
    const children:(Element|string)[]=[],spans=new Map<number,Span>();let selfClosing=true;
    whitespace();if(source[at]==='{')fail('Node children use [ ... ] with commas; records use { ... }');
    if(source[at]==='['){
      selfClosing=false;at++;whitespace();
      while(source[at]!==']'){
        if(at>=source.length)fail('Missing ] for '+tag,start,at);
        const begin=at;
        if(source[at]==='"'){children.push(string());spans.set(children.length-1,location(begin));}
        else children.push(element(depth+1));
        whitespace();if(source[at]===','){at++;whitespace();}else if(source[at]!==']')fail('Expected , between child nodes');
      }at++;
    }
    if(!children.length&&(['Value','Figure','FigureRef','br','hr'].includes(tag)||componentKind(tag)!==undefined))selfClosing=true;
    const result={name:tag,attrs,children,selfClosing,span:location(start)};
    childSpans.set(result,spans);return result;
  };
  const reserved=new Set(['data','figure','report','export','true','false','null','query','context','select','select_one','table','map','union_all','time_windows','is_some','is_none','map_opt','round','case_when','concat','to_datetime_utc','to_epoch_millis','asc','desc','count','sum','avg','min','max']);
  whitespace();while(at<source.length){
    if(declarations.size>=512)fail('DARI is limited to 512 declarations');
    const start=at,kind=name();
    if(!['data','figure','report'].includes(kind))fail('Expected data, figure or report declaration',start,at);
    whitespace();const bindingStart=at,binding=name();
    if(binding.startsWith('__')||reserved.has(binding))fail('Reserved binding name '+binding,bindingStart,at);
    if(declarations.has(binding))fail('Duplicate binding '+binding,bindingStart,at);
    eat(':=');
    if(kind==='data'){
      const part=expression(new Set([';']));const node=compile(part,binding);eat(';');node.statement.span=location(start);
    }else{
      const tree=element();eat(';');
      if(kind==='figure'){
        if(componentKind(tree.name)===undefined)fail('figure requires a chart component or Table',tree.span.start.offset,tree.span.end.offset);
        if(tree.children.length)fail('Chart components have attributes and no children',tree.span.start.offset,tree.span.end.offset);
        tree.selfClosing=true;
        if(tree.attrs.has('name'))fail('Figure name is supplied by its binding',tree.span.start.offset);
        tree.attrs.set('name',{kind:'text',value:binding,span:location(bindingStart,bindingStart+binding.length)});figures.set(binding,tree);
      }else{
        if(tree.name!=='Report')fail('report requires Report',tree.span.start.offset,tree.span.end.offset);
        const reportTitle=tree.attrs.get('title');
        const heading=tree.children.find(c=>typeof c!=='string'&&c.name==='h1');
        const ownTitle=reportTitle?.kind==='text'?reportTitle.value:heading&&typeof heading!=='string'?heading.children.filter(c=>typeof c==='string').join('')||binding:binding;
        if(!templates.length)title=ownTitle;
        if(reportTitle)tree.attrs.delete('title');
        // Report itself is the article root; no extra wrapper is needed in source.
        tree.name='article';tree.selfClosing=false;templates.push({name:binding,title:ownTitle,element:tree,span:location(start)});
      }
    }
    declarations.set(binding,kind as 'data'|'figure'|'report');whitespace();
  }
  if(!declarations.size)fail('Expected data, figure or report declaration',0,Math.min(1,source.length));
  let queries=0;
  const visit=(e:Expr)=>{if(e.kind==='call'){if(e.operator==='query')queries++;e.args.forEach(visit);}else if(e.kind==='array')e.values.forEach(visit);else if(e.kind==='object')e.entries.forEach(x=>visit(x.value));else if(e.kind==='project')visit(e.input);};
  nodes.forEach(n=>visit(n.statement.value));if(queries>128)fail('Pipeline exceeds 128 queries',0);
  return {nodes,figures,templates,references,childSpans,title};
}
