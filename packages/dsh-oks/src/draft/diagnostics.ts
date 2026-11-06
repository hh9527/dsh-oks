import type {SourceDiagnostic} from './pipeline.ts';
import {canonicalJson} from '../key.ts';

const identity=(d:SourceDiagnostic)=>canonicalJson([d.file,d.stage,d.severity??'error',d.span,d.message,d.asset,d.expected,d.found,d.related]);

/** Diagnostics belong to one analysis and retain their original source locations. */
export class DiagnosticCollector {
  private readonly entries:SourceDiagnostic[]=[];

  report(diagnostic:SourceDiagnostic):void { this.entries.push(diagnostic); }
  reportAll(diagnostics:readonly SourceDiagnostic[]):void { for(const diagnostic of diagnostics)this.report(diagnostic); }
  checkpoint():number { return this.entries.length; }
  hasErrors(since=0):boolean { return this.entries.slice(since).some(d=>d.severity!=='warning'); }
  list():SourceDiagnostic[] {
    const unique=new Map<string,SourceDiagnostic>();
    for(const entry of this.entries){const key=identity(entry),previous=unique.get(key);if(!previous||(!previous.excerpt&&!!entry.excerpt)||(!!previous.excerpt===!!entry.excerpt&&canonicalJson(entry)<canonicalJson(previous)))unique.set(key,entry);}
    return [...unique.values()].sort((a,b)=>
      (a.file??'').localeCompare(b.file??'','en') || a.span.start.offset-b.span.start.offset ||
      a.span.end.offset-b.span.end.offset || a.stage.localeCompare(b.stage,'en') || a.message.localeCompare(b.message,'en') ||
      identity(a).localeCompare(identity(b),'en'));
  }
}
