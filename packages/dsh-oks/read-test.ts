import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readWindow,formatRead,READ_MAX_BYTES} from './src/read.ts';
import {readWorkFile} from './src/results.ts';
const read=(text:string,offset?:unknown,limit?:unknown)=>readWindow([text],'oks://work/test.txt',offset,limit);
const simple=await read('one\r\ntwo\nthree\n',2,1);
assert.deepEqual(simple,{path:'oks://work/test.txt',offset:2,lines:[{number:2,text:'two'}],totalLines:3});
assert.equal(formatRead(simple,1),'<path>oks://work/test.txt</path>\n<type>file</type>\n<content>\n2: two\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)\n</content>');
const empty=await read('');assert.deepEqual(empty.lines,[]);assert.equal(empty.totalLines,0);
assert.match(formatRead(empty,undefined),/End of file - total 0 lines/);
for(const text of ['','one','one\n'])await assert.rejects(read(text,2),/out of range/);
for(const [offset,limit] of [[0,1],[-1,1],[1.5,1],[NaN,1],[Infinity,1],[1,0],[1,2001],[1,1.2]])await assert.rejects(read('x',offset,limit));
const many=await read('x\n'.repeat(2001));assert.equal(many.lines.length,2000);assert.equal(many.totalLines,2001);
const long=await read('x'.repeat(2001)+'\nafter');
assert.equal(long.lines[0].text,'x'.repeat(2000)+'... (line truncated to 2000 chars)');
assert.deepEqual(long.lines[1],{number:2,text:'after'});
// 50 KiB exactly fits 25*2000 characters + 25 newlines + 1175 final characters.
const exact='x'.repeat(2000)+'\n';
const full=await read(exact.repeat(25)+'y'.repeat(1175));
assert.equal(Buffer.byteLength(full.lines.map(line=>line.text).join('\n')),READ_MAX_BYTES);
assert.equal(full.lines.length,26);assert.match(formatRead(full,undefined),/End of file/);
const capped=await read(exact.repeat(25)+'y'.repeat(1176)+'\nlast');
assert.equal(capped.lines.length,25);assert.equal(capped.totalLines,27);
assert.match(formatRead(capped,undefined),/Output capped.*offset=26/);
assert.deepEqual((await read(exact.repeat(25)+'y'.repeat(1176)+'\nlast',26)).lines.map(line=>line.text),['y'.repeat(1176),'last']);
const chinese=await read(('中'.repeat(1000)+'\n').repeat(30));
assert.equal(chinese.lines.length,17);assert.ok(Buffer.byteLength(chinese.lines.map(line=>line.text).join('\n'))<=READ_MAX_BYTES);
// Streaming boundaries, CRLF and a giant newline-free line preserve host semantics.
async function* chunks(){yield 'first\r';yield '\n';for(let i=0;i<200;i++)yield '中'.repeat(20000);yield '\nlast';}
const streamed=await readWindow(chunks(),'oks://work/test.txt',undefined,undefined);
assert.equal(streamed.totalLines,3);assert.equal(streamed.lines[0].text,'first');
assert.match(streamed.lines[1].text,/line truncated to 2000 chars/);assert.equal(streamed.lines[2].text,'last');
// Actual work files above the streaming threshold are readable without the write-size cap.
const root=mkdtempSync(join(tmpdir(),'oks-read-'));
try {
 mkdirSync(join(root,'.work'));
 writeFileSync(join(root,'.work/large.txt'),'x'.repeat(11*1024*1024)+'\nlast');
 const result=await readWorkFile(root,'oks://work/large.txt',2,1,'oks_read');
 assert.deepEqual(result.lines,[{number:2,text:'last'}]);assert.equal(result.totalLines,2);
 await assert.rejects(readWorkFile(root,'oks://work/',1,1,'oks_read'));
}finally{rmSync(root,{recursive:true,force:true});}
console.log('read: host windows, byte boundaries, long lines, Unicode, empty/EOF, continuation and large streamed files passed');
