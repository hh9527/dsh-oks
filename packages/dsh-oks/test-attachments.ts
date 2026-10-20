import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export const testAttachments=(root:string)=>({
 async saveFile({data,name='attachment'}:{data:Uint8Array;name?:string}){
 const digest=createHash('sha256').update(data).digest('hex');const dir=join(root,'attachments',digest);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),data);return {attachmentId:'sha256:'+digest,name,bytes:data.byteLength};},
 fileHostPath(ref:{attachmentId:string;name:string}){return join(root,'attachments',ref.attachmentId.slice(7),ref.name);}
});
