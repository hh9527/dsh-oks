#!/usr/bin/env bash
# install-preset.sh —— 把一个 dsh profile 配成「OKS 问数」（preset id `oks`）。
#
# 构建插件、注册 OKS preset，图表和报告通过宿主附件交付。
# 用法：./install-preset.sh [--profile web] [--dsh-home ~/.dsh]

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE='@local/dsh-oks'
PACKAGE_DIR="$REPO_DIR/packages/dsh-oks"
PATCH_ID='preset-oks'

usage() {
  cat <<'USAGE'
用法：install-preset.sh

直接跑就够了：profile 取 $DSH_PROFILE（没有就用 web），home 取 $DSH_HOME（没有就用
~/.dsh）；被链接的插件源就是本脚本所在仓库里的 packages/dsh-oks，不用给路径。
下面两个开关只作覆盖：

  --profile <名字>    换成别的 profile
  --dsh-home <目录>   换成别的 Harness home
  -h, --help          这一段
USAGE
}

fail() {
  printf 'install-preset.sh: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'install-preset.sh: %s\n' "$*"
}

PROFILE="${DSH_PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || fail '--profile 后面要跟一个名字'
      PROFILE="$2"
      shift 2
      ;;
    --dsh-home)
      [ $# -ge 2 ] || fail '--dsh-home 后面要跟一个目录'
      DSH_HOME_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "不认识的参数 $1"
      ;;
  esac
done

[ -n "$PROFILE" ] || fail 'profile 名字是空的'
[ "$PROFILE" != 'desktop' ] || fail 'desktop profile 由 DeepSeek Harness Desktop 自己初始化，先打开它一次并完全退出，再用 dsh plugin 管理'

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

command -v node >/dev/null 2>&1 || fail '需要 node（dsh 也依赖它）'

# 用数组而不是字符串：路径里有空格时字符串会被拆开。
if [ -n "${DSH_CMD:-}" ]; then
  read -r -a DSH_ARR <<< "$DSH_CMD"
  [ "${#DSH_ARR[@]}" -gt 0 ] || fail "DSH_CMD 是空的：$DSH_CMD"
elif command -v dsh >/dev/null 2>&1; then
  DSH_ARR=(dsh)
elif command -v pnpm >/dev/null 2>&1; then
  DSH_ARR=(pnpm dlx @deepseek-ai/dsh)
else
  fail 'PATH 里既没有 dsh 也没有 pnpm：装一个，或用 DSH_CMD 给出调用方式（例如 DSH_CMD="pnpm dlx @deepseek-ai/dsh"）'
fi
say "用 ${DSH_ARR[*]} 调用 dsh"

# ── 1. 产物 ──────────────────────────────────────────────────────────────────
# 仓库只带源码：exports 指向 lib/index.mjs，而 lib/ 不入库，所以新克隆必须先构建。
for dir in "$PACKAGE_DIR"; do
  [ -f "$dir/package.json" ] || fail "没有包目录 $dir"
  need_build=0
  [ -f "$dir/lib/index.mjs" ] || need_build=1
  # 插件包还多一个旁资产：求值器的 .wasm（与 index.mjs 同目录）。
  if [ "$dir" = "$PACKAGE_DIR" ] && [ ! -f "$dir/lib/oks-wti.wasm" ]; then need_build=1; fi
  if [ "$need_build" = 1 ]; then
    command -v pnpm >/dev/null 2>&1 || fail "lib/ 里的产物不全（$dir），构建需要 pnpm"
    say "构建产物（$dir）"
    (
      cd "$dir"
      [ -d node_modules ] || pnpm install
      pnpm run build
    ) || fail "pnpm 构建失败（$dir）"
  fi
  [ -f "$dir/lib/index.mjs" ] || fail "构建后仍没有 $dir/lib/index.mjs"
  if [ "$dir" = "$PACKAGE_DIR" ]; then
    [ -f "$dir/lib/oks-wti.wasm" ] \
      || fail "构建后仍没有 $dir/lib/oks-wti.wasm：求值器要用 Rust 构建（cargo + wasm32-unknown-unknown target）"
  fi
done

# ── 2. profile ───────────────────────────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  say "初始化 profile $PROFILE（$PROFILE_DIR）"
  DSH_HOME="$DSH_HOME_DIR" "${DSH_ARR[@]}" plugin --profile "$PROFILE" install \
    || fail "初始化 profile $PROFILE 失败"
fi
[ -f "$MANIFEST" ] || fail "没有 profile 清单 $MANIFEST"
[ -f "$PATCH_FILE" ] || : > "$PATCH_FILE"

# ── 2b. bundles：OKS profile 是 Web 形态（base + web-app）──────────────────────
# Web profile 提供宿主附件展示与 agent-preset-registry。
if MANIFEST="$MANIFEST" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
  process.exit((manifest.dsh?.profile?.bundles ?? []).includes("@deepseek-ai/dsh-web-app") ? 0 : 1);
'; then
  say "bundles 已含 @deepseek-ai/dsh-web-app"
else
  say "把 @deepseek-ai/dsh-web-app 加进 bundles"
  MANIFEST="$MANIFEST" node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.env.MANIFEST;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const profile = manifest.dsh?.profile ?? {};
    const bundles = [...(profile.bundles ?? []), "@deepseek-ai/dsh-web-app"];
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...profile, bundles } };
    writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
  ' || fail "写 $MANIFEST 失败"
