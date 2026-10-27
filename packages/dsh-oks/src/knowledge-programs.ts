import builtinKtoolsSource from './builtin/ktools.lib.jq';
import { timeWindows, timeWindowCode } from './time-programs.ts';

// 方法元数据直接描述接口；使用说明位于 Markdown 帮助和 jq 源码注释。
const methodDescriptions:Record<string,string> = {
  search:'检索 ID、名称和说明，返回语义地址与精简匹配结果。',
  members:'读取分类出向引用或自有成员。',
  references:'查找指向精确语义地址的入向引用。',
  read:'配对读取事实分支与对应说明。',
  overview:'分页列出数据集名称、粒度与能力数量。',
  card:'分页读取 Dataset 的角色、绑定、维度、度量、时间角色与关系事实。',
  nodes:'批量读取节点的说明、提纲或精简事实。',
  cap:'发现目标的模型能力、约束与关联候选，返回事实引用和待 transform 验证的查询骨架。',
  shape_audit:'核对当前知识图观察到的类别和事实键。',
  metric_map:'按成员名子串发现相关 Dataset、单位与时间能力。',
  figure_kinds:'发现插件提供的图表组件、映射与开关。',
};

// jq 实现在独立源码中；这里仅描述工具参数并执行入口校验。
const methodArgs:Record<string,string[]> = {
  search:["input","query","type","dataset","skip","take"],
  members:["input","key","link","type","skip","take"],
  references:["input","key","link","type","skip","take"],
  read:["input","key"],
  overview:["input","skip","take","include_source"],
  card:["input","id","section","skip","take","docs"],
  nodes:["input","keys","mode","take","docs","expand"],
  cap:["input","cq","join_depth","skip","take"],
  shape_audit:["input"], metric_map:["input","pattern","skip","take"], figure_kinds:["input"],
};
const methodDefaults=(name:string):Record<string,unknown>=>({
  search:{skip:0,take:10},members:{skip:0,take:10},references:{skip:0,take:10},read:{},
  overview:{skip:0,take:40,include_source:true},
  card:{section:'all',skip:0,take:20,docs:false},
  nodes:{mode:'docs',take:8,docs:true,expand:[]},
  cap:{join_depth:1,skip:0,take:20},shape_audit:{},metric_map:{skip:0,take:20},figure_kinds:{},
}[name] ?? {});
export {builtinKtoolsSource};
export const knowledgePrograms:Record<string,{description:string;args:string[];source:string}> =
  Object.fromEntries(Object.entries(methodArgs).map(([name,args])=>[name,{
    description:methodDescriptions[name],args,source:`${builtinKtoolsSource}\n${name}($args)`,
  }]));

