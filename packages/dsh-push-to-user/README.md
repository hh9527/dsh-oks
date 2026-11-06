# dsh-push-to-user

Web 客户端的通用能力包：让 host 插件把一段 Markdown 作为消息推入会话，既进入模型上下文，也作为卡片出现在对话流里。与具体业务插件无关。

## 契约

host 插件推送一条 user 消息，`source.kind` 使用保留值：

```js
agent.inject({
  id: messageId,
  role: 'user',
  source: { kind: 'push-to-user', label: 'dsh-oks' },
  content: [{ type: 'text', text: markdown }],
});
```

| 字段 | 说明 |
| --- | --- |
| `source.kind` | 必须是 `push-to-user`，客户端据此认领该消息 |
| `source.label` | 可选，显示在卡片左上角的来源名；缺省时回退到 `source.kind` |
| `content` | 文本块，按 Markdown 渲染 |

## 行为

- 模型侧：普通 user 消息，进入上下文
- 界面侧：淡色卡片、来源标签、圆角背景，不折叠
- 没有这类消息的会话里不渲染任何内容

客户端认领该事件时使用独占匹配，因此同一条消息不会再生成默认的隐藏上下文行。

## 为什么需要独立客户端包

DSH 默认把非 `source.kind === 'user'` 的用户消息归为上下文，而可见性策略隐藏普通上下文行。要让它出现在对话流里，必须由客户端注册自己的对话节点。浏览器侧只有一个应用实例，客户端插件是 profile 级的，不能像宿主工具那样按 preset 隔离。

## 加载形态

包同时声明：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": [...], "platform": "web" }
}
```

客户端模块只扫描 profile 层的 loader entry，因此这个包必须列进 profile 的 `dsh.profile.bundles`；preset 里挂载的插件不会被扫描到。

## 依赖

客户端只 `require` 宿主模块图注入的包（`react`、`@deepseek-ai/dsh-client-ui-primitives` 等），其余依赖一律在构建期打包。`scripts/pack.mjs` 会拒绝清单外的 `require`。

## 安装

源码是 `src/*.ts`，`node build.mjs` 用 Node 的类型剥离生成 `lib/*.js`；产物不进入版本控制。类型检查用包自己的 TypeScript：`pnpm run typecheck`。

仓库根目录的 `just install-profile` 会在临时副本里构建这个包，把 `lib/` 与 patch 复制到安装目录，写入 profile 依赖并加入 bundles。
