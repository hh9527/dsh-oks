import assert from 'node:assert/strict';
import { buildOption, CHART_WIDTH } from './src/chart/option.ts';
import { renderEchartsSvg } from './src/chart/echarts.ts';
import { NEGATIVE_COLOR, SERIES_COLORS } from './src/chart/shared.ts';

// Each series has two marks and one legend swatch. The SVG must use its
// assigned color for all three, including with custom and entity palettes.
for (const kind of ['column', 'bar', 'line', 'area'] as const) {
  for (const style of [{}, { colors: ['#123456', '#789abc'] }]) {
    for (const entityColor of [false, true]) {
      const built = buildOption([
        { tenant: 'A', severity: 'critical', n: 3 },
        { tenant: 'B', severity: 'critical', n: 4 },
        { tenant: 'A', severity: 'major', n: 5 },
        { tenant: 'B', severity: 'major', n: -6 },
      ], {
        kind, title: null, sourceLabel: 'fixture', x: 'tenant', value: 'n', series: 'severity',
        xType: null, xLabel: null, valueLabel: null, unit: null,
        stack: 'total', style, entityColor,
      });
      const svg = renderEchartsSvg(built.option, CHART_WIDTH, built.height);
      const series = (built.option as any).series;
      for (const item of series) {
        const color = typeof item.itemStyle.color === 'function'
          ? item.itemStyle.color({ value: 3 }) : item.itemStyle.color;
        assert.equal(typeof item.itemStyle.color, 'string', 'series identity color must be explicit');
        if (item.lineStyle) assert.equal(item.lineStyle.color, color);
        if (item.areaStyle) assert.equal(item.areaStyle.color, color);
        const count = [...svg.matchAll(new RegExp(`fill="${color}"`, 'g'))].length;
        assert.ok(count >= 3, `${kind} ${item.name}: marks and legend must share ${color}; found ${count}`);
      }
    }
  }
}
const signed = buildOption([{ x: 'positive', v: 2 }, { x: 'negative', v: -1 }], {
  kind: 'column', title: null, sourceLabel: 'fixture', x: 'x', value: 'v', series: null,
  xType: null, xLabel: null, valueLabel: null, unit: null,
});
const signedSvg = renderEchartsSvg(signed.option, CHART_WIDTH, signed.height);
assert.ok(signedSvg.includes(`fill="${NEGATIVE_COLOR}"`));
assert.ok(signedSvg.includes(`fill="${SERIES_COLORS[0]}"`));
console.log('Chart legend and mark colors agree; negative values retain their override.');
