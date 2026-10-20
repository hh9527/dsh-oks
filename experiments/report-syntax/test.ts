import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceFile } from './source.ts';
import { compileReport } from './compiler.ts';
import { parseDraft } from '../../packages/dsh-oks/src/draft/document.ts';
import { DraftSyntaxError } from '../../packages/dsh-oks/src/draft/pipeline.ts';
import { parseMarkdownFixture } from '../../packages/dsh-oks/test-markdown.ts';
import { DraftRuntime } from '../../packages/dsh-oks/src/draft/runtime.ts';
import { createDraftBackend } from '../../packages/dsh-oks/src/draft/backend.ts';
import { createJaqEngine } from '../../packages/dsh-oks/src/jaq.ts';
import type { WorkspaceEntry } from '../../packages/dsh-oks/src/knowledge.ts';
const source=readFileSync(new URL('./example.dari',import.meta.url),'utf8');
const compiled=compileReport(source,'.work/analysis.dari');const document=parseDraft(compiled.markdown);
assert.deepEqual(compiled.fragments.map(f=>f.language),['jq','pipeline']);
for(const fragment of compiled.fragments){
 const location=fragment.locate(0,fragment.text.length);
 assert.equal(location.file,'.work/analysis.dari');
 assert.equal(source.slice(location.span.start.offset,location.span.end.offset),fragment.text);
}
// Native jq reports use UTF-8 byte ranges; pipeline/host spans use UTF-16 offsets.
// Chinese, emoji, CRLF, first-line column and EOF remain tied to the original file.
const unicodeSource='标题🙂\r\n  <script>中文🙂 broken</script>';
const original=new SourceFile('unicode.dari',unicodeSource);
const begin=unicodeSource.indexOf('中文');const end=unicodeSource.indexOf('</script>');
const fragment=original.fragment('a.jq','jq',begin,end);
const byteStart=Buffer.byteLength('中文🙂 ');
const mapped=fragment.locate(byteStart,byteStart+6,'utf8');
assert.equal(mapped.file,'unicode.dari');assert.equal(mapped.span.start.line,2);
assert.equal(unicodeSource.slice(mapped.span.start.offset,mapped.span.end.offset),'broken');
assert.equal(mapped.span.start.column,unicodeSource.split('\r\n')[1].indexOf('broken')+1);
assert.equal(fragment.locate(Buffer.byteLength(fragment.text),Buffer.byteLength(fragment.text),'utf8').span.end.offset,end);
assert.throws(()=>fragment.locate(1,2,'utf8'),/splits a code point/);
const moved=new SourceFile('moved.dari','前言\n'+unicodeSource);
const movedFragment=moved.fragment('a.jq','jq',begin+3,end+3);
assert.equal(movedFragment.locate(byteStart,byteStart+6,'utf8').span.start.line,3);

