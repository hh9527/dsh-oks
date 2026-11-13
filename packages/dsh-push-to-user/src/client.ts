const loader = (window as any).__ModuleLoader__;

loader.load({
  id: "@local/dsh-push-to-user",
  factory: (require: (id: string) => any) => {
    // 只能 require 宿主注入的模块；其他依赖必须在构建期打包。
    const React = require("react");
    const { MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives");

    // Reserved source contract: a host plugin pushes a `user/message` whose source carries
    // this kind; `label` names the producer and is shown verbatim above the content.
    const SOURCE_KIND = "push-to-user";
    const NODE_KIND = "push-to-user";

    const textOf = (event: any): string => {
      const content = event && event.data && event.data.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    };

    const sourceOf = (event: any): Record<string, any> => {
      const source = event && event.data && event.data.source;
      return source && typeof source === "object" ? source : {};
    };

    const labelOf = (source: Record<string, any>): string => {
      if (typeof source.label === "string" && source.label.trim() !== "") return source.label.trim();
      // No hard-coded product name: an unlabeled producer still names its own source kind.
      return typeof source.kind === "string" && source.kind !== "" ? source.kind : "";
    };

    function MarkdownMessageView(props: any): any {
      const data = props && props.node && props.node.data ? props.node.data : {};
      const inline = typeof data.text === "string" ? data.text : "";
      const [loaded,setLoaded] = React.useState(null);
      const [problem,setProblem] = React.useState("");
      React.useEffect(() => {
        if(!data.source?.href)return;
        const controller = new AbortController();setLoaded(null);setProblem("");
        let url: URL;
        try {
          const reference = new URL(data.source.href,window.location.href);
          // file: names a host file; the browser reads it through DSH's authenticated endpoint.
          if(reference.protocol === "file:") {
            if(reference.hostname && reference.hostname !== "localhost")throw Error("Remote file host");
            url = new URL("api/file",window.location.href);
            url.searchParams.set("path",decodeURIComponent(reference.pathname));
          } else url = reference;
        }catch {setProblem("无法加载交付：附件地址无效");return;}
        if(url.origin !== window.location.origin){setProblem("无法加载交付：附件必须同源");return;}
        fetch(url.href,{credentials:"same-origin",signal:controller.signal}).then(response=>{if(!response.ok)throw Error("HTTP "+response.status);return response.text();}).then(setLoaded).catch(error=>{if(!controller.signal.aborted)setProblem("交付加载失败："+error.message);});
        return ()=>controller.abort();
      },[data.source?.href]);
      const text = Boolean(data.source?.href) ? problem || loaded || "正在加载交付…" : inline;
      const source = data.source && typeof data.source === "object" ? data.source : {};
      const label = labelOf(source);
      const labelled = label !== "" && label !== SOURCE_KIND;
      return React.createElement(
        "div",
        { style: { maxWidth: "100%", marginBottom: "14px" } },
        React.createElement(
          "div",
          {
            style: {
              padding: "10px 14px 12px",
              margin: "2px 0 0",
              borderRadius: "10px",
              background: "var(--dsw-alias-markdown-code-block, #f2f5f9)",
            },
          },
          labelled
            ? React.createElement(
                "div",
                {
                  style: {
                    marginBottom: "6px",
                    color: "var(--dsw-alias-label-tertiary, #8494a5)",
                    fontSize: "12px",
                    letterSpacing: "0.2px",
                  },
                },
                label,
              )
            : null,
          React.createElement(MarkdownText, { text }),
        ),
      );
    }

    const definition = {
      kind: NODE_KIND,
      target: "chat",
      match: (event: any): any => {
        if (!event || event.type !== "user/message") return null;
        const data = event.data;
        if (!data || data.role !== "user") return null;
        if (!data.source || data.source.kind !== SOURCE_KIND) return null;
        return { id: String(data.id), role: "start", exclusive: true };
      },
      start: (_context: any, match: { event: any }): any => ({
        seq: match.event.seq,
        text: textOf(match.event),
        source: sourceOf(match.event),
      }),
      publication: () => "immediate",
      buildViewNode: (context: any): any => {
        const state = context.state;
        if (!state || typeof state.text !== "string") return null;
        const event = context.start && context.start.event;
        const source = (event && event.data && event.data.source) || state.source || {};
        return {
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: "chat",
          anchorSeq: state.seq,
          location: context.start && context.start.location,
          visibility: "visible",
          groupTree: "turn",
          data: { seq: state.seq, text: state.text, source },
        };
      },
    };

    function apply(ctx: any): void {
      ctx.uiConversation.events.register({ ...definition, match: { "user/message": definition.match } });
      ctx.slots.inject("conversation.chat.node", () =>
        ctx.slots.register({ name: "conversation.chat.node", key: NODE_KIND }, MarkdownMessageView));
    }

    return { apply, inject: ["uiConversation", "slots"] };
  }
});
