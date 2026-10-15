// 把求值器的 wasm 从 Cargo 的 target/ 拷进 lib/。
//
// 为什么必须拷：插件在 profile 里是 `link:` 装的，运行时加载的就是 `lib/index.mjs`，
// 而引擎按 `import.meta.url` 就近找同目录的 `oks-wti.wasm`。也就是说 —— **旁资产要跟产物同目录**。
//
//   cargo build --release -p oks-wti --target wasm32-unknown-unknown
//   <仓库>/target/wasm32-unknown-unknown/release/oks_wti.wasm → lib/oks-wti.wasm
//
// 需要 Rust 工具链与 wasm32-unknown-unknown target。缺了就**明确报错**（带补法），不静默跳过：
// 少一个引擎却"构建成功"是最坏的收场。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(packageDir, '../..');
const target = 'wasm32-unknown-unknown';
const built = join(repoDir, 'target', target, 'release', 'oks_wti.wasm');
const shipped = join(packageDir, 'lib', 'oks-wti.wasm');

// 先**只读地**看一眼缓存全不全：`cargo fetch --locked --offline` 不会碰网络、也不写 ~/.cargo。
// 全了就照常编（这一步只需要读共享缓存 + 写仓库里的 target/）；缺了就先说清"只有这一步要权限"，
// 免得每次构建都去要一次。
const manifest = join(repoDir, 'Cargo.toml');
const cached = spawnSync('cargo', ['fetch', '--locked', '--offline', '--manifest-path', manifest], { stdio: 'pipe' });
if (cached.status !== 0) {
  console.log('oks-wti: 共享的 cargo 缓存里还缺依赖（或 Cargo.lock 需要更新）——'
    + '这是**唯一**需要写 ~/.cargo 的一步：先跑一次 `cargo fetch`，或给这次构建一次缓存写权限；'
    + '之后重复构建都只读缓存，不再需要额外权限。');
}

const cargo = spawnSync('cargo', [
  'build', '--release', '-p', 'oks-wti', '--target', target, '--manifest-path', manifest,
], { stdio: 'inherit' });

if (cargo.error?.code === 'ENOENT') {
  throw new Error('这台机器上没有 cargo：求值器（crates/oks-wti）要用 Rust 构建。'
    + '装好 rustup 后执行 `rustup target add wasm32-unknown-unknown` 再重试。');
}
if (cargo.status !== 0) throw new Error(`cargo build 失败（退出码 ${cargo.status}）：求值器没编出来。`);
if (cargo.signal !== null) throw new Error(`cargo build 被信号 ${cargo.signal} 终止：求值器没编出来。`);

mkdirSync(dirname(shipped), { recursive: true });
copyFileSync(built, shipped);
console.log(`oks-wti.wasm ${statSync(shipped).size} 字节 → ${shipped}`);
