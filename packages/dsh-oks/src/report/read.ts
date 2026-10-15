// 读一份自带来源的产物：数据封装、图、表、报告——四种写法归一成同一份 { meta, origin, data }。
//
// 为什么单独一层：**"从产物里把来源读回来"**这件事与工具面无关。图/表/报告各用自己那一段
// 元数据（`<metadata>`、文件头注释、报表级 JSON 块），但读回来之后都是同一套
// `{ meta, origin, data }` + `chainLines`；工具只负责把结果说给人听。

import { errorText } from '../host.ts';
import {
  nameParts, parseEnvelope, readArtifactMeta, readChartInput, readTableView,
} from '../results.ts';
import type { Envelope, EnvelopeMeta } from '../results.ts';
import { readReportPage } from './page.ts';

/** 一份产物读回来的形态就是文件本身的三段：`{ meta, origin, data }`。
 *  四种产物到这里同形了——读的人不必再分辨它是图、表还是报告。 */
/** 按文件名里的**文件类别**分派：`.report.html` 报告、图（`<名>.<图元>.svg`）与 `.table.md` 表各有原生自述，
 *  其余（`.qres.json` / `.tr.json` / `.def.json` 数据封装）当三段 JSON 读。类别 ↔ 文件的映射由
 *  `nameParts` / `kindOfFile`（`results.ts`）一处给出。
 *  `content` 由调用方读进来（它负责路径校验与读文件），这一层只管形状。 */
export function parseArtifactOrigin(src: string, content: string): Envelope | { error: string } {
  const kind = nameParts(src).kind;
  // 图与报告的自述写在原生元素里（读开头几个字节就够），材料块里只有来源与数据。
  if (src.endsWith('.report.html')) {
    const parts = readReportPage(content);
    if ('error' in parts) return { error: parts.error };
    // 报告的来源以 `src://<key>` 引用形式给出，源码在 `data.assets` 里（RFC 0008 §3）。
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: parts.origin,
      data: { assets: parts.assets, items: parts.items, structure: parts.structure },
    };
  }
  if (kind === 'chart') {
    const material = readChartInput(content);
    if (material === null) return { error: '这张图里没有来源材料（不是本插件画的？）' };
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: material.origin,
      data: material.data,
    };
  }
  if (src.endsWith('.table.md')) {
    const view = readTableView(content);
    if (view === null) return { error: '这份表里没有来源材料（不是本插件出的？）' };
    return view.material;
  }
  try {
    return parseEnvelope(content, src);
  } catch (cause) {
    return { error: `这份文件不是一份 { meta, origin, data } 封装，也不是报告/图/表：${errorText(cause)}` };
  }
}