assert.equal(compiled.generated.filter(n=>n.operator==='render_figure').length,1);
assert.deepEqual(compiled.generated.find(n=>n.operator==='render_figure')!.bindings,['chartSpec','facts']);
assert.equal(compiled.generated.at(-1)!.name,'answer');
for(const ref of compiled.references){
 assert.equal(source.slice(ref.span.start.offset,ref.span.end.offset).trim(),`{${ref.source}}`);
 const before=source.slice(0,ref.span.start.offset).split('\n');
 assert.equal(ref.span.start.line,before.length);assert.equal(ref.span.start.column,before.at(-1)!.length+1);
}
assert.equal(document.nodes.at(-1)!.statement.kind,'binding');
const rejected:(string|string[])[]=[];
const rejects=(input:string,pattern:RegExp,needle?:string)=>{
 assert.throws(()=>compileReport(input),(error:unknown)=>{
  assert.ok(error instanceof DraftSyntaxError);assert.match(error.message,pattern);
  assert.ok(error.span.start.line>=1);assert.ok(error.span.start.column>=1);
  if(needle)assert.ok(input.slice(error.span.start.offset,error.span.end.offset).includes(needle),`${error.message}: expected span containing ${needle}`);
  rejected.push(error.message);return true;
 });
};
rejects(source.replace('data={summary.total}','data={{total:1}}'),/Expected a name/);
rejects(source.replace('data={summary.total}','data={jq("a.jq", {facts})}'),/only a pipeline binding/);
rejects(source.replace('data={summary.total}','data={summary.total + 1}'),/only a pipeline binding/);
rejects(source.replace('data={summary.total}','data={summary.total'),/only a pipeline binding/);
rejects(source.replace('data={summary.total}','data={missing.total}'),/Undefined pipeline binding missing/,'missing');
rejects(source.replace('facts.rows[0]["level"]','facts.rows[summary.total]'),/static string or safe array index/);
rejects(source.replace('spec={chartSpec}','spec="column"'),/requires a pipeline reference/);
rejects(source.replace('spec={chartSpec}',''),/requires a pipeline reference/);
rejects(source.replace('spec={chartSpec}','spec={chartSpec} spec={chartSpec}'),/Duplicate attribute spec/);
rejects(source.replace('</article>','</section>'),/Expected <\/article>/);
rejects(source.replace('</pipeline>',''),/Missing standalone <\/pipeline>/);
rejects(source.replace('name="answer"','name="facts"'),/conflicts with binding/);
rejects(source.replace('let summary =','let summary = missing; let other ='),/Undefined or forward binding/);
rejects(source.replace('name="summary.jq"','name="other.jq"'),/Missing jq asset/);
rejects(source.replace('<p>总数：','<p title={summary.total}>总数：'),/must be static strings/);
rejects(source.replace('<p>总数：','<p>{summary.total}总数：'),/Place pipeline references/);
// Raw jq keeps its own lexical rules: XML punctuation and inline closing-tag strings are ordinary jq text.
assert.ok(compileReport(source.replace('"甲 & 乙"','"甲 < 乙 & </script>"')).markdown.includes('甲 < 乙 & </script>'));
// Internal bindings avoid collisions; exploratory reports may have no template.
assert.ok(compileReport(source.replace('let facts =','let __report_1 = 1; let facts =')).generated[0].name!=='__report_1');
assert.equal(compileReport('<report>\n<pipeline>\nlet n=1; debug(n);\n</pipeline>\n</report>').generated.length,0);
const engine=createJaqEngine(new URL('../../packages/dsh-oks/lib/oks-wti.wasm',import.meta.url).pathname);
const backend=createDraftBackend({knowledge:{executorFor(){throw new Error('Example must not execute SQL');}},entry:{} as WorkspaceEntry,file:'.work/report-syntax.md',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'}),jq:engine});
let renders=0;const runtime=new DraftRuntime({...backend,async execute(ctx){if(ctx.operator==='render_figure')renders++;return backend.execute(ctx);}},{parse:parseMarkdownFixture});
try{
 const result=await runtime.run(compiled.markdown);assert.equal(result.status,'complete',result.error ?? '');
 const answer=runtime.read('answer',compiled.markdown).value;
 const html=answer.sources[0].delivery!.html;
 assert.match(html,/>5<\/span>/);assert.match(html,/>major<\/span>/);assert.match(html,/<svg/);
 assert.ok(Object.values(answer.sources[0].origin.nodes).some(node=>node.kind==='transform'));
 await runtime.run(compiled.markdown);assert.equal(renders,1,'unchanged figure is cached');
 const changed=compileReport(source.replace('总数：','合计：'));
 await runtime.run(changed.markdown);assert.equal(renders,1,'template prose edits reuse the figure');
 const empty=compileReport(source.replace('rows:[{level:"major",count:3},{level:"minor",count:2}]','rows:[]').replace('facts.rows[0]["level"]','summary.total'));
 const resultEmpty=await runtime.run(empty.markdown);assert.equal(resultEmpty.status,'complete',resultEmpty.error ?? '');
 console.log(JSON.stringify({ok:true,figures:1,referenceSpans:compiled.references.length,negativeCases:rejected.length,realJq:true,realSvg:true,provenance:true,cacheReuse:true,emptyRows:true}));
}finally{engine.dispose();}
