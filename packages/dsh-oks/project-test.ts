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
  title: 'sample', empty: null, rows: [{ a: 1, b: 2 }, { a: 2 }],
  documents: { first: { a: 3, b: 4 }, second: { b: 5 } },
});
assert.deepEqual(createProjector({ title: 'Value', missing: 'Value', empty: 'Value' })(input), { title: 'sample', empty: null });
assert.deepEqual(createProjector({ empty: 'Shape' })(input), { empty: { type: 'null' } });
assert.deepEqual(createProjector({ rows: ['Map', { a: 'Value' }] })(input), { rows: [{ a: 1 }, { a: 2 }] });
assert.deepEqual(createProjector({ documents: ['Map', { a: 'Value' }] })(input), { documents: { first: { a: 3 }, second: {} } });
for (const value of [null, true, 3, 'text', [1, 2]] satisfies JsonValue[]) {
  assert.throws(() => createProjector({ a: 'Value' })(value), /类型不匹配/);
  assert.throws(() => createProjector({})(value), /类型不匹配/);
}
for (const value of [null, true, 3, 'text'] satisfies JsonValue[]) {
  assert.throws(() => createProjector(['Map', 'Value'])(value), /类型不匹配/);
  assert.throws(() => createProjector(['TruncateThen', 1, 'Value'])(value), /类型不匹配/);
}
assert.deepEqual(createProjector({})(input), {});
assert.deepEqual(createProjector(['Map', 'Value'])([]), []);
assert.deepEqual(createProjector(['Map', 'Value'])({}), {});
assert.deepEqual(createProjector('Value')(input), input);

const rule = freeze({ rows: ['Map', { a: 'Value' }] }) as ProjectRule;
const projector = createProjector(rule);
assert.deepEqual(projector(input), { rows: [{ a: 1 }, { a: 2 }] });
assert.deepEqual(projector({ rows: [{ a: 9 }] }), { rows: [{ a: 9 }] });
const mutableRule: ProjectRule = { a: 'Value' };
const compiled = createProjector(mutableRule);
mutableRule.a = 'Shape';
assert.deepEqual(compiled({ a: 1 }), { a: 1 }, '已创建函数的行为固定于创建时的规则');

for (const [value, expected] of [
  [null, { type: 'null' }], [false, { type: 'boolean' }], [2, { type: 'number' }],
  ['A😀𠮷', { type: 'string', size: 3 }], [[1, 2], { type: 'array', size: 2 }],
] satisfies [JsonValue, JsonValue][]) assert.deepEqual(createProjector('Shape')(value), expected);
const keys = ['z', 'a', '𠮷', '\ue000', ...Array.from({ length: 40 }, (_, i) => `k${i}`)];
assert.deepEqual(createProjector('Shape')(Object.fromEntries(keys.map((k) => [k, 0]))), {
  type: 'object', size: keys.length, keys: [...keys].sort().slice(0, PROJECT_SHAPE_KEYS),
});

const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"a.b":2,"a\\"b":3,"a\\nb":4,"a\\\\b":5}');
const specialRule = Object.fromEntries(Object.keys(special).map((key) => [key, 'Value'])) as ProjectRule;
assert.deepEqual(createProjector(specialRule)(special), special);
assert.deepEqual(createProjector(["Map", "Value"])(special), special);
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.deepEqual(createProjector({ toString: 'Value', constructor: 'Value', missing: 'Value' })({}), {});

for (const invalid of [null, false, 1, [], '*', '$shape', ['Value'], ['Map'], ['Value', 'Value'], ['Map', 'Value', 'Value'], ['Map', '$bad'], 'label', '$foo', ['$chain', []], new Date(), { a: { b: [] } }]) {
  assert.throws(() => createProjector(invalid as ProjectRule), /project 规则 \$.*非法/);
}
assert.throws(() => createProjector(JSON.stringify({ datasets: 'Shape', index: 'Shape' }) as ProjectRule),
  /收到 string.*对象规则直接嵌套传入/);
assert.deepEqual(createProjector({ datasets: 'Shape', index: 'Shape' })({ datasets: { a: 1 }, index: 'guide' }), {
  datasets: { type: 'object', size: 1, keys: ['a'] }, index: { type: 'string', size: 5 },
});
assert.throws(() => createProjector({ documents: ['Map', { links: '$bad' }] } as unknown as ProjectRule),
  /\$\["documents"\]\[1\]\["links"\]/);
