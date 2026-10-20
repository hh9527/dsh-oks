import { timeHelp, timeWindows, timeWindowCode } from './time-programs.ts';
import { queryHelp } from './query-help.ts';

const definitions = `
  def pathof: split("#") | map(split("/") | map(decode_uri)) | add;
  def fact($g; $key): ($key | pathof) as $p | $g | getpath($p);
  def identity($key): ($key | pathof) as $p
    | {key:$key,type:({datasets:"Dataset",types:"Ty",relations:"Relation",fields:"Field",dimensions:"Dimension",measures:"Measure",values:"Value",time_roles:"TimeRole",business_links:"BusinessLink"}[$p[-2]]),
       id:$p[-1],dataset:(if $p[0] == "datasets" then $p[1] else null end)};
  def page($skip; $take): {total:length,start:$skip,items:.[$skip:($skip+$take)],next:(if ($skip+$take)<length then ($skip+$take) else null end)};
  def edges($g):
    $g.items[] | .key as $source | fact($g;$source) | to_entries[]
    | . as $entry
    | if (["datasets","types","relations","fields","dimensions","measures","values","time_roles","business_links"] | index($entry.key)) != null then
        if ($entry.value | type) == "array" then $entry.value[] | {source:$source,key:.,link:$entry.key}
        elif ($entry.value | type) == "object" then $entry.value | keys[] | {source:$source,key:($source + "#" + $entry.key + "/" + (. | encode_uri)),link:$entry.key}
        else empty end
      elif (["related","traversable","referenced_by"] | index($entry.key)) != null then
        $entry.value | to_entries[] | . as $group | $group.value[] | {source:$source,key:.,link:($entry.key+"."+$group.key)}
      else empty end;
`;
export const knowledgePrograms: Record<string, {description:string;args:string[];source:string}> = {
  search: {
    description:'Search IDs, names and documentation; return exact semantic addresses and compact matches.',
    args:['input','query','type','dataset','skip','take'],
    source:definitions+`
      .[$args.input] as $g | ($args.query // "" | ascii_downcase) as $q
      | [$g.items[] | . as $item | identity(.key) as $id
         | select(($args.type == null or $id.type == $args.type) and ($args.dataset == null or $id.dataset == $args.dataset))
         | ([{field:"id",text:$id.id,weight:4}] + [$item.names[] | {field:"name",text:.,weight:3}] + [{field:"doc",text:$item.doc,weight:1}])
           | map(select(.text | ascii_downcase | contains($q))) as $hits
         | select(($hits|length)>0)
         | $id + {label:($item.names[0] // $id.id),summary:($item.doc[:160]),matched:([$hits[].field]|unique),score:([$hits[].weight]|max)}]
      | sort_by([(-.score),.key]) | page($args.skip;$args.take)`,
  },
  members: {
    description:'Read categorized outgoing navigation or owned members. link selects fields/dimensions/values/etc.; optional target type.',
    args:['input','key','link','type','skip','take'],
    source:definitions+`
      .[$args.input] as $g
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key) else
        ($g.items | map({key:.key,value:.}) | from_entries) as $docs
        | [edges($g) | select(.source == $args.key and ($args.link == null or .link == $args.link))
           | . as $edge | identity(.key) as $id | select($args.type == null or $id.type == $args.type)
           | {key:$edge.key,type:$id.type,id:$id.id,label:($docs[$edge.key].names[0] // $id.id),link:$edge.link}]
        | unique_by([.key,.link]) | sort_by([.key,.link]) | page($args.skip;$args.take) end`,
  },
  references: {
    description:'Find incoming navigation references to an exact semantic address; optional category and source type.',
    args:['input','key','link','type','skip','take'],
    source:definitions+`
      .[$args.input] as $g
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key) else
        ($g.items | map({key:.key,value:.}) | from_entries) as $docs
        | [edges($g) | select(.key == $args.key and ($args.link == null or .link == $args.link))
           | . as $edge | identity(.source) as $id | select($args.type == null or $id.type == $args.type)
           | {key:$edge.source,type:$id.type,id:$id.id,label:($docs[$edge.source].names[0] // $id.id),link:$edge.link}]
        | unique_by([.key,.link]) | sort_by([.key,.link]) | page($args.skip;$args.take) end`,
  },
  read: {
    description:'Read facts and matching descriptions together. key may address a node, a member, or a category such as datasets/alarm#dimensions. No sibling branches are expanded.',
    args:['input','key'],
    source:definitions+`
      .[$args.input] as $g | fact($g;$args.key) as $facts
      | if $facts == null then error("Unknown knowledge key: "+$args.key) else
        ($args.key + (if ($args.key|contains("#")) then "/" else "#" end)) as $prefix
        | {key:$args.key,facts:$facts,items:[$g.items[] | select(.key == $args.key or (.key|startswith($prefix)))]} end`,
  },
};
export const knowledgeHelp = {
  resource:{data:'oks_knowledge project sees {datasets,types,relations,items}; jq sees {knowledge:<graph>}. Dictionaries use original business IDs; items is [{key,names,doc}].',
    address:'Independent node: datasets/<encoded-id>, types/<encoded-id>, relations/<encoded-id>. Member: node#fields/<encoded-id>, #dimensions/<id>, #measures/<id>, #time_roles/<id>, #business_links/<id>, or types/<id>#values/<id>. Each ID is URI-component encoded exactly once in addresses; use returned keys verbatim. Dictionary keys are original IDs.',
    navigation:'Datasets own fields/dimensions/measures/time_roles/business_links dictionaries. Types own values dictionaries and categorized references such as fields/dimensions. The tool derives reverse references from ownership and forward facts; member navigation is bidirectional; related/traversable retain their category and referenced_by provides reverse navigation. Reference arrays contain addresses; owned dictionaries contain facts. References preserve associations and never grant query authorization.',
    typeFields:'types.<id>.fields includes fields exposed through dimensions declaring that value type. This is navigation, not a claim about raw field storage. Dimensions use type for their declared value-domain ID and input_kinds for accepted literal kinds.',
    projections:'Selecting a branch reads only that branch: .knowledge.types.Severity.values does not include fields. Names and prose live in items; read.jq pairs a fact slice with its descriptions. facts retain business constraints (including nulls, ordering, scope, time encoding and deterministic Latest selection).'},
  examples:{
    overview:{project:'Shape'},
    shape:{project:{datasets:'Shape',types:'Shape',relations:'Shape',items:'Shape'}},
    search:{jq:{src:'builtin://knowledge/search.jq',args:{query:'<word returned by va_ask>',take:10}}},
    read:{jq:{src:'builtin://knowledge/read.jq',args:{key:'<returned address>'}}},
    dimensions:{jq:{src:'builtin://knowledge/members.jq',args:{key:'datasets/<returned encoded ID>',link:'dimensions',take:10}}},
    valuesOnly:{project:{types:{'<original type ID>':{values:'Value'}}}},
    references:{jq:{src:'builtin://knowledge/references.jq',args:{key:'<returned address>'}}},
    fieldDescriptions:{jq:{src:'builtin://knowledge/read.jq',args:{key:'datasets/<returned encoded ID>#fields'}}},
    customSource:'.knowledge.datasets | to_entries | map({id:.key,dimensions:(.value.dimensions|keys)})',
  },
  programs:Object.fromEntries(Object.entries(knowledgePrograms).map(([name,p])=>[name,{src:`builtin://knowledge/${name}.jq`,description:p.description,args:p.args}])),
  paging:'Search/members/references defaults: input=knowledge, skip=0, take=10 (1..50). Use next as skip. read args are input and key. All run in the same Wasm jq engine as .work programs; builtin source is readable as a resource. Final output is limited to 16 KiB; narrow a branch or use builtin pagination.',
  query:'Use oks_knowledge help=oks://help/query and topic for Intent grammar. Vocabulary normalization is va_ask; verify its leads through search and facts.',
};
export function toolResource(src:string):unknown {
  if(src==='oks://help/time')return timeHelp;
  if(src==='builtin://time/windows.jq')return timeWindows;
  if(src==='oks://help/knowledge')return knowledgeHelp;
  if(src==='oks://help/query')return queryHelp;
  const match=/^builtin:\/\/knowledge\/([a-z_]+)\.jq$/.exec(src);
  if(match&&knowledgePrograms[match[1]])return knowledgePrograms[match[1]];
  throw new Error(`Unknown tool resource: ${src}`);
}
export function builtinCode(src:string,rawArgs:unknown):{file:string;text:string} {
  if(src==='builtin://time/windows.jq')return timeWindowCode(src,rawArgs);
  const match=/^builtin:\/\/knowledge\/([a-z_]+)\.jq$/.exec(src);const name=match?.[1];const program=name&&knowledgePrograms[name];
  if(!program)throw new Error(`Unknown builtin jq: ${src}`);
  if(rawArgs!==undefined&&(rawArgs===null||typeof rawArgs!=='object'||Array.isArray(rawArgs)))throw new Error('jq.args must be an object');
  const args:Record<string,unknown>={input:'knowledge',...(name==='read'?{}:{skip:0,take:10}),...rawArgs as Record<string,unknown>};
  for(const key of Object.keys(args))if(!program.args.includes(key))throw new Error(`Unknown builtin argument: ${key}`);
  if(name!=='read'&&(!Number.isSafeInteger(args.skip)||Number(args.skip)<0||!Number.isSafeInteger(args.take)||Number(args.take)<1||Number(args.take)>50))throw new Error('builtin skip must be nonnegative; take must be 1..50');
  for(const key of ['input','key','query','type','dataset','link'])if(args[key]!==undefined&&(typeof args[key]!=='string'||(key!=='query'&&args[key]==='')))throw new Error(`builtin ${key} must be a string`);
  if(name!=='search'&&typeof args.key!=='string')throw new Error('builtin requires key');
  if(typeof args.key==='string' && !/^(datasets|types|relations)\/[^/#]+(?:#[^#]+)?$/.test(args.key))throw new Error(`Unknown knowledge key: ${args.key}`);
  return {file:src,text:`${JSON.stringify(args)} as $args | ${program.source}`};
}
