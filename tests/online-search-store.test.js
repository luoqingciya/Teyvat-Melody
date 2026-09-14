// 在线搜索「平台选择持久化」自检：
//   node tests/online-search-store.test.js
//
// 为什么单独测这个：store 是前端 ES 模块，依赖 vue 与 localStorage，跑在 Node 里需要桩。
// 但「平台选择记不住」这个缺陷**必须在单元测试里钉住** —— 它没有任何报错，
// 表现只是「用户选完平台，下次打开又变回全选」，全靠人肉发现，很容易改坏。
//
// ⚠️ 这里的桩要给全：store 在**模块顶层**就调用 restore()，所以 localStorage 必须在
//    require 之前就装好，否则模块一加载就抛错。
const path = require("path");
const { pathToFileURL } = require("url");

// ---- localStorage 桩（store 在模块顶层就会读它） ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

const KEY = "teyvat-melody:onlineSearch";
const STORE_PATH = path.join(__dirname, "..", "frontend", "src", "stores", "onlineSearch.js");
const STORE_URL = pathToFileURL(STORE_PATH).href;

/** 拿一份全新的 store 模块实例（清掉 ESM 缓存，模拟「重启应用」） */
async function freshStore({ preload } = {}) {
  store.clear();
  if (preload) store.set(KEY, JSON.stringify(preload));
  // 加个查询串绕过 ESM 模块缓存 —— 否则第二次 require 拿到的还是旧实例，
  // 模块顶层的 restore() 也就不会重跑，「重启」根本模拟不出来。
  const mod = await import(`${STORE_URL}?t=${Date.now()}-${Math.random()}`);
  return mod;
}

/** 等防抖落盘（persist 是 400ms） */
const settle = () => new Promise((r) => setTimeout(r, 520));

const readSaved = () => {
  const raw = store.get(KEY);
  return raw ? JSON.parse(raw) : null;
};

