# dsh-oks

将工作区的本体知识与只读数据源接入 DSH，使用 DARI 组织分析、图表与报告。
图表和自包含 HTML 报告通过宿主附件交付，生命周期由宿主管理。

- `packages/dsh-oks/`：知识工具、只读取数、DARI 运行与附件导出。
- `rfc/`：设计与变更记录。
- `justfile`：构建、安装和启动 OKS preset。

安装需要 just、watchexec、Node.js、pnpm，以及支持 `wasm32-unknown-unknown` 的 Rust 工具链。

```sh
just install
just run

# 修改端口，默认安装目录随端口变化。
just port=10924 install
just port=10924 run

# 自定义安装目录和会话工作区。
just port=10924 target=/srv/oks workspace="$HOME/ws/oks-demo/demo-ws" install
just target=/srv/oks run
```

默认端口为 `10923`，安装目录为 `~/ws/oks-demo/dsh-oks-10923/`，
工作区为 `~/ws/oks-demo/demo-ws/`（需已有 `oks.json`）。`profile` 默认 `web`，可单独覆盖。
安装命令在临时源码副本中构建插件，将插件及运行依赖放入安装目录的 `packages/`，
运行配置和会话数据使用该目录作为 `DSH_HOME`，启动器为 `start.sh`。
每次安装都会重新构建，运行时链接安装目录中的插件。安装完成后手动启动；
更新正在使用的安装目录前先停止对应进程，安装完成后再启动。
`just run` 使用启动器保存的端口和工作区，并透传额外参数，例如 `just run --help`。
从其他目录调用时可用 `just --justfile /path/to/dsh-oks/justfile install`。

`start.sh` 使用 watchexec 监听安装目录内的 `.ctrl`，文件变化时重启进程。
例如 `touch ~/ws/oks-demo/dsh-oks-10924/.ctrl` 重启验证区，
`touch ~/ws/oks-demo/dsh-oks-10923/.ctrl` 重启正式区。
首次使用新启动器时，先退出原进程，再运行 `start.sh`；之后可通过 `.ctrl` 触发重启。

安装和工具说明见 [插件 README](packages/dsh-oks/README.md)。
