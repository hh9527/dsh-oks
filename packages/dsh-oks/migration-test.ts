import assert from 'node:assert/strict';
import { splitQueryCalls } from './scripts/split-query.ts';
const oldQuery='<Dari><Pipeline>intent <-{limit:1}; facts <-query(intent); rows <-exec_query(query({limit:2}));</Pipeline><Asset name="x.sql" language="sql">"query(intent)"</Asset></Dari>';
const split=splitQueryCalls(oldQuery);
assert.ok(split.includes('facts <-exec_query(query(intent));'));
assert.ok(split.includes('rows <-exec_query(query({limit:2}));'));
assert.ok(split.includes('>"query(intent)"</Asset>'));
assert.equal(splitQueryCalls(split),split);
