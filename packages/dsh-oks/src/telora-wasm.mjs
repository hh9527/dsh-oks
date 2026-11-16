// Telora publication/Guest ABI 43, executed by Node's native WebAssembly engine.
function section(module,name,required=false){const values=WebAssembly.Module.customSections(module,name);if(values.length>1||required&&values.length!==1)throw Error('Invalid '+name+' publication section');return values[0]&&Buffer.from(values[0]);}
function snapshotArtifact(bytes){
 let at=0;const take=n=>{if(!Number.isSafeInteger(n)||n<0||at+n>bytes.length)throw Error('Truncated Telora snapshot');const v=bytes.subarray(at,at+n);at+=n;return v;},u32=()=>take(4).readUInt32LE(),field=()=>take(u32());
 if(take(8).toString()!=='TLSART01'||u32()!==1)throw Error('Unsupported Telora snapshot');
 const guest=field(),globals=new Map(),count=u32();if(count>bytes.length/9)throw Error('Invalid Telora snapshot global count');
 for(let i=0;i<count;i++){
  const name=field().toString('utf8'),tag=take(1)[0];if(globals.has(name))throw Error('Duplicate snapshot global');
  const value=tag===0?take(4).readInt32LE():tag===1?take(8).readBigInt64LE():tag===2?take(4).readFloatLE():tag===3?take(8).readDoubleLE():(()=>{throw Error('Invalid snapshot global type');})();globals.set(name,value);
 }
 if(at!==bytes.length)throw Error('Trailing Telora snapshot bytes');return {guest,globals};
}
export class TeloraWasm {
 constructor(bytes){
  this.module=new WebAssembly.Module(bytes);if(WebAssembly.Module.imports(this.module).length)throw Error('Telora model must be self-contained');
  const publication=JSON.parse(section(this.module,'telora.build',true)),manifest=JSON.parse(section(this.module,'telora.manifest',true));
  if(publication.version!==4||publication.abi!==43||manifest.abi!==43)throw Error('Unsupported Telora publication/Guest ABI');
  if(section(this.module,'telora.data')||section(this.module,'telora.tooling'))throw Error('Expected a runtime publication artifact');
  this.memoryLimit=publication.memory_limit;if(!Number.isSafeInteger(this.memoryLimit)||this.memoryLimit<=0||this.memoryLimit>2**32-1)throw Error('Invalid Telora memory limit');
  this.instantiate();const baked=section(this.module,'telora.snapshot');
  if(baked)this.baseline=snapshotArtifact(baked);
  else{
   if(this.call('get-data-source-count')!==0)throw Error('DARI model requires a self-contained service with no external sources');
   const status=this.call('create-service'),diagnostics=this.jsonResult('get-service-diagnostics');
   if(status!==0)throw Object.assign(Error('Model initialization failed'),{diagnostics});
   this.baseline={guest:this.exportSnapshot(),globals:this.captureGlobals()};
  }
  this.restore();
 }
 instantiate(){
  this.instance=new WebAssembly.Instance(this.module,{});this.exports=this.instance.exports;this.memory=this.exports.memory;
  for(const name of ['mem-alloc','mem-free','get-data-source-count','create-service','get-service-diagnostics','reset-service','run-service-located','telora_snapshot_export','telora_snapshot_import','telora_gc_heap_limit'])if(typeof this.exports[name]!=='function')throw Error('Missing Telora export '+name);
  if(!(this.memory instanceof WebAssembly.Memory)||this.call('telora_gc_heap_limit',this.memoryLimit)!==0)throw Error('Cannot configure Telora managed memory');
 }
 call(name,...args){return this.exports[name](...args);}
 range(pointer,length){if(!Number.isInteger(pointer)||!Number.isInteger(length)||pointer<=0||length<0||pointer+length>this.memory.buffer.byteLength)throw Error('Invalid Guest memory range');return new Uint8Array(this.memory.buffer,pointer,length);}
 alloc(length,align=1){const pointer=this.call('mem-alloc',length,align)>>>0;if(!pointer||pointer%align)throw Error('Invalid Guest allocation');this.range(pointer,length);return pointer;}
 free(pointer,length,align=1){this.call('mem-free',pointer,length,align);}
 transfer(bytes){const pointer=this.alloc(bytes.length);this.range(pointer,bytes.length).set(bytes);return pointer;}
 word(pointer){return new DataView(this.memory.buffer).getUint32(pointer,true);}
 output(record,snapshot=false){
  const pointer=this.word(record),length=this.word(record+4),capacity=snapshot?length:this.word(record+8);
  if(length>capacity)throw Error('Invalid Guest response capacity');this.range(pointer,capacity);
  const result=Buffer.from(this.range(pointer,length));this.free(pointer,capacity);return result;
 }
 jsonResult(name){const record=this.alloc(12,4);this.call(name,1,0,record);const result=this.output(record);this.free(record,12,4);return JSON.parse(result.toString('utf8'));}
 exportSnapshot(){const record=this.alloc(12,4);this.call('telora_snapshot_export',record);const result=this.output(record,true);this.free(record,12,4);return result;}
 captureGlobals(){return new Map(Object.entries(this.exports).filter(([name,value])=>name.startsWith('telora_reset_global_')&&value instanceof WebAssembly.Global&&(()=>{try{value.value=value.value;return true;}catch{return false;}})()).map(([name,value])=>[name,value.value]));}
 restore(){
  this.instantiate();const actual=[...this.captureGlobals().keys()].sort(),expected=[...this.baseline.globals.keys()].sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Snapshot globals do not match the module');
  const pointer=this.transfer(this.baseline.guest);this.call('telora_snapshot_import',pointer,this.baseline.guest.length);this.free(pointer,this.baseline.guest.length);
  this.restoreGlobals();this.poisoned=false;
 }
 restoreGlobals(){for(const [name,value]of this.baseline.globals)this.exports[name].value=value;}
 request(packet){
  if(this.poisoned)this.restore();
  try{this.call('reset-service');}catch{this.restore();}
  this.restoreGlobals();this.poisoned=true;
  const input=this.transfer(packet),record=this.alloc(12,4);
  this.call('run-service-located',input,packet.length,1,0,record);
  this.free(input,packet.length);const response=this.output(record);this.free(record,12,4);
  if(this.memory.buffer.byteLength>this.memoryLimit)throw Error('Model exceeds memory limit');
  this.poisoned=false;return JSON.parse(response.toString('utf8'));
 }
}
