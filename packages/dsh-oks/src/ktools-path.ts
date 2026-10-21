import { LIBRARY_URI, BUILTIN_LIBRARY_URI } from './resource-path.ts';
export const KTOOLS_FILE = LIBRARY_URI;
export const KTOOLS_BUILTIN = BUILTIN_LIBRARY_URI;
export const KTOOLS_INITIAL_SOURCE = `# Method input is the selected resource value. Graph root: {datasets,types,relations,tools,items}.
# Read oks://builtin/tools/ktools.lib.jq for examples; invoke with oks_project({input,transform:{lib,name,args}}).
# Object keys containing Chinese or starting with digits must be quoted.
def datasets($args): .datasets | keys;
`;
