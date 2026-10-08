#!/usr/bin/env bash
# install-preset.sh —— 把一个 dsh profile 配成「OKS 问数」（preset id `oks`）。
#
# 可重复执行：每一步都先看现状，已经成立就跳过。顺序是
#   1. 产物：dist/index.mjs 不存在时，在仓库里构建（node_modules 缺失才先 pnpm install）。
#   2. profile：package.json 不存在时，用 `dsh plugin` 按模板初始化。
#   3. 依赖：把本仓库以 link: 写进 profile 的 package.json。
#   4. 链接：profile 的 node_modules 里没有 @local/dsh-oks 时，在该 profile 里跑 pnpm install
#      （走 `dsh plugin --profile <名> install`，拿它的文件锁与 pnpm 调用）。
#   5. preset：profile 的 cordis.patch.yml 里没有 preset-oks 时，把下面这段追加进去。
#      模板里的空数组占位 [] 会让位——它后面再接 - insert: 不是合法 YAML。
#
# 注册的是 preset：oks_* / time_* / va_ask 只在这个 preset 的作用域里。脚本不把本包写进
# profile 的 dsh.profile.bundles：bundles 里的包会连它自己的 cordis.patch.yml 一起应用，
# 那多出一行全局工具注册。bundles 里已经有本包时，结尾给一条提示（脚本不改 bundles）。
#
# 用法：./install-preset.sh
# 直接跑就够了：profile 取 $DSH_PROFILE（没有就用 web），home 取 $DSH_HOME（没有就用 ~/.dsh）；
# 被链接的插件源就是本脚本所在的仓库，不用给路径。--profile / --dsh-home 只作覆盖。

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE='@local/dsh-oks'
PATCH_ID='preset-oks'

usage() {
  cat <<'USAGE'
用法：install-preset.sh

直接跑就够了：profile 取 $DSH_PROFILE（没有就用 web），home 取 $DSH_HOME（没有就用
~/.dsh）；被链接的插件源就是本脚本所在的仓库，不用给路径。下面两个开关只作覆盖：

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
command -v dsh >/dev/null 2>&1 || fail 'PATH 里没有 dsh；先装 DeepSeek Harness（或把 dsh 放进 PATH）'

# ── 1. 产物 ──────────────────────────────────────────────────────────────────
# 仓库只带源码：exports 指向 dist/index.mjs，而 dist/ 不入库，所以新克隆必须先构建。
if [ ! -f "$REPO_DIR/dist/index.mjs" ]; then
  command -v pnpm >/dev/null 2>&1 || fail 'dist/index.mjs 不存在，构建需要 pnpm'
  say '构建插件产物 dist/index.mjs'
  (
    cd "$REPO_DIR"
    [ -d node_modules ] || pnpm install
    pnpm run build
  ) || fail 'pnpm 构建失败'
fi
[ -f "$REPO_DIR/dist/index.mjs" ] || fail "构建后仍没有 $REPO_DIR/dist/index.mjs"

# ── 2. profile ───────────────────────────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  say "初始化 profile $PROFILE（$PROFILE_DIR）"
  DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile "$PROFILE" install \
    || fail "初始化 profile $PROFILE 失败"
fi
[ -f "$MANIFEST" ] || fail "没有 profile 清单 $MANIFEST"
[ -f "$PATCH_FILE" ] || : > "$PATCH_FILE"

# ── 3. 依赖 ──────────────────────────────────────────────────────────────────
# 先写依赖、再 install：install 在跑之前就把这份清单读成 before，reconcile 因此不会把这个
# 带 dsh.bundle 的包自动升成 profile bundle 层。
if MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
  process.exit(manifest.dependencies?.[process.env.PACKAGE] === undefined ? 1 : 0);
'; then
  say "依赖已在 $MANIFEST"
else
  say "把 $PACKAGE 以 link: 写进 $MANIFEST"
  MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" REPO_DIR="$REPO_DIR" node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.env.MANIFEST;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [process.env.PACKAGE]: `link:${process.env.REPO_DIR}` };
    writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
  ' || fail "写 $MANIFEST 失败"
fi

# ── 4. 链接 ──────────────────────────────────────────────────────────────────
# 判断链接而不是判断 node_modules 目录：-f 会跟随符号链接，断链也算没有。
if [ -f "$PROFILE_DIR/node_modules/$PACKAGE/package.json" ]; then
  say "链接已在 $PROFILE_DIR/node_modules/$PACKAGE"
else
  command -v pnpm >/dev/null 2>&1 || fail '安装依赖需要 pnpm'
  say "在 profile $PROFILE 里安装（pnpm install）"
  DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile "$PROFILE" install \
    || fail "profile $PROFILE 的依赖安装失败"
  [ -f "$PROFILE_DIR/node_modules/$PACKAGE/package.json" ] \
    || fail "安装后仍没有 $PROFILE_DIR/node_modules/$PACKAGE"
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

# agent preset：OKS 问数 —— 工具只有知识服务（oks_*）+ 时间（time_*）+ 追问。
- insert:
    - id: preset-oks
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: oks
        name: OKS 问数
        description: 业务问句 → 查询结果：术语检索、引用反查、知识发现、Intent 校验、只读查询、追问澄清。
        order: 5
        plugins:
          - id: persona
            name: "@deepseek-ai/dsh-persona"
            config:
              complete: true
              includeRuntimeContext: false
              prefix: |-
                You answer business questions from the data this workspace declares in oks.json.
                Find what a thing is called with oks_search and what references it with oks_references,
                read the declared knowledge with oks_info, express the question as structured Intents and
                check them with oks_check_intent, then get the actual rows with oks_query. Answer with
                those results and state the framing you used — time window, grouping, measures, filters.
                When the request is ambiguous, ask the user.
          - id: tool-ask-user
            name: "@deepseek-ai/dsh-tool-ask-user"
          - id: tool-skill
            name: "@deepseek-ai/dsh-tool-skill"
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
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
YAML
fi

say "profile $PROFILE 已注册 preset $PATCH_ID"
say "  profile 目录：$PROFILE_DIR"
say "  插件链接：$PROFILE_DIR/node_modules/$PACKAGE -> $REPO_DIR"

# 注册的是 preset；profile 的 bundle 层里若也有本包，全局那行会跟着一起生效。
if MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
  process.exit((manifest.dsh?.profile?.bundles ?? []).includes(process.env.PACKAGE) ? 0 : 1);
'; then
  say "注意：$MANIFEST 的 dsh.profile.bundles 里也有 $PACKAGE，本包自带的全局 oks 行会同时生效。"
  say "      只想保留 preset 就把它从 bundles 里删掉（本脚本不动 bundles）。"
fi

say "下一步：启动或重启该 profile（例如 dsh $PROFILE）。用户补丁层是热重载的，如果它正在运行，新会话用新定义。"
