import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import assert from 'node:assert/strict';
const code=stripTypeScriptTypes(fs.readFileSync(new URL('../src/client.ts',import.meta.url),'utf8'));
let plugin,definition,view,states,effects,fetches=0,lastUrl;
const React={useState(initial){const i=states.length;states.push(initial);return [initial,v=>states[i]=v];},useEffect(f){effects.push(f);},createElement:(...args)=>args};
vm.runInNewContext(code,{window:{location:{href:'https://demo.test/chat',origin:'https://demo.test'},__ModuleLoader__:{load({factory}){plugin=factory(id=>id==='react'?React:{MarkdownText:'markdown'});}}},URL,AbortController,fetch:async(url)=>{lastUrl=url;fetches++;return {ok:true,text:async()=> '# Delivered'};}});
plugin.apply({uiConversation:{events:{register(d){definition=d;}}},slots:{inject(_s,f){f();},register(_s,v){view=v;}}});
function node(source,text){const event={type:'user/message',seq:1,data:{id:'id',role:'user',source,content:[{type:'text',text}]}};assert(definition.match['user/message'](event));const state=definition.start({}, {event});return definition.buildViewNode({state,key:'id',id:'id',start:{event}});}
let n=node({kind:'push-to-user',label:'test'},'inline');states=[];effects=[];const inline=view({node:n});effects.forEach(f=>f());assert.equal(fetches,0);assert(JSON.stringify(inline).includes('inline'));
n=node({kind:'push-to-user',label:'test',href:'file:///attachments/%E4%B8%AD%E6%96%87%20a%23%3F%25.md'},'notice');states=[];effects=[];view({node:n});effects.forEach(f=>f());await new Promise(r=>setTimeout(r,0));assert.equal(fetches,1);assert.equal(states[0],'# Delivered');assert.equal(new URL(lastUrl).pathname,'/api/file');assert.equal(new URL(lastUrl).searchParams.get('path'),'/attachments/中文 a#?%.md');
n=node({kind:'push-to-user',href:'https://outside.test/a'},'notice');states=[];effects=[];view({node:n});effects.forEach(f=>f());assert.equal(fetches,1);assert.match(states[1],/同源/);
console.log('Push client: inline, replayable href, loading and cross-origin rejection passed');
