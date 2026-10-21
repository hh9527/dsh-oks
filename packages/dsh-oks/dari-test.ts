import assert from 'node:assert/strict';
import { parseDraft } from './src/draft/document.ts';
import { SourceFile } from './src/draft/source.ts';
import { DraftSyntaxError } from './src/draft/pipeline.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
import { createDraftBackend } from './src/draft/backend.ts';
import { createJaqEngine } from './src/jaq.ts';
import { presentationExample } from './src/presentation-knowledge.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';
const file='.work/中文.dari';
const engine=createJaqEngine(process.argv[2]??'lib/oks-wti.wasm');
let queries=0;
const backend=createDraftBackend({entry:{} as WorkspaceEntry,file,contextZone:()=>({kind:'resolved',timeZone:'UTC'}),jq:engine,knowledge:{executorFor(){queries++;throw new Error('Must not execute SQL');}}});
const runtime=()=>new DraftRuntime(backend,{file});
const document=(code:string,template='<article><Value data={facts.n} /></article>')=>`<Dari title="中文😀"><Notes>A " note</Notes>\n<Pipeline>\n${code}\n</Pipeline>\n<Template name="answer">${template}</Template></Dari>`;
try {
 const sample=document('facts <-data({n:3});');
 assert.equal(parseDraft(sample,file).answers[0],'answer');
 const bareMarkers=document('facts <-data({n:3});','<article><p data-oks-shrink>解释文字</p><ul data-oks-shrink class="notes"><li>说明</li></ul><p><span data-oks-lit>备注</span></p></article>');
 const explicitMarkers=bareMarkers.replaceAll('data-oks-shrink','data-oks-shrink=""').replace('data-oks-lit','data-oks-lit=""');
 assert.equal(parseDraft(bareMarkers,file).assets.get('@template/answer.xhtml')?.source,parseDraft(explicitMarkers,file).assets.get('@template/answer.xhtml')?.source);
 const markerRun=await runtime().run(bareMarkers);
 assert.equal(markerRun.outputs.get('answer')?.status,'executed',markerRun.outputs.get('answer')?.error??markerRun.error);
 for(const attr of ['data-oks-shrink data-oks-shrink=""','class','data-oks-ref','data-oks-pick']){
  assert.throws(()=>parseDraft(document('facts <-data({n:3});',`<article><p ${attr}>text</p></article>`),file),DraftSyntaxError);
 }

 const run=await runtime().run(sample);assert.equal(run.status,'complete',run.error);
 assert.equal((await runtime().run(presentationExample)).status,'complete');
 for(const [oldText,newText] of [
 ['facts.n','facts.n + 1'],['facts.n','{n:3}'],['facts.n','facts.n()'],['facts.n','unknown.n'],
 ['<Value data={facts.n} />','<Value data={facts.n}>text</Value>'],
 ['<article>','<article onclick="x">'],
 ['facts <-data({n:3});','facts <- (() => 3)();'],
 ['<Dari title="中文😀">','<Dari title="中文😀" title="x">'],
 ] as const){const result=await runtime().run(sample.replace(oldText,newText));assert.equal(result.status,'invalid',newText);assert.equal(result.diagnostics?.[0].file,file);}
 const missing=await runtime().run(sample.replace('facts.n','facts.missing'));assert.equal(missing.status,'invalid');
 const scalar=await runtime().run(sample.replace('facts.n','facts'));assert.equal(scalar.outputs.get('answer')?.status,'failed');
 assert.equal(scalar.outputs.get('answer')?.error?.includes('scalar'),true);
 const badJq=(program:string,prefix='')=>`<Dari>${prefix}\n<Pipeline>facts <-data({n:3});</Pipeline>\n<Asset language="jq" name="bad.jq">\n${program}\n</Asset>\n</Dari>`;
 for(const program of ['. as','"中文😀" | does_not_exist','[1,']){
  for(const prefix of ['', '<Notes>中文😀\r\n\r\n</Notes>']){
   const source=badJq(program,prefix).replaceAll('\n','\r\n');
   const r=await runtime().run(source);assert.equal(r.status,'invalid',r.error);
   const d=r.diagnostics?.[0];assert.equal(d?.file,file);assert.equal(d?.stage,'jq');
   const start=source.indexOf(program);assert.ok(d!.span.start.offset>=start,JSON.stringify(d));assert.ok(d!.span.start.offset<=start+program.length+2,JSON.stringify(d));
  }
 }
 for(const program of ['"</Asset>"','"before \\("</Asset>") after"','# </Asset>\n.', '"unterminated']){
  const source=badJq(program);assert.ok(parseDraft(source,file).assets.get('bad.jq')?.source.includes(program));
  if(program!=='"unterminated')assert.equal((await runtime().run(source)).status,'complete',program);
 }
 const tokenProgram='"中文😀" | does_not_exist';
 const tokenSource=badJq(tokenProgram);
 const tokenRun=await runtime().run(tokenSource);
 assert.equal(tokenRun.diagnostics![0].span.start.offset,tokenSource.indexOf('does_not_exist'));
 const renamed=await runtime().run(tokenSource.replace('bad.jq','renamed.jq'));
 assert.equal(renamed.diagnostics![0].asset,'renamed.jq');
 const gated=await runtime().run(badJq('. as').replace('facts <-data({n:3});','facts <-query({limit:1});'));
 assert.equal(gated.status,'invalid');assert.equal(queries,0);
 const pipelineSource=document('facts <-unknown;');
 const pipelineError=await runtime().run(pipelineSource);
 assert.equal(pipelineError.diagnostics![0].stage,'pipeline');assert.equal(pipelineError.diagnostics![0].span.start.offset,pipelineSource.indexOf('unknown'));
 assert.equal(parseDraft(document('facts <-data({n:3});','<article><p>&#123;literal}</p><Value data={facts.n} /></article>'),file).answers.length,1);
 const parsed=parseDraft(document('facts <-data({n:3});','<article><Value data={facts["n"]} /></article>'),file);assert.equal(parsed.nodes.length,2);
 const chinese=new SourceFile(file,'中😀\r\nabc');const fragment=chinese.fragment('x','jq',0,chinese.text.length);
 assert.equal(fragment.locate(3,7,'utf8').span.start.offset,1);
 assert.throws(()=>parseDraft('# Markdown',file),DraftSyntaxError);
 assert.equal(queries,0);
 console.log('DARI: direct AST, template restrictions, real jq original-file diagnostics, cached remapping, CRLF/Unicode and raw language delimiters passed');
} finally {engine.dispose();}
