// 宿主侧入口：这个包只提供浏览器半边（右侧栏的「产出」页签），所以这里是空的。
//
// 它存在是因为 profile 要挂一条 entry，而 `dsh-client-modules` 只扫描**已启用的 Loader 条目**
// 上的 `dsh.client` 声明——没有这条 entry，页面加载器就看不到我们这个包。
export const apply = (): void => {};

export default apply;
