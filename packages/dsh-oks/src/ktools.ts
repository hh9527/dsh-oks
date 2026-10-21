import { checkJaqLibrary, runJaq, type JaqLibraryCheck, type JaqCheckOptions, type JaqOptions } from './jaq.ts';
import { builtinCode, builtinKtoolsSource } from './knowledge-programs.ts';
import { KTOOLS_FILE, KTOOLS_BUILTIN } from './ktools-path.ts';
import { WORK_MAX_BYTES, readWorkText } from './results.ts';
import { isRecord } from './host.ts';

export function createKtools(check: (source:string, options:JaqCheckOptions)=>Promise<JaqLibraryCheck> = checkJaqLibrary, run:typeof runJaq=runJaq) {
  // Bounded, content-addressed validity cache. Failed checks are never retained.
  const cache = new Map<string,JaqLibraryCheck>();
  async function validate(source:unknown, file=KTOOLS_FILE, signal?:AbortSignal) {
    if(typeof source!=='string') throw new Error('Library content must be a string');
    if(Buffer.byteLength(source)>WORK_MAX_BYTES) throw new Error('Knowledge library exceeds 256 KiB');
    const key=file+'\0'+source;
    let result=cache.get(key);
    if(!result) {
      result=await check(source,{programFile:file,timeoutMs:5000,signal});
      if(cache.size>=16)cache.delete(cache.keys().next().value!);
      cache.set(key,result);
    }
    return result;
  }
  async function program(root:string, address:unknown, args:unknown={}, signal?:AbortSignal) {
    if(typeof address!=='string')throw new Error('method must be a library#method address');
    const [file,name,...extra]=address.split('#');
    if(extra.length||![KTOOLS_BUILTIN,KTOOLS_FILE].includes(file)||!name||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`method must be ${KTOOLS_BUILTIN}#name or ${KTOOLS_FILE}#name`);
    if(!isRecord(args))throw new Error('args must be an object');
    const source=file===KTOOLS_BUILTIN?builtinKtoolsSource:readWorkText(root,file,'oks_project').text;
    const checked=await validate(source,file,signal);
    const signatures=checked.methods.filter(method=>method.name===name);
    if(signatures.length!==1||signatures[0].args.length!==1||!signatures[0].args[0].startsWith('$'))
      throw new Error(`${file}: method ${name} must have exactly one value parameter, e.g. def ${name}($args): ...;`);
    // Keep builtin argument diagnostics strict; defaults are also visible in source.
    if(file===KTOOLS_BUILTIN&&Object.hasOwn(args,'input'))throw new Error('Select the resource with oks_project.input');
    if(file===KTOOLS_BUILTIN)builtinCode(`builtin://knowledge/${name}.jq`,args);
    return {file,text:source+'\n'+`${name}(${JSON.stringify(args)})`};
  }
  return {validate,program,run:(text:string,options:JaqOptions)=>run(text,options)};
}
export type Ktools = ReturnType<typeof createKtools>;