const cyclic: Record<string, unknown> = {};
cyclic.child = cyclic;
assert.throws(() => createProjector(cyclic as ProjectRule), /循环引用/);


assert.deepEqual(createProjector({ rows: ['TruncateThen', 1, ['Map', { a: 'Value' }]] })(input), { rows: [{ a: 1 }] });
assert.deepEqual(createProjector(['TruncateThen', 1, 'Value'])({ b: 2, a: 1 }), { b: 2 });
assert.deepEqual(createProjector(['TruncateThen', 2, ['Map', { a: 'Value' }]])(
  [{ a: 1, b: 2 }, { a: 2 }, null]), [{ a: 1 }, { a: 2 }]);
assert.deepEqual(createProjector(['TruncateThen', 1, ['Map', { a: 'Value' }]])(
  { first: { a: 1, b: 2 }, second: null }), { first: { a: 1 } });
assert.deepEqual(createProjector(['TruncateThen', 1, 'Value'])([]), []);
assert.deepEqual(createProjector(['TruncateThen', 1, 'Value'])({}), {});
assert.deepEqual(createProjector(['TruncateThen', 0, ['Map', { a: 'Value' }]])([null]), []);
assert.deepEqual(createProjector(['TruncateThen', 0, 'Value'])({ a: 1 }), {});
assert.deepEqual(createProjector(['TruncateThen', 99, 'Value'])([null, 1]), [null, 1]);
assert.deepEqual(createProjector(['TruncateThen', 99, 'Value'])({ a: 1 }), { a: 1 });
assert.deepEqual(createProjector(['TruncateThen', 1, 'Shape'])([{ a: 1 }, 2]), { type: 'array', size: 1 });
assert.deepEqual(createProjector(['TruncateThen', 1, ['Map', 'Shape']])([{ a: 1 }, 2]),
  [{ type: 'object', size: 1, keys: ['a'] }]);
assert.deepEqual(createProjector(['TruncateThen', 1, 'Shape'])({ b: 2, a: 1 }), { type: 'object', size: 1, keys: ['b'] });
assert.deepEqual(createProjector(['TruncateThen', 1, 'Value'])({ '10': 'ten', '2': 'two', a: 'letter' }), { '2': 'two' });
assert.deepEqual(createProjector(['TruncateThen', 2, 'Value'])(special), Object.fromEntries(Object.entries(special).slice(0, 2)));
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.throws(() => createProjector({ rows: { '0': 'Value' } })(input), /\$\["rows"\].*实际为 array/);
assert.throws(() => createProjector({ rows: ['Map', { a: 'Value' }] })({ rows: [null] }), /\$\["rows"\]\[1\].*实际为 null/);
assert.throws(() => createProjector(['TruncateThen', 0, { a: 'Value' }])([]), /实际为 array/);

for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
  assert.throws(() => createProjector(['TruncateThen', count, 'Value'] as ProjectRule), /\$\[1\].*非负安全整数/);
}
for (const invalid of [['TruncateThen'], ['TruncateThen', 1], ['TruncateThen', 1, 'Value', 'Shape'], ['TruncateThen', 1, '$bad']]) {
  assert.throws(() => createProjector(invalid as ProjectRule), /project 规则 \$.*非法/);
}
assert.throws(() => createProjector({ rows: ['TruncateThen', 1, { a: '$bad' }] } as unknown as ProjectRule),
  /\$\["rows"\]\[2\]\["a"\]/);
const cyclicTruncate: unknown[] = ['TruncateThen', 1];
cyclicTruncate.push(cyclicTruncate);
assert.throws(() => createProjector(cyclicTruncate as ProjectRule), /循环引用/);
const sampleRule = freeze({ rows: ['TruncateThen', 1, ['Map', { a: 'Value' }]] }) as ProjectRule;
const sample = createProjector(sampleRule);
assert.deepEqual(sample(input), { rows: [{ a: 1 }] });
assert.deepEqual(sample({ rows: [{ a: 9 }, { a: 10 }] }), { rows: [{ a: 9 }] });
const mutableSample: ProjectRule = ['TruncateThen', 1, 'Value'];
const fixedSample = createProjector(mutableSample);
mutableSample[1] = 2;
assert.deepEqual(fixedSample([1, 2]), [1], '截断数量固定于创建时，重复使用不修改输入或规则');
console.log('✓ 公共投影：递归、TruncateThen 组合与边界、严格类型、形状、字面键、规则校验与重复使用');
