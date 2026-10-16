// 公共投影函数的语义验收，使用 JSON 数据，不依赖工作区或 Wasm。
import assert from 'node:assert/strict';
import { createProjector, PROJECT_SHAPE_KEYS } from './src/project.ts';
import type { JsonValue, ProjectRule } from './src/project.ts';

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const input = freeze({
  title: 'sample', empty: null, rows: [{ a: 1, b: 2 }, null, 'text'],
  documents: { first: { a: 3, b: 4 }, second: { b: 5 } },
});
assert.deepEqual(createProjector({ title: '*', missing: '*', empty: '*' })(input), { title: 'sample', empty: null });
assert.deepEqual(createProjector({ empty: '$shape' })(input), { empty: { type: 'null' } });
assert.deepEqual(createProjector({ rows: [{ a: '*' }] })(input), { rows: [{ a: 1 }, null, 'text'] });
assert.deepEqual(createProjector({ documents: [{ a: '*' }] })(input), { documents: { first: { a: 3 }, second: {} } });
for (const value of [null, true, 3, 'text', [1, 2]] satisfies JsonValue[]) {
  assert.deepEqual(createProjector({ a: '*' })(value), value);
  assert.deepEqual(createProjector({})(value), value);
}
for (const value of [null, true, 3, 'text'] satisfies JsonValue[]) {
  assert.deepEqual(createProjector(['*'])(value), value);
}
assert.deepEqual(createProjector({})(input), {});
assert.deepEqual(createProjector(['*'])([]), []);
assert.deepEqual(createProjector(['*'])({}), {});
assert.deepEqual(createProjector('*')(input), input);

const rule = freeze({ rows: [{ a: '*' }] }) as ProjectRule;
const projector = createProjector(rule);
assert.deepEqual(projector(input), { rows: [{ a: 1 }, null, 'text'] });
assert.deepEqual(projector({ rows: [{ a: 9 }] }), { rows: [{ a: 9 }] });
const mutableRule: ProjectRule = { a: '*' };
const compiled = createProjector(mutableRule);
mutableRule.a = '$shape';
assert.deepEqual(compiled({ a: 1 }), { a: 1 }, '已创建函数的行为固定于创建时的规则');

for (const [value, expected] of [
  [null, { type: 'null' }], [false, { type: 'boolean' }], [2, { type: 'number' }],
  ['A😀𠮷', { type: 'string', size: 3 }], [[1, 2], { type: 'array', size: 2 }],
] satisfies [JsonValue, JsonValue][]) assert.deepEqual(createProjector('$shape')(value), expected);
const keys = ['z', 'a', '𠮷', '\ue000', ...Array.from({ length: 40 }, (_, i) => `k${i}`)];
assert.deepEqual(createProjector('$shape')(Object.fromEntries(keys.map((k) => [k, 0]))), {
  type: 'object', size: keys.length, keys: [...keys].sort().slice(0, PROJECT_SHAPE_KEYS),
});

const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"a.b":2,"a\\"b":3,"a\\nb":4,"a\\\\b":5}');
const specialRule = Object.fromEntries(Object.keys(special).map((key) => [key, '*'])) as ProjectRule;
assert.deepEqual(createProjector(specialRule)(special), special);
assert.deepEqual(createProjector(["*"])(special), special);
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.deepEqual(createProjector({ toString: '*', constructor: '*', missing: '*' })({}), {});

for (const invalid of [null, false, 1, [], ['*', '*'], 'label', '$foo', ['$chain', []], new Date(), { a: { b: [] } }]) {
  assert.throws(() => createProjector(invalid as ProjectRule), /project 规则 \$.*非法/);
}
assert.throws(() => createProjector(JSON.stringify({ datasets: '$shape', index: '$shape' }) as ProjectRule),
  /收到 string.*对象规则直接嵌套传入/);
assert.deepEqual(createProjector({ datasets: '$shape', index: '$shape' })({ datasets: { a: 1 }, index: 'guide' }), {
  datasets: { type: 'object', size: 1, keys: ['a'] }, index: { type: 'string', size: 5 },
});
assert.throws(() => createProjector({ documents: [{ links: '$bad' }] } as unknown as ProjectRule),
  /\$\["documents"\]\[0\]\["links"\]/);
const cyclic: Record<string, unknown> = {};
cyclic.child = cyclic;
assert.throws(() => createProjector(cyclic as ProjectRule), /循环引用/);
console.log('✓ 公共投影：递归、缺失/null/类型、形状、字面键、规则校验与重复使用');
