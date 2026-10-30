import workflow from './help/workflow.md';
import knowledge from './help/knowledge.md';
import draft from './help/draft.md';
import pipeline from './help/pipeline.md';
import querySource from './help/query.md';
import time from './help/time.md';
import figures from './help/figures.md';
import {modelContracts} from './contracts.ts';

/** Readonly virtual text files, inlined into the standalone bundle. */
export const helpFiles:Record<string,string> = Object.fromEntries(Object.entries({workflow,knowledge,draft,pipeline,query:querySource.replaceAll('{{intentContract}}',modelContracts.intent),time,figures}).map(([name,text])=>[`oks://help/${name}.md`,text]));
export function helpEntries(files:Record<string,string> = helpFiles) {return Object.entries(files).map(([name,text])=>({name,bytes:Buffer.byteLength(text),modifiedAt:''}));}
