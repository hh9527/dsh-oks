// Usage: just snapshot -- <model.wasm> <domain> ... <model.wasm> <domain> [<domain> ...]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRunner } from '@hh9527/dari-model';
import { readBuildInformation } from '@hh9527/dari-model';
import { collectProgrammedKnowledge } from '@hh9527/dari-model';
import { derivePublishedKnowledge } from '@hh9527/dari-model';
import { resolveFact } from '@hh9527/dari-model';
import type { Settings } from '@hh9527/dari-model';

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
      const id=Object.keys(index.knowledge.datasets)[0];
      assert.ok(id);
      const invalid=await runner.send(`${domain}/transform`,{intents:[{op:'Graph',root:'x',nodes:[{id:'x',entity:id,bogus:true}],edges:[],select:[],limit:1}]});
      assert.ok(JSON.stringify(invalid).includes('"accepted":false'));
      assert.ok(!JSON.stringify(invalid).includes('Schema/'));
      console.log(`${domain}: ${index.knowledge.items.length} facts; closed references, JS knowledge and diagnostic boundary passed`);
    } finally {runner.dispose();}
  }
} finally {}
