// Usage: node knowledge-snapshot-test.ts <snapshot.wasm> <domain> [<domain> ...]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRunner } from './src/runners.ts';
import { buildRetrievalIndex } from './src/retrieval.ts';
import { createJaqEngine } from './src/jaq.ts';
import { resolveFact } from './src/knowledge-graph.ts';
import { builtinCode } from './src/knowledge-programs.ts';
import type { Settings } from './src/config.ts';

const [model,...domains]=process.argv.slice(2);
assert.ok(model && domains.length, 'Expected snapshot path and one or more domains');
const bytes=readFileSync(model);
const sha=createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(readFileSync(`${model}.knowledge.json`,'utf8'));
assert.equal(manifest.artifact_sha256,sha);
const engine=createJaqEngine(fileURLToPath(new URL('./lib/oks-wti.wasm',import.meta.url)));
try {
  for(const domain of domains) {
    const settings={domain,model,requestTimeoutMs:30000} as Settings;
    const runner=createRunner(settings,()=>{},bytes);
    try {
      const index=await buildRetrievalIndex({settings,runner},sha,()=>{});
      const expected=manifest.domains.find((item:any)=>item.domain===domain);
      assert.ok(expected);
      assert.deepEqual(index.sourceNodes.map(node=>node.key).sort(),expected.entries.map((item:any)=>item.key).sort());
      assert.ok(!Object.hasOwn(index.knowledge,'guide'));
      for(const node of index.sourceNodes as any[]) {
        assert.notEqual(node.type,'Schema');
        assert.ok(!node.detail.schemas);
        for(const link of node.links) assert.ok(index.sourceNodes.some(n=>n.key===link.key));
      }
      for(const item of index.knowledge.items) {
        const fact=resolveFact(index.knowledge,item.key);
        assert.ok(!Object.hasOwn(fact,'description'));
        for(const [role,value] of Object.entries(fact)) {
          if(['datasets','types','relations','fields','dimensions','measures','values','time_roles','business_links'].includes(role) && Array.isArray(value)) for(const ref of value) assert.ok(resolveFact(index.knowledge,String(ref)));
          if(['related','traversable','referenced_by'].includes(role)) for(const refs of Object.values(value as object) as string[][]) for(const ref of refs) assert.ok(resolveFact(index.knowledge,ref));
        }
      }
      const code=builtinCode('builtin://knowledge/search.jq',{type:'Dataset',take:1});
      const result=await engine.run(code.text,{input:{knowledge:index.knowledge},timeoutMs:5000,maxBytes:16384,programFile:code.file});
      assert.equal(result.ok,true);
      const row=(result as any).data.items[0];
      assert.ok(index.knowledge.items.some(item=>item.key===row.key));
      assert.ok(index.knowledge.datasets[row.id]);
      assert.equal(index.knowledge.items.length,index.sourceNodes.length-1);
      const invalid=await runner.send(`${domain}/transform`,{intents:[{op:'Graph',root:'x',nodes:[{id:'x',entity:row.id,bogus:true}],edges:[],select:[],limit:1}]});
      assert.ok(JSON.stringify(invalid).includes('"accepted":false'));
      assert.ok(!JSON.stringify(invalid).includes('Schema/'));
      console.log(`${domain}: ${index.knowledge.items.length} facts; manifest equality, closed references, builtin jq and diagnostic boundary passed`);
    } finally {runner.dispose();}
  }
} finally {engine.dispose();}
