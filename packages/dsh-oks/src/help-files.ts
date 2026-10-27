import knowledge from './help/knowledge.md';
import project from './help/project.md';
import draft from './help/draft.md';
import querySource from './help/query.md';
import time from './help/time.md';
import figures from './help/figures.md';
import {modelContracts} from './contracts.ts';

/** Readonly virtual text files, inlined into the standalone bundle. */
export const helpFiles:Record<string,string> = Object.fromEntries(Object.entries({knowledge,project,draft,query:querySource.replaceAll('{{intentContract}}',modelContracts.intent),time,figures}).map(([name,text])=>[`oks://help/${name}.md`,text]));
export function helpEntries(files:Record<string,string> = helpFiles) {return Object.entries(files).map(([name,text])=>({name,bytes:Buffer.byteLength(text),modifiedAt:''}));}
