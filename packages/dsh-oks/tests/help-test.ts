import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {helpFiles,helpEntries,manualPrompt,PRELOADED_MANUALS} from '../src/help-files.ts';
import {modelContracts} from '../src/contracts.ts';
import {presentationManuals,presentationOverview} from '../src/presentation-guide.ts';
import {COMPONENT_KINDS} from '../src/draft/components.ts';
import {presentationFacts} from '../src/presentation-facts.ts';
import {installWorkMethods} from '../src/work-methods.ts';

assert.deepEqual(PRELOADED_MANUALS,['oks://help/workflow.md','oks://help/dari.md','oks://help/rules.md']);
const sections:any[]=[];
installWorkMethods({systemPrompt:{section(s:any){sections.push(s);}},get(){throw Error('Must not load model');}} as any);
assert.equal(sections.length,1,'One stable prefix, no duplicate presentation section');
assert.equal(sections[0].text,manualPrompt);
assert.equal(sections[0].interpolate,false);
let previous=-1;
for(const uri of PRELOADED_MANUALS){
  const at=manualPrompt.indexOf('<!-- '+uri+' -->');assert(at>previous);previous=at;
  assert(manualPrompt.includes('<!-- '+uri+' -->\n'+helpFiles[uri].trimEnd()));
  assert.equal(helpEntries().find(e=>e.name===uri)?.bytes,Buffer.byteLength(helpFiles[uri]));
}
assert(manualPrompt.endsWith(helpFiles['oks://help/rules.md'].trimEnd()),'Rules remain the final content');
assert.match(manualPrompt,/已完整载入，无需 oks_read/);
assert.equal(helpFiles['oks://help/workflow.md'],readFileSync(new URL('../src/help/workflow.md',import.meta.url),'utf8'));
assert.equal(helpFiles['oks://help/rules.md'],readFileSync(new URL('../src/help/rules.md',import.meta.url),'utf8'));
assert.match(helpFiles['oks://help/dari.md'],/ontology-intent-v1/);
assert(!manualPrompt.includes('{{intentContract}}')&&!manualPrompt.includes('{{figureIndex}}'));
assert(helpFiles['oks://help/dari.md'].includes(presentationOverview().join('\n')));
const manuals=presentationManuals();
for(const [component,kind] of Object.entries(COMPONENT_KINDS)){
  const uri='oks://help/figure-'+kind+'.md',required=presentationFacts.roots.render_figure.kinds[kind].facts.required;
  const row=presentationOverview().find(line=>line.startsWith('- '+component+'：'))!;assert(row);
  assert(row.includes('必填 spec：'+(required.length?required.join(', '):'无')));
  assert(row.includes(uri));assert(!manualPrompt.includes(manuals[uri]),'Figure-specific manual stays on demand');
}
for(const name of ['knowledge','draft','pipeline','query','time','figures','report']){
  assert(!Object.hasOwn(helpFiles,'oks://help/'+name+'.md'));
  assert(!Object.hasOwn(manuals,'oks://help/'+name+'.md'));
}
for(const [uri,text] of Object.entries({...helpFiles,...manuals})){
  for(const target of text.match(new RegExp("oks://help/[A-Za-z_-]+[.]md","g"))??[])assert(Object.hasOwn({...helpFiles,...manuals},target),uri+' -> '+target);
}
assert(manualPrompt.length<19000,'Keep the fixed manuals near the 17k-character target');
console.log('Preloaded manuals: same-source order, final rules, no figure payloads, generated keys, exact rereads and valid links passed; '+manualPrompt.length+' characters / '+Buffer.byteLength(manualPrompt)+' UTF-8 bytes');

// Run every DARI example through the actual checker; fragments receive their named inputs.
const {checkDesign}=await import('../src/draft/design.ts');
const {createDraftBackend}=await import('../src/draft/backend.ts');
const backend=createDraftBackend({entry:{modelHash:'manual-test',settings:{domain:'test',queryMaxRows:500},runner:{async send(_method:any,{intents}:any){return {ok:{accepted:true,queries:[{sql:'SELECT 1 AS n LIMIT ?',bindings:[intents[0].limit],limit_slot:0,columns:[{name:'n',type:'Int',nullable:false}]}]}};}}} as any,file:'manual.dari',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'}),knowledge:{executorFor(){throw Error('Manual checks must not read business data');}} as any});
const fixtures=`data base = table([{server_id:"a",cpu:7},{server_id:"b",cpu:None}],{kind:"example"});
data current = table([{server_id:"a",cpu:9},{server_id:"b",cpu:None}],{kind:"example"});
data samples = table([{tenant_id:"a",cpu:7},{tenant_id:"b",cpu:None}],{kind:"example"});
data grouped = table([{name:"a",count:3}],{kind:"example"});
data summary = select_one({from:{g:grouped},group_by:r=>({}),fields:(g,rows)=>({total:sum(rows.g.count)})});`;
for(const [i,match] of [...helpFiles['oks://help/dari.md'].matchAll(/```dari\n([\s\S]*?)```/g)].entries()){
  const code=match[1],fragment=!code.includes('query(');
  const checked=await checkDesign((fragment?fixtures+'\n':'')+code,'manual-'+i+'.dari',backend);
  assert(checked.ok,JSON.stringify({example:i,diagnostics:checked.diagnostics}));
}
console.log('All DARI manual examples pass semantic/type checking without business reads');
