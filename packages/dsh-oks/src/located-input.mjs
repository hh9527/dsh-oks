// Telora RFC 0322 TLI1; paths identify values and object keys in the host input.
const MAX_BYTES=64*1024*1024,MAX_NODES=100000,MAX_DEPTH=128,MAX_OFFSET=2**25;
export function encodeLocatedInput(value,origins=[]){
 const sources=new Map(origins.map(o=>[JSON.stringify([!!o.key,o.path]),o.span]));
 const chunks=[Buffer.from('TLI1')];let size=4,nodes=0;
 const append=b=>{size+=b.length;if(size>MAX_BYTES)throw Error('Located input exceeds 64 MiB');chunks.push(b);};
 const u32=n=>{const b=Buffer.allocUnsafe(4);b.writeUInt32LE(n);append(b);};
 const text=s=>{const b=Buffer.from(s);if(b.toString('utf8')!==s)throw Error('Located input requires valid Unicode');u32(b.length);append(b);};
 const span=(path,key=false)=>{const s=sources.get(JSON.stringify([key,path]));if(s&&(!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.start>s.end||s.end>=MAX_OFFSET))throw Error('Invalid located input span');u32(s?.start??0);u32(s?.end??0);};
 function item(v,path,depth){
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw Error('Located input exceeds node/depth limit');
  const tag=v===null?0:v===false?1:v===true?2:typeof v==='bigint'||typeof v==='number'&&Number.isSafeInteger(v)?3:typeof v==='number'?4:typeof v==='string'?5:Array.isArray(v)?6:typeof v==='object'&&Object.getPrototypeOf(v)!==null&&Object.getPrototypeOf(v)!==Object.prototype?-1:typeof v==='object'?7:-1;
  if(tag<0)throw Error('Unsupported located input value');
  append(Buffer.from([tag]));span(path);
  if(tag===3){const n=BigInt(v);if(n<-(2n**63n)||n>=2n**63n)throw Error('Located input Int exceeds Int64');const b=Buffer.allocUnsafe(8);b.writeBigInt64LE(n);append(b);}
  if(tag===4){if(!Number.isFinite(v))throw Error('Located input Float must be finite');const b=Buffer.allocUnsafe(8);b.writeDoubleLE(v);append(b);}
  if(tag===5)text(v);
  if(tag===6){u32(v.length);v.forEach((v,i)=>item(v,[...path,i],depth+1));}
  if(tag===7){const fields=Object.entries(v);u32(fields.length);for(const [key,v]of fields){text(key);span([...path,key],true);item(v,[...path,key],depth+1);}}
 }
 item(value,[],0);return Buffer.concat(chunks,size);
}