fi

# ── 3. 依赖 ──────────────────────────────────────────────────────────────────
# 先写依赖、再 install：install 在跑之前就把这份清单读成 before，reconcile 因此不会把这个
# 带 dsh.bundle 的包自动升成 profile bundle 层。
for pair in "$PACKAGE:$PACKAGE_DIR"; do
  name="${pair%%:*}"
  dir="${pair#*:}"
  if MANIFEST="$MANIFEST" PACKAGE="$name" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
    process.exit(manifest.dependencies?.[process.env.PACKAGE] === undefined ? 1 : 0);
  '; then
    say "依赖已在 $MANIFEST（$name）"
  else
    say "把 $name 以 link: 写进 $MANIFEST"
    MANIFEST="$MANIFEST" PACKAGE="$name" PACKAGE_DIR="$dir" node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const file = process.env.MANIFEST;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [process.env.PACKAGE]: `link:${process.env.PACKAGE_DIR}` };
      writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
    ' || fail "写 $MANIFEST 失败"
  fi
done

# ── 4. 链接 ──────────────────────────────────────────────────────────────────
# 判断链接而不是判断 node_modules 目录：-f 会跟随符号链接，断链也算没有。
missing=''
for pair in "$PACKAGE:$PACKAGE_DIR"; do
  name="${pair%%:*}"
  [ -f "$PROFILE_DIR/node_modules/$name/package.json" ] || missing="$missing $name"
done
if [ -z "$missing" ]; then
  say "链接已在 $PROFILE_DIR/node_modules/"
else
  command -v pnpm >/dev/null 2>&1 || fail '安装依赖需要 pnpm'
  say "在 profile $PROFILE 里安装（pnpm install）"
  DSH_HOME="$DSH_HOME_DIR" "${DSH_ARR[@]}" plugin --profile "$PROFILE" install \
    || fail "profile $PROFILE 的依赖安装失败"
  for pair in "$PACKAGE:$PACKAGE_DIR"; do
    name="${pair%%:*}"
    [ -f "$PROFILE_DIR/node_modules/$name/package.json" ] \
      || fail "安装后仍没有 $PROFILE_DIR/node_modules/$name"
  done
fi

# ── 5. preset ────────────────────────────────────────────────────────────────
if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${PATCH_ID}[[:space:]]*\$" "$PATCH_FILE"; then
  say "preset $PATCH_ID 已在 $PATCH_FILE"
else
  say "把 preset $PATCH_ID 追加进 $PATCH_FILE"
  tmp="$(mktemp "${PATCH_FILE}.XXXXXX")"
  # 模板里的空数组占位 [] 恰好是最后一个有意义行时删掉它；文件里别处的 [] 原样保留。
  # 用重定向而不是 mv：保持补丁文件原有的属主与权限。
  awk '
    { line[NR] = $0 }
    $0 ~ /^[[:space:]]*\[\][[:space:]]*$/ { empty = NR }
    NF && $0 !~ /^[[:space:]]*#/ { meaning = NR }
    END {
      for (i = 1; i <= NR; i++) if (!(i == empty && i == meaning)) print line[i]
    }
  ' "$PATCH_FILE" > "$tmp"
  cat "$tmp" > "$PATCH_FILE"
  rm -f "$tmp"
  cat >> "$PATCH_FILE" <<'YAML'

