// 服务端出图：把 typst 源码编译成 SVG。
//
// 四条约束决定了这里的形状：
//   1) 资源自包含——WASM、中文字体、typst 包都从 dist/ 读，与 index.mjs 一起部署；
//   2) 离线——禁用默认字体资产，包从本地缓存目录取，运行时不联网；
//   3) 中文——系统里没有任何中文字体，字体由 dist/fonts/ 提供；
//   4) 一次初始化、常驻复用——实例化与字体加载约三秒，只付一次，之后每张图几毫秒。

import { $typst } from '@myriaddreamin/typst.ts/contrib/snippet';
import { FetchPackageRegistry } from '@myriaddreamin/typst.ts/fs/package';
import { MemoryAccessModel } from '@myriaddreamin/typst.ts/fs/memory';
import {
  loadFonts,
  withAccessModel,
  withPackageRegistry,
} from '@myriaddreamin/typst.ts/options.init';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 所有静态资产都在 dist/ 里，和 index.mjs 同级。 */
const assetUrl = (relative: string): URL => new URL(relative, import.meta.url);

const readAsset = (relative: string): Uint8Array => {
  const path = fileURLToPath(assetUrl(relative));
  if (!existsSync(path)) throw new Error(`出图缺少资产：${path}`);
  return new Uint8Array(readFileSync(path));
};

/** 包注册表：从 dist/typst-pkgs/ 读构建时落盘的包，运行时一次也不联网。 */
class BundledPackages extends FetchPackageRegistry {
  constructor(private readonly access: MemoryAccessModel) {
    super(access);
  }

  resolve(spec: { namespace: string; name: string; version: string }): string | undefined {
    if (spec.namespace !== 'preview') return undefined;
    const directory = fileURLToPath(assetUrl(`./typst-pkgs/preview/${spec.name}/${spec.version}`));
    if (!existsSync(directory)) return undefined;
    const root = `/@memory/bundled/${spec.namespace}/${spec.name}/${spec.version}`;
    for (const relative of readdirSync(directory, { recursive: true })) {
      try {
        this.access.insertFile(`${root}/${relative}`, new Uint8Array(readFileSync(`${directory}/${relative}`)), new Date());
      } catch {
        // readdir 会给出目录项，读不出内容就跳过
      }
    }
    return root;
  }
}

/** 读 dist/fonts/ 下的全部字体：将来加字重就是多放几个文件。 */
const loadBundledFonts = (): Uint8Array[] => {
  const directory = fileURLToPath(assetUrl('./fonts'));
  if (!existsSync(directory)) throw new Error(`出图缺少字体目录：${directory}`);
  const fonts = readdirSync(directory)
    .filter((name) => /\.(otf|ttf)$/i.test(name))
    .map((name) => readAsset(`./fonts/${name}`));
  if (fonts.length === 0) throw new Error(`出图缺少字体：${directory} 里没有 .otf/.ttf`);
  return fonts;
};

let ready: Promise<void> | null = null;

/** 初始化编译器与渲染器；重复调用共用同一次初始化。
 *
 *  首次调用时 stderr 上会出现两条 "deprecated parameters for the initialization function"
 *  ——那是 typst.ts 的 WASM 胶水（wasm-bindgen 生成）仍在用旧签名调初始化，上游行为、与插件无关，
 *  只在这一次出现，不影响功能。 */
const initialize = (): Promise<void> => {
  if (ready !== null) return ready;
  ready = (async () => {
    const access = new MemoryAccessModel();
    $typst.setCompilerInitOptions({
      getModule: () => readAsset('./typst_ts_web_compiler_bg.wasm'),
      beforeBuild: [
        withAccessModel(access),
        withPackageRegistry(new BundledPackages(access)),
        // assets: false —— 字体全部由 dist/fonts/ 提供，运行时不碰 jsdelivr。
        // typst 的默认字体集（DejaVu、Libertinus、NewCM）与中文字体都在那一个目录里，
        // 所以关掉远程也有字体可用。
        loadFonts(loadBundledFonts(), { assets: false }),
      ],
    });
    $typst.setRendererInitOptions({
      getModule: () => readAsset('./typst_ts_renderer_bg.wasm'),
    });
    // 预热：把一次性成本（实例化 + 字体加载）提前付掉，之后每张图都走快路径。
    await $typst.svg({ mainContent: '#set page(width: 1pt, height: 1pt)' });
  })();
  return ready;
};

/** typst 会在 SVG 里附带一层 <foreignObject class="tsel">——那是给网页内选中文字用的副本，
 *  文字本身已经画成 <path> 了。宿主是在 <img> 里渲染这份 SVG：既选不中文字，
 *  这层 HTML 内容还可能被渲染成重复的字，所以直接去掉，只留图形本体。 */
const stripTextSelectionLayer = (svg: string): string =>
  svg.replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/g, '');

/** typst 的 pt 在 SVG 里被当作 px 用，而 96dpi 下 1pt ≈ 1.33px，所以它输出的画布偏小
 *  （字号看着比正常小一档）。保持 viewBox 不变、把 width/height 按比例放大，
 *  图形与字号就一起回到正常的物理尺寸。 */
const PT_TO_PX = 4 / 3;

const scaleCanvasToPixels = (svg: string): string => {
  const scaled = svg.replace(
    /(<svg\b[^>]*?)\swidth="([\d.]+)"\s+height="([\d.]+)"/,
    (_all, head: string, width: string, height: string) =>
      `${head} width="${Math.round(Number(width) * PT_TO_PX)}" height="${Math.round(Number(height) * PT_TO_PX)}"`,
  );
  return scaled;
};

/** 把一份 typst 源码编译成 SVG 文本。
 *
 *  data_selection 只取图形本体：typst 默认还会输出为网页内嵌准备的交互层
 *  （<script>、<style>），而宿主是在 <img> 里渲染这份 SVG 的。 */
export const renderTypstSvg = async (mainContent: string): Promise<string> => {
  await initialize();
  return await $typst.svg({
    mainContent,
    data_selection: { body: true, defs: true, css: false, js: false },
  }).then(scaleCanvasToPixels).then(stripTextSelectionLayer);
};

/** 后台预热：把 WASM 实例化与字体加载的一次性成本（约一秒）提前付掉。
 *  失败静默——真正的初始化会在第一次出图时重试，并把错误报给调用方。 */
export const warmUpChartRendering = (): void => {
  void initialize().catch(() => {});
};
