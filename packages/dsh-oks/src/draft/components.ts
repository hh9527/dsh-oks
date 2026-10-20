import { isRecord } from '../host.ts';
import type { ChartKind } from '../chart/shared.ts';

/** DARI component names and their renderer kind; the tag owns the discriminant. */
export const COMPONENT_KINDS = {
  BarChart: 'bar', ColumnChart: 'column', LineChart: 'line', AreaChart: 'area',
  PieChart: 'pie', ScatterChart: 'scatter', Histogram: 'histogram', BoxPlot: 'box',
  Heatmap: 'heatmap', RadarChart: 'radar', Sankey: 'sankey', NetworkGraph: 'graph',
  Gauge: 'gauge', Table: 'table',
} as const satisfies Record<string, ChartKind | 'table'>;
export type FigureKind = (typeof COMPONENT_KINDS)[keyof typeof COMPONENT_KINDS];
export function componentKind(name: string): FigureKind | undefined {
  return Object.hasOwn(COMPONENT_KINDS, name) ? COMPONENT_KINDS[name as keyof typeof COMPONENT_KINDS] : undefined;
}
export function componentSpec(raw: unknown, kind?: FigureKind): unknown {
  if (kind === undefined) return raw;
  if (!isRecord(raw)) throw new Error('Component spec must be an object');
  if (Object.hasOwn(raw, 'kind')) throw new Error('Component spec must omit kind; the component tag selects the chart type');
  return { ...raw, kind };
}
