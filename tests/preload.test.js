// preload 桥接层自检：node tests/preload.test.js
//
// 守住一个真实缺陷：渲染进程传给 IPC 的 Vue reactive 对象（Proxy）无法被结构化克隆，
// Electron 会抛 "An object could not be cloned."，表现为界面上「搜索失败」之类的报错。
// 桥接层必须统一做 JSON 深拷贝（见 README「安全与开发约定」）。
//
// 这里用 Proxy 模拟 Vue reactive —— 与 Electron 一致，structuredClone 对 Proxy 会抛
// DOMException；并让假的 ipcRenderer 真的调用 structuredClone，从而真实复现该约束。
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
