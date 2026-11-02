import assert from 'node:assert/strict';
import { installKnowledgeNavigation } from './src/knowledge-navigation.ts';
const sections:any[]=[];
installKnowledgeNavigation({ctx:{systemPrompt:{section:(s:any)=>sections.push(s)}} as any,knowledge:{ensureWorkspace(){throw Error('Must not load model');}} as any,log(){}});
assert.equal(sections.length,1);
assert.equal(sections[0].name,'oks:presentation');
assert(sections[0].text.includes('ColumnChart'));
assert(!sections[0].text.includes('oks_project'));
console.log('Presentation navigation is static and does not load domain knowledge');
