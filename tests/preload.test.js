// preload 桥接层自检：node tests/preload.test.js
//
// ⚠️ 覆盖范围说明（很重要，别误读）：
// 参数跨桥接有**两道**边界，本测试只覆盖第 2 道：
//   1) 渲染进程主世界 → preload 隔离世界：由 contextBridge 用结构化克隆复制参数，
//      发生在 preload 代码执行之前 —— **本测试无法覆盖**（打桩 electron 就绕过了它）。
//      这道边界要求调用侧先把 reactive 对象转成普通值（见 frontend/src/utils/bridge.js
//      的 toPlain），真正能验证它的是 electron/__test-ui.js（真实 Electron + 真实界面）。
//   2) preload 隔离世界 → 主进程：由 preload 的 invoke 统一深拷贝 —— **本测试覆盖这道**。
//
// 背景：曾误以为「在 preload 里做深拷贝」就能解决界面上的
// "An object could not be cloned."，实际位置错了，真因在第 1 道边界。
// 这里用 Proxy 模拟 Vue reactive（structuredClone 对 Proxy 会抛 DOMException）。
const Module = require("module");
const path = require("path");

let exposed = null;
const calls = [];

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      contextBridge: {
        // preload 暴露的是 { api } 包装对象，方法挂在 .api 上
        exposeInMainWorld: (_name, wrapper) => {
          exposed = wrapper.api;
        },
      },
      ipcRenderer: {
        invoke: (channel, payload) => {
          // 模拟 Electron 的结构化克隆：不可克隆的值会抛 DOMException
          structuredClone(payload);
          calls.push({ channel, payload });
          return Promise.resolve({ ok: true });
        },
        on: () => {},
        removeAllListeners: () => {},
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

require(path.join(__dirname, "..", "electron", "preload.js"));
Module._load = originalLoad;

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

/** Vue reactive 等价物：Proxy（structuredClone 对其抛 DataCloneError） */
const reactiveObj = (o) => new Proxy(o, {});
const reactiveArr = (a) => new Proxy(a, {});

(async () => {
  try {
    ok("preload 暴露了 pywebview.api", !!exposed && typeof exposed === "object");

    // 反向校验：确认测试前提成立 —— 裸 Proxy 确实不可克隆
    let threw = false;
    try {
      structuredClone({ sources: reactiveArr(["kw"]) });
    } catch {
      threw = true;
    }
    ok("反向校验：裸 Proxy 确实不可结构化克隆（测试前提成立）", threw);

    // 以下均**直接调用 preload 暴露的方法**（因此绕过了第 1 道 contextBridge 边界），
    // 验证的是第 2 道边界：preload 出口是否把载荷深拷贝后才交给 ipcRenderer.invoke。
    const cases = [
      ["searchOnline（reactive 数组）", () => exposed.searchOnline("晴天", reactiveArr(["kw", "kg"]))],
      ["getOnlineUrl（reactive 对象）", () => exposed.getOnlineUrl("kw", reactiveObj({ rid: "1" }), "320k")],
      ["getOnlineLyric（reactive 对象）", () => exposed.getOnlineLyric("kw", reactiveObj({ rid: "1" }))],
      ["pushDesktopLyrics（reactive 载荷）", () => exposed.pushDesktopLyrics(reactiveObj({ title: "t" }))],
      ["pushMiniState（reactive 快照）", () => exposed.pushMiniState(reactiveObj({ title: "t" }))],
      ["notifySong（reactive 载荷）", () => exposed.notifySong(reactiveObj({ title: "t", artist: "a" }))],
      ["saveFont（RPC 方法）", () => exposed.saveFont("a.ttf", "AAAA")],
      ["toggleSource（原始值）", () => exposed.toggleSource("id", true)],
      ["setFullscreen（布尔）", () => exposed.setFullscreen(true)],
    ];

    for (const [name, fn] of cases) {
      try {
        await fn();
        ok(name, true);
      } catch (e) {
        ok(name, false, `${e.constructor.name}: ${e.message}`);
      }
    }

    // 深拷贝语义：传给主进程的必须是副本，而不是渲染进程的引用
    const src = { kw: true };
    const proxySrc = reactiveObj(src);
    await exposed.getOnlineLyric("kw", proxySrc);
    const sent = calls[calls.length - 1].payload.musicInfo;
    ok("传给主进程的是深拷贝副本（非原引用）", sent !== proxySrc && sent.kw === true, JSON.stringify(sent));

    ok("所有调用都经由 ipcRenderer.invoke", calls.length >= cases.length, `calls=${calls.length}`);
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();
