import {dariLiteral} from './test-dari.ts';
import assert from 'node:assert/strict';
import {parseDraft} from './src/draft/document.ts';
import {SourceFile} from './src/draft/source.ts';
const file='analysis.dari';
const source='data text = "中😀";\nreport r = tree! { Report [p [Value(data=text)]] };';
const doc=parseDraft(source,file);assert(doc.nodes.length>0);
assert.throws(()=>parseDraft('data x = jq("x.jq",{});',file));
const original=new SourceFile(file,'中😀\r\nabc');
assert.deepEqual(original.position(5),{offset:5,line:2,column:1});
assert.throws(()=>original.span(5,4),/Invalid original source range/);
console.log('DARI source coordinates, Unicode and retired jq syntax rejection passed');

for(const [text,value]of [['True',true],['False',false],['None',null]] as const){
 const declaration=parseDraft('data x = '+text+';').nodes[0].statement;
 assert.equal(declaration.kind,'binding');assert.equal(declaration.value.kind,'literal');
 assert.equal((declaration.value as any).value,value);
}
assert.equal(parseDraft('answer tree! { Answer() [if (True) [p ["ok"]]] };').answers[0],'answer');
assert.equal(parseDraft('report r = tree! { /* open */ Report() [p ["}"]] /* close */ };').answers[0],'r');
assert.equal(dariLiteral({a:true,b:false,c:null,text:'true false null'}),'{"a":True,"b":False,"c":None,"text":"true false null"}');
for(const [text,pattern]of [
 ['data x := True;',/Expected "="/],
 ['answer = tree! { Answer [] };',/Expected "tree"/],
 ['report r = Report [];',/Expected "tree"/],
 ['answer Answer [];',/Expected "tree"/],
 ['answer tree! { Answer [], Answer [] };',/Expected "}"/],
 ['answer tree! { Answer []; };',/Expected "}"/],
 ['answer tree! { Answer [] ;',/Expected "}"/],
 ['data True = 1;',/Reserved binding/],
 ['data x = true;',/Use True/],['data x = false;',/Use False/],['data x = null;',/Use None/],
] as const)assert.throws(()=>parseDraft(text),pattern,text);
console.log('DARI syntax: = bindings, explicit tree boundary, True/False/None, quoted strings and retired syntax diagnostics passed');
