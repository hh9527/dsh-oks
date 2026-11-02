import type {ReportNode,ReportProgram} from './structure.ts';

const inline=new Set(['span','strong','em','a','code','br']);
const blocks=new Set(['article','section','div','h1','h2','h3','p','ul','ol','li','blockquote','pre','hr','figure','figcaption']);
/** Markdown has a deliberately bounded node/attribute vocabulary. */
export function validateMarkdownAnswer(program:ReportProgram):void {
    const error=(node:ReportNode,message:string)=>program.errors.push({code:'answer-markdown',message,line:node.span.start.line,column:node.span.start.column,element:node.kind==='element'?node.name:null});
    const walk=(node:ReportNode,parent?:string)=>{
        if(node.kind!=='element')return;
        if(!inline.has(node.name)&&!blocks.has(node.name))error(node,`Unsupported Answer node ${node.name}`);
        for(const key of Object.keys(node.attrs))if(!['data-oks-ref','data-oks-lit'].includes(key)&&!(node.name==='a'&&key==='href'))error(node,`Answer cannot represent attribute ${key} on ${node.name}`);
        if(parent&&(inline.has(parent)||/^h[123]$/.test(parent)||parent==='p')&&blocks.has(node.name))error(node,`Answer block ${node.name} cannot be nested in ${parent}`);
        if(parent&&['ul','ol'].includes(parent)&&node.name!=='li')error(node,'Answer lists require li children');
        if(node.name==='a'&&!node.attrs.href)error(node,'Answer link requires href');
        if(node.name==='li'&&!['ul','ol'].includes(parent??''))error(node,'Answer li requires a list parent');
        if(node.name==='code'&&node.children.some(n=>n.kind==='element'&&n.name!=='span'))error(node,'Answer code accepts text and scalar values');
        if(node.name==='pre'&&node.children.some(n=>n.kind==='element'&&!['code','span'].includes(n.name)))error(node,'Answer pre accepts text, code and scalar values');
        for(const child of node.children){
            if(['ul','ol'].includes(node.name)&&child.kind==='text'&&child.text.trim())error(child,'Answer lists require li children');
            walk(child,node.name);
        }
    };
    walk(program.root);
}

/** Escape both authored text and dynamic values; only nodes introduce Markdown syntax. */
export const escapeMarkdown=(text:string)=>text.replace(/\\/g,'\\\\').replace(/([`*_{}\[\]()<>#+.!|~\-])/g,'\\$1');
export function renderMarkdownAnswer(program:ReportProgram,values:Record<string,unknown>,figures:Record<string,string>):string {
    const scalar=(ref:string)=>{
        if(!Object.hasOwn(values,ref))throw new Error('Missing Answer value '+ref);
        const value=values[ref];
        if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('Answer value must be scalar');
        return value===null?'—':String(value);
    };
    const raw=(n:ReportNode):string=>n.kind==='comment'?'':n.kind==='text'?n.text:n.attrs['data-oks-ref']?scalar(n.attrs['data-oks-ref']):n.children.map(raw).join('');
    const render=(n:ReportNode):string=>{
        if(n.kind==='comment')return '';
        if(n.kind==='text')return escapeMarkdown(n.text).replace(/\r?\n/g,' ');
        const ref=n.attrs['data-oks-ref'];
        if(n.name==='span'&&ref)return escapeMarkdown(scalar(ref)).replace(/\r?\n/g,' ');
        const children=()=>n.children.map(render).join('');
        switch(n.name){
            case 'article':case 'section':case 'div':return children();
            case 'span':return children();
            case 'h1':case 'h2':case 'h3':return '#'.repeat(Number(n.name[1]))+' '+children()+'\n\n';
            case 'p':return children()+'\n\n';
            case 'strong':return '**'+children()+'**';
            case 'em':return '*'+children()+'*';
            case 'br':return '  \n';
            case 'hr':return '\n---\n\n';
            case 'a':{
                if(ref){if(!Object.hasOwn(figures,ref))throw new Error('Missing Answer report '+ref);return figures[ref];}
                if(!n.attrs.href)throw new Error('Answer link requires href');
                const target=n.attrs.href.replace(/[\s<>\\()]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0'));
                return '['+children()+']('+target+')';
            }
            case 'code':{
                const text=raw(n).replace(/\r?\n/g,' '),fence='`'.repeat(Math.max(1,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1)));
                const padding=/^`|`$|^ | $/.test(text)?' ':'';
                return fence+padding+text+padding+fence;
            }
            case 'pre':{
                const text=raw(n),fence='`'.repeat(Math.max(3,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1)));
                return fence+'\n'+text+'\n'+fence+'\n\n';
            }
            case 'blockquote':return children().trimEnd().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
            case 'ul':case 'ol':return n.children.filter(c=>c.kind==='element').map((c,i)=>{
                const marker=n.name==='ul'?'- ':`${i+1}. `;
                return marker+render(c).trimEnd().split('\n').map((line,j)=>j?' '.repeat(marker.length)+line:line).join('\n');
            }).join('\n')+'\n\n';
            case 'li':return n.children.map(c=>c.kind==='element'&&['ul','ol','blockquote','pre','figure','hr'].includes(c.name)?'\n'+render(c):render(c)).join('');
            case 'figure':{
                if(!ref||!Object.hasOwn(figures,ref))throw new Error('Missing Answer figure '+ref);
                return figures[ref]+'\n\n'+children();
            }
            case 'figcaption':return children()+'\n\n';
            default:throw new Error('Unsupported Answer node '+n.name);
        }
    };
    return render(program.root).trim();
}
