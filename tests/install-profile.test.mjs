// 隔离验证安装、重复安装和启动；外部构建及宿主命令使用替身。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const IGNORED = new Set(['.git', 'node_modules', 'target', 'lib', 'dist', '__pycache__']);
const CALL_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ cmd: name, args, cwd: process.cwd(), home: process.env.DSH_HOME }) + '\\n');
if (name === 'watchexec') {
  const command = args.slice(args.indexOf('--') + 1);
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (name === 'pnpm') {
  if (args.join(' ') === 'install --frozen-lockfile --ignore-scripts' && process.env.FAIL_BUILD_INSTALL) process.exit(17);
  if (args.join(' ') === 'run build') {
    fs.mkdirSync('lib', { recursive: true });
    fs.writeFileSync('lib/index.mjs', '// published plugin');
  }
} else if (args[0] === 'plugin') {
  const profile = path.join(process.env.DSH_HOME, 'profiles', args[2]);
  fs.mkdirSync(profile, { recursive: true });
  const manifest = path.join(profile, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# user config\\n[]\\n');
  }
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const [pkg, source] of Object.entries(data.dependencies ?? {})) {
    const link = path.join(profile, 'node_modules', pkg);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(source.replace(/^link:/, ''), link);
  }
}
`;
const SLEEPER_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.RESTART_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.DSH_HOME }) + '\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 50);
`;

function copyRepo(destination) {
  cpSync(REPO, destination, {
    recursive: true,
    filter: (source) => !IGNORED.has(basename(source)),
  });
}

