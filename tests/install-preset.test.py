"""隔离验证安装、重复安装和启动；外部构建及宿主命令使用替身。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]


class InstallTest(unittest.TestCase):
    def test_install_and_run(self):
        with tempfile.TemporaryDirectory(prefix="oks-install-") as tmp:
            root = Path(tmp)
            repo = root / "source repo"
            shutil.copytree(REPO, repo, ignore=shutil.ignore_patterns(
                ".git", "node_modules", "target", "lib", "__pycache__"))
            tools = root / "bin"
            tools.mkdir()
            stub = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as f:
 f.write(json.dumps({'cmd':Path(sys.argv[0]).name,'args':args,'cwd':os.getcwd(),'home':os.environ.get('DSH_HOME')})+'\\n')
if Path(sys.argv[0]).name=='pnpm':
 if args==['install','--frozen-lockfile','--ignore-scripts'] and os.environ.get('FAIL_BUILD_INSTALL'):
  sys.exit(17)
 if args==['run','build']:
  Path('lib').mkdir(exist_ok=True)
  Path('lib/index.mjs').write_text('// published plugin')
  Path('lib/oks-wti.wasm').write_bytes(b'wasm')
elif args[0]=='plugin':
 profile=Path(os.environ['DSH_HOME'])/'profiles'/args[2]
 profile.mkdir(parents=True,exist_ok=True)
 manifest=profile/'package.json'
 if not manifest.exists():
  manifest.write_text(json.dumps({'dsh':{'profile':{'bundles':[]}}}))
  (profile/'cordis.patch.yml').write_text('# user config\\n[]\\n')
 data=json.loads(manifest.read_text())
 for package,source in data.get('dependencies',{}).items():
  link=profile/'node_modules'/package
  link.parent.mkdir(parents=True,exist_ok=True)
  if link.is_symlink(): link.unlink()
  link.symlink_to(source.removeprefix('link:'))
'''
            for name in ("pnpm", "dsh"):
                tool = tools / name
                tool.write_text(stub)
                tool.chmod(0o755)
            workspace = root / "user's workspace"
            workspace.mkdir()
            (workspace / "oks.json").write_text('{}')
            target = root / "user's runtime"
            log = root / "calls.jsonl"
            env = {**os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
                   "CALL_LOG": str(log), "DSH_CMD": "dsh", "JUST_TEMPDIR": str(root)}
            command = ["just", "--justfile", str(repo / "justfile"),
                       f"target={target}", f"workspace={workspace}", "port=10924"]

            def run(*args, **overrides):
                return subprocess.run([*command, *args], cwd=root,
                                      env={**env, **overrides}, text=True,
                                      capture_output=True)

            for _ in range(2):
                result = run("install")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((target / "profiles/web/package.json").read_text())
            published = target / "packages/dsh-oks"
            self.assertEqual(manifest['dependencies']['@local/dsh-oks'], f"link:{published}")
            self.assertEqual(manifest['dsh']['profile']['bundles'], ['@deepseek-ai/dsh-web-app'])
            self.assertTrue((published / "lib/oks-wti.wasm").exists())
            self.assertNotIn('scripts', json.loads((published / 'package.json').read_text()))
            self.assertFalse((repo / "packages/dsh-oks/lib").exists())
            patch = (target / "profiles/web/cordis.patch.yml").read_text()
            self.assertEqual(patch.count('id: preset-oks\n'), 1)
            self.assertEqual(patch.count('id: preset-oks-vocabulary\n'), 1)
            self.assertIn('id: oks-vocabulary\n', patch)
            self.assertIn('vocabularyHelper: true', patch)
            self.assertEqual(patch.count('id: agent-preset-registry\n'), 1)
            self.assertNotIn('\n[]\n', patch)
            self.assertIn('# user config', patch)

            result = run("run", "--host", "127.0.0.1", "two words")
            self.assertEqual(result.returncode, 0, result.stderr)
            call = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual(call['args'], ['web', '--port', '10924', '--host', '127.0.0.1', 'two words'])
            self.assertEqual(call['cwd'], str(workspace))
            self.assertEqual(call['home'], str(target))

            count = len(log.read_text().splitlines())
            result = run("install", FAIL_BUILD_INSTALL="1")
            self.assertNotEqual(result.returncode, 0)
            calls = [json.loads(line) for line in log.read_text().splitlines()[count:]]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['args'], ['install', '--frozen-lockfile', '--ignore-scripts'])

            result = subprocess.run([*command, 'port=65536', 'install'], cwd=root,
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('1..65535', result.stderr)

    def test_defaults_follow_port(self):
        for port in ('10923', '10925'):
            result = subprocess.run(['just', '--set', 'port', port, '--evaluate', 'target'],
                                    cwd=REPO, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), str(Path.home() / f'ws/oks-demo/dsh-oks-{port}'))


if __name__ == '__main__':
    unittest.main()
