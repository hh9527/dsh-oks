import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateDraft } from './scripts/migrate-draft.ts';
import { splitQueryCalls } from './scripts/split-query.ts';
import { parseDraft } from './src/draft/document.ts';
const old=readFileSync('examples/answer.md','utf8');
const result=migrateDraft(old);
const parsed=parseDraft(result,'new.dari');
assert.deepEqual(parsed.answers,['conclusion']);
assert.ok(parsed.notes?.includes('演示数据'));
assert.equal(parsed.assets.get('summary.jq')!.source.includes('map(.value)'),true);
assert.throws(()=>migrateDraft(old+'\n</Notes>'),/reserved/);
assert.throws(()=>migrateDraft('## pipeline\n```js\nlet a=data(1);'),/closed/);
console.log('explicit migration: original Markdown validation, notes, pipeline and assets preserved');

const oldQuery='<Dari><Pipeline>let intent={limit:1}; let facts=query(intent); let rows=exec_query(query({limit:2}));</Pipeline><Asset name="x.jq" language="jq">"query(intent)"</Asset></Dari>';
const split=splitQueryCalls(oldQuery);
assert.ok(split.includes('let facts=exec_query(query(intent));'));
assert.ok(split.includes('let rows=exec_query(query({limit:2}));'));
assert.ok(split.includes('>"query(intent)"</Asset>'));
assert.equal(splitQueryCalls(split),split);

const migratedQuery=migrateDraft('## pipeline\n```js\nlet facts=query({limit:1});\n```');
assert.ok(migratedQuery.includes('exec_query(query({limit:1}))'));
