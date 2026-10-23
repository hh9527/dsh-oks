import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeContext } from './src/time-context.ts';
import { deriveContextTimeZone, resolveZone } from './src/time.ts';
import type { ContextMessageLike, EventLike, PluginContext, PreStepHandler, SessionLike, StepDecision } from './src/host.ts';

const user = (clientTimeZone?: string): ContextMessageLike => ({ source: {
  kind: 'user', rpcId: 'rpc', ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
} });
const internal = { source: { kind: 'subagent-settled' } };
const shanghai = { kind: 'resolved', timeZone: 'Asia/Shanghai' };
function session(messages: (ContextMessageLike | 'turn')[] = []): SessionLike {
  const events: EventLike[] = messages.map((message, seq) => message === 'turn'
    ? { seq, type: 'turn/start', data: {} }
    : { seq, type: 'user/message', data: message });
  return { seq: events.length, eventAt: seq => events[seq], snapshotEvents: () => events,
    append: () => { throw new Error('Read-only fixture'); } };
}
function harness() {
  let handler: PreStepHandler;
  const ctx = { on: (_event: string, listener: PreStepHandler) => { handler = listener; return () => {}; } } as unknown as PluginContext;
  const tracker = createTimeContext({ ctx, log: message => assert.fail(message) });
  tracker.install();
  const step = async (session: SessionLike, messages: ContextMessageLike[] = [], decision?: StepDecision, signal?: AbortSignal) => {
    const expected = decision ?? { kind: 'enter', messages };
    const result = await handler({ agent: { session }, messages, signal }, async () => expected);
    assert.equal(result, expected, 'Preserve the host decision');
    return tracker.zones.get(session);
  };
  return { tracker, step };
}

test('subagent, tool and system continuations retain the user timezone', async () => {
  const { step } = harness(), s = session();
  assert.deepEqual(await step(s, [user('Asia/Shanghai')]), shanghai);
  for (const messages of [[], [internal], [{ source: { kind: 'agent-message' } }],
    [{ source: { kind: 'tool' } }], [{ source: { kind: 'runtime-context' } }], [{ source: { kind: 'user' } }]]) {
    assert.deepEqual(await step(s, messages), shanghai);
  }
});

test('effective middleware messages supply or replace the timezone', async () => {
  const { step } = harness(), s = session();
  assert.deepEqual(await step(s, [], { kind: 'enter', messages: [user('Asia/Shanghai')] }), shanghai);
  assert.deepEqual(await step(s, [user('Asia/Shanghai')], { kind: 'enter', messages: [user('UTC')] }), { kind: 'resolved', timeZone: 'UTC' });
  assert.deepEqual(await step(s, [user('UTC')], { kind: 'enter', messages: [] }), { kind: 'resolved', timeZone: 'UTC' });
});

test('payload messages remain available when a decision omits messages', async () => {
  const { step } = harness();
  assert.deepEqual(await step(session(), [user('Asia/Shanghai')], { kind: 'enter' }), shanghai);
});

test('a new RPC without a timezone clears the preceding request timezone', async () => {
  const { step } = harness(), s = session();
  await step(s, [user('Asia/Shanghai')]);
  assert.deepEqual(await step(s, [user()]), { kind: 'missing' });
  assert.deepEqual(await step(s, [internal]), { kind: 'missing' });
  assert.throws(() => resolveZone(undefined, { kind: 'missing' }), /没有带浏览器时区/);
});

test('conflicting and invalid new user timezones remain explicit', async () => {
  const { step } = harness(), s = session();
  await step(s, [user('Asia/Shanghai')]);
  assert.deepEqual(await step(s, [user('UTC'), user('Asia/Shanghai')]), { kind: 'mixed', timeZones: ['Asia/Shanghai', 'UTC'] });
  assert.deepEqual(await step(s, [user('Mars/Olympus')]), { kind: 'invalid', timeZone: 'Mars/Olympus' });
  assert.deepEqual(await step(s, [internal]), { kind: 'invalid', timeZone: 'Mars/Olympus' });
});

test('rejected and cancelled steps leave the timezone unchanged', async () => {
  const { step } = harness(), s = session();
  await step(s, [user('Asia/Shanghai')]);
  assert.deepEqual(await step(s, [user('UTC')], { kind: 'reject', messages: [user('UTC')] }), shanghai);
  assert.deepEqual(await step(s, [user('UTC')], undefined, AbortSignal.abort()), shanghai);
});

test('recreated tracker restores the last user request across internal turns', async () => {
  const s = session(['turn', user('UTC'), 'turn', user('Asia/Shanghai'), internal, 'turn', internal]);
  const { step } = harness();
  assert.deepEqual(await step(s, [internal]), shanghai);
});

test('restoration preserves missing, invalid and mixed request states', async () => {
  for (const [messages, expected] of [
    [[user()], { kind: 'missing' }],
    [[user('Mars/Olympus')], { kind: 'invalid', timeZone: 'Mars/Olympus' }],
    [[user('UTC'), user('Asia/Shanghai')], { kind: 'mixed', timeZones: ['Asia/Shanghai', 'UTC'] }],
  ] as const) {
    const { step } = harness();
    const s = session(['turn', user('UTC'), 'turn', ...messages, 'turn', internal]);
    assert.deepEqual(await step(s, [internal]), expected);
  }
});

test('incoming user RPC takes precedence over restored history', async () => {
  const { step } = harness();
  assert.deepEqual(await step(session(['turn', user('Asia/Shanghai')]), [user()]), { kind: 'missing' });
});

test('sessions are isolated and absent history gives missing', async () => {
  const { step } = harness();
  await step(session(), [user('Asia/Shanghai')]);
  assert.deepEqual(await step(session(), [internal]), { kind: 'missing' });
});

test('valid IANA aliases are accepted and equivalent aliases do not conflict', () => {
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata' }).resolvedOptions().timeZone;
  assert.deepEqual(deriveContextTimeZone([user('Asia/Kolkata'), user('Asia/Calcutta')]), { kind: 'resolved', timeZone: canonical });
  assert.deepEqual(deriveContextTimeZone([user('Etc/UTC'), user('UTC')]), { kind: 'resolved', timeZone: 'UTC' });
  assert.deepEqual(deriveContextTimeZone([user('GMT+8')]), { kind: 'invalid', timeZone: 'GMT+8' });
});