(async () => {
  // ① 用户勾选平台后必须落盘
  {
    const m = await freshStore();
    const s = m.useOnlineSearch();
    s.setPicked(["kw", "kg"]);
    await settle();
    const saved = readSaved();
    ok(
      "勾选平台后写入 localStorage",
      saved && Array.isArray(saved.picked) && saved.picked.join(",") === "kw,kg",
      JSON.stringify(saved && saved.picked)
    );
    ok("同时记下「用户动过勾选」的标记", saved && saved.pickedTouched === true);
  }

  // ② 重启后恢复用户的勾选（这就是用户报的「不能持久化」）
  {
    const m = await freshStore({ preload: { picked: ["kw"], pickedTouched: true, searched: false } });
    const s = m.useOnlineSearch();
    ok("重启后恢复上次勾选的平台", s.state.picked.join(",") === "kw", JSON.stringify(s.state.picked));

    // 关键：平台列表加载完成后，**不能**把用户的单选覆盖成默认全选
    s.markPlatformsLoaded(["kw", "kg", "tx", "wy"]);
    ok(
      "平台列表加载后不覆盖用户选择（旧实现在这里被重置成全选）",
      s.state.picked.join(",") === "kw",
      JSON.stringify(s.state.picked)
    );
  }

  // ③ 用户从没动过勾选 → 默认全选，**并且要落盘**
  //
  // 旧实现的问题就在这：默认全选只写在内存里，从不落盘。
  // 于是下次启动又按「没选过」重算一遍 —— 一旦可用平台变了，
  // 界面上的勾选就自己变，用户看到的就是「平台选择保存不了」。
  {
    const m = await freshStore();
    const s = m.useOnlineSearch();
    s.markPlatformsLoaded(["kw", "kg", "tx", "wy"]);
    await settle();
    const saved = readSaved();
    ok(
      "默认全选也要落盘（旧实现漏了这一步）",
      saved && Array.isArray(saved.picked) && saved.picked.length === 4,
      JSON.stringify(saved && saved.picked)
    );
    ok("默认全选不算作「用户动过」", saved && saved.pickedTouched === false);
  }

  // ④ 默认全选落盘后，可用平台变少时不该把用户的勾选弄丢
  {
    const m = await freshStore({ preload: { picked: ["kw", "kg", "tx", "wy"], pickedTouched: false } });
    const s = m.useOnlineSearch();
    // 这次只有两个平台可用（另两个的源被禁用了）
    s.markPlatformsLoaded(["kw", "kg"]);
    await settle();
    ok(
      "可用平台变少 → 只保留可用的（不残留不可用平台）",
      s.state.picked.join(",") === "kw,kg",
      JSON.stringify(s.state.picked)
    );
    ok(
      "落盘的也是过滤后的集合（下次启动不会再出现不可用平台）",
      readSaved().picked.join(",") === "kw,kg",
      JSON.stringify(readSaved().picked)
    );
  }

  // ⑤ 用户动过勾选后，即使可用平台列表变化也不覆盖（尊重偏好）
  {
    const m = await freshStore({ preload: { picked: ["wy"], pickedTouched: true } });
    const s = m.useOnlineSearch();
    s.markPlatformsLoaded(["kw", "kg", "tx", "wy"]);
    ok("用户选过 → 平台列表变化不覆盖其选择", s.state.picked.join(",") === "wy", JSON.stringify(s.state.picked));
  }

  // ⑥ 用户把平台全取消 → 必须记住「全不选」，不能又被默认成全选
  //
  // 这是 pickedTouched 标记存在的直接原因：空数组在结构上分不清
  // 「用户主动全取消」和「还没选过」。
  {
    const m = await freshStore();
    const s = m.useOnlineSearch();
    s.setPicked([]);
    await settle();
    ok("主动全取消 → picked 为空但标记为「动过」", readSaved().pickedTouched === true);

    const m2 = await freshStore({ preload: readSaved() });
    const s2 = m2.useOnlineSearch();
    s2.markPlatformsLoaded(["kw", "kg", "tx", "wy"]);
    ok(
      "重启后仍保持「全不选」，不会被默认成全选",
      s2.state.picked.length === 0,
      JSON.stringify(s2.state.picked)
    );
  }

  // ⑦ flushNow 立刻落盘（切页面时不等 400ms 防抖）
  {
    const m = await freshStore();
    const s = m.useOnlineSearch();
    s.setPicked(["tx"]);
    // 不 await settle()：直接看是否已经写进去了
    ok("flushNow 立即落盘（组件卸载时用，来不及等防抖）", readSaved()?.picked.join(",") === "tx");
  }

  // ⑧ 损坏的 localStorage 不能让模块加载失败
  {
    store.clear();
    store.set(KEY, "{ 这不是合法 JSON");
    let threw = false;
    try {
      await freshStore({ preload: null });
      // freshStore 会 clear 掉，所以这里单独手动塞一次坏数据再导入
      store.set(KEY, "{ 仍然不是合法 JSON");
      const url = `${STORE_URL}?bad=${Date.now()}`;
      await import(url);
    } catch {
      threw = true;
    }
    ok("localStorage 内容损坏时不抛错（忽略即可）", !threw);
  }

  // ⑨ reset 保留平台勾选（那是偏好，不是搜索现场）
  {
    const m = await freshStore();
    const s = m.useOnlineSearch();
    s.setPicked(["kw", "kg"]);
    s.state.keyword = "晴天";
    s.state.results = [{ id: 1 }];
    await settle();
    s.reset();
    ok("reset 清掉关键词与结果", s.state.keyword === "" && s.state.results.length === 0);
    ok("reset 保留平台勾选", s.state.picked.join(",") === "kw,kg", JSON.stringify(s.state.picked));
    ok("reset 后落盘仍是用户的勾选", readSaved().picked.join(",") === "kw,kg");
  }

  console.log("\n自检结束");
})();
