import type {SourceDiagnostic} from './pipeline.ts';

/** Diagnostics belong to one analysis and retain their original source locations. */
export class DiagnosticCollector {
  private readonly entries:SourceDiagnostic[]=[];

  report(diagnostic:SourceDiagnostic):void { this.entries.push(diagnostic); }
  reportAll(diagnostics:readonly SourceDiagnostic[]):void { for(const diagnostic of diagnostics)this.report(diagnostic); }
  checkpoint():number { return this.entries.length; }
  hasErrors(since=0):boolean { return this.entries.length>since; }
  list():SourceDiagnostic[] { return [...this.entries]; }
}
