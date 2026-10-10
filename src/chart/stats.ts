/** 分布类图元要的统计：分箱与四分位。
 *
 *  这里是整个出图链路里唯一"从原始值算出新值"的地方——前两波都只是换表达，这一波要先算。
 *  所以两者都是纯函数、不碰 echarts，便于单独核对。
 */

/** 直方图的一箱。区间是左闭右开，最后一箱含右端点（否则最大值会被丢掉）。 */
export interface Bin {
  start: number;
  end: number;
  count: number;
}

/** 默认箱子数：按数据量取一个经验档，并夹在 4–40 之间。
 *  太少看不出形状，太多每箱只剩一两个样本、全是锯齿。 */
export const defaultBinCount = (sampleCount: number): number => {
  if (sampleCount <= 1) return 4;
  // Sturges 的档数：随样本量对数增长，比"固定 10 箱"更适应大小数据集。
  const sturges = Math.ceil(Math.log2(sampleCount)) + 1;
  return Math.min(40, Math.max(4, sturges));
};

/** 把一组数值等宽分箱。只统计有限值；样本为空时返回空数组。 */
export const histogramBins = (values: readonly number[], requested?: number): Bin[] => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const count = Math.min(200, Math.max(1, Math.round(requested ?? defaultBinCount(finite.length))));

  // 全是同一个值时，宽度为 0 会让所有样本落进同一个"零宽箱"，这里给一个人为的跨度。
  const width = max === min ? 1 : (max - min) / count;
  const origin = max === min ? min - 0.5 : min;
  const bins: Bin[] = Array.from({ length: count }, (_, index) => ({
    start: origin + index * width,
    end: origin + (index + 1) * width,
    count: 0,
  }));
  for (const value of finite) {
    const index = Math.min(count - 1, Math.floor((value - origin) / width));
    bins[index].count += 1;
  }
  return bins;
};

/** 一个类别的箱线摘要。 */
export interface BoxSummary {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** 超出 1.5 倍四分位距的点（Tukey 的规则）。 */
  outliers: number[];
  count: number;
}

/** 线性插值分位数（与多数统计软件一致：位置 = (n-1) * p）。 */
const quantile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

/** 按 Tukey 的规则算箱线摘要：须是 1.5 倍四分位距内的最远点，超出的记成离群点。 */
export const boxSummary = (values: readonly number[]): BoxSummary | null => {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const q1 = quantile(finite, 0.25);
  const median = quantile(finite, 0.5);
  const q3 = quantile(finite, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const inside = finite.filter((value) => value >= lowFence && value <= highFence);
  return {
    // 没有落在须内的样本时（全是离群点），退回四分位本身，免得画出空箱。
    min: inside.length === 0 ? q1 : inside[0],
    q1,
    median,
    q3,
    max: inside.length === 0 ? q3 : inside[inside.length - 1],
    outliers: finite.filter((value) => value < lowFence || value > highFence),
    count: finite.length,
  };
};
