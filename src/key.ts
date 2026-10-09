import { createHash } from 'node:crypto';

// Intent 的 key：两个用途——「先校验、再执行」的一致性核对，以及结果文件的命名。
// 它是一致性标识，不是访问授权凭据：对 agent 不透明、必须原样搬运，也不能凭它取回 Intent。

/** 规范化：递归按对象字段名排序，保留数组顺序，数值 / 字符串按 JSON 编码。
 *  同一个 Intent 无论字段书写顺序如何，都得到同一个字符串；`undefined` 的字段不参与。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`;
  }
  // 函数 / symbol / undefined：JSON 里没有对应表示，按 null 记，保证函数总返回字符串。
  return 'null';
}

/** key = 单个 Intent 的规范化 JSON 的 SHA-256 前 32 个十六进制字符（128 位）。
 *  校验返回、查询核对、结果文件与文件名统一用这一个值（见 rfc/0001 的承载清单）。 */
export function intentKey(intent: unknown): string {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex').slice(0, 32);
}