function writeTool(directory, name, content) {
  const file = join(directory, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function findWatchexec() {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'watchexec');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function realWatchexec() {
  const found = findWatchexec();
  if (found && basename(dirname(found)) === 'shims') {
    const resolved = spawnSync('mise', ['which', 'watchexec'], { encoding: 'utf8' });
    if (resolved.status === 0) return resolved.stdout.trim();
  }
  return found;
}

function readJsonLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('install-profile installs twice, upgrades patches and starts the runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oks-install-'));
  try {
    const repo = join(root, 'source repo');
    copyRepo(repo);
    // install-profile consumes dist/; build a minimal release fixture.
    for (const [name, files] of Object.entries({
      'dsh-oks': ['lib/index.mjs', 'cordis.patch.yml'],
      'dsh-push-to-user': ['lib/client.js', 'cordis.patch.yml'],
    })) {
      const packageDirectory = join(repo, 'dist', name);
      for (const relative of files) {
        const target = join(packageDirectory, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, '// fixture\n');
      }
      writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: `@local/${name}`, type: 'module' }));
    }

    const tools = join(root, 'bin');
    mkdirSync(tools);
    for (const name of ['pnpm', 'dsh', 'watchexec']) writeTool(tools, name, CALL_STUB);

    const workspace = join(root, "user's workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'oks.json'), '{}');
    const target = join(root, "user's runtime");
    const log = join(root, 'calls.jsonl');
    const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, CALL_LOG: log, DSH_CMD: 'dsh', JUST_TEMPDIR: root };
    const command = ['--justfile', join(repo, 'justfile'), `target=${target}`, `workspace=${workspace}`, 'port=10924'];
    const run = (...args) => spawnSync('just', [...command, ...args], { cwd: root, env, encoding: 'utf8' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run('install-profile');
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const manifest = JSON.parse(readFileSync(join(target, 'profiles/web/package.json'), 'utf8'));
    const published = join(target, 'packages/dsh-oks');
    assert.equal(manifest.dependencies['@local/dsh-oks'], `link:${published}`);
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app', '@local/dsh-push-to-user']);
    assert.equal(manifest.dependencies['@local/dsh-push-to-user'], `link:${join(target, 'packages/dsh-push-to-user')}`);
    assert.ok(existsSync(join(target, 'packages/dsh-push-to-user/lib/client.js')));
    assert.ok(!('scripts' in JSON.parse(readFileSync(join(published, 'package.json'), 'utf8'))));
    assert.ok(!existsSync(join(repo, 'packages/dsh-oks/lib')));

    let patch = readFileSync(join(target, 'profiles/web/cordis.patch.yml'), 'utf8');
    assert.equal(patch.split('id: preset-oks\n').length - 1, 1);
    assert.equal(patch.split('id: preset-oks-knowledge\n').length - 1, 1);
    assert.ok(patch.includes('id: oks-knowledge\n'));
    assert.ok(patch.includes('knowledgeHelper: true'));
    assert.equal(patch.split('id: preset-oks-vocabulary\n').length - 1, 1);
    assert.ok(patch.includes('vocabularyHelper: true'));
    assert.equal(patch.split('id: agent-preset-registry\n').length - 1, 1);
    assert.ok(!patch.includes('\n[]\n'));
    assert.ok(patch.includes('# user config'));
    for (const name of ['dsh-fs-observation-policy', 'dsh-tool-fs', 'dsh-tool-fs-search']) {
      assert.equal(patch.split(`name: "@deepseek-ai/${name}"`).length - 1, 1);
      assert.ok(!patch.split('id: preset-oks-knowledge\n')[1].includes(name));
    }
    assert.ok(patch.includes('sampleOverCapGlobResults: false'));

    // Upgrade an existing search tool missing its required setting.
    const patchFile = join(target, 'profiles/web/cordis.patch.yml');
    writeFileSync(patchFile, patch.replace('              sampleOverCapGlobResults: false\n', ''));
    let result = run('install-profile');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    patch = readFileSync(patchFile, 'utf8');
    assert.equal(patch.split('sampleOverCapGlobResults: false').length - 1, 1);

    // Upgrade a previously installed profile with missing file tools.
    patch = patch.replace('            config:\n              sampleOverCapGlobResults: false\n', '');
    const dropped = ['id: tool-fs', 'id: fs-observation-policy', 'name: "@deepseek-ai/dsh-tool-fs', 'name: "@deepseek-ai/dsh-fs-observation-policy'];
    writeFileSync(patchFile, patch.split('\n').filter((line) => !dropped.some((name) => line.includes(name))).join('\n'));
    result = run('install-profile');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const restored = readFileSync(patchFile, 'utf8');
    for (const name of ['dsh-fs-observation-policy', 'dsh-tool-fs', 'dsh-tool-fs-search']) {
      assert.equal(restored.split(`name: "@deepseek-ai/${name}"`).length - 1, 1);
    }

    assert.ok(!existsSync(join(target, 'start.sh')));
    assert.ok(!existsSync(join(target, 'run-dsh.sh')));
    assert.ok(existsSync(join(target, 'justfile')));
    assert.ok(!existsSync(join(target, 'run-watch')));

    const direct = spawnSync('just', ['--justfile', join(target, 'justfile'), 'run-dsh', '--host', '127.0.0.1'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    const directCall = readJsonLines(log).at(-1);
    assert.deepEqual(directCall.args, ['web', '--port', '10924', '--host', '127.0.0.1']);

    const watched = spawnSync('just', ['--justfile', join(target, 'justfile'), 'run', '--host', '127.0.0.1', 'two words'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(watched.status, 0, watched.stderr);
    const call = readJsonLines(log).at(-1);
    assert.deepEqual(call.args, ['web', '--port', '10924', '--host', '127.0.0.1', 'two words']);
    assert.equal(call.cwd, workspace);
    assert.equal(call.home, target);
    assert.ok(existsSync(join(target, '.ctrl')));
    const watcher = readJsonLines(log).at(-2);
    assert.equal(watcher.cmd, 'watchexec');
    assert.deepEqual(watcher.args, ['--restart', '--ignore-nothing', '--shell=none', '-w', join(target, '.ctrl'), '--',
      'just', '--justfile', join(target, 'justfile'), 'run-dsh', '--host', '127.0.0.1', 'two words']);

    // 真实 watcher 验证 touch 会重启；子进程为替身，不监听任何服务端口。
    const real = realWatchexec();
    assert.ok(real, 'watchexec is required for restart acceptance');
    rmSync(join(tools, 'watchexec'));
    symlinkSync(real, join(tools, 'watchexec'));
    writeTool(tools, 'dsh', SLEEPER_STUB);
    const restartLog = join(root, 'restart.jsonl');
    const watcherLog = join(root, 'watcher.log');
    const output = openSync(watcherLog, 'w');
    const child = spawn('just', ['--justfile', join(target, 'justfile'), 'run'], {
      cwd: root,
      env: { ...env, RESTART_LOG: restartLog },
      detached: true,
      stdio: ['ignore', output, output],
    });
    const waitRuns = async (count) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, readFileSync(watcherLog, 'utf8'));
        const entries = existsSync(restartLog) ? readJsonLines(restartLog) : [];
        if (entries.length >= count) return entries;
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.fail(`watcher did not start/restart: ${readFileSync(watcherLog, 'utf8')}`);
    };
    try {
      await waitRuns(1);
      for (const count of [2, 3]) {
        writeFileSync(join(target, '.ctrl'), '');
        await waitRuns(count);
      }
      const runs = readJsonLines(restartLog);
      assert.equal(new Set(runs.map((item) => item.pid)).size, 3);
      assert.ok(runs.every((item) => item.cwd === workspace && item.home === target));
      writeFileSync(join(workspace, 'unrelated.txt'), 'no restart');
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(readJsonLines(restartLog).length, 3);
    } finally {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await new Promise((done) => setTimeout(done, 500));
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }

    const before = readJsonLines(log).length;
    rmSync(join(repo, 'dist'), { recursive: true, force: true });
    result = run('install-profile');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('先运行 just build'));
    assert.equal(readJsonLines(log).length - before, 0);

    result = spawnSync('just', [...command, 'port=65536', 'install-profile'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('1..65535'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaults follow the port', () => {
  for (const port of ['10923', '10925']) {
    const result = spawnSync('just', ['--set', 'port', port, '--evaluate', 'target'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(process.env.HOME, `ws/oks-demo/dsh-oks-${port}`));
  }
});
