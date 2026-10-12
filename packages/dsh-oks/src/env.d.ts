declare module '*.md' {
  /** 构建期由 tsdown 的 text loader 内联成字符串（见 tsdown.config.ts 的 loader）。 */
  const text: string;
  export default text;
}
