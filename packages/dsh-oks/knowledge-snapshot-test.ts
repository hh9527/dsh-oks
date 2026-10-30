import {queryKnowledge} from './src/knowledge-methods.ts';
// Usage: node knowledge-snapshot-test.ts <model.wasm> <domain> [<domain> ...]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRunner } from './src/runners.ts';
import { readBuildInformation } from './src/service-metadata.ts';
import { collectProgrammedKnowledge } from './src/programmed-knowledge.ts';
import { derivePublishedKnowledge } from './src/published-knowledge.ts';
import { resolveFact } from './src/knowledge-graph.ts';
import type { Settings } from './src/config.ts';

const [model,...domains]=process.argv.slice(2);
assert.ok(model && domains.length, 'Expected model path and one or more domains');
const bytes=readFileSync(model);
const sha=createHash('sha256').update(bytes).digest('hex');
const publication=readBuildInformation(bytes)?.['ontology.knowledge'];
try {
  for(const domain of domains) {
    const settings={domain,model,requestTimeoutMs:30000} as Settings;
    const runner=createRunner(settings,()=>{},bytes);
    try {
      const collected=await collectProgrammedKnowledge(publication) as {graph:unknown;vocabulary:unknown};
      const index=derivePublishedKnowledge(collected.graph,undefined,collected.vocabulary);
      assert.ok(!Object.hasOwn(index.knowledge,'guide'));
      for(const item of index.knowledge.items) {
        const fact=resolveFact(index.knowledge,item.key);
        assert.ok(!Object.hasOwn(fact,'description'));
        for(const [role,value] of Object.entries(fact)) {
          if(['datasets','types','relations','fields','dimensions','measures','values','time_roles','business_links'].includes(role) && Array.isArray(value)) for(const ref of value) assert.ok(resolveFact(index.knowledge,String(ref)));
          if(['related','traversable','referenced_by'].includes(role)) for(const refs of Object.values(value as object) as string[][]) for(const ref of refs) assert.ok(resolveFact(index.knowledge,ref));
        }
      }
      const result=queryKnowledge(index.knowledge,'search',{query:'a',type:'Dataset',take:1});

      const row=(result as any).items[0];
      assert.ok(index.knowledge.items.some(item=>item.key===row.key));
      assert.ok(index.knowledge.datasets[row.id]);
      const invalid=await runner.send(`${domain}/transform`,{intents:[{op:'Graph',root:'x',nodes:[{id:'x',entity:row.id,bogus:true}],edges:[],select:[],limit:1}]});
      assert.ok(JSON.stringify(invalid).includes('"accepted":false'));
      assert.ok(!JSON.stringify(invalid).includes('Schema/'));
      console.log(`${domain}: ${index.knowledge.items.length} facts; closed references, JS knowledge and diagnostic boundary passed`);
    } finally {runner.dispose();}
  }
} finally {}
