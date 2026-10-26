import builtinKtoolsSource from './builtin/ktools.lib.jq';
import { timeWindows, timeWindowCode } from './time-programs.ts';

// 方法元数据直接描述接口；使用说明位于 Markdown 帮助和 jq 源码注释。
const methodDescriptions:Record<string,string> = {
  search:'检索 ID、名称和说明，返回语义地址与精简匹配结果。',
  members:'读取分类出向引用或自有成员。',
  references:'查找指向精确语义地址的入向引用。',
  read:'配对读取事实分支与对应说明。',
  overview:'分页列出数据集名称、粒度与能力数量。',
  card:'分页读取数据集的维度、度量、时间角色、关系与值域。',
  nodes:'批量读取节点的说明、提纲或精简事实。',
  routes:'在深度、路径数与边检查预算内探索有向连接。',
};

// jq 实现在独立源码中；这里仅描述工具参数并执行入口校验。
const methodArgs:Record<string,string[]> = {
  search:["input","query","type","dataset","skip","take"],
  members:["input","key","link","type","skip","take"],
  references:["input","key","link","type","skip","take"],
  read:["input","key"],
  overview:["input","skip","take","include_source"],
  card:["input","id","section","skip","take","docs","value_skip"],
  nodes:["input","keys","mode","take","docs","expand"],
  routes:["input","nodes","max_depth","max_paths","budget","via","avoid"],
};
const methodDefaults=(name:string):Record<string,unknown>=>({
  search:{skip:0,take:10},members:{skip:0,take:10},references:{skip:0,take:10},read:{},
  overview:{skip:0,take:40,include_source:true},
  card:{section:'all',skip:0,take:20,docs:false,value_skip:0},
  nodes:{mode:'docs',take:8,docs:true,expand:[]},
  routes:{max_depth:3,max_paths:20,budget:20000,via:[],avoid:[]},
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
  for(const key of ['input','key','query','type','dataset','link','id','section','mode'])if(args[key]!==undefined&&(typeof args[key]!=='string'||(key!=='query'&&args[key]==='')))throw new Error(`builtin ${key} must be a string`);
  if(['read','members','references'].includes(name)&&typeof args.key!=='string')throw new Error('builtin requires key');
  if(typeof args.key==='string' && !/^(entities|datasets|dimension_groups|measure_groups|types|relations|tools)\/[^/#]+(?:#[^#]+)?$/.test(args.key))throw new Error(`Unknown knowledge key: ${args.key}`);
  for(const key of ['docs','include_source'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new Error(`builtin ${key} must be boolean`);
  for(const key of ['keys','nodes','expand','via','avoid'])if(args[key]!==undefined&&(!Array.isArray(args[key])||args[key].length>50||args[key].some(value=>typeof value!=='string'||!value)))throw new Error(`builtin ${key} must be an array of at most 50 nonempty strings`);
  if(name==='card') {
    if(typeof args.id!=='string')throw new Error('card requires dataset id');
    if(!['all','shape','dimensions','measures','time_roles','relations','values'].includes(args.section as string))throw new Error('Unknown card section');
    if(!Number.isSafeInteger(args.value_skip)||Number(args.value_skip)<0)throw new Error('value_skip must be nonnegative');
  }
  if(name==='nodes') {
    if(!Array.isArray(args.keys))throw new Error('nodes requires keys');
    if(!['docs','facts','both'].includes(args.mode as string))throw new Error('Unknown nodes mode');
  }
  if(name==='routes') {
    if(!Array.isArray(args.nodes)||args.nodes.length!==2)throw new Error('routes requires exactly 2 nodes');
    for(const [key,min,max]of [['max_depth',0,8],['max_paths',1,50],['budget',1,20000]] as const)
      if(!Number.isSafeInteger(args[key])||Number(args[key])<min||Number(args[key])>max)throw new Error(`routes ${key} must be ${min}..${max}`);
  }
  return {file:src,text:`.[${JSON.stringify(args.input)}] | ${builtinKtoolsSource}\n${name}(${JSON.stringify(args)})`};
}
