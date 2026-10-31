import {parseTypedPipeline} from './typed-syntax.ts';
import type { FigureKind } from './components.ts';
/** The draft language is parsed as data. Source text is never evaluated as JavaScript. */
export type Position = { offset: number; line: number; column: number };
export type Span = { start: Position; end: Position };
export type Operator = 'data' | 'query' | 'exec_query' | 'sql' | 'typed_value' | 'relational' | 'relational_one' | 'table_union' | 'typed_table' | 'analysis_map' | 'context' | 'render_figure' | 'render_report' | 'time_windows';
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
export type AssetDependency = { name: string; language: 'sql'; span: Span };
export type PipelineNode = {
  /** Analysis lowering retains higher-order structure instead of executable expansion. */
  analysis?:Expr;
  typed?:boolean;
  internal?: boolean;
  display?: { label: string; template: string; figureId?: string; component: string };
  statement: Statement;
  bindings: string[];
  assets: AssetDependency[];
};
export type SourceDiagnostic = {file?:string;stage:string;message:string;span:Span;asset?:string;expected?:string;found?:string;excerpt?:{line:number;column:number;text:string;marker:string};related?:{message:string;span:Span}[]};
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

type Token = { text: string; value?: string | number; kind: 'id' | 'string' | 'number' | 'symbol' | 'eof'; span: Span; comments: string[] };
const OPERATORS = new Set<string>(['data', 'query', 'exec_query', 'sql', 'context', 'render_figure', 'time_windows']);
const RESERVED = new Set(['let', 'debug', 'output', 'true', 'false', 'null', ...OPERATORS]);
const MAX_DEPTH = 128;

