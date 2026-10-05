// 惰性初始化的 single flight：第一个调用者触发，之后到它落地之前的调用者都 **await 同一个
// promise**，不会各自再初始化一遍；落地（成功或失败）后从表里撤掉——成功的结果由调用方自己
// 缓存，失败则让下一次调用可以重新触发。
//
// 两处惰性初始化都用它：检索层按 artifact sha 派生词汇表与引用图（lib/knowledge.js）、
// 词汇助手按调用方装配顶层 agent（lib/va.js）。

/** 取（或触发）某个键上正在进行的初始化；`start` 只在没有在飞时被调用一次。 */
export function singleFlight(map, key, start) {
  const inflight = map.get(key);
  if (inflight !== undefined) return inflight;
  const flight = start();
  map.set(key, flight);
  void flight.then(() => {}, () => {}).then(() => { if (map.get(key) === flight) map.delete(key); });
  return flight;
}
