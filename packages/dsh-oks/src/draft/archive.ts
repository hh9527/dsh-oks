import type { Acquisition, DraftRun } from './runtime.ts';

/** 作者结构直接取自原始 DARI 的源码范围，保留注释、顺序与完整可恢复源码。 */
export type DariAuthoring = {
  source: string;
  title: string;
  notes: string;
  assets: Record<string,string>;
  pipeline: string;
  reports: Record<string,string>;
  figures: Record<string,{code:string;binding:string}>;
};
export type ExecutionContext = {
  run: string;
  batch: string;
  sourceHash: string;
  startedAt: string;
  model: {hash:string|null;domain:string|null}|null;
  captures: {binding:string;at:{line:number;column:number};value:unknown}[];
  acquisitions: Acquisition[];
};
export type ReportArchive = {
  version: 1;
  context: ExecutionContext;
  dari: Omit<DariAuthoring,'figures'> & {
    figures: Record<string,{code:string;binding:string;status:string;data?:unknown;error?:string}>;
    values: Record<string,unknown>;
  };
};

/** DAG 全部结束后归档，因此未被当前报告引用的图表也具有明确的执行状态。 */
export function buildReportArchive(authoring:DariAuthoring,run:DraftRun,context:ExecutionContext):ReportArchive {
  const named=Object.entries(authoring.figures);
  const bindings=new Set(named.map(([,figure])=>figure.binding));
  const extra=[...run.outputs].filter(([name,state])=>!bindings.has(name)&&(state.display||state.context?.operator==='render_figure'||state.value?.sources.some(s=>s.display&&s.at.length===0&&s.path.length===0)))
    .map(([name,state])=>[state.display?.figureId?`${state.display.template}#${state.display.figureId}`:`binding:${name}`,{binding:name,code:authoring.source.slice(state.span.start.offset,state.span.end.offset)}] as const);
  const figures=Object.fromEntries([...named,...extra].map(([name,figure])=>{
    const state=run.outputs.get(figure.binding);
    return [name,{...figure,status:state?.status??'unavailable',
      ...(state?.value?{data:state.value.data}:{}),...(state?.error?{error:state.error.slice(0,800)}:{})}];
  }));
  const values=Object.fromEntries([...run.outputs.values()].flatMap(state=>Object.entries(state.value?.reportValues??{})));
  return structuredClone({version:1,context,dari:{...authoring,figures,values}});
}