export function toolResource(src:string):unknown {
  if(src==='builtin://time/windows.jq')return timeWindows;
  if(src==='oks://builtin/tools/ktools.lib.jq')return {source:builtinKtoolsSource,readonly:true};
  const match=/^builtin:\/\/knowledge\/([a-z_]+)\.jq$/.exec(src);
  if(match&&knowledgePrograms[match[1]])return knowledgePrograms[match[1]];
  throw new Error(`Unknown tool resource: ${src}`);
}
export function builtinCode(src:string,rawArgs:unknown):{file:string;text:string} {
  if(src==='builtin://time/windows.jq')return timeWindowCode(src,rawArgs);
  const match=/^builtin:\/\/knowledge\/([a-z_]+)\.jq$/.exec(src);const name=match?.[1];const program=name&&knowledgePrograms[name];
  if(!program)throw new Error(`Unknown builtin jq: ${src}`);
  if(rawArgs!==undefined&&(rawArgs===null||typeof rawArgs!=='object'||Array.isArray(rawArgs)))throw new Error('jq.args must be an object');
  const args:Record<string,unknown>={input:'knowledge',...methodDefaults(name),...rawArgs as Record<string,unknown>};
  for(const key of Object.keys(args))if(!program.args.includes(key))throw new Error(`Unknown builtin argument: ${key}`);
  if((program.args.includes('skip')&&(!Number.isSafeInteger(args.skip)||Number(args.skip)<0))||(program.args.includes('take')&&(!Number.isSafeInteger(args.take)||Number(args.take)<1||Number(args.take)>50)))throw new Error('builtin skip must be nonnegative; take must be 1..50');
  for(const key of ['input','key','query','type','dataset','link','id','section','mode','pattern'])if(args[key]!==undefined&&(typeof args[key]!=='string'||(key!=='query'&&args[key]==='')))throw new Error(`builtin ${key} must be a string`);
  if(['read','members','references'].includes(name)&&typeof args.key!=='string')throw new Error('builtin requires key');
  if(typeof args.key==='string' && !/^(entities|datasets|dimension_groups|measure_groups|types|relations|tools)\/[^/#]+(?:#[^#]+)?$/.test(args.key))throw new Error(`Unknown knowledge key: ${args.key}`);
  for(const key of ['docs','include_source'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new Error(`builtin ${key} must be boolean`);
  for(const key of ['keys','expand'])if(args[key]!==undefined&&(!Array.isArray(args[key])||args[key].length>50||args[key].some(value=>typeof value!=='string'||!value)))throw new Error(`builtin ${key} must be an array of at most 50 nonempty strings`);
  if(name==='card') {
    if(typeof args.id!=='string')throw new Error('card requires dataset id');
    if(!['all','shape','roles','bindings','dimensions','measures','time_roles','relations','business_links'].includes(args.section as string))throw new Error('Unknown card section');
  }
  if(name==='nodes') {
    if(!Array.isArray(args.keys))throw new Error('nodes requires keys');
    if(!['docs','facts','both'].includes(args.mode as string))throw new Error('Unknown nodes mode');
  }
  if(name==='metric_map' && (typeof args.pattern!=='string' || !args.pattern.trim()))throw new Error('metric_map requires a nonempty pattern');
  if(name==='cap') {
    if(!Number.isSafeInteger(args.join_depth)||Number(args.join_depth)<0||Number(args.join_depth)>2)throw new Error('cap join_depth must be 0..2');
    const record=(value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value);
    const cq=args.cq;
    if(!record(cq)||!record(cq.target))throw new Error('cap requires cq.target');
    for(const key of Object.keys(cq))if(!['target','node','select','measures','window','rank'].includes(key))throw new Error(`Unknown cq field: ${key}`);
    const targets=Object.keys(cq.target);
    if(targets.length!==1||!['dataset','entity'].includes(targets[0])||typeof cq.target[targets[0]]!=='string'||!cq.target[targets[0]])throw new Error('cq.target requires exactly one dataset or entity ID');
    if(cq.node!==undefined&&(typeof cq.node!=='string'||!cq.node))throw new Error('cq.node must be a nonempty string');
    for(const [field,member] of [['select','dimension'],['measures','measure']] as const) {
      const entries=cq[field];
      if(entries!==undefined&&(!Array.isArray(entries)||entries.length>50||entries.some(item=>!record(item)||Object.keys(item).length!==1||typeof item[member]!=='string'||!item[member])))throw new Error(`cq.${field} requires at most 50 {${member}: ID} entries`);
    }
    for(const [field,member,allowed] of [['window','dimension',['dimension','start','end']],['rank','measure',['measure','direction','take']]] as const){
      const value=cq[field];
      if(value!==undefined&&value!==null&&(!record(value)||typeof value[member]!=='string'||!value[member]||Object.keys(value).some(k=>!(allowed as readonly string[]).includes(k))))throw new Error(`cq.${field} requires ${member} and declared request fields`);
    }
  }
  return {file:src,text:`.[${JSON.stringify(args.input)}] | ${builtinKtoolsSource}\n${name}(${JSON.stringify(args)})`};
}
