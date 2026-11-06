import type {SourceDiagnostic} from './pipeline.ts';

/** Diagnostics belong to one analysis and retain their original source locations. */
export class DiagnosticCollector {
  private readonly entries:SourceDiagnostic[]=[];

  report(diagnostic:SourceDiagnostic):void { this.entries.push(diagnostic); }
  reportAll(diagnostics:readonly SourceDiagnostic[]):void { for(const diagnostic of diagnostics)this.report(diagnostic); }
  checkpoint():number { return this.entries.length; }
  hasErrors(since=0):boolean { return this.entries.slice(since).some(d=>d.severity!=='warning'); }
  list():SourceDiagnostic[] {
    return [...this.entries].sort((a,b)=>
      (a.file??'').localeCompare(b.file??'','en') || a.span.start.offset-b.span.start.offset ||
      a.span.end.offset-b.span.end.offset || a.stage.localeCompare(b.stage,'en') || a.message.localeCompare(b.message,'en'));
  }
}
