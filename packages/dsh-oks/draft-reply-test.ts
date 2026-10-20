import assert from 'node:assert/strict';
import { renderDraftReply } from './src/draft/reply.ts';
const page = (body: string) => `<html><head><title>x</title></head><body><article>${body}</article></body></html>`;
const markdown = renderDraftReply(page('<h1>标题</h1><p>Count: <span>42</span> <strong>text</strong></p><ul><li>A</li><li>B</li></ul><table><tr><th>key</th><th>value</th></tr><tr><td>x</td><td>7</td></tr></table>'), () => { throw new Error('no image expected'); });
assert.match(markdown, /^# 标题/);
assert.match(markdown, /Count: 42 \*\*text\*\*/);
assert.match(markdown, /- A\n- B/);
assert.match(markdown, /\| x \| 7 \|/);
assert.match(renderDraftReply(page('<p>[fake](javascript:evil)</p>'), () => ''), /\\\[fake\\\]/);
assert.match(renderDraftReply(page('<pre><code>```\ncontent\n```</code></pre>'), () => ''), /^````/);
let saved = 0;
assert.match(renderDraftReply(page('<figure data-oks-ref="chart"><figcaption>Chart</figcaption><svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg></figure>'), (svg, ref) => { saved++; assert.equal(ref, 'chart'); assert.match(svg, /<svg/); return '/attachments/one.svg'; }), /!\[图\]\(\/attachments\/one\.svg\)/);
assert.equal(saved, 1);
assert.throws(() => renderDraftReply(page('<table><tr><td colspan="2">x</td></tr></table>'), () => ''), /merged cells/);
assert.throws(() => renderDraftReply(page('<svg/>'), () => ''), /Unsupported reply/);
console.log('draft reply: native Markdown, safe values, tables, figures and explicit unsupported cases passed');

const code = '  first\n\n\n    second\n';
assert.ok(renderDraftReply(page('<pre><code>' + code + '</code></pre>'), () => '').includes(code), 'code indentation and consecutive blank lines are preserved');
