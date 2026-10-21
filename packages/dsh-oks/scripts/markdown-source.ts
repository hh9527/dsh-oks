import { fromMarkdown } from 'mdast-util-from-markdown';
import { DraftSyntaxError, parsePipeline } from '../src/draft/pipeline.ts';
import type { PipelineNode, Position, Span } from '../src/draft/pipeline.ts';

export type DraftAsset = { name: string; language: 'jq'; source: string; span: Span; body: Position };
export type DraftDocument = { title?: string; nodes: PipelineNode[]; assets: Map<string, DraftAsset>; pipeline: Span;answers:string[];file:string };
const MAX_SOURCE_BYTES = 256 * 1024;

/** CommonMark decides block boundaries. Fence checks only inspect nodes already classified as code. */
export function parseMarkdownDraft(source: string): DraftDocument {
  const start: Position = { offset: 0, line: 1, column: 1 };
  const fail = (message: string, span: Span = { start, end: start }): never => { throw new DraftSyntaxError(message, span); };
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) fail('Draft exceeds the 256 KiB source budget');
  const tree = fromMarkdown(source);
  let region: 'pipeline' | 'assets' | null = null;
  const regions = new Set<string>();
  let pipeline: { source: string; body: Position; span: Span } | undefined;
  const assets = new Map<string, DraftAsset>();
  const spanOf = (node: { position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } } }): Span => ({
    start: { ...node.position!.start, offset: node.position!.start.offset! },
    end: { ...node.position!.end, offset: node.position!.end.offset! },
  });
  const bodyOf = (span: Span) => {
    if (span.start.column !== 1) fail('Draft fences must start in column 1', span);
    const firstEnd = source.indexOf('\n', span.start.offset);
    const opening = source.slice(span.start.offset, firstEnd < 0 ? source.length : firstEnd).replace(/\r$/, '');
    const marker = /^(`{3,}|~{3,})/.exec(opening)?.[1];
    if (!marker || firstEnd < 0) return fail('Draft code must use a closed fenced block', span);
    const closingStart = source.lastIndexOf('\n', span.end.offset - 1) + 1;
    const closing = source.slice(closingStart, span.end.offset).replace(/\r$/, '');
    if (closingStart <= firstEnd || !new RegExp(`^${marker[0]}{${marker.length},}[ \\t]*$`).test(closing)) {
      return fail('Draft code fence is not closed', span);
    }
    return {
      source: source.slice(firstEnd + 1, closingStart),
      body: { offset: firstEnd + 1, line: span.start.line + 1, column: 1 },
      span,
    };
  };
  for (const block of tree.children) {
    if (block.type === 'heading' && block.depth <= 2) {
      region = null;
      const title = block.children.length === 1 && block.children[0].type === 'text' ? block.children[0].value : '';
      if (block.depth === 2 && (title === 'pipeline' || title === 'assets')) {
        if (regions.has(title)) fail(`Duplicate ${title} section`, spanOf(block));
        regions.add(title);
        region = title;
      }
      continue;
    }
    if (block.type !== 'code' || region === null) continue;
    const span = spanOf(block);
    if (region === 'pipeline') {
      if (pipeline) fail('The pipeline section must contain exactly one code block', span);
      if (block.lang !== 'js' || block.meta) fail('The pipeline fence must be tagged js without attributes', span);
      pipeline = bodyOf(span);
    } else if (block.meta) {
      const match = /^name="([A-Za-z0-9_-][A-Za-z0-9_.-]*)"$/.exec(block.meta);
      if (!match) fail('Asset attributes must be name="single-file.jq"', span);
      const name = match![1];
      if (assets.has(name)) fail(`Duplicate asset ${name}`, span);
      if (block.lang !== 'jq' || !name.endsWith(`.${block.lang}`)) fail('Asset language and extension must match jq', span);
      assets.set(name, { ...bodyOf(span), name, language: block.lang as 'jq' });
    }
  }
  if (!pipeline) return fail('A pipeline section with exactly one js block is required');
  const nodes = parsePipeline(pipeline.source, pipeline.body);
  for (const node of nodes) for (const dependency of node.assets) {
    const asset = assets.get(dependency.name);
    if (!asset) fail(`Missing asset ${dependency.name}`, dependency.span);
    if (asset!.language !== dependency.language) fail(`Asset language mismatch for ${dependency.name}`, dependency.span);
  }
  const heading = tree.children.find(block => block.type === 'heading' && block.depth === 1);
  const title = heading?.type === 'heading' ? heading.children.map(child => 'value' in child ? child.value : '').join('').trim() : undefined;
  return { title: title || undefined,nodes,assets,pipeline:pipeline.span,answers:[],file:'fixture.dari' };
}

