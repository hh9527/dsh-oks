// 固定时间锚点验证日历语义；必须使用真实 Wasm，不能用 JS 日期计算替代。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createJaqEngine } from './src/jaq.ts';
import { helpFiles } from './src/help-files.ts';
import { builtinCode, toolResource } from './src/knowledge-programs.ts';

const engine = createJaqEngine(process.argv[2] ?? fileURLToPath(new URL('./lib/oks-wti.wasm', import.meta.url)));
const uri = 'builtin://time/windows.jq';
const context = (at:string, zone='Asia/Shanghai') => ({utc:{epochMillis:Date.parse(at)},tz:{client:{id:zone}}});
const ctx = context('2026-10-19T11:41:03.456+08:00');
let checks = 0;
const run = async (args:Record<string,unknown>, value:unknown=ctx) => {
  const code = builtinCode(uri,args);
  const out = await engine.run(code.text,{input:{ctx:value,anchor:value},timeoutMs:5000,maxBytes:16384,programFile:uri});
  assert.equal(out.ok,true); checks++;
  return (out as any).data as any[];
};
const verify = (rows:any[]) => {
  for (const [i,row] of rows.entries()) {
    for (const b of [row.start,row.end]) assert.equal(Date.parse(b.rfc3339), b.epochMillis);
    assert.ok(row.start.epochMillis < row.end.epochMillis);
    if (i > 0) assert.deepEqual(rows[i-1].end,row.start);
  }
};
try {
  const complete = await run({unit:'month',count:3,mode:'complete'});
  assert.deepEqual(complete.map(w=>w.label),['2026-07','2026-08','2026-09']);
  assert.equal(complete[2].end.rfc3339,'2026-10-01T00:00:00+08:00');
  assert.equal(complete[2].end.epochMillis,1790784000000);
  const current = await run({unit:'month',count:5,mode:'current'});
  assert.deepEqual(current.map(w=>w.label),['2026-06','2026-07','2026-08','2026-09','2026-10']);
  assert.equal(current[4].end.rfc3339,'2026-11-01T00:00:00+08:00');
  const rolling = await run({unit:'month',count:1,mode:'rolling'});
  assert.equal(rolling[0].start.rfc3339,'2026-09-19T11:41:03.456+08:00');
  assert.equal(rolling[0].end.epochMillis,ctx.utc.epochMillis);
  const week = await run({unit:'week',count:2,mode:'complete'});
  assert.deepEqual(week.map(w=>w.label),['2026-10-05','2026-10-12']);
  const quarter = await run({unit:'quarter',count:2,mode:'current'});
  assert.deepEqual(quarter.map(w=>w.label),['2026-Q3','2026-Q4']);
  assert.equal(quarter[1].end.rfc3339,'2027-01-01T00:00:00+08:00');
  const year = await run({unit:'year',count:2,mode:'complete'});
  assert.deepEqual(year.map(w=>w.label),['2024','2025']);
  const leap = await run({unit:'month',count:2,mode:'rolling'},context('2024-03-31T12:34:56.789+08:00'));
  assert.equal(leap[0].end.rfc3339,'2024-02-29T12:34:56.789+08:00');
  const dst = await run({unit:'month',count:1,mode:'current'},context('2026-03-19T11:41:03-04:00','America/New_York'));
  assert.equal(dst[0].start.rfc3339,'2026-03-01T00:00:00-05:00');
  assert.equal(dst[0].end.rfc3339,'2026-04-01T00:00:00-04:00');
  const shortDay = await run({unit:'day',count:1,mode:'current'},context('2026-03-08T12:00:00-04:00','America/New_York'));
  assert.equal(shortDay[0].end.epochMillis-shortDay[0].start.epochMillis,23*3600000);
  const longDay = await run({unit:'day',count:1,mode:'current'},context('2026-11-01T12:00:00-05:00','America/New_York'));
  assert.equal(longDay[0].end.epochMillis-longDay[0].start.epochMillis,25*3600000);
  const midnightGap = await run({unit:'day',count:1,mode:'current'},context('2018-11-04T12:00:00-02:00','America/Sao_Paulo'));
  assert.equal(midnightGap[0].start.rfc3339,'2018-11-04T01:00:00-02:00');
  assert.equal(midnightGap[0].end.rfc3339,'2018-11-05T00:00:00-02:00');
  assert.equal(midnightGap[0].end.epochMillis-midnightGap[0].start.epochMillis,23*3600000);
  const atBoundary = await run({unit:'month',count:1,mode:'complete'},context('2026-10-01T00:00:00+08:00'));
  assert.equal(atBoundary[0].label,'2026-09');
  const renamed = await run({input:'anchor',unit:'month',count:1,mode:'current'});
  assert.equal(renamed[0].label,'2026-10');
  const max = await run({unit:'month',count:50,mode:'complete'});
  assert.equal(max.length,50);
  for (const rows of [complete,current,rolling,week,quarter,year,leap,dst,shortDay,longDay,midnightGap,atBoundary,renamed,max]) verify(rows);
  for (const args of [null,[], 'encoded', {}, {unit:'hour',count:1,mode:'complete'}, {unit:['month'],count:1,mode:'complete'}, {unit:'month',count:1,mode:['complete']}, {unit:'month',count:0,mode:'complete'}, {unit:'month',count:51,mode:'complete'}, {unit:'month',count:1.5,mode:'complete'}, {unit:'month',count:1,mode:'guess'}, {unit:'month',count:1,mode:'complete',offset:480}]) {
    assert.throws(()=>builtinCode(uri,args)); checks++;
  }
  for (const value of [null,{},context('2026-01-01T00:00:00Z','Mars/Olympus'),{utc:{epochMillis:'1790854863000'},tz:{client:{id:'UTC'}}}]) {
    await assert.rejects(run({unit:'month',count:1,mode:'complete'},value)); checks++;
  }
  assert.match(helpFiles['oks://help/time.md'],/tzfloor/);
  assert.ok((toolResource(uri) as any).source.includes('tzfloor'));
  console.log(`✓ 时间窗口 ${checks} 组检查通过：毫秒/RFC3339 一致、完整/当前/滚动、跨年/闰年、DST、连续窗口与坏输入`);
} finally {engine.dispose();}
