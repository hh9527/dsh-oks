/** JSON 投影：规则校验与函数构造独立于工具、知识结构和求值引擎。 */
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ProjectRule =
  | 'Value'
  | 'Shape'
  | { [key: string]: ProjectRule }
  | ['Map', ProjectRule]
  | ['TruncateThen', number, ProjectRule];

export type Projector = (value: JsonValue) => JsonValue;

/** 形状摘要最多列出的对象键数；键按 JS 默认字符串顺序排序。 */
export const PROJECT_SHAPE_KEYS = 20;

const objectValue = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const shape: Projector = (value): JsonValue => {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', size: value.length };
  if (objectValue(value)) {
    const keys = Object.keys(value).sort();
    return { type: 'object', size: keys.length, keys: keys.slice(0, PROJECT_SHAPE_KEYS) };
  }
  if (typeof value === 'string') {
    let size = 0;
    for (const _ of value) size++;
    return { type: 'string', size };
  }
  return { type: typeof value };
};

/** 创建时完整校验规则；返回函数可重复处理 JSON 值，保持输入与规则不变。 */
export function createProjector(project: ProjectRule): Projector {
  const ancestors = new Set<object>();
  const compile = (rule: unknown, path: string): Projector => {
    if (rule === 'Value') return (value) => value;
    if (rule === 'Shape') return shape;
    const invalid = (): never => {
      const received = rule === null ? 'null' : Array.isArray(rule) ? '数组' : typeof rule;
      const hint = typeof rule === 'string'
        ? '字符串规则只接受 "Value" 或 "Shape"；对象规则直接嵌套传入，例如 {"project":{"fact":{"rows":"Shape"}}}。'
        : '使用 "Value"、"Shape"、对象、["Map", 子规则] 或 ["TruncateThen", N, 子规则]。';
      throw new Error(`project 规则 ${path} 非法（收到 ${received}）：${hint}`);
    };
    if (rule === null || typeof rule !== 'object') return invalid();
    if (ancestors.has(rule)) throw new Error(`project 规则 ${path} 非法：规则包含循环引用。`);
    ancestors.add(rule);
    try {
      if (Array.isArray(rule)) {
        if (rule[0] === 'Map' && rule.length === 2) {
          const child = compile(rule[1], `${path}[1]`);
          return (value) => {
            if (Array.isArray(value)) return value.map(child);
            if (objectValue(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, child(item)]));
            throw new Error(`project 规则 ${path} 类型不匹配：Map 需要 array 或 object，实际为 ${value === null ? 'null' : typeof value}。`);
          };
        }
        if (rule[0] === 'TruncateThen' && rule.length === 3) {
          const size = rule[1];
          if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
            throw new Error(`project 规则 ${path}[1] 非法：TruncateThen 的 N 必须是非负安全整数。`);
          }
          const child = compile(rule[2], `${path}[2]`);
          return (value) => {
            if (Array.isArray(value)) return child(value.slice(0, size));
            if (objectValue(value)) {
              const keys = Object.keys(value).slice(0, size);
              return child(Object.fromEntries(keys.map(key => [key, value[key]])));
            }
            throw new Error(`project 规则 ${path} 类型不匹配：TruncateThen 需要 array 或 object，实际为 ${value === null ? 'null' : typeof value}。`);
          };
        }
        return invalid();
      }
      const proto = Object.getPrototypeOf(rule);
      if (proto !== Object.prototype && proto !== null) return invalid();
      const fields = Object.entries(rule).map(([key, child]) => ({
        key, project: compile(child, `${path}[${JSON.stringify(key)}]`),
      }));
      return (value) => {
        if (!objectValue(value)) throw new Error(`project 规则 ${path} 类型不匹配：对象规则需要 object，实际为 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}；数组取样使用 ["TruncateThen", N, 子规则]，逐项处理使用 ["Map", 子规则]。`);
        return Object.fromEntries(fields
          .filter(({ key }) => Object.hasOwn(value, key))
          .map(({ key, project }) => [key, project(value[key])]));
      };
    } finally {
      ancestors.delete(rule);
    }
  };
  return compile(project, '$');
}
