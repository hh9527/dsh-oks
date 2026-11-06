import {readBuildInformation} from '../src/service-metadata.ts';
import {collectProgrammedKnowledge} from '../src/programmed-knowledge.ts';
import {resolveSettings} from '../src/config.ts';
import {testAttachments} from './test-attachments.ts';
// 集成冒烟：真实插件、动态领域发现与只读数据源；在隔离工作区执行。
// @ts-expect-error 构建产物没有类型声明，路径指向 dist 里的发布树。
import { apply, artifactName, buildOption, CHART_WIDTH, embedArtifactMeta, NAME_MAX, readArtifactMeta, renderEchartsSvg, resultStamp } from '../../dist/dsh-oks/lib/index.mjs';
import { readReportPage } from '../src/report/page.ts';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { singleFlight } from '../src/single-flight.ts';
import { intentKey } from '../src/key.ts';
import { CHART_KINDS, SERIES_COLORS, supports } from '../src/chart/shared.ts';
import { tableMarkdown } from '../src/view/table.ts';
// 来源链的读取与易读视图：冒烟直接调这一层，验证编码与边界（不经工具）。
import { canonicalJson, chainLines, recordId, rowsOf } from '../src/results.ts';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ROOT = process.env.OKS_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/oks-smoke`;
// 临时测试资源在专用子目录中创建。
const workspaceListing = () => readdirSync(DEV_ROOT).filter((name) => name !== 'oks-smoke').sort().join(',');
const listingBefore = workspaceListing();
// 目录里可能已经躺着上次跑剩下的文件，所以只看"这次新增的"。
const dataListingBefore = new Set(existsSync(`${DEV_ROOT}/artifacts`) ? readdirSync(`${DEV_ROOT}/artifacts`) : []);

const registered = new Map();
/** 插件在启动时注册的页面端点路径：漏注册一条（路由表里没有）时，界面上表现为"点了没反应"。 */
const webPaths: any[] = [];
const disposers: any[] = [];
const skillsRegistered: any[] = [];
const events = new Map();
const logs: any[] = [];
// 插件可能在同一事件上注册多个监听器，桩必须按事件名把**全部**监听器收下来；触发时按注册顺序
// 走 cordis 的 waterfall：每个监听器拿到 next 继续，最外层监听器的返回值就是这一步的决策。
const listen = (map: any, name: any, listener: any) => {
  const list = map.get(name) ?? [];
  list.push(listener);
  map.set(name, list);
  return () => {
    const rest = (map.get(name) ?? []).filter((item: any) => item !== listener);
    if (rest.length > 0) map.set(name, rest); else map.delete(name);
  };
};
const listenersOf = (map: any, name: any) => map.get(name) ?? [];
const waterfall = (listeners: any, payload: any, terminal: any) => {
  const at = (index: any) => async () => (index >= listeners.length ? terminal() : listeners[index](payload, at(index + 1)));
  return at(0)();
};
const ctx = {
  logger: { info: (message: any) => { logs.push(message); console.error(`[log] ${message}`); } },
  // 技能服务是可选的：插件能拿到就注册，拿不到就静默降级。
  get: (name: any) => (name === 'attachments' ? testAttachments(SCRATCH) : name === 'skills'
    ? { register: (skill: any) => { skillsRegistered.push(skill); return () => {}; } }
    : undefined),
  tools: {
    register: (tool: any) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  effect: (fn: any) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
  // 宿主没有 web 服务时插件照常工作，所以真机上这段是可选的；这里给一个桩，
  // 让"启动时注册了哪几条端点"进入测试视野。
  inject: (deps: any, callback: any) => {
    if (!Array.isArray(deps) || !deps.includes('webServer')) return;
    const services = {
      webServer: { register: (handler: any) => { webPaths.push(handler.path); return () => {}; } },
      sessions: { get: () => undefined },
      sessionQuery: { readSession: () => undefined },
    };
    callback({
      get: (name: any) => (services as any)[name],
      effect: (fn: any) => {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
    });
  },
  // 插件按规范监听 agent/pre-step 以取得上下文时区；桩把监听器全部记下来，测试里手动触发。
  on: (name: any, listener: any) => listen(events, name, listener),
};

apply(ctx, {});
const toolNames = [...registered.keys()];
console.error(`registered tools: ${toolNames.join(', ')}\n`);
const EXPECTED_TOOLS = ['oks_read','report_extract_dari','remove_file','move_entry','dari_check','dari_resolve','dari_renew_context','oks_routes','oks_info','oks_search','va_ask'];
console.log(`=== 工具集 ===\n  ${toolNames.join(', ')} ${
  EXPECTED_TOOLS.every((name) => toolNames.includes(name)) && toolNames.length === EXPECTED_TOOLS.length ? '✓' : '✗'}`);
for (const name of EXPECTED_TOOLS) {
  if (!toolNames.includes(name)) throw new Error(`missing tool: ${name}（实际 ${toolNames.join(', ')}）`);
}
{
  const described = EXPECTED_TOOLS.every((name) => {
    const description = registered.get(name)?.description;
    return typeof description === 'string' && description.length > 0;
  });
  console.log(`  每个工具都有非空描述: ${described ? '✓' : '✗'}`);{
  if (webPaths.length) throw new Error('插件不应注册制品端点');
}

  if (!described) throw new Error('有工具的描述为空');
}
// exec 模拟 harness 传进来的 ToolRunContext：工作区从会话头里取，不由调用方给。
const sessions = new Map();
const sessionFor = (cwd: any) => {
  if (!sessions.has(cwd)) sessions.set(cwd, { id: `smoke-${sessions.size}`, header: { cwd } });
  return { agent: { session: sessions.get(cwd) } };
};
const call = async (name: any, args: any, cwd = DEV_ROOT) => {
  args = { ...args };
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  const value = await tool.execute(args, { signal: new AbortController().signal, ...sessionFor(cwd) });
  const text = tool.output.render(args, value).map((block: any) => block.text ?? '').join('');
  // 宿主还会把 presentationMeta 投影进工具结果的 meta（不进模型上下文）；这里照做一遍，
  // 好让冒烟能断言「哪些东西只留在 meta 里」。
  const meta = typeof tool.output.presentationMeta === 'function'
    ? tool.output.presentationMeta(args, value)
    : undefined;
  return { value, text, meta };
};

const modelSettings = resolveSettings(DEV_ROOT, undefined);
const modelKnowledge = await collectProgrammedKnowledge(readBuildInformation(readFileSync(modelSettings.model))!['ontology.knowledge']);
const datasetId = decodeURIComponent((modelKnowledge.graph.facts as any).find((f: any) => f.key.startsWith('datasets/') && !f.key.includes('#'))!.key.slice(9));

// 将分析稿夹具写入工作区，再通过文件路径调用工具。
const progDir = resolve(DEV_ROOT, '.work');
let progSeq = 0;
const prog = (program: any) => {
  mkdirSync(progDir, { recursive: true });
  const name = `smoke_p${++progSeq}.jq`;
  writeFileSync(resolve(progDir, name), program);
  return `.work/${name}`;
};

// 每个实例一套独立的假 ctx：工具表、事件表（按名字收全部监听器）、日志。disposer 统一在最后收尾。
const makeHarness = (config = {}) => {
  const tools = new Map();
  const harnessEvents = new Map();
  const harnessLogs: any[] = [];
  const localDisposers: any[] = [];
  apply({
    logger: { info: (message: any) => harnessLogs.push(message) },
    get: () => undefined,
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect: (fn: any) => { const d = fn(); if (typeof d === 'function') localDisposers.push(d); },
    on: (name: any, listener: any) => listen(harnessEvents, name, listener),
  }, config);
  disposers.push(...localDisposers);
  return { tools, events: harnessEvents, logs: harnessLogs, disposers: localDisposers };
};
const buildCtx = (config: any) => {
  const harness = makeHarness(config);
  return { tools: harness.tools, events: harness.events, logs: harness.logs };
};
// 知识与查询工具需要工作区；时间工具不需要。
const NOWHERE = `${SCRATCH}/nowhere`;
mkdirSync(NOWHERE, { recursive: true });

// ── 自带技能 ────────────────────────────────────────────────────────────────
console.log('=== 自带技能（注册进 runtime 层，所有工作区可见）===');
{
  const body = readFileSync(new URL('../src/skill.md', import.meta.url), 'utf8');
  const skill = skillsRegistered[0];
  console.log(`  注册次数 ${skillsRegistered.length} ${skillsRegistered.length === 1 ? '✓' : '✗'}`);
  if (skill === undefined) throw new Error('没有注册任何技能');
  console.log(`  name=${skill.name} · source=${skill.source} · ${Buffer.byteLength(skill.content, 'utf8')} 字节`);
  console.log(`  名字合法(kebab): ${/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ? '✓' : '✗'}`
    + ` · 描述非空: ${String(skill.description ?? '').length > 0 ? '✓' : '✗'}`);
  console.log(`  正文 = src/skill.md 原文: ${skill.content === body ? '✓' : '✗'}`);
  console.log(`  正文不含具体领域名: ${/\bic\b|icloud/i.test(skill.content) ? '✗' : '✓'}`);
}
let passed = 0;
const ok = (label: any, condition: any) => {
  if (!condition) throw new Error('✗ ' + label);
  passed += 1;
  console.log(`  ✓ ${label}`);
};

const refusalOf = async (run: any) => {
  try { await run(); return null; } catch (cause) { return String((cause as any)?.message ?? cause); }
};
console.log('=== 检索层：并发的首次检索只派生一次索引 ===');
{
  const [left, right] = await Promise.all([
    call('oks_info', { ids: ["datasets/"+encodeURIComponent(datasetId)] }),
    call('oks_routes', {from:'datasets/'+encodeURIComponent(datasetId),to:'datasets/'+encodeURIComponent(datasetId)}),
  ]);
  ok('并发两次首次检索只派生一次索引',
    logs.filter((line) => line.includes('build-time knowledge')).length === 1);
  ok('两个并发调用都拿到了结果', left.text.length > 0 && right.text.length > 0);
}


console.log('=== va_ask：工具边界与宿主子会话调用 ===');
{
  const calls: any[]=[];const tools=new Map();let releases=0;
  apply({...ctx,tools:{register(tool: any){tools.set(tool.name,tool);return()=>{};}},
    get(name: any){return name==='subagents'?{async listChildren(){return[];},async startActivation(spec: any){
      calls.push(spec);return{childId:spec.childId,messageId:'initial',result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'请阅读 datasets/'+encodeURIComponent(datasetId)+'，关注当前问题相关字段。\n补充说明：保持原始阅读清单。'}]}),async dispose(){releases++;}};
    },async sendMessage(){throw Error('smoke does not send');}}:ctx.get(name);}},{});
  const tool=tools.get('va_ask');
  const caller={session:{id:'smoke-parent',header:{cwd:DEV_ROOT}}};
  const result=await tool.execute({query:'丢包'},{agent:caller});
  ok('工具将调用方交给宿主管理',calls[0].request.parent===caller&&calls[0].delivery==='caller');
  ok('只调用词汇预设',calls.length===1&&calls[0].request.agentPreset==='oks-vocabulary'&&calls[0].request.prompt[0].text==='丢包');
  ok('工具等待宿主执行并返回答案',result.answer==='请阅读 datasets/'+encodeURIComponent(datasetId)+'，关注当前问题相关字段。\n补充说明：保持原始阅读清单。'&&result.messageId==='initial'&&releases===0);
  ok('模型直接在工具结果中收到答案',tool.output.render({},result)[0].text===result.answer);
  ok('拒绝空问题',/需要一个问题/.test(String(await refusalOf(()=>tool.execute({query:' '},{agent:caller})))));
  ok('拒绝递归咨询',/不咨询自己/.test(String(await refusalOf(()=>tool.execute({query:'丢包'},{agent:{session:{id:'session-va-self'}}})))));
}

console.log('=== 惰性初始化：single flight 的机制 ===');
{
  const inflight = new Map();
  let started = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((done) => { release = () => done(); });
  const start = async () => { started += 1; await gate; return 'index'; };
  const both = Promise.all([singleFlight(inflight, 'k', start), singleFlight(inflight, 'k', start)]);
  ok('并发两次只触发一次初始化', started === 1);
  release!();
  ok('两个调用拿到同一个结果', (await both).every((value) => value === 'index'));
  ok('落地后从表里撤掉（下一次可以重新触发）', inflight.size === 0);

  const failing = new Map();
  let attempts = 0;
  const boom = async () => { attempts += 1; throw new Error('boom'); };
  const first = await singleFlight(failing, 'k', boom).catch((cause) => String(cause.message));
  ok('初始化抛错时把错误交给调用者', first === 'boom');
  ok('失败不留缓存', failing.size === 0);
  const second = await singleFlight(failing, 'k', boom).catch((cause) => String(cause.message));
  ok('下一次调用会重新触发', attempts === 2 && second === 'boom');
}

console.log('=== 知识发现与文档运行 ===');
const member={dataset:datasetId};
await call('oks_info',{ids:["datasets/"+encodeURIComponent(datasetId)]});
if(!member)throw new Error('没有发现数据集');
const countIntent={op:'Graph',root:'x',nodes:[{id:'x',entity:member.dataset}],edges:[],select:[],count:'x',limit:5};
mkdirSync(join(DEV_ROOT,'.work'),{recursive:true});
const draftFile='.work/smoke_answer.dari';
const draftSource=`data ctx = context();
data months = time_windows(ctx,{unit:"month",count:2,mode:"complete"});
data facts = query(${JSON.stringify(countIntent)});
data total = select_one({from:{f:facts},group_by:(r)=>({}),fields:(g,rows)=>({groups:count(rows)})});
report answer = tree! { Report(title = "集成冒烟") [
  p [ "返回组数 ", Value(data = total?.groups), ],
] };`;
writeFileSync(join(DEV_ROOT,draftFile),draftSource);
// 模拟真实宿主：用户 RPC 建立时区，知识子会话的结果随后触发内部续跑。
const timeSession = sessionFor(DEV_ROOT).agent.session;
for (const messages of [
  [{ source: { kind: 'user', rpcId: 'smoke-time', clientTimeZone: 'Asia/Shanghai' } }],
  [{ source: { kind: 'subagent-settled' } }],
]) {
  await waterfall(listenersOf(events, 'agent/pre-step'), { agent: { session: timeSession }, messages },
    () => Promise.resolve({ kind: 'enter', messages }));
}
const checked=await call('dari_check',{src:draftFile});
ok('设计检查返回真实模型列类型',checked.value.ok && checked.value.queries.length===2 && checked.value.queries[0].columns.length>0);
ok('真实数据后处理留到运行期',checked.value.deferred.some((d: any)=>d.operator==='render_report'));
for(const name of ['oks_run_answer','oks_result','oks_show','renew_context','oks_project']) ok('agent 不暴露运行与结果入口',!registered.has(name));
const runResult=await call('dari_resolve',{answer:false,src:draftFile,data:['total'],reports:['answer']});
if(modelSettings.requireRunApproval) {
 ok('开启批准后缺少服务时禁止运行',runResult.value.status==='approval-unavailable');
} else {
 ok('默认无需批准即可运行',runResult.value.ok && runResult.value.approval==='not-required');
}
for(const limit of [undefined,0,501,1.5]){
 const intent={...countIntent,limit};
 writeFileSync(join(DEV_ROOT,draftFile),draftSource.replace(JSON.stringify(countIntent),JSON.stringify(intent)));
 ok('非法 limit 在检查时以工具异常拒绝',!!await refusalOf(()=>call('dari_check',{src:draftFile})));
}
writeFileSync(join(DEV_ROOT,draftFile),draftSource);
// Workspace configuration and executor failures must surface through the current tools.
const settings=resolveSettings(DEV_ROOT,undefined);
const baseConfig=JSON.parse(readFileSync(join(DEV_ROOT,'oks.json'),'utf8'));
for(const [name,patch] of ([
 ['missing-data',{dataFile:undefined}],
 ['bad-data',{dataFile:join(SCRATCH,'not-sqlite')}],
] as [string, any][])){
 const dir=join(SCRATCH,name);mkdirSync(join(dir,'.work'),{recursive:true});
 writeFileSync(join(SCRATCH,'not-sqlite'),'not a database');
 writeFileSync(join(dir,'oks.json'),JSON.stringify({...baseConfig,model:settings.model,...(patch as any)}));
 writeFileSync(join(dir,draftFile),draftSource.replace('data ctx = context();','').replace('data months = time_windows(ctx,{unit:"month",count:2,mode:"complete"});',''));
 const result=await call('dari_check',{src:draftFile},dir);
 ok('设计检查不依赖业务数据库',result.value.ok===true);
}
const nested=join(SCRATCH,'nested');mkdirSync(join(nested,'.work'),{recursive:true});
writeFileSync(join(nested,'oks.json'),JSON.stringify({...baseConfig,model:relative(nested,settings.model!),dataFile:relative(nested,settings.dataFile!)}));
writeFileSync(join(nested,draftFile),draftSource.replace('data ctx = context();','').replace('data months = time_windows(ctx,{unit:"month",count:2,mode:"complete"});',''));
ok('模型与数据源相对 oks.json 解析',(await call('dari_check',{src:draftFile},nested)).value.ok===true);
const bare=join(SCRATCH,'bare');mkdirSync(bare,{recursive:true});
ok('缺工作区配置明确拒绝',!!await refusalOf(()=>call('oks_info',{ids:["datasets/"+encodeURIComponent(datasetId)]},bare)));
const badModel=join(SCRATCH,'bad-model');mkdirSync(badModel,{recursive:true});
writeFileSync(join(badModel,'empty.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
writeFileSync(join(badModel,'oks.json'),JSON.stringify({...baseConfig,model:'empty.wasm',dataFile:settings.dataFile}));
ok('缺快照模型明确拒绝',!!await refusalOf(()=>call('oks_info',{ids:["datasets/"+encodeURIComponent(datasetId)]},badModel)));
const help=(await call('oks_read',{path:'oks://help/dari.md',limit:2000},bare)).value;
ok('帮助是无需配置的文本文件',help.lines.map((line:any)=>line.text).join('\n').includes('ontology-intent-v1'));
for(const args of [{load:{}},{input:draftFile+'#total',save:{}},{input:draftFile+'#total',jq:{src:'.work/nope.jq'}}])
 ok('只读入口拒绝加工与写入参数',!!await refusalOf(()=>call('dari_check',args)));
if(process.env.OKS_TOOLS_MODULE){
 const host=await import(pathToFileURL(resolve(process.env.OKS_TOOLS_MODULE)).href);
 for(const name of ['dari_check']){
  host.assertSupportedJsonSchema(registered.get(name).parameters);
  ok(`${name} schema 属于宿主支持的子集`,true);
 }
}
console.log('=== 产物命名 ===');
{
  const sha = (text: any) => createHash('sha256').update(text).digest('hex');
  const svg = '<svg/>';
  // 图的名字里写的是图元本身（`<名>.bar.svg`）；artifactName 收到的 kind 是**文件类别**。
  const named = artifactName({ at: '20261010T115343Z', name: 'alarm_by_level', kind: 'bar', extension: '.svg', content: svg });
  ok('名字里那段就是内容哈希（前缀 8 位）',
    named === `20261010T115343Z-alarm_by_level-${sha(svg).slice(0, 8)}.bar.svg`);
  ok('时间戳到秒', /^\d{8}T\d{6}Z$/.test(resultStamp()));
  // 内容不是一次拿到时那一段可以省掉（现在没有调用方这么做，但格式留了这个位置）。
  ok('没有内容就没有哈希段',
    artifactName({ at: '20261010T115343Z', name: 'x', kind: 'qres', extension: '.json' }) === '20261010T115343Z-x.qres.json');

  // 超长名字：前 53 + `~` + 6 位哈希，总长仍在上限内；`~` 是允许字符集之外的唯一记号。
  const nameOf = (fileName: any) => fileName.slice('20261010T115343Z-'.length).replace(/-[0-9a-f]{8}\.report\.html$/, '');
  const long = 'a'.repeat(NAME_MAX - 7) + 'XXXXXXX' + 'b'.repeat(20);
  const cut = artifactName({ at: '20261010T115343Z', name: long, kind: 'report', extension: '.html', content: svg });
  const cutName = nameOf(cut);
  ok(`超长名字截到 ${NAME_MAX} 字符且留了 ~ 记号`,
    cutName.length === NAME_MAX && cutName === `${long.slice(0, NAME_MAX - 7)}~${sha(long.slice(NAME_MAX - 7)).slice(0, 6)}`);
  // 只差"被截掉的那一段"的两个长名字仍要分得开：哈希覆盖的是**整个**被丢掉的部分。
  // （若按 name[N..] 取哈希，这两个名字会塌成同一个文件名。）
  const twin = artifactName({ at: '20261010T115343Z', name: `${long.slice(0, NAME_MAX - 7)}YYYYYYY${'b'.repeat(20)}`, kind: 'report', extension: '.html', content: svg });
  ok('被截掉的那一段参与哈希', nameOf(twin) !== cutName);

  // 名字是标识：字符集收得紧，`-` 与 `.` 才能当无歧义的分隔符。
  // 校验在工具入口：非法名字进不了文件名（这里先只核对纯函数，工具那条在图表一节里真跑）。
  console.log(`  命名：${named}`);
}


// ── 产物自述：写进文件里的元数据（报告 <meta>，图 <title> / <metadata>）──────────────
console.log('=== 产物自述 ===');
{
  const meta = { name: 'alarm_by_level', kind: 'chart', at: '20261010T115343Z', title: '告警等级 <分布>' };
  const svg = embedArtifactMeta('<svg width="10"><path d="M0 0"/></svg>', meta);
  ok('图的自述写在根 <svg> 之后', svg.startsWith('<svg width="10"><title>') && svg.includes('id="dsh-oks-artifact"'));
  const back = readArtifactMeta(svg);
  ok('图的自述能读回（标题里的尖括号走 XML 转义）',
    back?.title === meta.title && back?.at === meta.at && back?.name === meta.name);

  const html = embedArtifactMeta('<html><head><meta charset="utf-8"></head><body></body></html>', { ...meta, kind: 'report' });
  ok('报告的自述插在 <head> 之后', html.startsWith('<html><head>\n<meta name="dsh-oks-artifact"'));
  ok('报告的自述能读回', readArtifactMeta(html)?.kind === 'report' && readArtifactMeta(html)?.title === meta.title);
  ok('没有自述的产物读回 null', readArtifactMeta('<svg/>') === null && readArtifactMeta('{}') === null);

  // 形状不认识时报错而不是原样返回：渲染层形状变了要立刻知道，静默写出一份没有自述的产物更糟。
  const throwsWith = (run: any, needle: any) => {
    try { run(); return null; } catch (err) { const text = String((err as any)?.message ?? err); return text.includes(needle) ? text : null; }
  };
  ok('报告形状不符时报错', throwsWith(() => embedArtifactMeta('<html><body>没有 head</body></html>', { ...meta, kind: 'report' }), '<head>') !== null);
  ok('图形状不符时报错', throwsWith(() => embedArtifactMeta('not svg', meta), '<svg>') !== null);

  console.log(`  自述：${back?.title} · at=${back?.at}`);
}
console.log('=== 自包含（把 lib/ 整个目录放进空目录）===');
{
  mkdirSync(SCRATCH, { recursive: true });
  const alone = mkdtempSync(join(SCRATCH, 'alone-'));
  try {
    const libDir = fileURLToPath(new URL('../../dist/dsh-oks/lib', import.meta.url));
    copyFileSync(join(libDir,'index.mjs'),join(alone,'index.mjs'));

    const mod = await import(pathToFileURL(join(alone, 'index.mjs')).href);
    const captured: any[] = [];
    mod.apply({
      logger: { info: () => {} },
      get: (name: any) => (name === 'attachments' ? testAttachments(SCRATCH) : name === 'skills'
        ? { register: (skill: any) => { captured.push(skill); return () => {}; } }
        : undefined),
      tools: { register: () => () => {} },
      // effect 的回调必须真的执行：技能注册就在里面（收 dispose 即可）。
      effect: (fn: any) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
      on: () => () => {},
    }, {});
    ok('空目录里只放整个 lib/ 就能加载', typeof mod.apply === 'function' && captured.length === 1);
    ok('技能正文来自内联（与 asset/skill.md 逐字一致）',
      captured[0]?.content === readFileSync(new URL('../src/skill.md', import.meta.url), 'utf8'));
    const text = readFileSync(join(alone, 'index.mjs'), 'utf8');
    ok('助手提示词也内联在产物里（占位符在同一份源码里）',
      text.includes('<!-- 词表 -->')
      && readFileSync(new URL('../src/va-prompt-tpl.md', import.meta.url), 'utf8').includes('<!-- 词表 -->')
      && text.includes('<!-- 领域摘要 -->')
      && readFileSync(new URL('../src/ka-prompt-tpl.md', import.meta.url), 'utf8').includes('<!-- 领域摘要 -->'));
    // 产物自足：从空目录里真画一张图。echarts 已经打进 index.mjs，没有旁资产要读。
    const built = mod.buildOption([{ k: 'A', n: 1 }], {
      kind: 'bar', title: null, x: 'k', value: 'n',
      series: null, xType: null, xLabel: null, valueLabel: null, unit: null,
    });
    const svg = mod.renderEchartsSvg(built.option, mod.CHART_WIDTH, built.height);
    ok('空目录里也能出图（echarts 已打进产物）',
      svg.startsWith('<svg') && svg.includes('<path'));
    ok('单文件产物不依赖 jq 引擎', !text.includes('oks-wti.wasm') && !text.includes('JAQ_WORKER'));
  } finally {
    rmSync(alone, { recursive: true, force: true });
  }
}

  const gaugeMarked = (buildOption(
    [{ name: 'A', v: 88 }],
    { kind: 'gauge', title: null, x: 'name', value: 'v', series: null, marks: [{ value: 80 }] } as never,
  ).option as { series: Array<{ axisLine: { lineStyle: { color?: unknown } } }> }).series[0]!;
  ok('gauge：marks 画成阈值刻度（80 之前正常色、之后警戒色）',
    JSON.stringify(gaugeMarked.axisLine.lineStyle.color ?? '').includes('0.8'));

  const gaugeSeries = (buildOption(
    [{ name: 'A', v: 60 }, { name: 'B', v: 75 }],
    { kind: 'gauge', title: null, x: 'name', value: 'v', series: null } as never,
  ).option as { series: Array<{ min: number; max: number; data: Array<{ name: string; value: number }> }> }).series;
  ok('gauge：每行一张小仪表，值按 0–100 读',
    gaugeSeries.length === 2
    && gaugeSeries.every((one) => one.min === 0 && one.max === 100)
    && gaugeSeries[0]!.data[0]!.name === 'A' && gaugeSeries[0]!.data[0]!.value === 60);
  let gaugeOverflow = '';
  try {
    buildOption([{ name: 'A', v: 120 }],
      { kind: 'gauge', title: null, x: 'name', value: 'v', series: null } as never);
  } catch (cause) {
    gaugeOverflow = String((cause as Error)?.message ?? cause);
  }
  ok('gauge：超出 0–100 明确报错并给出两条出路',
    gaugeOverflow.includes('0–100') && gaugeOverflow.includes('bar'));

  const piePlain = buildOption([{ k: 'A', w: 3 }, { k: 'B', w: 2 }],
    { kind: 'pie', title: null, x: 'k', value: 'w', series: null } as never).option as {
      series: Array<{ radius: [string, string] }> };
  const pieDonut = buildOption([{ k: 'A', w: 3 }, { k: 'B', w: 2 }],
    { kind: 'pie', title: null, x: 'k', value: 'w', series: null, donut: true } as never).option as {
      series: Array<{ radius: [string, string] }> };
  ok('pie：donut 打开就是环形（中心留白），关掉仍是实心',
    piePlain.series[0]!.radius[0] === '0%' && pieDonut.series[0]!.radius[0] === '45%');

  // 断点：缺失点处断开（SVG 里是两段 path），打开 connectNulls 才连起来。
  // 缺口是"这段没有数据"，连起来会被读成"这段数据是平的"——两种读法在图上必须分得开。
  // 「工具收下了」不等于「画出来了」，所以这里数的是渲染出来的那条线有几个起点。
  const gapRows = [
    { d: '2026-01-01', s: '甲', w: 3 }, { d: '2026-01-02', s: '甲', w: 4 },
    { d: '2026-01-03', s: '甲', w: 5 }, { d: '2026-01-04', s: '甲', w: 6 },
    { d: '2026-01-01', s: '乙', w: 6 }, { d: '2026-01-03', s: '乙', w: 4 }, { d: '2026-01-04', s: '乙', w: 5 },
  ];
  const gapSpec = (extra: Record<string, unknown>) => ({
    kind: 'line', title: null, x: 'd', value: 'w', series: 's',
    xType: 'String', xLabel: null, valueLabel: null, unit: null, ...extra,
  });
  const gapSegments = (spec: Record<string, unknown>): number[] => {
    const built = buildOption(spec.xType==='Rfc3339'?gapRows.map(r=>({...r,d:r.d+'T00:00:00Z'})):gapRows, spec as never);
    const svg = renderEchartsSvg(built.option, CHART_WIDTH, built.height);
    return [...svg.matchAll(/<path d="([^"]*)"[^>]*stroke-linejoin="bevel"/g)]
      .map(([, d]) => ((d ?? '').match(/M/g) ?? []).length)
      .sort((a, b) => a - b);
  };
  ok('断点：缺失点处断开（有缺口的那条线画成两段）',
    JSON.stringify(gapSegments(gapSpec({}))) === '[1,2]');
  ok('断点：打开 connectNulls 才连成一条（不写就是断开）',
    JSON.stringify(gapSegments(gapSpec({ connectNulls: true }))) === '[1,1]');
  // 时间轴走另一条数据装配路（[时间, 值]）：过去这里把缺的那一行整个删掉，缺口就消失了。
  ok('断点：时间轴上的缺失点同样断开，不连过去',
    JSON.stringify(gapSegments(gapSpec({ xType: 'Rfc3339' }))) === '[1,2]'
    && JSON.stringify(gapSegments(gapSpec({ xType: 'Rfc3339', connectNulls: true }))) === '[1,1]');

  // 颜色跟实体：颜色由名字决定，同一个机房在饼图与折线图里同色，颜色能跨图对照；
  // 不打开则照旧按序列序号取色（既有图的样子不变）。
  const entityPie = [{ k: '机房甲', w: 5 }, { k: '机房乙', w: 3 }, { k: '机房丙', w: 2 }];
  const entityLine = [
    { d: 'D1', s: '机房丙', w: 2 }, { d: 'D1', s: '机房甲', w: 5 },
    { d: 'D2', s: '机房乙', w: 3 }, { d: 'D2', s: '机房甲', w: 4 },
  ];
  const pieColorOf = (entityColor: boolean | null): Record<string, string> => Object.fromEntries(
    (buildOption(entityPie, {
      kind: 'pie', title: null, x: 'k', value: 'w', series: null, entityColor,
    } as never)
      .option as { series: Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }> })
      .series[0]!.data.map((slice) => [slice.name, slice.itemStyle.color]));
  const lineColorOf = (rows: readonly Record<string, unknown>[], entityColor: boolean | null): Record<string, string> =>
    Object.fromEntries(
      (buildOption(rows, {
        kind: 'line', title: null, x: 'd', value: 'w', series: 's',
        xType: 'String', xLabel: null, valueLabel: null, unit: null, entityColor,
      } as never)
        .option as { series: Array<{ name: string; itemStyle: { color: string } }> })
        .series.map((one) => [one.name, one.itemStyle.color]));
  const namedPie = pieColorOf(true);
  const namedLine = lineColorOf(entityLine, true);
  ok('颜色跟实体：同一个实体在饼图与折线图里同色',
    Object.keys(namedPie).every((name) => namedPie[name] === namedLine[name]));
  ok('颜色跟实体：同一张图里不同实体不同色',
    new Set(Object.values(namedPie)).size === 3 && new Set(Object.values(namedLine)).size === 3);
  const reversedLine = lineColorOf([...entityLine].reverse(), true);
  ok('颜色跟实体：行序变了颜色不变（颜色跟名字，不跟行序）',
    Object.keys(namedLine).every((name) => namedLine[name] === reversedLine[name]));
  ok('颜色跟实体：不打开时照旧按序号取色（默认图的样子不变）',
    pieColorOf(null)['机房甲'] === SERIES_COLORS[0] && pieColorOf(null)['机房乙'] === SERIES_COLORS[1]);

  const graphRows = [
    { id: 'core', label: '核心', depth: 0 },
    { id: 'agg', label: '汇聚', depth: 1 },
    { id: 'acc1', label: '接入 1', depth: 2 },
    { id: 'acc2', label: '接入 2', depth: 2 },
  ];
  const graphEdges = [
    { from: 'core', to: 'agg' }, { from: 'agg', to: 'acc1' },
    { from: 'agg', to: 'acc2' }, { from: 'agg', to: 'acc1' },   // 重复边 → 合并
    { from: 'ghost', to: 'agg' },                                // 端点不在节点表 → 不进图
  ];
  const graphSpec = { kind: 'graph', title: null, x: 'from', series: 'to', value: '' };
  const graphOf = (rows: any, spec: any, nodes: any) => (buildOption(rows, spec as never, nodes as never).option as {
    series: Array<{ data: Array<{ name: string; x: number; y: number }>; links: unknown[] }>;
  }).series[0]!;
  const graphOne = graphOf(graphEdges, graphSpec, graphRows);
  const graphTwo = graphOf(graphEdges, graphSpec, graphRows);
  const at = new Map(graphOne.data.map((node) => [node.name, node]));
  ok('graph：按 depth 分层（同层同列、层间递进）',
    at.get('core')!.x < at.get('agg')!.x && at.get('agg')!.x < at.get('acc1')!.x
    && at.get('acc1')!.x === at.get('acc2')!.x && at.get('acc1')!.y !== at.get('acc2')!.y);
  ok('graph：两次渲染坐标一致（分层是确定的，不靠力引导）',
    JSON.stringify(graphOne.data) === JSON.stringify(graphTwo.data));
  ok('graph：重复边合并、端点不在节点表里的边不进图', graphOne.links.length === 3);
  const parallel = graphOf(
    [{ from: 'core', to: 'agg', label: '经 site_id' }, { from: 'core', to: 'agg', label: '经 region' },
      { from: 'core', to: 'agg', label: '经 site_id' }],
    graphSpec,
    graphRows,
  );
  ok('graph：平行边按关系名区分（不同关系名各留一条，三样都相同才合并）',
    parallel.links.length === 2
    && (parallel.links as Array<{ label: string }>).map((link) => link.label).sort().join(',')
      === '经 region,经 site_id');
  const colored = graphOf([{ from: 'a', to: 'b' }], graphSpec, [
    { id: 'a', category: '机房', depth: 0 }, { id: 'b', category: '机房', depth: 1 },
    { id: 'c', category: '链路', depth: 2 },
  ]);
  ok('graph：category 决定颜色（同类同色、异类异色）',
    (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[0]!.itemStyle?.color
      === (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[1]!.itemStyle?.color
    && (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[0]!.itemStyle?.color
      !== (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[2]!.itemStyle?.color);

  const focused = graphOf([{ from: 'a', to: 'b' }], graphSpec, [
    { id: 'a', status: 'focus', depth: 0 }, { id: 'b', depth: 1 },
  ]);
  const focusNodes = focused.data as unknown as Array<{
    name: string; symbolSize: number; itemStyle?: { color?: string };
  }>;
  ok('graph：status=focus 的节点强调、其余退为灰',
    focusNodes[0]!.symbolSize > focusNodes[1]!.symbolSize
    && focusNodes[1]!.itemStyle?.color === '#c8d2dc'
    && focusNodes[0]!.itemStyle?.color !== '#c8d2dc');

  let graphDepth = '';
  try {
    graphOf([{ from: 'a', to: 'b' }], graphSpec, [{ id: 'a' }, { id: 'b' }]);
  } catch (cause) { graphDepth = String((cause as Error)?.message ?? cause); }
  ok('graph：节点缺 depth 又没给坐标时明确报错', graphDepth.includes('depth'));

  const sankeySeries = (buildOption([
    { from: 'D1', to: 'kpi', w: 2 },
    { from: 'D1', to: 'kpi', w: 3 },
    { from: 'kpi', to: 'r1', w: 4 },
  ], { kind: 'sankey', title: null, x: 'from', value: 'w', series: 'to' } as never).option as {
    series: Array<{ data: Array<{ name: string }>; links: Array<{ source: string; target: string; value: number }> }>;
  }).series[0]!;
  ok('sankey：行是边，同一对起终点累加合并',
    sankeySeries.links.length === 2
    && sankeySeries.links.some((link) => link.source === 'D1' && link.target === 'kpi' && link.value === 5));
  ok('sankey：节点按首次出现定序并去重',
    sankeySeries.data.map((node) => node.name).join(',') === 'D1,kpi,r1');
  const sankeyDefault = buildOption(
    [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    { kind: 'sankey', title: null, x: 'from', value: '', series: 'to' } as never,
  ).option as { series: Array<{ links: Array<{ value: number }> }> };
  ok('sankey：不给 value 时每条边计 1',
    sankeyDefault.series[0]!.links.every((link) => link.value === 1));

console.log('=== DARI 路径与符号链接边界 ===');
const outside=mkdtempSync(join(tmpdir(),'dari-boundary-'));
writeFileSync(join(outside,'protected.dari'),'data n = 1;');
symlinkSync(outside,resolve(DEV_ROOT,'.work/escape-test'),'dir');
try {
 for(const name of ['dari_check','dari_renew_context'])
  ok('执行入口拒绝符号链接逃逸',!!await refusalOf(()=>call(name,{src:'.work/escape-test/protected.dari'})));
 ok('内置读取拒绝本地文件',!!await refusalOf(()=>call('oks_read',{path:'.work/escape-test/protected.dari'})));
 ok('拒绝后外部文件不变',readFileSync(join(outside,'protected.dari'),'utf8')==='data n = 1;');
} finally {rmSync(resolve(DEV_ROOT,'.work/escape-test'));rmSync(outside,{recursive:true,force:true});}
for(const dispose of disposers.reverse())dispose();
rmSync(SCRATCH,{recursive:true,force:true});
console.log(`\n✓ ${passed} / ✗ 0`);
