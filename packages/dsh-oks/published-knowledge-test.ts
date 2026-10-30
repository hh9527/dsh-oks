import {queryKnowledge} from './src/knowledge-methods.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBuildInformation } from './src/service-metadata.ts';
import { derivePublishedKnowledge } from './src/published-knowledge.ts';
import { collectProgrammedKnowledge } from './src/programmed-knowledge.ts';
import { encodePart, resolveFact } from './src/knowledge-graph.ts';

const leb = (n: number): number[] => n < 128 ? [n] : [(n % 128) | 128, ...leb(Math.floor(n / 128))];
const header = [0,97,115,109,1,0,0,0];
const section = (text: string, sectionName = 'telora.build.information'): number[] => {
  const name = [...Buffer.from(sectionName)];
  const payload = [...leb(name.length), ...name, ...Buffer.from(text)];
  return [0, ...leb(payload.length), ...payload];
};
const publication = (facts: unknown[], items: unknown[] = []): unknown => ({ knowledge_contract: 'ontology-knowledge-v4', intent_contract: 'ontology-intent-v1', addressing: 'node-member-uri-v1', revision: 'fixture', facts, items });
const fact = (key: string, value = {}, references: string[] = []): unknown => ({ key, value, references });
const id = 'a/b#%中文'; const ds = `datasets/${encodePart(id)}`;
const group = 'dimension_groups/shared'; const first = `${ds}#bindings/first`; const second = `${ds}#bindings/second`;
const input = publication([fact('entities/customer'), fact(ds, { grain: ['id'] }), fact(group), fact(first, { group }, [group]), fact(second, { group }, [group]), fact(`${ds}#dimensions/one`, { projectable: false, binding: first }, [first]), fact(`${ds}#roles/customer`, { entity: 'entities/customer' }, ['entities/customer'])]);
const bytes = Uint8Array.from([...header, ...section(JSON.stringify({ version: 1, entries: { 'ontology.knowledge': input } }))]);
assert.deepEqual(readBuildInformation(bytes)?.['ontology.knowledge'], input);
assert.equal(readBuildInformation(Uint8Array.from(header)), null);
for (const malformed of [bytes.subarray(0, bytes.length - 1), Uint8Array.from([...header, ...section('{}')]), Uint8Array.from([...bytes, ...section('{"version":1,"entries":{}}')]), Uint8Array.from([...header, 0, 1, 5])]) assert.throws(() => readBuildInformation(malformed));
// A custom-section-only module has no Service, executable code or Host imports.
const envelope = JSON.stringify({ version: 1, entries: { 'ontology.knowledge': input } });
const current = section(envelope, 'telora.build.information');
assert.deepEqual(readBuildInformation(Uint8Array.from([...header, ...current]))?.['ontology.knowledge'], input);
assert.throws(() => readBuildInformation(Uint8Array.from([...header, ...current, ...current])));
assert.equal(readBuildInformation(Uint8Array.from([...header, ...section(envelope, 'telora.service.metadata')])), null);
assert.deepEqual(readBuildInformation(Uint8Array.from([...header, ...section('{}', 'telora.service.metadata'), ...current]))?.['ontology.knowledge'], input);
// Builtins are inline expressions, never graph addresses or reverse-link hubs.
const inline = derivePublishedKnowledge(publication([
  fact('types/Business', { kind: 'Ref', representation: 'Int', reverse_references: true }),
  fact('types/Row', { kind: 'Ref', field_types: [
    { name: 'flag', type: 'Bool' }, { name: 'count', type: 'Option(Int)' },
    { name: 'nested', type: 'Array(Option(Dict(types/Business)))' },
  ] }, ['types/Business']),
  fact('datasets/inline'),
  fact('datasets/inline#fields/value', { type: 'Float' }),
]));
assert.equal(inline.links.length, 2); // One named-type edge and one owned member.
assert.equal(inline.keys.has('types/Int'), false);
assert.equal(inline.keys.has('types/Float'), false);
assert.equal(resolveFact(inline.knowledge, 'datasets/inline#fields/value').type, 'Float');
assert.deepEqual((resolveFact(inline.knowledge, 'types/Business').referenced_by as any).types, ['types/Row']);
assert.throws(() => derivePublishedKnowledge(publication([fact(ds), fact(ds)])), /Duplicate/);
assert.throws(() => derivePublishedKnowledge(publication([fact(ds, {}, ['types/missing'])])), /Unresolved/);
assert.throws(() => derivePublishedKnowledge(publication([fact(`${ds}#bindings/orphan`)])), /Unknown/);
assert.throws(() => derivePublishedKnowledge({}), /contract/);
const enriched = derivePublishedKnowledge(input, { version: 1, items: [{ key: ds, names: ['客户记录'], doc: '外部说明' }] });
assert.equal(enriched.knowledge.items.find(item => item.key === ds)?.names[0], '客户记录');
assert.equal(enriched.knowledge.items.find(item => item.key === ds)?.doc, '外部说明');
assert.equal(resolveFact(enriched.knowledge, `${ds}#dimensions/one`).projectable, false);
assert.throws(() => derivePublishedKnowledge(input, { version: 1, items: [{ key: ds, names: [], doc: '', projectable: true }] }), /presentation item/);
assert.throws(() => derivePublishedKnowledge(input, { version: 1, items: [{ key: 'datasets/missing', names: [], doc: '' }] }), /presentation item/);
const index = derivePublishedKnowledge(input);
assert.equal(resolveFact(index.knowledge, `${ds}#dimensions/one`).projectable, false);
assert.deepEqual((resolveFact(index.knowledge, group).referenced_by as any).bindings, [first, second]);
assert.ok(index.keys.has(first) && index.keys.has(second));
assert.equal((queryKnowledge(index.knowledge,'search',{query:'customer',type:'Entity'}) as any).items[0].key,'entities/customer');
if (process.argv[2]) {
  const metadata = readBuildInformation(readFileSync(process.argv[2]));
  assert.ok(metadata && Object.hasOwn(metadata, 'ontology.knowledge'));
  const collected = await collectProgrammedKnowledge(metadata['ontology.knowledge']) as {graph:unknown;vocabulary:unknown};
  const actual = derivePublishedKnowledge(collected.graph, undefined, collected.vocabulary);
  for (const ty of Object.values(actual.knowledge.types)) {
    assert.ok(!['Int', 'Float', 'String', 'Array', 'Dict'].includes(ty.kind as string));
    const variants = Array.isArray(ty.variants) ? ty.variants.map((v: any) => v.name) : [];
    if (ty.name == null) assert.ok(![['False', 'True'], ['None', 'Some']].some(names => JSON.stringify(names) === JSON.stringify(variants)));
  }
  assert.ok(Object.keys(actual.knowledge.datasets).length >= 5);
  for (const root of ['entities', 'dimension_groups'] as const) assert.ok(Object.keys(actual.knowledge[root] ?? {}).length > 0, root);
  const dataset=Object.keys(actual.knowledge.datasets)[0];
  queryKnowledge(actual.knowledge,'card',{id:dataset});
  console.log(JSON.stringify({ artifact: process.argv[2], revision: actual.revision, counts: actual.meta.counts, facts: actual.keys.size, links: actual.links.length }));
}
console.log('static knowledge: no discovery calls, strict metadata, closed references, separate bindings and JS navigation passed');
