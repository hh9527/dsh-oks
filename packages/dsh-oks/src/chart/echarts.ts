/** echarts 服务端渲染：呈现规格 → SVG 文本。
 *
 *  这里是整条链路里唯一碰 echarts 的地方。它负责三件事：按需注册用到的图表与组件、
 *  把 option 渲染成 SVG、以及**始终 dispose**——echarts 会为动画注册定时器，在服务端
 *  不销毁的话事件循环不会空，进程会一直挂着。
 *
 *  宽高必须在 init 时给定：SSR 模式下没有 DOM 可测量，echarts 不做自适应。
 */
import * as echarts from 'echarts/core';
import { BarChart, BoxplotChart, HeatmapChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

/** 只注册用得到的图表与组件——全量 echarts 约 1 MB，按需导入能显著小于它。
 *  这里漏注册任何一项都不报错：echarts 只往 stderr 打一行警告，然后静默丢掉那部分图形
 *  （graphic 丢了来源标识、markLine 丢了参考线、ScatterChart 丢了整张图、VisualMapComponent
 *  丢了矩阵的颜色——矩阵会画成一格一个默认色的白板）。 */
echarts.use([
  BarChart,
  BoxplotChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  SVGRenderer,
]);

/** 把一份 option 渲染成 SVG 文本。 */
export const renderEchartsSvg = (option: EChartsCoreOption, width: number, height: number): string => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    // 关掉动画。这张图是静态产物，会被放进 <img> 或内联进报告——而 echarts 的 SSR 动画用的是
    // CSS `transform`，它的优先级高于 SVG 的 `transform` 属性：散点的定位本来全靠
    // `matrix(缩放, 平移)` 属性，动画一生效就被替换成 `scale(...)`，平移量丢失，所有点缩到
    // 左上角原点附近叠在一起。渲染器忽略 @keyframes 所以看不出问题，浏览器里就露馅了
    // （柱状图不受影响：它靠 x/y/width/height 属性定位，缩放不改变位置）。
    // 关掉之后产物不再有 @keyframes，体积也小一截。
    chart.setOption({ ...(option as Record<string, unknown>), animation: false });
    return chart.renderToSVGString();
  } finally {
    // 必须销毁：echarts 的动画定时器会拖住 Node 的事件循环。
    chart.dispose();
  }
};
