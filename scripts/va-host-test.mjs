// 真实宿主集成：DSH_PACKAGE 指向已安装的 @deepseek-ai/dsh 目录。
// 使用独立 DSH_HOME（需已有 headless 模板）和 OKS_WORKSPACE；只调用本地确定性适配器。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dsh = process.env.DSH_PACKAGE ? realpathSync(process.env.DSH_PACKAGE) : undefined;
const home = process.env.DSH_HOME;
const workspace = process.env.OKS_WORKSPACE;
if (!dsh || !home || !workspace) throw Error('需要 DSH_PACKAGE、独立 DSH_HOME 和 OKS_WORKSPACE');
const require = createRequire(join(dsh, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { runProfile } = await import(pathToFileURL(join(dsh, 'lib/profile-boot.js')).href);
const { loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot');
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = join(home, 'profiles/headless');
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
manifest.dependencies['@local/dsh-oks'] = `link:${repo}/packages/dsh-oks`;
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
mkdirSync(join(profile, 'node_modules/@local'), { recursive: true });
const link = join(profile, 'node_modules/@local/dsh-oks');
if (!existsSync(link)) symlinkSync(join(repo, 'packages/dsh-oks'), link);
const preset = (id, helper) => ({ id: `test-preset-${id}`, name: '@deepseek-ai/dsh-agent-preset',
  config: { id, name: id, plugins: [{ id: 'oks', name: '@local/dsh-oks', config: helper ? { vocabularyHelper: true } : {} }] } });
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'session-title-llm', disabled: true },
  { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
  { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'oks' } }, preset('oks', false), preset('oks-vocabulary', true)] },
], null, 2));
const requests = [], parentRequests = [], ends = [];
const observers = new Set();
const wake = () => { for (const fn of [...observers]) fn(); };
function waitFor(predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { if (predicate()) { clearTimeout(timer); observers.delete(done); resolve(); } };
    const timer = setTimeout(() => { observers.delete(done); reject(Error('等待宿主结束或父会话接收回答超时')); }, 30000);
    observers.add(done);
    done();
  });
}
let mode = 'success';
let onStream;
class LocalAdapter extends LlmAdapter {
  async resolveModel(provider, id) {
    return { provider, id, name: id, reasoning: { efforts: [{ id: 'off', name: 'Off' }] } };
  }
  async *stream(options) {
    if (options.tools?.some(tool => tool.name === 'va_ask')) {
      parentRequests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '主会话收到子会话消息' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '主会话收到子会话消息' } };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    requests.push(options);
    assert.equal(options.provider, 'oks-va-test');
    assert.equal(options.model, 'local-fixture');
    assert.equal(options.reasoningEffort, 'off');
    assert.equal(options.tools?.length ?? 0, 0);
    const system = options.messages.filter(message => message.role === 'system').map(message =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n');
    assert.match(system, /词汇助手/);
    assert.ok(system.includes('datasets/'), '词表必须来自真实模型');
    assert.ok(!system.includes('PARENT_PRIVATE_MARKER'));
    const users = options.messages.filter(message => message.role === 'user');
    const text = users.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(text.includes('咨询问题'));
    assert.ok(!text.includes('PARENT_PRIVATE_MARKER'));
    if (mode === 'failure') throw new Error('fixture model failure');
    if (mode === 'cancel') {
      const waiting = new Promise((_resolve, reject) => {
        options.signal.throwIfAborted();
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      onStream();
      await waiting;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '本地词汇回答' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '本地词汇回答' } };
    yield { type: 'finish', reason: 'stop' };
  }
}
let ctx, parent;
try {
  ({ ctx } = await runProfile({ profile: 'headless', patchFiles: [], args: [], environment: loadLayeredEnv('dsh') }));
  ctx.on('subagent/end', info => { ends.push(info); wake(); });
  ctx.on('agent/status', wake);
  ctx.llm.registerAdapter(['oks-va-test'], new LocalAdapter());
  parent = await ctx.agents.create({ sessionId: `session-host-parent-${Date.now()}`, meta: { cwd: workspace, agentPreset: 'oks' },
    agentOptions: { provider: 'oks-va-test', model: 'local-fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'oks'); } });
  parent.agent.followup({ id: 'private-parent-message', role: 'user',
    content: [{ type: 'text', text: 'PARENT_PRIVATE_MARKER' }], source: { kind: 'user' } });
  await waitFor(() => parentRequests.length === 1 && parent.agent.status === 'idle');
  const tools = ctx.tools;
  let tool = tools.get('va_ask', parent.agent);
  assert.ok(tool, '父会话须有 va_ask');
  let before = parent.agent.session.snapshotEvents().length;
  const added = [];
  let helperId;
  async function ask(query, expected = 'completed') {
    const count = ends.length + 1;
    const result = await tool.execute({ query }, { agent: parent.agent });
    assert.equal(result.accepted, true);
    assert.equal(typeof result.messageId, 'string');
    if (helperId) assert.equal(result.helper, helperId);
    helperId = result.helper;
    if (mode === 'cancel') {
      await waitFor(() => requests.length === count);
      ctx.subagents.interrupt(helperId, { kind: 'ancestor', agent: parent.agent });
    }
    await waitFor(() => ends.length >= count && parentRequests.length >= count + 1 && parent.agent.status === 'idle');
    assert.equal(ends.at(-1).stopReason, expected);
    assert.equal(ctx.agents.get(helperId), undefined);
    return result;
  }
  for (let i = 0; i < 12; i++) await ask(`咨询问题 ${i}`);
  added.push(...parent.agent.session.snapshotEvents().slice(before));
  const parentId = parent.agent.id;
  await parent.dispose();
  parent = await ctx.agents.resume({ resumeSessionId: parentId,
    agentOptions: { provider: 'oks-va-test', model: 'local-fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'oks'); } });
  before = parent.agent.session.snapshotEvents().length;
  tool = tools.get('va_ask', parent.agent);
  await ask('咨询问题 restored');
  mode = 'failure';
  await ask('咨询问题 failure', 'error');
  mode = 'cancel';
  onStream = wake;
  await ask('咨询问题 cancel', 'aborted');
  mode = 'success';
  await ask('咨询问题 retry');
  const children = await ctx.subagents.listChildren(parent.agent.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, helperId);
  for (const child of children) assert.equal(ctx.agents.get(child.id), undefined, '各退出路径须释放 Agent');
  assert.ok(children.every(child => child.id.startsWith('session-va-') && child.label.includes('词汇助手')));
  added.push(...parent.agent.session.snapshotEvents().slice(before));
  const notices = added.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled');
  assert.equal(notices.length, 16, '每次咨询由官方宿主向主 agent 投递一条回答通知');
  assert.equal(parentRequests.length - 1, 16, '主 agent 每次原生接收一次结果');
  assert.equal(requests.length, 16);
  const normalized = requests.map(request => request.messages.map(message => ({
    role: message.role,
    content: message.content.map(block => block.type === 'text'
      ? { ...block, text: block.text.replace(/咨询问题 (?:\d+|restored|failure|cancel|retry)/g, '咨询问题 CURRENT') }
      : block),
  })));
  const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
  // 官方 sendMessage 为续问附加固定的发送者标识；首轮创建没有这个路由标识。
  const sender = `Agent ${parent.agent.id} sent a message: `;
  for (const input of normalized.slice(1)) {
    assert.equal(hash(input), hash(normalized[1]), '续问输入只改变当前问题，发送者标识保持固定');
    const withoutSender = input.map(message => ({ ...message,
      content: message.content.filter(block => block.type !== 'text' || block.text !== sender),
    }));
    assert.equal(hash(withoutSender), hash(normalized[0]), '首轮和续问的词表、标记、当前问题与运行时快照一致');
  }
  for (const request of requests) assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
  const history = await ctx.sessionQuery.observeSession(helperId);
  let retainedQueries;
  try {
    retainedQueries = history.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && /^咨询问题 /.test(block.text)));
    assert.equal(retainedQueries.length, requests.length, '收起后原始问题须完整留在持久日志中');
    assert.ok(history.events.filter(event => event.type === 'assistant/message').length >= 14,
      '全部成功回答须保留在持久日志中');
    assert.ok(history.events.some(event => event.surfaceOp?.op === 'replace'
      && event.sourceEventSeqs.length > 0), '收起须记录原始来源');
  } finally {
    history[Symbol.dispose]();
  }

  writeFileSync(join(home, 'va-host-result.json'), JSON.stringify({ children, modelCalls: requests.length,
    retainedQueries: retainedQueries.length,
    inputMessageCounts: requests.map(request => request.messages.length),
    systemChars: normalized[0].filter(message => message.role === 'system').map(message => message.content[0]?.text.length),
    parentNotifications: notices.length, parentModelCalls: parentRequests.length - 1 }, null, 2));
  console.log('官方宿主验证通过：单一子会话、固定模型输入、主 agent 原生收到回答、父会话恢复、失败/中断重试。');
} finally {
  await parent?.dispose();
  await ctx?.fiber.dispose();
}
