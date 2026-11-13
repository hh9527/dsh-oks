import {modelErrorText} from '@hh9527/dari-core';
import {sharedTypes} from '@hh9527/dari-core';
import {Worker} from 'node:worker_threads';
import {accessSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve as pathResolve} from 'node:path';
import type {ModelPort,IntentType,MemberSymbol,DatasetSymbol,RelationSymbol,ResultColumn,ValueCodec} from '@hh9527/dari-core';
import {MODEL_ABI_VERSION,type EncodedIntent,type ProofReceipt} from '@hh9527/dari-core';
import type {Type} from '@hh9527/dari-core';
import {primaryCodecs} from '@hh9527/dari-core/codecs';

type WireMember={id:string;symbol:string;kind:'dimension'|'measure';logical:string;storage:string;nullable:boolean};
type WireDataset={id:string;symbol:string;members:WireMember[]};
type WireTemplate={container:'table'|'option';receipt:ProofReceipt;sql:string;bindings:any[];columns:(ResultColumn&{logical:string})[];max_rows:number|null};
export async function openModel(artifact:string,runner=pathResolve('bin/telora-run')){
    accessSync(artifact);accessSync(runner);
    const buffer=new SharedArrayBuffer(8+8*1024*1024),state=new Int32Array(buffer,0,2),bytes=new Uint8Array(buffer,8);
    const worker=new Worker(new URL('./model-worker.mjs',import.meta.url),{execArgv:[],workerData:{buffer,artifact:pathResolve(artifact),runner}});
    const stats={requests:0,checkMs:[] as number[],contractMs:0};
    let closed=false;
    function request(method:string,input:unknown):any{
        if(closed)throw Error('Model bridge is closed');
        Atomics.store(state,0,0);worker.postMessage({method,input});
        if(Atomics.wait(state,0,0,60000)==='timed-out')throw Error('Model ABI request timed out');
        const response=JSON.parse(new TextDecoder().decode(bytes.subarray(0,Atomics.load(state,1))));
        stats.requests++;
        if(response.error)throw Error(modelErrorText(response.error));return response.value;
    }
    function scalar(name:string):Type{return sharedTypes[name]??{kind:'scalar',name};}
    const types:Record<string,Type>=Object.create(null),businessTypes=new Map<string,Type>();
    let codecs:Record<string,ValueCodec>,presentations:Record<string,Type["presentation"]>,semantics:Record<string,{identity?:string;semantic?:string}>;
    function business(logical:string,physical:string):Type{
        const key=logical+'@'+physical;
        const previous=businessTypes.get(key);
        if(previous)return previous;
        const base=scalar(physical);
        const primary=Object.hasOwn(primaryCodecs,logical);
        const codec=primary?primaryCodecs[physical]:codecs[key];
        if(!codec)throw Error('Missing model type codec '+key);
        const metadata=semantics?.[key],shared=metadata?.identity?sharedTypes[metadata.identity]:undefined;
        if(metadata?.identity&&!shared)throw Error('Unknown shared ontology type '+metadata.identity);
        if(shared&&JSON.stringify(shared.codec?.operations)!==JSON.stringify(codec.operations))throw Error('Shared type calculation contract mismatch '+metadata!.identity);
        const type:Type=shared??(primary?{...base,codec}:{kind:'nominal',name:logical,inner:base,codec,semantic:metadata?.semantic??undefined,presentation:presentations?.[key]??undefined});
        const published={...type,modelLogical:logical};
        businessTypes.set(key,published);return published;
    }
    const started=performance.now();
    let contract:{contract_id:string;abi_version:string;datasets:WireDataset[];relations:Omit<RelationSymbol,'kind'>[];types:{name:string;logical:string;storage:string}[];codec_module:string};
    try{
        contract=request('ontology/dari',{method:'contract',input:{}});
        if(contract.abi_version!==MODEL_ABI_VERSION)throw Error('Unsupported model proof ABI '+contract.abi_version);
        // Trusted model build output; .dari text is never executed as JavaScript.
        const generated=await import('data:text/javascript;base64,'+Buffer.from(contract.codec_module).toString('base64'));
        codecs=generated.createCodecs(primaryCodecs);presentations=generated.presentations;semantics=generated.semantics;
        if(!presentations||!semantics)throw Error('Model must publish independent semantic and presentation contracts');
        for(const t of contract.types){
            types[t.name]=business(t.logical,t.storage);
            if(types[t.name].kind==='nominal'&&!Object.hasOwn(sharedTypes,types[t.name].name??''))types[t.name].displayName=t.name;
        }
    }catch(e){worker.postMessage({close:true});throw e;}
    stats.contractMs=performance.now()-started;
    const datasets:Record<string,DatasetSymbol>=Object.create(null);
    for(const item of contract.datasets){
        const members:Record<string,MemberSymbol>=Object.create(null);
        for(const m of item.members){
            if(Object.hasOwn(members,m.symbol))throw Error('Ambiguous published model member '+item.symbol+'.'+m.symbol);
            const type=business(m.logical,m.storage);
            members[m.symbol]={kind:m.kind,id:m.id,symbol:m.symbol,owner:item.id,type:m.nullable?{kind:'option',inner:type}:type};
        }
        if(Object.hasOwn(datasets,item.symbol))throw Error('Ambiguous published Dataset '+item.symbol);
        datasets[item.symbol]={kind:'dataset',id:item.id,symbol:item.symbol,members};
    }
    const model:ModelPort={
        contractId:contract.contract_id,
        implementationId:createHash('sha256').update(readFileSync(artifact)).digest('hex'),
        datasets,types,relations:Object.fromEntries(contract.relations.map(r=>[r.symbol,{...r,kind:'relation' as const}])),
        check_type(intent:IntentType,encoded:EncodedIntent){
            const start=performance.now();
            const checked:WireTemplate=request('ontology/dari',{method:'check_type',input:{intent_json:encoded.json}});
            stats.checkMs.push(performance.now()-start);
            const fields:Record<string,Type>=Object.create(null);
            for(const c of checked.columns){const t=business(c.logical,c.type);fields[c.name]=c.nullable?{kind:'option',inner:t}:t;}
            return {element:{kind:'schema',fields},container:checked.container,receipt:checked.receipt,maxRows:checked.max_rows??undefined,plan:{checked,constants:encoded.constants,parameterTypes:encoded.parameterTypes}};
        },
        bind(plan:unknown,parameters:unknown[]){
            const {checked,constants,parameterTypes}=plan as {checked:WireTemplate;constants:Map<number,unknown>;parameterTypes:Map<number,Type>};
            const bindings:any[]=[];
            // Scan SQL tokens: placeholders in quoted text/comments are not bindings.
            const sql=checked.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d+)|:__dari_(\d+)/g,(token,constant,parameter)=>{
                if(constant===undefined&&parameter===undefined)return token;
                const index=Number(parameter);
                const value=constant!==undefined?checked.bindings[Number(constant)-1]:constants.has(index)?constants.get(index):parameters[index];
                if(value===undefined)throw Error('Missing model binding');
                let type=parameterTypes.get(index);
                if(type?.kind==='option')type=type.inner;
                const unwrapped=value?.tag==='None'?null:value?.tag==='Some'?value.value:value;
                bindings.push(parameter!==undefined&&unwrapped!==null&&type?.codec?type.codec.encode(unwrapped):unwrapped);return '?';
            });
            return {sql,bindings,columns:checked.columns.map(({logical,...column})=>column),max_rows:checked.max_rows??undefined};
        }
    };
    return {model,stats,contract,codecs,codecModuleSource:contract.codec_module,
        checkWire(intentJson:string):WireTemplate{return request('ontology/dari',{method:'check_type',input:{intent_json:intentJson}});},
        transform(input:unknown){return request('ontology/dari',{method:'transform',input});},
        async close(){if(closed)return;closed=true;const exited=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));worker.postMessage({close:true});await exited;}};
}