/** base is the location of the first code character in the original source file. */
export function parsePipeline(source: string, base: Position = { offset: 0, line: 1, column: 1 }): PipelineNode[] {
  const code=source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,' ');
  if(/\b(?:select|select_one|table|union_all|map|map_opt|is_some|is_none|round|concat|case_when)\s*\(|=>|\?\.|\?\?|&&|\|\||==|!=/.test(code)||/[+*%!<>/]/.test(code.replaceAll('<-',''))||/[A-Za-z0-9_$)\]]\s*-/.test(code.replaceAll('<-','')))return parseTypedPipeline(source,base);
  let index = 0;
  let line = base.line;
  let column = base.column;
  const pos = (): Position => ({ offset: base.offset + index, line, column });
  const advance = () => {
    const ch = source[index++];
    if (ch === '\n') { line++; column = 1; } else { column++; }
    return ch;
  };
  const fail = (message: string, start = pos()): never => {
    throw new DraftSyntaxError(message, { start, end: pos() });
  };
  const lex = (): Token => {
    let comments: string[] = [];
    let commentLine = -1;
    while (index < source.length) {
      if (/\s/.test(source[index])) {
        advance();
        continue;
      }
      if (source.startsWith('//', index)) {
        const standalone = /^[ \t\r]*$/.test(source.slice(source.lastIndexOf('\n', index - 1) + 1, index));
        const currentLine = line;
        advance(); advance();
        const start = index;
        while (index < source.length && source[index] !== '\n') advance();
        if (standalone) {
          if (commentLine < currentLine - 1) comments = [];
          comments.push(source.slice(start, index).trim());
          commentLine = currentLine;
        }
        continue;
      }
      if (source.startsWith('/*', index)) {
        const start = pos();
        advance(); advance();
        while (index < source.length && !source.startsWith('*/', index)) advance();
        if (index === source.length) fail('Unterminated block comment', start);
        advance(); advance();
        continue;
      }
      break;
    }
    if (line > commentLine + 1) comments = [];
    const start = pos();
    const begin = index;
    if (index === source.length) return { kind: 'eof', text: '', span: { start, end: pos() }, comments };
    const ch = source[index];
    if (/[A-Za-z_$]/.test(ch)) {
      advance();
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) advance();
      if (index - begin > 128) fail('Identifiers are limited to 128 characters', start);
      return { kind: 'id', text: source.slice(begin, index), span: { start, end: pos() }, comments };
    }
    if (ch === '"') {
      advance();
      let closed = false;
      while (index < source.length) {
        const current = advance();
        if (current === '"') { closed = true; break; }
        if (current === '\n' || current === '\r') fail('Strings must use JSON escaping', start);
        if (current === '\\' && index < source.length) advance();
      }
      if (!closed) fail('Unterminated JSON string', start);
      const raw = source.slice(begin, index);
      let value: string;
      try { value = JSON.parse(raw); } catch { return fail('Invalid JSON string', start); }
      return { kind: 'string', text: raw, value, span: { start, end: pos() }, comments };
    }
    if (source.startsWith('<-',index)) { advance(); advance(); return {kind:'symbol',text:'<-',span:{start,end:pos()},comments}; }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (!match) fail('Expected a JSON number', start);
      for (let n = 0; n < match![0].length; n++) advance();
      const value = Number(match![0]);
      if (!Number.isFinite(value)) fail('Numbers must be finite', start);
      return { kind: 'number', text: match![0], value, span: { start, end: pos() }, comments };
    }
    if ('{}[]().,:;='.includes(ch)) {
      advance();
      return { kind: 'symbol', text: ch, span: { start, end: pos() }, comments };
    }
    return fail(`Unsupported character ${JSON.stringify(ch)}`, start);
  };
  let token = lex();
  let previous = token;
  const take = () => { const result = token; previous = result; token = lex(); return result; };
  const error = (message: string, at = token): never => { throw new DraftSyntaxError(message, at.span); };
  const is = (text: string): boolean => token.text === text;
  const expect = (text: string): Token => {
    if (!is(text)) error(`Expected ${JSON.stringify(text)}, got ${JSON.stringify(token.text)}`);
    return take();
  };
  const identifier = () => {
    if (token.kind !== 'id') error('Expected an identifier');
    return take();
  };
  const spanFrom = (start: Position): Span => ({ start, end: previous.span.end });
  const expression = (depth = 0): Expr => {
    if (depth > MAX_DEPTH) error(`Expression nesting exceeds ${MAX_DEPTH}`);
    const start = token.span.start;
    let value: Expr;
    if (token.kind === 'string' || token.kind === 'number') {
      const t = take();
      value = { kind: 'literal', value: t.value!, span: t.span };
    } else if (['true', 'false', 'null'].includes(token.text)) {
      const t = take();
      value = { kind: 'literal', value: JSON.parse(t.text), span: t.span };
    } else if (is('[')) {
      take();
      const values: Expr[] = [];
      while (!is(']')) {
        values.push(expression(depth + 1));
        if (!is(',')) break;
        take();
      }
      expect(']');
      value = { kind: 'array', values, span: spanFrom(start) };
    } else if (is('{')) {
      take();
      const entries: { key: string; value: Expr }[] = [];
      const keys = new Set<string>();
      while (!is('}')) {
        const keyToken = token as Token;
        if (keyToken.kind !== 'id' && keyToken.kind !== 'string') error('Object keys must be identifiers or JSON strings');
        take();
        const key = keyToken.kind === 'string' ? keyToken.value as string : keyToken.text;
        if (keys.has(key)) error(`Duplicate object key ${JSON.stringify(key)}`, keyToken);
        keys.add(key);
        let entry: Expr;
        if (is(':')) { take(); entry = expression(depth + 1); }
        else {
          if (keyToken.kind !== 'id' || RESERVED.has(key)) error('Shorthand requires a binding name', keyToken);
          entry = { kind: 'ref', name: key, span: keyToken.span };
        }
        entries.push({ key, value: entry });
        if (!is(',')) break;
        take();
      }
      expect('}');
      value = { kind: 'object', entries, span: spanFrom(start) };
    } else if (token.kind === 'id') {
      const name = take();
      if (is('(')) {
        if (!OPERATORS.has(name.text)) error(`Unknown operator ${name.text}`, name);
        take();
        const args: Expr[] = [];
        while (!is(')')) {
          args.push(expression(depth + 1));
          if (!is(',')) break;
          take();
        }
        expect(')');
        value = { kind: 'call', operator: name.text as Operator, args, span: spanFrom(start) };
      } else {
        if (RESERVED.has(name.text)) error(`Reserved name ${name.text}`, name);
        value = { kind: 'ref', name: name.text, span: name.span };
      }
    } else return error('Expected a value, binding, object, array or fixed operator');
    while (is('.') || is('[')) {
      let key: string | number;
      if (is('.')) { take(); key = identifier().text; }
      else {
        take();
        const part = take();
        if (part.kind === 'string') key = part.value as string;
        else if (part.kind === 'number' && Number.isSafeInteger(part.value) && (part.value as number) >= 0 && /^(0|[1-9][0-9]*)$/.test(part.text)) key = part.value as number;
        else return error('Projection requires a static string key or nonnegative safe integer index', part);
        expect(']');
      }
      value = { kind: 'project', input: value, key, span: spanFrom(start) };
    }
    return value;
  };
  const nodes: PipelineNode[] = [];
  const names = new Set<string>();
  while (token.kind !== 'eof') {
    if (nodes.length >= 512) error('Pipeline is limited to 512 statements');
    const head = token;
    let statement: Statement;
    const motivation = head.comments.join('\n');
    if (head.text === '{') {
      const value=expression();
      if(value.kind!=='object')error('Pipeline output must be an object',head);
      if(is(';'))take();
      if((token as Token).kind!=='eof')error('The output object must be the final pipeline statement');
      statement={kind:'output',value,motivation,span:spanFrom(head.span.start)};
    } else {
      const name=identifier();
      if(RESERVED.has(name.text))error(`Reserved binding name ${name.text}`,name);
      if(names.has(name.text))error(`Duplicate binding ${name.text}`,name);
      expect('<-');
      const value=expression();expect(';');
      statement={kind:'binding',name:name.text,value,motivation,span:spanFrom(head.span.start)};
    }
    const bindings = new Set<string>();
    const assets: AssetDependency[] = [];
    const visit = (expr: Expr): void => {
      if (expr.kind === 'ref') {
        if (!names.has(expr.name)) throw new DraftSyntaxError(`Undefined or forward binding ${expr.name}`, expr.span);
        bindings.add(expr.name);
      } else if (expr.kind === 'array') expr.values.forEach(visit);
      else if (expr.kind === 'object') expr.entries.forEach(entry => visit(entry.value));
      else if (expr.kind === 'project') visit(expr.input);
      else if (expr.kind === 'call') {
        const count = expr.args.length;
        const arity = expr.operator === 'context' ? [0, 0] : ['query','exec_query'].includes(expr.operator) ? [1, 1] : ['data'].includes(expr.operator) ? [1, 2] : [2, 2];
        if (count < arity[0] || count > arity[1]) throw new DraftSyntaxError(`Invalid argument count for ${expr.operator}`, expr.span);
        if (expr.operator === 'sql') {
          const asset = expr.args[0];
          const language = expr.operator;
          if (asset.kind !== 'literal' || typeof asset.value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(asset.value) || !asset.value.endsWith(`.${language}`)) {
            throw new DraftSyntaxError(`${expr.operator} requires a literal single-file .${language} asset name`, asset.span);
          }
          assets.push({ name: asset.value, language, span: asset.span });
        }
        expr.args.forEach(visit);
      }
    };
    visit(statement.value);
    nodes.push({ statement, bindings: [...bindings], assets });
    if (statement.kind === 'binding') names.add(statement.name);
  }
  return nodes;
}
