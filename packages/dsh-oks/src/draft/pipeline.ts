import type { FigureKind } from './components.ts';
/** The draft language is parsed as data. Source text is never evaluated as JavaScript. */
export type Position = { offset: number; line: number; column: number };
export type Span = { start: Position; end: Position };
export type Operator = 'data' | 'query' | 'exec_query' | 'typed_value' | 'relational' | 'relational_one' | 'table_union' | 'typed_table' | 'analysis_map' | 'context' | 'render_figure' | 'render_report' | 'time_windows';
export type Expr = (
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; values: Expr[] }
  | { kind: 'object'; entries: { key: string; value: Expr }[] }
  | { kind: 'ref'; name: string }
  | { kind: 'project'; input: Expr; key: string | number }
  | { kind: 'call'; operator: Operator; args: Expr[]; figureKind?: FigureKind }
) & { span: Span };
export type Statement = (
  | { kind: 'binding'; name: string; value: Expr }
  | { kind: 'output'; value: Expr }
) & { span: Span; motivation: string };
export type PipelineNode = {
  /** Analysis lowering retains higher-order structure instead of executable expansion. */
  analysis?:Expr;
  /** No executable lowering exists because a syntax-failed dependency is unavailable. */
  analysisOnly?:boolean;
  typed?:boolean;
  internal?: boolean;
  display?: { label: string; template: string; figureId?: string; component: string };
  statement: Statement;
  bindings: string[];
};
export type SourceDiagnostic = {file?:string;stage:string;severity?:'error'|'warning';message:string;span:Span;asset?:string;expected?:string;found?:string;excerpt?:{line:number;column:number;text:string;marker:string};related?:{message:string;span:Span}[]};
export class DraftSyntaxError extends Error {
  readonly span: Span;
  readonly diagnostics: SourceDiagnostic[];
  constructor(message: string, span: Span, diagnostics:SourceDiagnostic[] = []) {
    super(message);
    this.name = 'DraftSyntaxError';
    this.span = span;
    this.diagnostics = diagnostics;
  }
}