# agent preset：OKS 问数 —— 知识发现、DARI 回答源码和只读输出工具 + 追问。
- insert:
    - id: preset-oks
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: oks
        name: OKS 问数
        description: 业务问句 → 查询结果：词汇规整、知识发现、DARI 分析、只读查询与答案交付。
        order: 5
        plugins:
          - id: persona
            name: "@deepseek-ai/dsh-persona"
            config:
              includeRuntimeContext: false
              prefix: ''
          - id: tool-ask-user
            name: "@deepseek-ai/dsh-tool-ask-user"
          - id: tool-skill
            name: "@deepseek-ai/dsh-tool-skill"
          - id: present
            name: "@deepseek-ai/dsh-tool-present"
          - id: oks
            name: "@local/dsh-oks"
            config: {}
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: "@deepseek-ai/dsh-compaction-basic"
              - id: command-compact
                name: "@deepseek-ai/dsh-command-compact"
              - id: tool-result-pruner
                name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
                config:
                  # 阈值管"小于这个数就别动它"：64K 之下原样进上下文（被剪掉的中间段往往是
                  # 知识节点声明、文件正文与构建输出里最要紧的部分）；head/tail 只服务更大的输出。
                  thresholdChars: 65536
                  headChars: 4096
                  tailChars: 1024
YAML
fi

# 清理本安装器管理的旧产出页签，保留宿主文件与附件预览。
MANIFEST="$MANIFEST" PATCH_FILE="$PATCH_FILE" node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.MANIFEST;const manifest=JSON.parse(readFileSync(file,'utf8'));
if(manifest.dependencies)delete manifest.dependencies['@local/dsh-oks-ui'];
writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
const patch=process.env.PATCH_FILE;
let text=readFileSync(patch,'utf8');
text=text.replace(/^- insert:\s*\n    - id: oks-ui\n      name: ['"]@local\/dsh-oks-ui['"]\n/gm,'');
text=text.replace(/^- id: ui-sidebar-(files|terminal)\n  disabled: true\n/gm,'');
writeFileSync(patch,text);
JS

# ── 8. 默认 preset ───────────────────────────────────────────────────────────
# preset 注册了不等于被选中：新会话落在 preset-registry 的 default 上（base 那里是 standard）。
# selectedDefault（用户在界面上选过的）优先级更高，所以这里只写 default，不锁死用户的选择。
if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*agent-preset-registry[[:space:]]*\$" "$PATCH_FILE"; then
  say "agent-preset-registry 已在 $PATCH_FILE"
else
  say "把默认 preset 写成 $PATCH_ID（追加 agent-preset-registry）"
  cat >> "$PATCH_FILE" <<'YAML'

# 默认 preset：新会话落在 OKS 上（preset 注册了不等于被选中）。
- id: agent-preset-registry
  config:
    default: oks
YAML
fi

say "profile $PROFILE 已注册 preset $PATCH_ID"
say "  profile 目录：$PROFILE_DIR"
say "  插件链接：$PROFILE_DIR/node_modules/$PACKAGE -> $PACKAGE_DIR"

# 注册的是 preset；profile 的 bundle 层里若也有本包，全局那行会跟着一起生效。
if MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
  process.exit((manifest.dsh?.profile?.bundles ?? []).includes(process.env.PACKAGE) ? 0 : 1);
'; then
  say "注意：$MANIFEST 的 dsh.profile.bundles 里也有 $PACKAGE，本包自带的全局 oks 行会同时生效。"
  say "      只想保留 preset 就把它从 bundles 里删掉（本脚本不动 bundles）。"
fi

say "下一步：启动或重启该 profile（例如 ${DSH_ARR[*]} $PROFILE）。用户补丁层是热重载的，如果它正在运行，新会话用新定义。"
