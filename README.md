# dsh-oks

把**某个领域的知识服务（OKS）**接进 DSH：把工作区声明的知识服务与数据文件接成一组原生工具，
并把产出（查询结果、图、报告）落进工作区的产出层。

```
packages/dsh-oks/     插件本体：工具、只读取数、出图、报告（含它自己的 README 与冒烟测试）
packages/dsh-oks-ui/  右侧栏「产出」页签（浏览器半边；数据来自 oksArtifacts 接口）
rfc/                  变更计划
install-preset.sh     把一个 dsh profile 配成「OKS 问数」（被链接的包是 packages/dsh-oks）
AGENTS.md             在本仓库工作时的约定
```

安装、工具面、工作区声明（`oks.json`）与产出的完整说明见
[`packages/dsh-oks/README.md`](packages/dsh-oks/README.md)。

右侧栏的「产出」页签在 [`packages/dsh-oks-ui`](packages/dsh-oks-ui/README.md)：调插件开的两条
同源端点（清单 + 保留），呈现制品（图与报告）而不是文件；`★` 一下就保留，不经过 agent。
方案与边界见 [`rfc/0004-artifact-timeline.md`](rfc/0004-artifact-timeline.md)。
