import type {ModelDiagnostic} from '@hh9527/dari-core';
export class TeloraWasm {
 constructor(bytes:Uint8Array);
 request(packet:Uint8Array):{schema:string;error:boolean;ok:any;diagnostics:ModelDiagnostic[]};
}
