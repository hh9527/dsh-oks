import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// 源码测试与 tsdown 的文本加载保持一致；发布产物已内联 Markdown 和 jq。
registerHooks({load(url, context, next) {
  if (url.endsWith('.md') || url.endsWith('.jq')) return {format:'module', source:`export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`, shortCircuit:true};
  return next(url, context);
}});
