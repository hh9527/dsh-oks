# dsh-oks

> **已归档。** 插件源码迁至 [dari](https://github.com/hh9527/dari) 的
> `packages/dsh/`（`dsh-plugin-dari`、`dsh-plugin-dari-client`、`dsh-preset-dari`），
> 部署编排迁至 [dataseer-ic](https://github.com/hh9527/dataseer-ic)。
> 本仓库只保留历史。

将工作区的本体知识与只读数据源接入 DSH，使用 DARI 组织分析、图表与报告。
图表和自包含 HTML 报告通过宿主附件交付，生命周期由宿主管理。

- `vendors/dari/`：固定版本的 DARI 引擎、语言服务与 LSP（Git submodule）。
- `packages/dsh-oks/`：知识工具、只读取数、DARI 运行与附件导出。
- `packages/dsh-push-to-user/`：Web 客户端通用能力，把 host 插件推送的 Markdown 消息渲染成对话卡片。
- `dist/`：`just build` 生成的发布目录，安装只消费它，不进入版本控制。发布产物自包含：清单不含任何依赖；依赖只有两种来源——构建期打包进产物，或由插件环境注入。
- `rfc/`：设计与变更记录。
- `justfile`：构建和安装 OKS profile。

`just deploy <PORT>` 构建两个插件并安装到仓库内的 `.deploy/dsh-<PORT>/`。每个端口拥有独立的 profile、插件安装文件、会话目录和 `demo-ws`。主 Agent 启用官方文件工具、ask user、skill、present 与 OKS 工具，VA 使用独立 preset。

需要 just、watchexec、Node.js、pnpm。依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog`；升级时修改 catalog 并执行 `just update-deps`。

```sh
pnpm run setup:dari
pnpm install --ignore-scripts
just deploy 10924
./.deploy/dsh-10924/run.sh

# 另一套独立环境
just deploy 10925
./.deploy/dsh-10925/run.sh
```

部署只准备文件，服务由用户手动启动。生成目录如下，`.deploy/` 不进入版本控制。

```text
.deploy/dsh-10924/
├── packages/
├── profiles/web/
├── demo-ws/
├── .ctrl
├── run.sh
├── run-dsh.sh
└── justfile
```

首次部署创建空的 `demo-ws/`，允许没有 `dari.json`，可直接启动服务。需要使用模型工具时，在工作区创建 `dari.json` 配置模型与数据库；相对路径以该工作区为基准，例如：

```json
{
  "domain": "demo",
  "model": "model.wasm",
  "dataFile": "demo.sqlite"
}
```

模型和数据库由用户提供，可在部署 profile 的插件 config 配置默认的 `domain`、`model`、`dataFile`；工作区的 `dari.json` 可选，显式字段覆盖部署默认值。VA、知识工具与 DARI 共用解析后的模型。两处均未配置模型时，模型工具明确报告缺失项。部署命令不绑定特定模型，也不复制其他环境的凭据。

`run.sh` 从任意当前目录均可执行，通过 watchexec 仅监听 `.ctrl`；`run-dsh.sh` 是直接启动入口。启动参数原样透传，例如：

```sh
./.deploy/dsh-10924/run.sh --host 127.0.0.1
touch .deploy/dsh-10924/.ctrl
```

`DSH_HOME` 指向部署目录，服务在其中的 `demo-ws` 工作区运行。生成的 `justfile` 也提供 `just run` 与 `just run-dsh`，分别调用这两个脚本。

重复执行 `just deploy <PORT>` 会重新构建并更新插件安装，保留已有工作区、`dari.json`、用户 profile 配置与 `.ctrl` 内容；不会自动触发重启。更新正在使用的安装目录前先停止对应进程，安装完成后再启动。

已有发布产物或需要自定义目录时，可单独使用安装器：

```sh
just build
just port=10924 target=/srv/oks workspace=/srv/my-workspace install-profile
/srv/oks/run.sh
```

`install-profile` 只消费 `dist/`，自动创建指定工作区，允许没有 `dari.json`。默认 `profile` 为 `web`；默认安装目录为 `.deploy/dsh-<port>`，工作区为其下的 `demo-ws`。可通过 `DSH_CMD` 指定宿主调用方式；安装器优先使用已安装的 dsh，否则使用 pnpm dlx。

从其他目录也可调用 `just --justfile /path/to/dsh-oks/justfile deploy 10924`；部署目录始终位于该仓库内。

安装和工具说明见 [插件 README](packages/dsh-oks/README.md)。

## DARI 编辑器语法

[tree-sitter-dari](vendors/dari/editors/tree-sitter-dari/README.md) 由 DARI 引擎的 Git submodule 固定版本，提供 DARI 的增量语法树、C parser 和高亮查询；运行期语义检查由 DARI 引擎负责。

```sh
git submodule update --init --recursive
npm --prefix vendors/dari/editors/tree-sitter-dari ci
npm run check:dari-grammar
```

检查覆盖 grammar corpus、语法样例、错误恢复、增量编辑和编辑器查询。更新语法时，先在 grammar 仓库提交，再更新 DARI 仓库的 grammar 指针，最后更新本仓库的 vendors/dari 指针。
