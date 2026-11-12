import {errorText,isRecord} from './host.ts';

export type ReportContext={run:string;batch:string;sourceHash:string;startedAt:string;captures:unknown[];acquisitions:unknown[];[key:string]:unknown};
export type ReportPageArchive={version:1;source:string;context:ReportContext};
const sourceMarker='<script type="text/plain" id="dari-source">';
const contextMarker='<script type="application/json" id="dari-context">';
function section(html:string,marker:string):string|undefined{
 const open=html.indexOf(marker);if(open<0)return;
 const start=open+marker.length,end=html.indexOf('</script>',start);
 return end<0?undefined:html.slice(start,end);
}
/** Read fixed inert source/context nodes; report contents are never executed. */
export function readReportPage(html:string):ReportPageArchive|{error:string}{
 const source=section(html,sourceMarker),context=section(html,contextMarker);
 if(source===undefined||context===undefined)return {error:'报告缺少完整的源码或上下文元数据节点。'};
 let meta:unknown;try{meta=JSON.parse(context);}catch(cause){return {error:'报告元数据不是 JSON：'+errorText(cause)};}
 if(!isRecord(meta)||meta.version!==1)return {error:'不支持的报告归档版本。'};
 const c=meta.context;
 if(!isRecord(c)||typeof c.run!=='string'||typeof c.batch!=='string'||typeof c.sourceHash!=='string'||typeof c.startedAt!=='string'||!Array.isArray(c.captures)||!Array.isArray(c.acquisitions))return {error:'报告执行上下文不完整。'};
 return {version:1,source:source.replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'),context:c as ReportContext};
}
