// Pinia 持久化插件：对声明了 options.persist 的 store 自动读写 localStorage。
// persist 为 true 时持久化整个 state；为数组时仅持久化指定 key。
export function piniaPersist({ store, options }) {
  if (!options.persist) return;
  const key = `teyvat-melody:${store.$id}`;
  const persistKeys = Array.isArray(options.persist) ? options.persist : null;

  const pick = (state) =>
    persistKeys
      ? Object.fromEntries(persistKeys.map((k) => [k, state[k]]))
      : state;

  // 启动时恢复
  try {
    const saved = localStorage.getItem(key);
    if (saved) store.$patch(JSON.parse(saved));
  } catch (e) {
    // 忽略损坏的缓存
  }

  // 变更时写入
  store.$subscribe(
    (_mutation, state) => {
      try {
        localStorage.setItem(key, JSON.stringify(pick(state)));
      } catch (e) {
        // 忽略配额等错误
      }
    },
    { detached: true }
  );
}