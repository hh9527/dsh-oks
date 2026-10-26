// CLI 验收驱动：复用正式插件的通用采集器和 v4 事实校验。
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {collectProgrammedKnowledge} from '../packages/dsh-oks/src/programmed-knowledge.ts';
import {derivePublishedKnowledge} from '../packages/dsh-oks/src/published-knowledge.ts';
import {renderWholeVocabulary} from '../packages/dsh-oks/src/retrieval.ts';
const [inputFile,outputFile]=process.argv.slice(2);
const input=JSON.parse(readFileSync(inputFile,'utf8'));
const start=performance.now();
const result=await collectProgrammedKnowledge(input);
const collectedAt=performance.now();
const index=derivePublishedKnowledge(result.graph,undefined,result.vocabulary);
const derivedAt=performance.now();
const feed=renderWholeVocabulary(index);
const renderedAt=performance.now();
writeFileSync(outputFile,JSON.stringify(result));
console.log(JSON.stringify({elapsedMs:performance.now()-start,collectMs:collectedAt-start,deriveMs:derivedAt-collectedAt,vocabularyMs:renderedAt-derivedAt,facts:result.graph.facts.length,terms:index.terms.length,vocabularyBytes:Buffer.byteLength(feed)}));
