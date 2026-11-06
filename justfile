# OKS 发布与运行环境。命令行示例见 README.md。
port := "10923"
target := home_directory() / "ws/oks-demo/dsh-oks-" + port
profile := "web"
workspace := home_directory() / "ws/oks-demo/demo-ws"

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
    rm -rf dist
    (cd packages/dsh-oks && pnpm run build) || { printf 'build: dsh-oks 构建失败\n' >&2; exit 1; }
    (cd packages/dsh-push-to-user && pnpm run build) || { printf 'build: dsh-push-to-user 构建失败\n' >&2; exit 1; }
    node scripts/pack.mjs

# 安装已构建的发布目录到完整 Web profile，包含主 Agent 文件工具。
install-profile:
    #!/usr/bin/env bash
    set -euo pipefail
    REPO_DIR="$PWD"
    PACKAGE='@local/dsh-oks'
    PACKAGE_DIR="$DSH_HOME/packages/dsh-oks"
    PATCH_ID='preset-oks'
    PROFILE="$DSH_PROFILE"
    DSH_HOME_DIR="$DSH_HOME"
    fail() { printf 'install-profile: %s\n' "$*" >&2; exit 1; }
    say() { printf 'install-profile: %s\n' "$*"; }
    [[ "$OKS_INSTALL_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( OKS_INSTALL_PORT <= 65535 )) || fail 'port 必须是 1..65535 的整数'
    [[ "$PROFILE" =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'profile 只能包含字母、数字、下划线与连字符'
    [ -f "$OKS_WORKSPACE/oks.json" ] || fail "工作区没有 oks.json：$OKS_WORKSPACE"
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
    DIST_DIR="$REPO_DIR/dist"
    [ -f "$DIST_DIR/dsh-oks/package.json" ] || fail "缺少发布目录 $DIST_DIR/dsh-oks，先运行 just build"
    [ -f "$DIST_DIR/dsh-push-to-user/package.json" ] || fail "缺少发布目录 $DIST_DIR/dsh-push-to-user，先运行 just build"
    CLIENT_PACKAGE='@local/dsh-push-to-user'
    CLIENT_DIR="$DSH_HOME/packages/dsh-push-to-user"
    rm -rf "$PACKAGE_DIR" "$CLIENT_DIR"
    mkdir -p "$DSH_HOME/packages"
    cp -R "$DIST_DIR/dsh-oks" "$PACKAGE_DIR"
    cp -R "$DIST_DIR/dsh-push-to-user" "$CLIENT_DIR"

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

    # ── 3. 依赖 ──────────────────────────────────────────────────────────────────
    # 先写依赖、再 install：install 在跑之前就把这份清单读成 before，reconcile 因此不会把这个
    # 带 dsh.bundle 的包自动升成 profile bundle 层。
    say "把 $PACKAGE 和 $CLIENT_PACKAGE 链接到发布目录"
    MANIFEST="$MANIFEST" PACKAGE="$PACKAGE" PACKAGE_DIR="$PACKAGE_DIR" CLIENT_PACKAGE="$CLIENT_PACKAGE" CLIENT_DIR="$CLIENT_DIR" node --input-type=module <<'JS'
    import {readFileSync,writeFileSync} from 'node:fs';
    const file=process.env.MANIFEST;
    const manifest=JSON.parse(readFileSync(file,'utf8'));
    manifest.dependencies={
      ...(manifest.dependencies??{}),
      [process.env.PACKAGE]:`link:${process.env.PACKAGE_DIR}`,
      [process.env.CLIENT_PACKAGE]:`link:${process.env.CLIENT_DIR}`,
    };
    writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    JS

    # ── 4. 链接 ──────────────────────────────────────────────────────────────────
    say "安装 profile $PROFILE 的依赖"
    DSH_HOME="$DSH_HOME_DIR" "${DSH_ARR[@]}" plugin --profile "$PROFILE" install \
      || fail "profile $PROFILE 的依赖安装失败"
    [ -f "$PROFILE_DIR/node_modules/$PACKAGE/package.json" ] || fail '插件链接未就位'
    [ -f "$PROFILE_DIR/node_modules/$CLIENT_PACKAGE/package.json" ] || fail '客户端包链接未就位'

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

    # File tools belong only to the main agent. Reinstalling also upgrades
    # an existing managed preset without replacing its user configuration.
    PATCH_FILE="$PATCH_FILE" node --input-type=module <<'JS'
    import {readFileSync,writeFileSync} from 'node:fs';
    const file=process.env.PATCH_FILE;
    let text=readFileSync(file,'utf8');
    const marker=/^([ \t]*)- id: preset-oks[ \t]*$/m.exec(text);
    if(!marker)throw new Error('Missing managed OKS preset');
    const start=marker.index;
    const remainder=text.slice(start);
    const next=/^-[ \t]/m.exec(remainder);
    const end=next?start+next.index:text.length;
    let block=text.slice(start,end);
    const plugins=/^([ \t]*)plugins:[ \t]*$/m.exec(block);
    if(!plugins)throw new Error('Missing OKS preset plugins');
    const indent=plugins[1]+'  ';
    const required=[
     ['fs-observation-policy','@deepseek-ai/dsh-fs-observation-policy'],
     ['tool-fs','@deepseek-ai/dsh-tool-fs'],
     ['tool-fs-search','@deepseek-ai/dsh-tool-fs-search'],
    ];
    const missing=required.filter(([,name])=>!block.includes('name: "'+name+'"')&&!block.includes("name: '"+name+"'"));
    const entries=missing.map(([id,name])=>`${indent}- id: ${id}\n${indent}  name: "${name}"`).join('\n');
    if(entries){const at=plugins.index+plugins[0].length;block=block.slice(0,at)+'\n'+entries+block.slice(at);}
    // Host preset validation requires this value even when the plugin has defaults.
    const lines=block.split('\n');
    const search=lines.findIndex(line=>/name: ['"]@deepseek-ai\/dsh-tool-fs-search['"]/.test(line));
    if(search<0)throw new Error('Missing file search tool');
    let stop=search+1;
    while(stop<lines.length&&!lines[stop].startsWith(indent+'- '))stop++;
    const settings=lines.slice(search+1,stop);
    if(!settings.some(line=>/^\s*sampleOverCapGlobResults:/.test(line))){
      const config=settings.findIndex(line=>line.trim()==='config:');
      if(config<0)lines.splice(search+1,0,indent+'  config:',indent+'    sampleOverCapGlobResults: false');
      else lines.splice(search+2+config,0,indent+'    sampleOverCapGlobResults: false');
    }
    block=lines.join('\n');text=text.slice(0,start)+block+text.slice(end);writeFileSync(file,text);
    JS

    # 知识助手预设仅装配提示词和权限。
    if ! grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*preset-oks-knowledge[[:space:]]*$' "$PATCH_FILE"; then
      cat >> "$PATCH_FILE" <<'YAML'

    - insert:
        - id: preset-oks-knowledge
          name: "@deepseek-ai/dsh-agent-preset"
          config:
            id: oks-knowledge
            name: OKS 知识助手
            description: 根据领域关系地图与词汇助手提供知识导航。
            plugins:
              - id: oks-knowledge
                name: "@local/dsh-oks"
                config:
                  knowledgeHelper: true
    YAML
    fi

    if ! grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*preset-oks-vocabulary[[:space:]]*$' "$PATCH_FILE"; then
      cat >> "$PATCH_FILE" <<'YAML'

    - insert:
        - id: preset-oks-vocabulary
          name: "@deepseek-ai/dsh-agent-preset"
          config:
            id: oks-vocabulary
            name: OKS 词汇助手
            description: 完整领域词汇对齐与归属定位。
            plugins:
              - id: oks-vocabulary
                name: "@local/dsh-oks"
                config:
                  vocabularyHelper: true
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

    # 运行目录只生成 justfile：run-dsh 直接运行，run 监听 .ctrl 后调用 run-dsh。
    WORKSPACE="$OKS_WORKSPACE" PORT="$OKS_INSTALL_PORT" node --input-type=module - "${DSH_ARR[@]}" "$PROFILE" <<'JS'
    import {writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
    const command=process.argv.slice(2).map(quote).join(' ');
    const home=process.env.DSH_HOME;
    const runtime=join(home,'justfile');
    writeFileSync(runtime,
      'default:\n    @just --list\n\n[positional-arguments]\nrun-dsh *args:\n'+
      '    #!/usr/bin/env bash\n    set -euo pipefail\n    export DSH_HOME='+quote(home)+
      '\n    cd -- '+quote(process.env.WORKSPACE)+
      '\n    exec '+command+' --port '+quote(process.env.PORT)+' "$@"\n\n'+
      '[positional-arguments]\nrun *args:\n'+
      '    #!/usr/bin/env bash\n    set -euo pipefail\n    export DSH_HOME='+quote(home)+
      '\n    CTRL_FILE="$DSH_HOME/.ctrl"\n    touch "$CTRL_FILE"\n'+
      '    exec watchexec --restart --ignore-nothing --shell=none -w "$CTRL_FILE" -- just --justfile '+quote(runtime)+' run-dsh "$@"\n');
    JS
    say "启动：just --justfile $DSH_HOME_DIR/justfile run（端口 $OKS_INSTALL_PORT，工作区 $OKS_WORKSPACE）"

# 隔离核验安装和启动，不构建真实插件、不启动服务。
test-install:
    node --test tests/install-profile.test.mjs
