# OKS 发布与运行环境。命令行示例见 README.md。
port := "10923"
target := justfile_directory() / ".deploy/dsh-" + port
profile := "web"
workspace := absolute_path(target) / "demo-ws"

export OKS_INSTALL_PORT := port
export DSH_HOME := absolute_path(target)
export DSH_PROFILE := profile
export OKS_WORKSPACE := absolute_path(workspace)

# 显示可用命令。
default:
    @just --list

# 更新依赖并写回 lockfile（版本统一在 pnpm-workspace.yaml 的 catalog）。
update-deps:
    pnpm install --ignore-scripts

# 构建所有包到发布目录 dist/（不进入版本控制）。
build:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v pnpm >/dev/null 2>&1 || { printf 'build: 需要 pnpm\n' >&2; exit 1; }
    # 插件随 dari 仓库演进：默认从同级 ../dari 构建，可用 DARI_REPO 指定。
    DARI_REPO="${DARI_REPO:-../dari}"
    (cd "$DARI_REPO/packages/dsh" && pnpm run build) || { printf 'build: 插件构建失败（%s）\n' "$DARI_REPO" >&2; exit 1; }

# 构建并准备独立部署；服务由生成的 run.sh 手动启动。
[positional-arguments]
deploy deploy_port:
    #!/usr/bin/env bash
    set -euo pipefail
    DEPLOY_PORT="$1"
    [[ "$DEPLOY_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( DEPLOY_PORT <= 65535 )) || { printf 'deploy: port 必须是 1..65535 的整数\n' >&2; exit 1; }
    # 部署产物属于使用方项目：默认放在调用者当前目录的 .deploy 下，可用 OKS_DEPLOY_ROOT 指定。
    DEPLOY_ROOT="${OKS_DEPLOY_ROOT:-$PWD/.deploy}"
    DEPLOY_DIR="$DEPLOY_ROOT/dsh-$DEPLOY_PORT"
    just build
    mkdir -p "$DEPLOY_DIR/demo-ws"
    just "port=$DEPLOY_PORT" "target=$DEPLOY_DIR" "workspace=$DEPLOY_DIR/demo-ws" install-profile

# 安装已构建的发布目录到完整 Web profile，包含主 Agent 文件工具。
install-profile:
    #!/usr/bin/env bash
    set -euo pipefail
    REPO_DIR="$PWD"
    PACKAGE='@local/dsh-plugin-dari'
    PACKAGE_DIR="$DSH_HOME/packages/dsh-plugin-dari"
    PATCH_ID='preset-dari'
    PROFILE="$DSH_PROFILE"
    DSH_HOME_DIR="$DSH_HOME"
    fail() { printf 'install-profile: %s\n' "$*" >&2; exit 1; }
    say() { printf 'install-profile: %s\n' "$*"; }
    [[ "$OKS_INSTALL_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( OKS_INSTALL_PORT <= 65535 )) || fail 'port 必须是 1..65535 的整数'
    [[ "$PROFILE" =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'profile 只能包含字母、数字、下划线与连字符'
    mkdir -p "$OKS_WORKSPACE"
    [ "$PROFILE" != 'desktop' ] || fail 'desktop profile 由 DeepSeek Harness Desktop 自己初始化，先打开它一次并完全退出，再用 dsh plugin 管理'

    PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
    MANIFEST="$PROFILE_DIR/package.json"
    PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

    command -v node >/dev/null 2>&1 || fail '需要 node（dsh 也依赖它）'
    command -v watchexec >/dev/null 2>&1 || fail '启动器需要 watchexec'

    # 用数组而不是字符串：路径里有空格时字符串会被拆开。
    if [ -n "${DSH_CMD:-}" ]; then
      read -r -a DSH_ARR <<< "$DSH_CMD"
      [ "${#DSH_ARR[@]}" -gt 0 ] || fail "DSH_CMD 是空的：$DSH_CMD"
    elif command -v dsh >/dev/null 2>&1; then
      DSH_ARR=(dsh)
    elif command -v pnpm >/dev/null 2>&1; then
      DSH_ARR=(pnpm dlx -y
        --allow-build @deepseek-ai/dsh-subprocess-local
        --allow-build @google/genai
        --allow-build koffi
        --allow-build node-pty
        --allow-build protobufjs
        @deepseek-ai/dsh)
    else
      fail 'PATH 里既没有 dsh 也没有 pnpm：装一个，或用 DSH_CMD 给出调用方式（例如 DSH_CMD="pnpm dlx @deepseek-ai/dsh"）'
    fi
    say "用 ${DSH_ARR[*]} 调用 dsh"

    # 发布目录由 just build 生成；安装只负责复制与接线。
    DARI_REPO="${DARI_REPO:-$REPO_DIR/../dari}"
    DIST_DIR="$DARI_REPO/dist"
    [ -f "$DIST_DIR/dsh-plugin-dari/package.json" ] || fail "缺少发布目录 $DIST_DIR/dsh-plugin-dari，先运行 just build"
    [ -f "$DIST_DIR/dsh-plugin-dari-client/package.json" ] || fail "缺少发布目录 $DIST_DIR/dsh-plugin-dari-client，先运行 just build"
    CLIENT_PACKAGE='@local/dsh-plugin-dari-client'
    PRESET_PACKAGE='@local/dsh-preset-dari'
    CLIENT_DIR="$DSH_HOME/packages/dsh-plugin-dari-client"
    PRESET_DIR="$DSH_HOME/packages/dsh-preset-dari"
    rm -rf "$PACKAGE_DIR" "$CLIENT_DIR"
    mkdir -p "$DSH_HOME/packages"
    cp -R "$DIST_DIR/dsh-plugin-dari" "$PACKAGE_DIR"
    cp -R "$DIST_DIR/dsh-plugin-dari-client" "$CLIENT_DIR"
    rm -rf "$PRESET_DIR"
    cp -R "$DARI_REPO/packages/dsh/dsh-preset-dari" "$PRESET_DIR"

    # ── 1b. runtime：锁定 dsh 及其依赖版本 ──────────────────────────────────────
    # runtime/pnpm-lock.yaml 固定全部解析结果；适配器的本地补丁以 pnpm patch 形式
    # 记录在 runtime/pnpm-workspace.yaml，安装时按补丁哈希自动应用，升级不匹配即报错。
    rm -rf "$DSH_HOME_DIR/runtime"
    mkdir -p "$DSH_HOME_DIR/runtime/patches"
    cp "$REPO_DIR/runtime/package.json" "$REPO_DIR/runtime/pnpm-lock.yaml" "$REPO_DIR/runtime/pnpm-workspace.yaml" "$DSH_HOME_DIR/runtime/"
    cp "$REPO_DIR/runtime"/patches/*.patch "$DSH_HOME_DIR/runtime/patches/"
    say "安装 runtime 依赖（frozen lockfile）"
    ( cd "$DSH_HOME_DIR/runtime" && pnpm install --frozen-lockfile --reporter=append-only ) || fail "runtime 依赖安装失败"
    # 显式给出 DSH_CMD 时保留调用方指定的命令（测试与特殊环境），否则用锁定版本。
    if [ -z "${DSH_CMD:-}" ]; then
      DSH_ARR=("$DSH_HOME_DIR/runtime/node_modules/.bin/dsh")
      [ -x "${DSH_ARR[0]}" ] || fail "runtime 里没有 dsh 可执行文件"
    fi

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
    # 客户端能力包必须进 bundles：客户端模块只扫描 profile 层的 loader entry，
    # preset 里挂载的插件不会被发现。
    if MANIFEST="$MANIFEST" CLIENT_PACKAGE="$CLIENT_PACKAGE" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
      process.exit((manifest.dsh?.profile?.bundles ?? []).includes(process.env.CLIENT_PACKAGE) ? 0 : 1);
    '; then
      say "bundles 已含 $CLIENT_PACKAGE"
    else
      say "把 $CLIENT_PACKAGE 加进 bundles"
      MANIFEST="$MANIFEST" CLIENT_PACKAGE="$CLIENT_PACKAGE" node --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const file = process.env.MANIFEST;
        const manifest = JSON.parse(readFileSync(file, "utf8"));
        const profile = manifest.dsh?.profile ?? {};
        const bundles = [...(profile.bundles ?? []), process.env.CLIENT_PACKAGE];
        manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...profile, bundles } };
        writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
      ' || fail "写 $MANIFEST 失败"
    fi

    # preset 组合包必须进 bundles：它的 cordis.patch.yml 定义 preset 与默认选择。
    if MANIFEST="$MANIFEST" PRESET_PACKAGE="$PRESET_PACKAGE" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
      process.exit((manifest.dsh?.profile?.bundles ?? []).includes(process.env.PRESET_PACKAGE) ? 0 : 1);
    '; then
      say "bundles 已含 $PRESET_PACKAGE"
    else
      say "把 $PRESET_PACKAGE 加进 bundles"
      MANIFEST="$MANIFEST" PRESET_PACKAGE="$PRESET_PACKAGE" node --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const file = process.env.MANIFEST;
        const manifest = JSON.parse(readFileSync(file, "utf8"));
        const profile = manifest.dsh?.profile ?? {};
        const bundles = [...(profile.bundles ?? []), process.env.PRESET_PACKAGE];
        manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...profile, bundles } };
        writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
      ' || fail "写 $MANIFEST 失败"
    fi

    # ── 3. 依赖 ──────────────────────────────────────────────────────────────────
    # 先写依赖、再 install：install 在跑之前就把这份清单读成 before，reconcile 因此不会把这个
    # 带 dsh.bundle 的包自动升成 profile bundle 层。
    say "把 $PACKAGE 和 $CLIENT_PACKAGE 链接到发布目录"
    MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" PACKAGE_DIR="$PACKAGE_DIR" CLIENT_PACKAGE="$CLIENT_PACKAGE" CLIENT_DIR="$CLIENT_DIR" PRESET_PACKAGE="$PRESET_PACKAGE" PRESET_DIR="$PRESET_DIR" node --input-type=module <<'JS'
    import {readFileSync,writeFileSync} from 'node:fs';
    const file=process.env.MANIFEST;
    const manifest=JSON.parse(readFileSync(file,'utf8'));
    manifest.dependencies={
      ...(manifest.dependencies??{}),
      [process.env.PACKAGE]:`link:${process.env.PACKAGE_DIR}`,
      [process.env.CLIENT_PACKAGE]:`link:${process.env.CLIENT_DIR}`,
      [process.env.PRESET_PACKAGE]:`link:${process.env.PRESET_DIR}`,
    };
    writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    JS

    # ── 4. 链接 ──────────────────────────────────────────────────────────────────
    say "安装 profile $PROFILE 的依赖"
    DSH_HOME="$DSH_HOME_DIR" "${DSH_ARR[@]}" plugin --profile "$PROFILE" install \
      || fail "profile $PROFILE 的依赖安装失败"
    [ -f "$PROFILE_DIR/node_modules/$PACKAGE/package.json" ] || fail '插件链接未就位'
    [ -f "$PROFILE_DIR/node_modules/$CLIENT_PACKAGE/package.json" ] || fail '客户端包链接未就位'

    # preset 由 @local/dsh-preset-dari 包提供（dsh.bundle.patch），部署不再生成 YAML。

    # ── 9. 模型流式工具入参损坏的重试 ───────────────────────────────────────────
    # 提供方偶发下发非法 JSON 的工具入参（MALFORMED_RESPONSE）；默认重试码不含它，
    # 整个回合会作废，该段任务被拖到下一段重做。把它并入有界重试集合即可就地恢复。
    if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*llm-deepseek[[:space:]]*\$" "$PATCH_FILE"; then
      say "llm-deepseek 重试策略已在 $PATCH_FILE"
    else
      say "给 llm-deepseek 追加 MALFORMED_RESPONSE 重试策略"
      cat >> "$PATCH_FILE" <<'YAML'

    # 模型流式工具入参损坏时按有界重试恢复，避免整轮作废；其余重试条件沿用默认。
    - id: llm-deepseek
      config:
        retryPolicy:
          mode: normal
          retryableCodes:
            - EMPTY_RESPONSE
            - RATE_LIMIT
            - SERVER
            - TIMEOUT
            - TRANSPORT
            - MALFORMED_RESPONSE
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

    # 启动脚本直接运行；justfile 为同一组脚本提供便捷入口。
    WORKSPACE="$OKS_WORKSPACE" PORT="$OKS_INSTALL_PORT" node --input-type=module - "${DSH_ARR[@]}" "$PROFILE" <<'JS'
    import {writeFileSync,chmodSync,existsSync} from 'node:fs';
    import {join} from 'node:path';
    const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
    const command=process.argv.slice(2).map(quote).join(' ');
    const home=process.env.DSH_HOME;
    const runtime=join(home,'justfile');
    const direct=join(home,'run-dsh.sh');
    const watched=join(home,'run.sh');
    const dshBin=join(home,'runtime/node_modules/.bin/dsh');
    const launcher=process.env.DSH_CMD ? command : quote(dshBin)+' web';
    writeFileSync(direct,
      '#!/usr/bin/env bash\nset -euo pipefail\nexport DSH_HOME='+quote(home)+
      '\ncd -- '+quote(process.env.WORKSPACE)+
      '\nexec '+launcher+' --port '+quote(process.env.PORT)+' "$@"\n');
    writeFileSync(watched,
      '#!/usr/bin/env bash\nset -euo pipefail\nexport DSH_HOME='+quote(home)+
      '\nCTRL_FILE="$DSH_HOME/.ctrl"\n'+
      'test -e "$CTRL_FILE" || touch "$CTRL_FILE"\n'+
      'exec watchexec --restart --ignore-nothing --shell=none -w "$CTRL_FILE" -- '+quote(direct)+' "$@"\n');
    chmodSync(direct,0o755);chmodSync(watched,0o755);
    const control=join(home,'.ctrl');
    if(!existsSync(control))writeFileSync(control,'');
    writeFileSync(runtime,
      'default:\n    @just --list\n\n[positional-arguments]\nrun-dsh *args:\n    @'+quote(direct)+' "$@"\n\n'+
      '[positional-arguments]\nrun *args:\n    @'+quote(watched)+' "$@"\n');
    JS
    say "启动：$DSH_HOME_DIR/run.sh（端口 $OKS_INSTALL_PORT，工作区 $OKS_WORKSPACE）"

# 隔离核验安装和启动，不构建真实插件、不启动服务。
test-install:
    node --test tests/install-profile.test.mjs
