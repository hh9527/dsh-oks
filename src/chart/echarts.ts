/** echarts 服务端渲染：呈现规格 → SVG 文本。
 *
 *  这里是整条链路里唯一碰 echarts 的地方。它负责三件事：按需注册用到的图表与组件、
 *  把 option 渲染成 SVG、以及**始终 dispose**——echarts 会为动画注册定时器，在服务端
 *  不销毁的话事件循环不会空，进程会一直挂着。
 *
 *  宽高必须在 init 时给定：SSR 模式下没有 DOM 可测量，echarts 不做自适应。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GraphicComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

/** 只注册用得到的图表与组件——全量 echarts 约 1 MB，按需导入能显著小于它。
 *  graphic 是画来源标识用的：不注册它 echarts 会警告并静默丢掉那段文字。 */
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

/** 把一份 option 渲染成 SVG 文本。 */
export const renderEchartsSvg = (option: EChartsCoreOption, width: number, height: number): string => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally {
    // 必须销毁：echarts 的动画定时器会拖住 Node 的事件循环。
    chart.dispose();
  }
};
