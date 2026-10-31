// 惰性初始化的 single flight：第一个调用者触发，之后到它落地之前的调用者都 **await 同一个
// promise**，不会各自再初始化一遍；落地（成功或失败）后从表里撤掉——成功的结果由调用方自己
// 缓存，失败则让下一次调用可以重新触发。
//
// 两处并发合并都用它：检索层按模型内容的 sha 派生词汇表与引用图（src/knowledge.ts）、
// 知识助手合并同一调用方的相同并发咨询（src/ka.ts）。

/** 取（或触发）某个键上正在进行的初始化；`start` 只在没有在飞时被调用一次。 */
export function singleFlight<T>(map: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const inflight = map.get(key);
  if (inflight !== undefined) return inflight;
  const flight = start();
  map.set(key, flight);
  void flight.then(() => {}, () => {}).then(() => { if (map.get(key) === flight) map.delete(key); });
  return flight;
}
