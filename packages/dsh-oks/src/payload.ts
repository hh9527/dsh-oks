/** 模型可见回执的字节预算：以最终渲染文本计量，超限时返回有界诊断。 */
import { isRecord } from './host.ts';
import type { ToolDefinition } from './host.ts';
import { createProjector } from './project.ts';
import type { JsonValue } from './project.ts';

export const PAYLOAD_MAX_BYTES = 16 * 1024;
const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const FIELD_LIMIT = 8;
const shapeOf = createProjector('Shape');
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

export interface PayloadError {
  ok: false;
  error: {
    code: 'payload_too_large' | 'evaluation_truncated';
    tool: string;
    limitBytes: number;
    actualBytes: number | null;
  };
  shape?: JsonValue;
  /** 输出对象的主要字段；bytes 是该字段值的紧凑 JSON 字节数。 */
  fields?: { key: string; bytes: number; shape: JsonValue }[];
}

/** 保留准确的类型与数量；列出的键由摘要自身的字节预算约束。 */
const boundedShape = (value: unknown): JsonValue => {
  const shape = shapeOf(value as JsonValue) as Record<string, JsonValue>;
  if (Array.isArray(shape.keys)) {
    while (shape.keys.length > 0 && jsonBytes(shape) > 1024) shape.keys.pop();
  }
  return shape;
};

/** shape 描述被拦截的业务结果；字段只给形状和体积，结果正文留在调用方。 */
export function payloadTooLarge(tool: string, value: unknown, actualBytes: number): PayloadError {
  const error: PayloadError = {
    ok: false,
    error: { code: 'payload_too_large', tool, limitBytes: PAYLOAD_MAX_BYTES, actualBytes },
    shape: boundedShape(value),
  };
  if (isRecord(value)) {
    const fields: { key: string; bytes: number }[] = [];
    for (const [key, child] of Object.entries(value)) {
      // 字段名原样返回；过长的键由顶层 shape 的数量表达。
      if (Buffer.byteLength(key, 'utf8') > 256 || child === undefined) continue;
      fields.push({ key, bytes: jsonBytes(child) });
      fields.sort((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (fields.length > FIELD_LIMIT) fields.pop();
    }
    if (fields.length > 0) {
      error.fields = fields.map(field => ({ ...field, shape: boundedShape(value[field.key]) }));
      while (error.fields.length > 0 && jsonBytes(error) > DIAGNOSTIC_MAX_BYTES) error.fields.pop();
      if (error.fields.length === 0) delete error.fields;
    }
  }
  return error;
}

/** 所有工具共用最终出口；oks_data 成功回执的 data 是业务结果，其他回执按自身结构摘要。 */
export function withOutputLimit(definition: ToolDefinition): ToolDefinition {
  const render = definition.output.render.bind(definition.output);
  return {
    ...definition,
    output: {
      ...definition.output,
      render: (args, value) => {
        const blocks = render(args, value);
        const actualBytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text ?? '', 'utf8'), 0);
        if (actualBytes <= PAYLOAD_MAX_BYTES) return blocks;
        const result: unknown = value;
        // A failed run must remain actionable even when its failure directory exceeds
        // the normal result budget. Messages are bounded by the producer.
        if(definition.name==='oks_run_answer' && isRecord(result) && Array.isArray(result.failures) && result.failures.length) {
          const {outputs,acquisitions,reply,...diagnostic}=result;
          return [{type:'text',text:JSON.stringify({...diagnostic,
            omittedOutputs:Number(result.omittedOutputs??0)+(Array.isArray(outputs)?outputs.length:0),
            omittedAcquisitions:Number(result.omittedAcquisitions??0)+(Array.isArray(acquisitions)?acquisitions.length:0)})}];
        }
        const data = definition.name === 'oks_data' && isRecord(result) && result.ok === true
          && Object.hasOwn(result, 'data') ? result.data : result;
        return [{ type: 'text', text: JSON.stringify(payloadTooLarge(definition.name, data, actualBytes)) }];
      },
    },
  };
}
