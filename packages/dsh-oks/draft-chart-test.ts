import {testAttachments} from './test-attachments.ts';
import { COMPONENT_KINDS } from './src/draft/components.ts';
// Retained visual regression assertions now execute Markdown render_figure pipelines.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildOption,CHART_WIDTH} from './src/chart/option.ts';
import {renderEchartsSvg} from './src/chart/echarts.ts';
import {CHART_KINDS,SERIES_COLORS,supports} from './src/chart/shared.ts';
import {readChartInput} from './src/results.ts';
import {createDraftTools} from './src/draft/tools.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {readReportPage} from './src/report/page.ts';
import type {Knowledge,WorkspaceEntry} from './src/knowledge.ts';
import type {ToolExec} from './src/host.ts';
const DEV_ROOT=mkdtempSync(join(tmpdir(),'oks-chart-draft-'));
mkdirSync(join(DEV_ROOT,'.work'));
const entry={root:DEV_ROOT,modelHash:'fixture',settings:{workspaceRoot:DEV_ROOT,domain:'test',queryMaxRows:500}} as WorkspaceEntry;
const knowledge={ensureWorkspace:()=>entry} as Knowledge;
const drafts=createDraftTools({knowledge,timeContext:{zones:new Map(),install(){}},
 backend:(entry,file,contextZone)=>createDraftBackend({knowledge,entry,file,contextZone}),
 attachments:()=>testAttachments(DEV_ROOT),
});
const exec={agent:{session:{id:'chart-regression'}}} as ToolExec;
const call=(name:string,args:unknown)=>drafts.tools.find(tool=>tool.name===name)!.execute(args as never,exec) as Promise<any>;
let passed=0;
const ok=(label:string,condition:unknown)=>{assert.ok(condition,label);passed++;};
// This is a test fixture writer, not an adapter for the removed write tools.
const chart=async({spec,data,nodes}:any)=>{
 const file='.work/chart.dari';
 const {kind,...mapping}=spec;
 const component=Object.keys(COMPONENT_KINDS).find(key=>COMPONENT_KINDS[key as keyof typeof COMPONENT_KINDS]===kind)!;
 const source=`<Dari title="图表回归"><Pipeline>
 rows <-data(${JSON.stringify(data)},{kind:"example"});
 ${nodes?`nodes <-data(${JSON.stringify(nodes)},{kind:"example"});`:''}
 chartSpec <-${JSON.stringify(mapping)};
 figure <-render_figure(${JSON.stringify(spec)},{data:rows${nodes?',nodes':''}});
 </Pipeline><Figures><${component} name="rendered" spec={chartSpec} data={rows}${nodes?' nodes={nodes}':''}/></Figures>
 <Template name="answer"><article><figure><Figure ref="rendered"/></figure></article></Template></Dari>`;
 writeFileSync(join(DEV_ROOT,file),source);
 const result=await call('oks_run_answer',{src:file});
 if(result.delivery.status!=='ready')throw new Error(JSON.stringify(result));
 const publication=await call('oks_resolve',{src:file,figures:['figure']});assert(publication.ok,JSON.stringify(publication));
 const embedded=publication.figures.figure.embedded;const path=decodeURI(embedded.slice(embedded.indexOf('](')+2,-1));
 const shown={path,markdown:embedded,title:embedded.slice(2,embedded.indexOf(']('))};
 const figure=await call('oks_project',{input:file+'#figure'});
 return {value:{ok:true,asset:shown.path,rowCount:figure.data.rows.length,spec:figure.data.spec,title:shown.title},text:shown.markdown};
};
try {
  // 负值走 0 轴另一侧，并且换色，方向一眼可辨。
  const signed = await chart({
    spec: { kind: 'bar', title: '正负对照', x: 'label', value: 'value' },
    data: [{ label: '正', value: 5 }, { label: '负', value: -3 }],
    name: 'probe_signed',
  });
  const signedSvg = readFileSync(resolve(DEV_ROOT, signed.value.asset), 'utf8');
  console.log(`  正负对照：${signedSvg.includes('#c0567a') ? '负值用区分色 ✓' : '✗ 没有区分色'}`);
  if (!signedSvg.includes('#c0567a')) throw new Error('负值应当用区分色绘制');

  // 分组柱：横轴是类别，每个类别里按 series 分成相邻的柱子。
  const column = await chart({
    spec: {
      kind: 'column', title: '月销售额（按渠道）', x: 'month', series: 'channel', value: 'amount',
      valueLabel: '销售额（万元）',
    },
    data: [
      { month: '1月', channel: '零售', amount: 120 },
      { month: '1月', channel: '批发', amount: 90 },
      { month: '2月', channel: '零售', amount: 135 },
      // 2 月的批发刻意缺失：它的位置应当留空，而不是让后面的柱子挤过来
    ],
    name: 'probe_column',
  });
  const columnSvg = readFileSync(resolve(DEV_ROOT, column.value.asset), 'utf8');
  console.log(`  分组柱：${column.value.rowCount} 行 → ${column.value.asset} · ${(columnSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!columnSvg.startsWith('<svg')) throw new Error('分组柱应当落一份 SVG');
  if (!columnSvg.includes('<path')) throw new Error('分组柱的 SVG 里应当有图形');

  // 饼图：只画正数，负数与零跳过；配色按扇区轮转。
  const pie = await chart({
    spec: { kind: 'pie', title: '各级别占比', x: 'label', value: 'value' },
    data: [
      { label: '甲', value: 3 },
      { label: '乙', value: 5 },
      { label: '丙', value: 2 },
      { label: '零', value: 0 },
      { label: '负', value: -1 },
    ],
    name: 'probe_pie',
  });
  const pieSvg = readFileSync(resolve(DEV_ROOT, pie.value.asset), 'utf8');
  console.log(`  饼图：${pie.value.rowCount} 行 → ${(pieSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!pieSvg.startsWith('<svg') || !pieSvg.includes('<path')) throw new Error('饼图应当落一份有图形的 SVG');
  // 没有正数时也不该报错：出一张只有说明的图。
  const pieEmpty = await chart({
    spec: { kind: 'pie', x: 'label', value: 'value' },
    data: [{ label: '零', value: 0 }],
    name: 'probe_pie_empty',
  });
  if (pieEmpty.value.ok !== true) throw new Error('没有正数时饼图也应当出图');

  // 面积图：字段与折线一致，x 轴同样支持 number / time。
  const area = await chart({
    spec: { kind: 'area', title: '每日告警数', x: 'day', value: 'count', xType: 'number' },
    data: [{ day: 0, count: 15 }, { day: 1, count: 25 }, { day: 2, count: 18 }],
    name: 'probe_area',
  });
  const areaSvg = readFileSync(resolve(DEV_ROOT, area.value.asset), 'utf8');
  console.log(`  面积图：${area.value.rowCount} 行 → ${(areaSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!areaSvg.startsWith('<svg') || !areaSvg.includes('<path')) throw new Error('面积图应当落一份有图形的 SVG');

  // 排版覆盖项：用户不满意时 agent 可以调字号与高度，越界或写错项直接拒绝。
  const tuned = await chart({
    spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 14, height: 240, slantTicks: false } },
    data: [{ label: '甲', value: 3 }, { label: '乙', value: 5 }],
    name: 'probe_layout',
  });
  const tunedSvg = readFileSync(resolve(DEV_ROOT, tuned.value.asset), 'utf8');
  console.log(`  排版覆盖：labelFont/height/slantTicks 生效 → ${(tunedSvg.match(/<path/g) ?? []).length} 个 path`);
  if (!tunedSvg.includes('<path')) throw new Error('覆盖排版后仍应出图');
  // 这张图没有标题：自述里那一行**永不为空**，工具按"维度 × 度量"造一个（只进自述，不改绘制）。
  const tunedMeta = {title:tuned.value.title};
  if (tunedMeta === null) throw new Error('落盘的图应当带自述');
  if (tunedMeta.title !== 'label × value') {
    throw new Error(`没给标题时应当按维度与度量造一个，收到 ${JSON.stringify(tunedMeta.title)}`);
  }
  if (!tunedSvg.includes('<title>label × value</title>')) throw new Error('自述应当把造出来的标题也写进 <title>');
  // 造出来的标题只进自述：绘图区仍由 agent 的 spec 决定，没标题就不该有标题位。
  if (/<text[^>]*>label × value<\/text>/.test(tunedSvg)) throw new Error('造标题不该顺手把标题画进图里');
  console.log(`  自述：${tunedMeta.title}（agent 没给标题，工具造的）`);

  // 堆叠：column / area 的 stack 开关（绝对量与占比两种）。
  const stackRows = [
    { m: '1月', sev: '严重', n: 4 }, { m: '1月', sev: '重要', n: 8 },
    { m: '2月', sev: '严重', n: 5 }, { m: '2月', sev: '重要', n: 10 },
  ];
  for (const [label, stack] of [['绝对量', 'total'], ['占比', 'percent']]) {
    const stacked = await chart({
      spec: { kind: 'column', x: 'm', series: 'sev', value: 'n', stack },
      data: stackRows,
      name: 'probe_stack_' + stack,
    });
    const svg = readFileSync(resolve(DEV_ROOT, stacked.value.asset), 'utf8');
    console.log(`  堆叠（${label}）：${(svg.match(/<path/g) ?? []).length} 个 path`);
    if (!svg.includes('<path')) throw new Error(`堆叠（${label}）应当出图`);
  }

  // 散点：两个量的关系；给了 size 就是气泡。
  const scatter = await chart({
    spec: { kind: 'scatter', title: 'CPU vs 内存', x: 'cpu', value: 'mem', size: 'samples', valueLabel: '内存', unit: '%' },
    data: [
      { cpu: 74.4, mem: 88.8, samples: 720 },
      { cpu: 40.4, mem: 48.4, samples: 120 },
      { cpu: 10.4, mem: 22.4, samples: 24 },
    ],
    name: 'probe_scatter',
  });
  const scatterSvg = readFileSync(resolve(DEV_ROOT, scatter.value.asset), 'utf8');
  console.log(`  散点（带点大小）：${(scatterSvg.match(/<path/g) ?? []).length} 个 path`);
  if (!scatterSvg.includes('<path')) throw new Error('散点应当出图');

  // 组合图：第二个度量走独立的右侧数值轴。
  const comboRows = [
    { m: '1月', cpu: 36.9, ports: 526150 }, { m: '2月', cpu: 41.2, ports: 531200 },
    { m: '3月', cpu: 43.4, ports: 540880 }, { m: '4月', cpu: 39.8, ports: 549310 },
  ];
  const combo = await chart({
    spec: { kind: 'column', title: 'CPU 与端口数', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%', second: { value: 'ports', label: '端口数', unit: '个' } },
    data: comboRows,
    name: 'probe_combo',
  });
  const comboSvg = readFileSync(resolve(DEV_ROOT, combo.value.asset), 'utf8');
  // 两个轴的名字都要在：右侧轴是第二维度的落地标志。
  if (!comboSvg.includes('CPU 使用率')) throw new Error('组合图应当有左轴说明');
  if (!comboSvg.includes('端口数（个）')) throw new Error('组合图应当有右侧数值轴');
  console.log('  组合图：两个数值轴都在（' + (comboSvg.match(/<path/g) ?? []).length + ' 个 path）');
  // 可选字段不给时，回执里**不能出现 undefined**：那会让宿主把整份结果判成"不是无损 JSON"，
  // 模型拿到一条 invalid output 而不是图，而图其实已经落盘了（真机上出现过三次）。
  // 两个度量位各走一条：第二轴、参考线。
  const bareOptional = await chart({
    spec: {
      kind: 'line', title: '只给必填项的第二轴与参考线', x: 'm', value: 'cpu',
      second: { value: 'ports' }, marks: [{ value: 90 }],
    },
    data: comboRows,
    name: 'probe_optional_bare',
  });
  ok('第二轴与参考线只给必填项：回执是无损 JSON，可选键不出现',
    bareOptional.value.ok === true
    && bareOptional.value.spec.second.value === 'ports'
    && !('label' in bareOptional.value.spec.second) && !('unit' in bareOptional.value.spec.second)
    && bareOptional.value.spec.marks[0].value === 90 && !('label' in bareOptional.value.spec.marks[0])
    && readFileSync(resolve(DEV_ROOT, bareOptional.value.asset), 'utf8').includes('ports'));

  // 阈值线：值超出数据范围时，轴要撑开把它容纳进去（否则 echarts 直接不画）。
  const threshold = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%', marks: [{ value: 40, label: '基线 40%' }, { value: 55, label: '上限 55%' }] },
    data: comboRows,
    name: 'probe_marks',
  });
  const marksSvg = readFileSync(resolve(DEV_ROOT, threshold.value.asset), 'utf8');
  if (!marksSvg.includes('stroke-dasharray')) throw new Error('阈值线应当是虚线');
  if (!marksSvg.includes('基线 40%') || !marksSvg.includes('上限 55%')) {
    throw new Error('两条阈值线都应当画出来（超出数据范围的那条靠撑开的轴容纳）');
  }
  const dashedCount = (marksSvg.match(/stroke-dasharray/g) ?? []).length;
  if (dashedCount < 2) throw new Error(`两条阈值线应当在图里，只找到 ${dashedCount} 条`);
  console.log('  阈值线：' + dashedCount + ' 条虚线，标签都在');
  // 参考线属于**绘图规格**，随规格一起进图：它不进来源链（不是数据），但要能核对。
  const marksSpec = readChartInput(marksSvg)?.data.spec;
  ok('参考线随绘图规格存进图里（它属于规格，不属于数据）',
    (marksSpec?.marks ?? []).length === 2 && marksSpec.marks[1].label === '上限 55%'
    && marksSpec.unit === '%' && marksSpec.kind === 'column');

  // 横条图：数值在 x 轴上，second 与 marks 都要跟着换边。
  const barSecond = await chart({
    spec: {
      kind: 'bar', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%',
      second: { value: 'ports', label: '端口数', unit: '个' },
      marks: [{ value: 50, label: '阈值 50%' }, { value: '3月', label: '重点', axis: 'x' }],
    },
    data: comboRows,
    name: 'probe_bar_second',
  });
  const barSvg = readFileSync(resolve(DEV_ROOT, barSecond.value.asset), 'utf8');
  if (!barSvg.includes('端口数（个）')) throw new Error('横条图上的第二个度量应当有自己的轴');
  if (!barSvg.includes('阈值 50%') || !barSvg.includes('重点')) throw new Error('横条图上的两条参考线标签都该在');
  const barDashed = [...barSvg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"[^>]*stroke-dasharray/g)]
    .map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }));
  // 数值轴在 x 上：阈值是竖线；类别轴在 y 上：类别标记是横线。
  if (!barDashed.some((d) => d.x1 === d.x2)) throw new Error('横条图上的阈值线应当是竖线（数值轴在 x）');
  if (!barDashed.some((d) => d.y1 === d.y2)) throw new Error('横条图上的类别标记应当是横线');
  console.log('  横条图：second 换到 x 轴，阈值竖线 + 类别横线都在');

  // xType 不填时从数据推断。这条同时钉住"年份数字不能被当成 epoch 毫秒"——
  // 那会把横轴画到 1970 年，而且图看起来还挺正常。
  const inferredTime = await chart({
    spec: { kind: 'line', x: 't', value: 'v' },
    data: [{ t: '2026-01-01T00:00:00Z', v: 1 }, { t: '2026-01-02T00:00:00Z', v: 2 }, { t: '2026-01-03T00:00:00Z', v: 3 }],
    name: 'probe_infer_time',
  });
  if (inferredTime.value.spec.xType !== 'time') throw new Error('时间文本应当被推断成 time');
  const inferredNumber = await chart({
    spec: { kind: 'line', x: 'y', value: 'v' },
    data: [{ y: 2026, v: 1 }, { y: 2027, v: 2 }, { y: 2028, v: 3 }],
    name: 'probe_infer_number',
  });
  if (inferredNumber.value.spec.xType !== 'number') {
    throw new Error('年份数字应被推断成 number，而不是当作 epoch 毫秒');
  }
  const inferredCategory = await chart({
    spec: { kind: 'line', x: 'k', value: 'v' },
    data: [{ k: '甲', v: 1 }, { k: '乙', v: 2 }],
    name: 'probe_infer_category',
  });
  if (inferredCategory.value.spec.xType !== null) throw new Error('文本类别应当留空（走类目轴）');
  console.log('  横轴推断：时间文本→time · 年份数字→number · 文本类别→类目轴');

  // 放错层时，报错要指出正确位置——agent 靠它自己纠正，比让它在两层之间猜好。
  let misplacedMessage = '';
  try {
    await chart({
      spec: { kind: 'column', x: 'label', value: 'value', layout: { labels: true } },
      data: [{ label: 'A', value: 1 }],
    });
  } catch (cause) {
    misplacedMessage = String((cause as { message?: string })?.message ?? cause);
  }
  if (!misplacedMessage.includes('spec.style')) {
    throw new Error(`放错层的报错应当指出 labels 属于 spec.style，实际：${misplacedMessage}`);
  }
  console.log('  放错层：' + misplacedMessage.slice(0, 72));

  // 百分比堆叠：顶部要有余量（否则 100% 那条线压在轴顶上，像图被截断），但刻度仍只到 100%。
  const pctRows = Array.from({ length: 6 }, (_, i) => [
    { m: 'M' + i, s: 'a', v: 60 + i },
    { m: 'M' + i, s: 'b', v: 30 - i },
    { m: 'M' + i, s: 'c', v: 10 },
  ]).flat();
  const pct = await chart({
    spec: { kind: 'area', x: 'm', series: 's', value: 'v', stack: 'percent', valueLabel: '占比', unit: '%' },
    data: pctRows,
    name: 'probe_percent_headroom',
  });
  const pctSvg = readFileSync(resolve(DEV_ROOT, pct.value.asset), 'utf8');
  const pctTicks = [...pctSvg.matchAll(/<text[^>]*>([^<]{1,10})<\/text>/g)].map((m) => m[1].trim()).filter((t) => /%$/.test(t));
  if (!pctTicks.includes('100%')) throw new Error('百分比堆叠的刻度应当到 100%');
  if (pctTicks.some((t) => t !== '100%' && Number.parseInt(t, 10) > 100)) {
    throw new Error(`留余量用的上限不该出现在刻度上，实际刻度：${JSON.stringify(pctTicks)}`);
  }
  console.log('  百分比堆叠：刻度 ' + JSON.stringify(pctTicks) + '（上限被隐掉，顶部留了余量）');
  // 描边要比填充深一档：同色叠同色时，堆叠最上层那条外缘线会整个消失
  //（层与层之间因为有别的颜色垫着还看得出来，所以只有最上面那条出问题）。
  const strokeColors = [...new Set([...pctSvg.matchAll(/stroke="(#[0-9a-fA-F]{6})"[^>]*stroke-width="2"/g)].map((m) => m[1]))];
  const fillColors = new Set([...pctSvg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]));
  const sameColor = strokeColors.filter((color) => fillColors.has(color));
  if (sameColor.length > 0) {
    throw new Error(`描边不该与填充同色（同色等于看不见），发现：${JSON.stringify(sameColor)}`);
  }
  console.log('  描边与填充不同色：' + JSON.stringify(strokeColors));
  // 时间轴 + stack='percent'：归一化不能被时间轴分支覆盖。这条曾经让总和线一路爬出绘图区，
  // 真机上看起来就是"图被截断了"——比数值错更难发现，因为图还画得出来。
  const timePctRows = ['a', 'b', 'c'].flatMap((s2, j) =>
    Array.from({ length: 6 }, (_, i) => ({
      t: `2024-${String(i + 1).padStart(2, '0')}-01T00:00:00Z`, s: s2, v: 20 + i * 5 + j * 3,
    })));
  const timePct = await chart({
    spec: { kind: 'area', x: 't', series: 's', value: 'v', xType: 'time', stack: 'percent', valueLabel: '占比', unit: '%' },
    data: timePctRows,
    name: 'probe_time_percent',
  });
  const timePctSvg = readFileSync(resolve(DEV_ROOT, timePct.value.asset), 'utf8');
  // 总和线 = 最后一条系列的描边；归一化生效时它应当是一条平线（y 的极差极小）。
  const sumTags = [...timePctSvg.matchAll(/<path[^>]*>/g)].map((m) => m[0])
    .filter((t) => t.includes('stroke-width="2"') && /stroke="(#[0-9a-fA-F]{6})"/.test(t) && /d="M[0-9.]+ /.test(t) && !/d="M0 /.test(t));
  const last = sumTags[sumTags.length - 1];
  const sumYs = last === undefined ? [] : [...(/d="([^"]+)"/.exec(last)[1]).matchAll(/[0-9.]+ (-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const spread = sumYs.length === 0 ? Infinity : Math.max(...sumYs) - Math.min(...sumYs);
  if (spread > 3) {
    throw new Error(`时间轴上的百分比堆叠应当归一化（总和线接近水平），实际 y 极差 ${spread.toFixed(1)}px`);
  }
  console.log(`  时间轴 + percent：总和线 y 极差 ${spread.toFixed(1)}px（归一化生效）`);



  // 直方图：一列数值分箱。histogram 不需要 x，列校验也不该因此报"列不存在"。
  const manyRows = Array.from({ length: 60 }, (_, i) => ({ v: 10 + (i % 3) * 30 + i * 0.001, s: i % 2 ? 'p' : 'q' }));
  const hist = await chart({
    spec: { kind: 'histogram', value: 'v', valueLabel: '设备数', unit: '台', bins: 6, title: '取值分布' },
    data: manyRows,
    name: 'probe_hist',
  });
  const histSvg = readFileSync(resolve(DEV_ROOT, hist.value.asset), 'utf8');
  const histLabels = [...histSvg.matchAll(/<text[^>]*>([^<]{1,20})<\/text>/g)].map((m) => m[1].trim());
  if (!histSvg.includes('设备数')) throw new Error('直方图的数值轴该有名字');
  if (!histLabels.some((t) => t.includes('–'))) throw new Error('直方图的横轴该是分箱区间');
  console.log('  直方图：' + histLabels.filter((t) => t.includes('–')).length + ' 个箱');

  // 箱线图：按类别算四分位与离群点。
  const boxRows = [
    ...[12, 18, 22, 30, 45, 51, 60].map((v) => ({ site: '甲', v })),
    ...[20, 26, 31, 38, 52, 58, 70].map((v) => ({ site: '乙', v })),
    { site: '甲', v: 200 },
  ];
  const box = await chart({
    spec: { kind: 'box', x: 'site', value: 'v', valueLabel: '响应时间', unit: 'ms', title: '响应时间分布' },
    data: boxRows,
    name: 'probe_box',
  });
  const boxSvg = readFileSync(resolve(DEV_ROOT, box.value.asset), 'utf8');
  if (!boxSvg.includes('响应时间')) throw new Error('箱线图的数值轴该有名字');
  if (!boxSvg.includes('甲') || !boxSvg.includes('乙')) throw new Error('箱线图每个类别一个箱');
  console.log('  箱线图：两个类别都在');

  // 矩阵：两个类别维度 + 数值决定深浅。它是分组柱的另一种画法，同一份三元组。
  const heatRows = [
    { day: '周一', level: '严重', n: 12 }, { day: '周二', level: '严重', n: 18 },
    { day: '周一', level: '重要', n: 25 }, { day: '周二', level: '重要', n: 31 },
    { day: '周一', level: '次要', n: 40 },
    { day: '周一', level: '提示', n: 61 }, { day: '周二', level: '提示', n: 74 },
  ];
  const heatSpec = { kind: 'heatmap', title: '等级 × 星期', x: 'day', value: 'n', series: 'level' };
  const heat = await chart({ spec: heatSpec, data: heatRows, name: 'probe_heatmap' });
  const heatSvg = readFileSync(resolve(DEV_ROOT, heat.value.asset), 'utf8');
  if (!heatSvg.startsWith('<svg') || !heatSvg.includes('<path')) throw new Error('矩阵应当落一份有图形的 SVG');
  const heatBuilt = buildOption(heatRows, {
    kind: 'heatmap', title: null, sourceLabel: 'agent 自主填写', x: 'day', value: 'n', series: 'level',
    xType: null, xLabel: null, valueLabel: null, unit: null,
  });
  const heatCells = heatBuilt.option.series[0].data;
  // 4 个等级 × 2 天 = 8 个组合，数据里只有 7 个：缺的那格不画，也不补 0。
  if (heatCells.length !== 7) throw new Error(`矩阵应当只画有数据的格子（8 个组合里 7 个有数据，画了 ${heatCells.length} 个）`);
  // 颜色标尺：两端是数据里的最小 / 最大值，中间是一支连续色阶。
  const scale = heatBuilt.option.visualMap;
  if (scale.min !== 12 || scale.max !== 74) throw new Error(`颜色标尺的上下限应当是 12 与 74，收到 ${scale.min} / ${scale.max}`);
  if (!Array.isArray(scale.inRange.color) || scale.inRange.color.length < 3) {
    throw new Error('矩阵该有一条连续色阶，不是一组序列色板');
  }
  // 格子里的数字：深色格子配浅字、浅色格子配深字——中段两边都只有 3.5:1，取好的那一边。
  const labelColorOf = (value) => heatCells.find((cell) => Array.isArray(cell?.value) && cell.value[2] === value)?.label?.color;
  if (labelColorOf(74) !== '#ffffff') throw new Error(`最深那格的数字该用浅色，收到 ${labelColorOf(74)}`);
  if (labelColorOf(12) !== '#2a3540') throw new Error(`最浅那格的数字该用深色，收到 ${labelColorOf(12)}`);
  console.log(`  矩阵：8 个组合画了 ${heatCells.length} 格（缺格留白）· 色标 12–74`);

  // 最浅的那一格也要和"没数据留的白"分得开：真机上 21 个有数据的格子里有 13 个是 rgb(242,246,254)，
  // 与纯白只差 (13,9,1)——同一张图里还有 15 个空格，读者分不出哪些格子在说话。
  const wide = await chart({
    spec: { kind: 'heatmap', x: 'k', value: 'v', series: 's' },
    data: [
      { k: 'a', s: '甲', v: 1 }, { k: 'b', s: '甲', v: 100 },
      { k: 'a', s: '乙', v: 2 }, { k: 'b', s: '乙', v: 60 },
    ],
    name: 'probe_heatmap_light',
  });
  const wideSvg = readFileSync(resolve(DEV_ROOT, wide.value.asset), 'utf8');
  const fills = [...wideSvg.matchAll(/fill="rgb\((\d+),(\d+),(\d+)\)"/g)]
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
  const lightest = fills.reduce((best, fill) => (Math.min(...fill) > Math.min(...best) ? fill : best), [0, 0, 0]);
  const gap = Math.max(...lightest.map((channel) => 255 - channel));
  if (gap < 20) {
    throw new Error(`矩阵最浅的一格与纯白只差 ${gap}（${lightest}）：有数据和没数据会分不开`);
  }
  console.log(`  矩阵最浅一格 ${lightest.join(',')}，与纯白差 ${gap}`);

  // 雷达：一圈指标轴，每个对象一条闭合折线，每个指标一根自己的量纲。
  const radarRows = [
    { metric: '可用率', device: '核心', v: 99 }, { metric: '时延', device: '核心', v: 12 },
    { metric: '端口占用', device: '核心', v: 71 },
    { metric: '可用率', device: '汇聚', v: 96 }, { metric: '时延', device: '汇聚', v: 31 },
    { metric: '端口占用', device: '汇聚', v: 88 },
  ];
  const radarSpec = { kind: 'radar', title: '两台设备', x: 'metric', value: 'v', series: 'device' };
  const radar = await chart({ spec: radarSpec, data: radarRows, name: 'probe_radar' });
  const radarSvg = readFileSync(resolve(DEV_ROOT, radar.value.asset), 'utf8');
  if (!radarSvg.includes('核心') || !radarSvg.includes('汇聚')) throw new Error('雷达上的每个对象都该出现（图例）');
  const radarBuilt = buildOption(radarRows, {
    kind: 'radar', title: null, sourceLabel: 'agent 自主填写', x: 'metric', value: 'v', series: 'device',
    xType: null, xLabel: null, valueLabel: null, unit: null,
  });
  const peaks = radarBuilt.option.radar.indicator.map((entry) => entry.max);
  // 上限取 1/2/5 的整十倍数：时延最大 31 → 50，可用率最大 99 → 100。
  // 三个指标共用一根轴的话，时延会被压成贴着圆心的一道。
  if (JSON.stringify(peaks) !== '[100,50,100]') throw new Error(`每个指标该有自己的量纲，收到 ${JSON.stringify(peaks)}`);
  console.log(`  雷达：3 个指标各一根量纲 ${JSON.stringify(peaks)} · 2 个对象`);


  // 轴名里的单位不该拼两遍：agent 常把单位写进 valueLabel，同时又给 unit（真机反馈）。
  const dupUnit = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率 (%)', unit: '%' },
    data: comboRows,
    name: 'probe_unit_once',
  });
  const dupSvg = readFileSync(resolve(DEV_ROOT, dupUnit.value.asset), 'utf8');
  if (!dupSvg.includes('CPU 使用率 (%)')) throw new Error('轴名应当保留 valueLabel');
  if (dupSvg.includes('(%)（%）') || dupSvg.includes('(%)(%)')) {
    throw new Error('valueLabel 里已带单位时不该再拼一次');
  }
  // 第二个度量同理：它的轴名走的也是同一条规则。
  const secondUnit = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', second: { value: 'ports', label: '端口数 (个)', unit: '个' } },
    data: comboRows,
    name: 'probe_unit_second',
  });
  const secondSvg = readFileSync(resolve(DEV_ROOT, secondUnit.value.asset), 'utf8');
  if (secondSvg.includes('(个)（个）') || secondSvg.includes('(个)(个)')) {
    throw new Error('第二个度量的轴名也不该重复单位');
  }
  console.log('  轴名去重：valueLabel 带单位时不再重复');

  // 纵向参考线：画在类别轴上。
  const vertical = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', marks: [{ value: '3月', label: '变更窗口', axis: 'x' }] },
    data: comboRows,
    name: 'probe_marks_x',
  });
  const vertSvg = readFileSync(resolve(DEV_ROOT, vertical.value.asset), 'utf8');
  if (!vertSvg.includes('变更窗口')) throw new Error('纵向参考线的标签应当画出来');
  console.log('  纵向参考线：标签在');

  // 通用表达开关：排序与配色。
  const styled = await chart({
    spec: { kind: 'bar', x: 'site', value: 'n', style: { sort: 'desc', labels: true, colors: ['#8a6ad0'] } },
    data: [{ site: '甲', n: 1 }, { site: '乙', n: 9 }, { site: '丙', n: 5 }],
    name: 'probe_style',
  });
  const styledSvg = readFileSync(resolve(DEV_ROOT, styled.value.asset), 'utf8');
  console.log(`  表达开关（排序 + 标签 + 配色）：${styledSvg.includes('#8a6ad0') ? '配色生效' : '✗ 配色没生效'}`);
  if (!styledSvg.includes('#8a6ad0')) throw new Error('style.colors 应当覆盖色板');

  // 规格与图的校验：这些都要在画图之前被拒。
  // 分组柱 vs 堆叠柱：真机上报回来的问题——不给 stack 时柱子变成多段的一根（永远堆叠）。
  // 原来这里只断言"有图形"，而那种断言抓不到它：堆叠也是一个 <path>。所以要断言几何关系。
  const groupRows = [
    { q: 'Q1', c: '线上', v: 320 }, { q: 'Q1', c: '门店', v: 180 }, { q: 'Q1', c: '政企', v: 90 },
    { q: 'Q2', c: '线上', v: 360 }, { q: 'Q2', c: '门店', v: 175 }, { q: 'Q2', c: '政企', v: 120 },
  ];
  // 柱子是 d="M<x> <y>l<宽> 0l0 <高>l-<宽> 0Z"：竖柱看 x 与底边 y，横条看 y 与厚度。
  const barsOf = (svg) => [...svg.matchAll(/<path\b[^>]*>/g)].flatMap((match) => {
    const d = /d="M([\d.]+) ([\d.]+)l([\d.]+) 0l0 (-?[\d.]+)l-/.exec(match[0]);
    const fill = /fill="(#[0-9a-f]{6})"/.exec(match[0]);
    return d === null || fill === null ? [] : [{ x: Number(d[1]), y: Number(d[2]), w: Number(d[3]), h: Number(d[4]) }];
  });
  const barSpread = (values) => Math.max(...values) - Math.min(...values);
  const columnSpec = { kind: 'column', x: 'q', value: 'v', series: 'c' };
  const grouped = await chart({ spec: columnSpec, data: groupRows, name: 'probe_grouped' });
  const stacked = await chart({ spec: { ...columnSpec, stack: 'total' }, data: groupRows, name: 'probe_stacked' });
  const groupedBars = barsOf(readFileSync(resolve(DEV_ROOT, grouped.value.asset), 'utf8'));
  const stackedBars = barsOf(readFileSync(resolve(DEV_ROOT, stacked.value.asset), 'utf8'));
  const distinctX = (bars) => [...new Set(bars.map((bar) => bar.x))];
  // 并排：6 根柱子各占一个 x，而且都踩在同一条基线上。
  if (groupedBars.length !== 6 || distinctX(groupedBars).length !== 6 || barSpread(groupedBars.map((bar) => bar.y)) > 1) {
    throw new Error(`不给 stack 时柱子应当并排（各占一个 x、同一条基线），实际 ${JSON.stringify(groupedBars)}`);
  }
  // 堆叠：一个类别一个 x（2 个类别 2 个位置），同一个 x 上垒着三段、底边各不相同。
  const stackedX = distinctX(stackedBars);
  const legs = stackedBars.filter((bar) => bar.x === stackedX[0]).map((bar) => bar.y);
  if (stackedX.length !== 2 || legs.length !== 3 || barSpread(legs) < 10) {
    throw new Error(`stack: total 时柱子应当垒起来（同一个 x、三段不同的底），实际 ${JSON.stringify(stackedBars)}`);
  }
  // 同一个默认值不落在别的图元上：area 不给 stack 是叠着画、line 从来不分段。
  const stackOf = (kind, spec) => buildOption(groupRows, {
    kind, title: null, sourceLabel: 'agent 自主填写', x: 'q', value: 'v', series: 'c',
    xType: null, xLabel: null, valueLabel: null, unit: null, ...spec,
  }).option.series.map((item) => item.stack ?? null);
  if (JSON.stringify(stackOf('area', {})) !== '[null,null,null]') throw new Error('area 不给 stack 时不该堆叠');
  if (JSON.stringify(stackOf('line', {})) !== '[null,null,null]') throw new Error('line 没有堆叠这个说法');
  console.log('  分组柱 vs 堆叠柱：并排与垒起各就各位');

  // 横条图 + series：横向的分组条。它原来按"类别数"算高度，一个类别三条时每根只有 5px 高。
  const groupedBar = await chart({
    spec: { kind: 'bar', x: 'q', value: 'v', series: 'c' },
    data: groupRows,
    name: 'probe_bar_grouped',
  });
  const barBars = barsOf(readFileSync(resolve(DEV_ROOT, groupedBar.value.asset), 'utf8'));
  if (barBars.length !== 6) throw new Error(`横条分组应当是 6 条，收到 ${barBars.length}`);
  if (new Set(barBars.map((bar) => bar.y)).size !== 6) throw new Error('横条分组应当是 6 条各自一个 y');
  if (Math.min(...barBars.map((bar) => Math.abs(bar.h))) < 12) {
    throw new Error(`分组横条的厚度应当够读（≥12px），实际 ${Math.min(...barBars.map((bar) => Math.abs(bar.h)))}px`);
  }
  console.log(`  分组横条：6 条各自 ${Math.abs(barBars[0].h).toFixed(1)}px 厚`);

  // 折线的数值轴跟着数据收紧（柱与面积仍然从 0 起）。真机报告里的图 9/图 10 是这事的第一现场：
  // 可用率 98.4–99.9% 落在 0–100 的轴上，三条线的全部差距只有 3px，图注说的"一起下沉"根本看不见。
  const kpiRows = ['1月', '2月', '3月'].flatMap((month, index) => [
    { month, device: '甲', v: [99.8, 99.4, 99.9][index] },
    { month, device: '乙', v: [99.6, 98.41, 99.9][index] },
  ]);
  const axisTicksOf = (svg) => [...svg.matchAll(/<text[^>]*>([^<]{1,12})<\/text>/g)]
    .map((match) => match[1].trim()).filter((text) => /^-?[\d.]+$/.test(text)).map(Number);
  const lineSpec = { kind: 'line', x: 'month', value: 'v', series: 'device', unit: '%' };
  const kpiLine = await chart({ spec: lineSpec, data: kpiRows, name: 'probe_line_kpi' });
  const lineTicks = axisTicksOf(readFileSync(resolve(DEV_ROOT, kpiLine.value.asset), 'utf8'));
  if (Math.min(...lineTicks) < 90) {
    throw new Error(`折线的数值轴应当贴住数据（98.4% 起），实际最低刻度 ${Math.min(...lineTicks)}`);
  }
  // 面积与柱不从 0 起会说谎（长度/面积本身就是量），所以它们照旧。
  const kpiArea = await chart({ spec: { ...lineSpec, kind: 'area' }, data: kpiRows, name: 'probe_area_kpi' });
  const areaTicks = axisTicksOf(readFileSync(resolve(DEV_ROOT, kpiArea.value.asset), 'utf8'));
  if (Math.min(...areaTicks) !== 0) throw new Error(`面积的数值轴应当从 0 起，实际最低刻度 ${Math.min(...areaTicks)}`);
  // 轴收紧之后，比数据还低的参考线不能像上一波那样静默消失。
  const marked = await chart({
    spec: { ...lineSpec, marks: [{ value: 98, label: '可用率下限' }] },
    data: kpiRows,
    name: 'probe_line_mark_low',
  });
  const markedSvg = readFileSync(resolve(DEV_ROOT, marked.value.asset), 'utf8');
  if (!markedSvg.includes('可用率下限')) throw new Error('低于数据的参考线也该画出来（轴要为它让出下界）');
  console.log(`  折线轴收紧：线图最低刻度 ${Math.min(...lineTicks)} · 面积图 ${Math.min(...areaTicks)} · 轴外阈值线仍在`);

  // 竖着排的类别轴自上而下：横条图的"第一名"在最上面，矩阵的第一行在最上面。
  // 横条原来是从下往上（Top-N 排名得反着读），矩阵的行也一样——而我们还把数值写进格子里、
  // 说它"同时就是一张表"。表格不会从最后一行开始读。
  const rankRows = [{ k: '第一项', v: 100 }, { k: '第二项', v: 60 }, { k: '第三项', v: 20 }];
  const rankBars = async (kind, name) => barsOf(readFileSync(resolve(DEV_ROOT, (await chart({
    spec: { kind, x: 'k', value: 'v' },
    data: rankRows,
    name,
  })).value.asset), 'utf8'));
  const horizontalBars = (await rankBars('bar', 'probe_bar_rank')).sort((a, b) => b.w - a.w);
  if (!(horizontalBars[0].y < horizontalBars[horizontalBars.length - 1].y)) {
    throw new Error(`横条最长的那根（第一名）应当在最上面，实际 y=${horizontalBars[0].y} 与 ${horizontalBars[2].y}`);
  }
  // 竖柱照旧从左往右：这条规则只落在"竖着排的类别轴"上。
  const verticalBars = await rankBars('column', 'probe_column_rank');
  if (!(verticalBars[0].x < verticalBars[verticalBars.length - 1].x)) {
    throw new Error('竖柱的第一项应当仍在最左边');
  }
  const matrixRows = await chart({
    spec: { kind: 'heatmap', x: 'k', value: 'v', series: 's' },
    data: rankRows.flatMap((row, index) => [{ ...row, s: '甲' }, { ...row, s: '乙', v: 3 - index }]),
    name: 'probe_heatmap_rows',
  });
  const matrixSvg = readFileSync(resolve(DEV_ROOT, matrixRows.value.asset), 'utf8');
  const labelY = (svg, text) => {
    for (const match of svg.matchAll(/<text[^>]*transform="translate\(([\d.]+) ([\d.]+)\)"[^>]*>([\s\S]*?)<\/text>/g)) {
      if (match[3].includes(text)) return Number(match[2]);
    }
    return null;
  };
  const firstRow = labelY(matrixSvg, '甲');
  const secondRow = labelY(matrixSvg, '乙');
  if (!(firstRow !== null && secondRow !== null && firstRow < secondRow)) {
    throw new Error(`矩阵的第一行应当在最上面，实际甲 y=${firstRow}、乙 y=${secondRow}`);
  }
  console.log(`  竖着排的类别轴：横条第一名 y=${horizontalBars[0].y}（最上）· 矩阵第一行 y=${firstRow}`);

  // 图元专属开关的适用表只有一份（shared.ts）。把"开关 × 图元"逐个真跑一遍：
  // 表里写支持的必须收下，不支持的必须按表报错。表改了而校验没跟上，这里当场露馅；
  // 报错文案也必须是"spec.<开关>"这一条，免得它其实是因为别的原因被拒、看起来却像通过了。
  // 注册表也要跟着图元走：series 类型没注册时 echarts 静默不画，工具却回 ok——
  // 「工具收下了」不等于「画出来了」，所以这里读一眼渲染出来的 SVG 里有没有内容。
  const sankeyBlank = (await chart({
    spec: { kind: 'sankey', x: 'k', series: 's', value: 'w' },
    data: [{ k: 'D1', s: 'kpi', w: 2 }, { k: 'kpi', s: 'r1', w: 1 }],
    name: 'probe_sankey_registered',
  })).value;
  const sankeySvg = readFileSync(resolve(DEV_ROOT, sankeyBlank.asset), 'utf8');
  ok('sankey：渲染出的 SVG 里有节点名（不是空白）',
    sankeySvg.includes('D1') && sankeySvg.includes('kpi'));
  const gaugeBlank = (await chart({
    spec: { kind: 'gauge', x: 'k', value: 'w' },
    data: [{ k: '可用率', w: 88 }],
    name: 'probe_gauge_registered',
  })).value;
  const gaugeSvg = readFileSync(resolve(DEV_ROOT, gaugeBlank.asset), 'utf8');
  ok('gauge：渲染出的 SVG 里有名称与数值（不是空白）',
    gaugeSvg.includes('可用率') && gaugeSvg.includes('88'));
  const graphNodes=[{id:'core',label:'核心',depth:0},{id:'edge',label:'接入',depth:1}];
  const graphEdges=[{from:'core',to:'edge',label:'经 site_id'}];
  const graph=await chart({spec:{kind:'graph',x:'from',series:'to'},data:graphEdges,nodes:graphNodes});
  const graphSvg=readFileSync(resolve(DEV_ROOT,graph.value.asset),'utf8');
  ok('graph SVG 包含节点与边名称',graphSvg.includes('核心') && graphSvg.includes('经 site_id'));
  const graphInput=readChartInput(graphSvg)!;
  assert.deepEqual(graphInput.data.rows,graphEdges);
  assert.deepEqual(graphInput.data.nodeRows,graphNodes);
  const graphRoot=graphInput.origin.nodes[graphInput.origin.root];
  assert.deepEqual(Object.keys(graphRoot.inputs!).sort(),['data','nodes']);
  for(const parent of Object.values(graphRoot.inputs!))assert.ok(graphInput.origin.nodes[parent]);
  const archived=await call('oks_run_answer',{src:'.work/chart.dari'});
  assert.equal(archived.delivery.status,'ready');
  const publication=await call('oks_resolve',{src:'.work/chart.dari',reports:['answer']});assert(publication.ok,JSON.stringify(publication));
  const embedded=publication.reports.answer.embedded;
  const graphReport=readReportPage(readFileSync(decodeURI(embedded.slice(embedded.indexOf('](')+2,-1)),'utf8'));
  assert.ok(!('error' in graphReport));
  assert.deepEqual((graphReport.dari.figures.rendered.data as any).nodeRows,graphNodes);
  assert.deepEqual((graphReport.dari.figures.rendered.data as any).rows,graphEdges);
  const minimalSpec: Record<string, Record<string, unknown>> = {
    bar: { x: 'k', value: 'w' },
    line: { x: 'k', value: 'w' },
    column: { x: 'k', value: 'w' },
    pie: { x: 'k', value: 'w' },
    area: { x: 'k', value: 'w' },
    scatter: { x: 'w', value: 'w' },
    histogram: { value: 'w' },
    box: { x: 'k', value: 'w' },
    heatmap: { x: 'k', value: 'w', series: 's' },
    radar: { x: 'k', value: 'w', series: 's' },
    // 新图元也要进这张表：不变量测试是"开关 × 图元"逐个真跑，缺了条目就等于没被覆盖
    // （gauge 缺 x/value 时会被"必须给 x 与 value"拒掉，看起来却像开关不支持）。
    sankey: { x: 'k', series: 's', value: 'w' },
    gauge: { x: 'k', value: 'w' },
    graph: { x: 'k', series: 's', value: 'w' },
  };
  const switchValue: Record<string, unknown> = {
    stack: 'total', size: 'w', bins: 4, second: { value: 'w' }, marks: [{ value: 1 }], donut: true,
    connectNulls: true, entityColor: true,
  };
  // 一份能让所有图元都过关的数据：两个分组 × 三个类别（雷达因此有 3 个指标且没有缺口）。
  const gridRows = ['a', 'b', 'c'].flatMap((k, i) => ['p', 'q'].map((s, j) => ({ k, s, w: i + j + 1 })));
  let checked = 0;
  for (const feature of Object.keys(switchValue)) {
    for (const kind of CHART_KINDS) {
      const expected = supports(kind, feature);
      let message = '';
      let accepted = true;
      try {
        await chart({
          spec: { kind, ...minimalSpec[kind], [feature]: switchValue[feature] },
          data: gridRows,
          nodes: kind==='graph' ? [...new Set(gridRows.flatMap(row=>[row.k,row.s]))].map((id,depth)=>({id,depth})) : undefined,
        });
      } catch (cause) { accepted = false; message = String(cause?.message ?? cause); }
      if (accepted !== expected) {
        throw new Error(`${kind} + ${feature}：表里写${expected ? '支持' : '不支持'}，实际${accepted ? '收下了' : '被拒了'}（${message.slice(0, 60)}）`);
      }
      if (!expected && !message.includes(`spec.${feature}`)) {
        throw new Error(`${kind} + ${feature}：被拒的理由不是这个开关，而是 ${message.slice(0, 60)}`);
      }
      checked += 1;
    }
  }
  console.log(`  开关适用表：${Object.keys(switchValue).length} 个开关 × ${CHART_KINDS.length} 种图元 = ${checked} 组，逐一核对`);
  const failures = [
    ['列不存在', { spec: { kind: 'bar', x: 'nope', value: 'nope2' }, data: [{ a: 1 }] }],
    ['bar 缺 value', { spec: { kind: 'bar', x: 'label' }, data: [{ label: 'A' }] }],
    ['pie 缺 value', { spec: { kind: 'pie', x: 'label' }, data: [{ label: 'A' }] }],
    ['layout 越界', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 4 } }, data: [{ label: 'A', value: 1 }] }],
    ['layout 写错项', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { nope: 1 } }, data: [{ label: 'A', value: 1 }] }],
    ['stack 填给 bar', { spec: { kind: 'bar', x: 'label', value: 'value', stack: 'total' }, data: [{ label: 'A', value: 1 }] }],
    ['size 填给 column', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', size: 'n' }, data: [{ label: 'A', s: 'x', value: 1 }] }],
    ['stack 取值非法', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', stack: 'nope' }, data: [{ label: 'A', s: 'x', value: 1 }] }],
    ['style.sort 非法', { spec: { kind: 'bar', x: 'label', value: 'value', style: { sort: 'nope' } }, data: [{ label: 'A', value: 1 }] }],
    ['style.colors 非法', { spec: { kind: 'bar', x: 'label', value: 'value', style: { colors: ['red'] } }, data: [{ label: 'A', value: 1 }] }],
    ['scatter 缺 value', { spec: { kind: 'scatter', x: 'a' }, data: [{ a: 1 }] }],
    ['histogram 缺 value', { spec: { kind: 'histogram' }, data: [{ a: 1 }] }],
    ['box 缺 x', { spec: { kind: 'box', value: 'v' }, data: [{ v: 1 }] }],
    ['bins 填给 column', { spec: { kind: 'column', x: 'label', value: 'value', bins: 5 }, data: [{ label: 'A', value: 1 }] }],
    ['bins 越界', { spec: { kind: 'histogram', value: 'value', bins: 999 }, data: [{ value: 1 }] }],
    ['heatmap 缺 series', { spec: { kind: 'heatmap', x: 'day', value: 'n' }, data: [{ day: 'a', n: 1 }] }],
    ['radar 缺 series', { spec: { kind: 'radar', x: 'm', value: 'v' }, data: [{ m: 'a', v: 1 }] }],
    ['radar 指标不足 3', { spec: { kind: 'radar', x: 'm', value: 'v', series: 's' }, data: [{ m: 'a', s: 'x', v: 1 }, { m: 'b', s: 'x', v: 2 }] }],
    // 雷达没有"留白"这个选项：缺的顶点 echarts 会画在圆心，看起来就是"这一维是 0"。
    ['radar 有缺口', {
      spec: { kind: 'radar', x: 'm', value: 'v', series: 's' },
      data: [{ m: 'a', s: 'x', v: 1 }, { m: 'b', s: 'x', v: 2 }, { m: 'c', s: 'x', v: 3 }, { m: 'a', s: 'y', v: 4 }, { m: 'b', s: 'y', v: 5 }],
    }],
    ['second 填给 pie', { spec: { kind: 'pie', x: 'label', value: 'value', second: { value: 'n' } }, data: [{ label: 'A', value: 1, n: 2 }] }],
    ['second 缺 value', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { label: 'x' } }, data: [{ label: 'A', s: 'p', value: 1 }] }],
    ['second.kind 非 line', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { value: 'n', kind: 'bar' } }, data: [{ label: 'A', s: 'p', value: 1, n: 2 }] }],
    ['marks 填给 scatter', { spec: { kind: 'scatter', x: 'a', value: 'b', marks: [{ value: 1 }] }, data: [{ a: 1, b: 2 }] }],
    ['marks.axis 非法', { spec: { kind: 'bar', x: 'label', value: 'value', marks: [{ value: 1, axis: 'z' }] }, data: [{ label: 'A', value: 1 }] }],
    ['marks.value 类型非法', { spec: { kind: 'bar', x: 'label', value: 'value', marks: [{ value: true }] }, data: [{ label: 'A', value: 1 }] }],
    ['second 指向不存在的列', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { value: 'nope' } }, data: [{ label: 'A', s: 'p', value: 1 }] }],
  ];
  for (const [label, args] of failures) {
    let rejected = false;
    let message = '';
    try { await chart( args); } catch (cause) { rejected = true; message = String(cause?.message ?? cause); }
    console.log(`  ${String(label).padEnd(10)} → ${rejected ? '✓ 被拒' : '✗ 未拒'} ${message.slice(0, 64)}`);
    if (!rejected) throw new Error(`render_figure ${label} 应当被拒`);
  }
  const empty = await chart({ spec: { kind: 'bar', x: 'label', value: 'value' }, data: [] });
  console.log(`  空数组有效: ${empty.value.ok === true && empty.value.rowCount === 0 ? '✓' : '✗'}`);
  if (empty.value.ok !== true) throw new Error('空数组应当是有效输入');

 console.log(`chart regression: ${passed} visual assertions plus switch matrix and invalid specs passed through draft tools`);
}finally{drafts.dispose();rmSync(DEV_ROOT,{recursive:true,force:true});}
