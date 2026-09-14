// 用 CDP 截取真实界面的截图：做排版 / 样式改动时用来自查，比盲改可靠。
//
// 用法：
//   node tools/screenshot.js <输出文件.png> [--route=#/online] [--settings] [--tab=lyrics] [--search=关键词] [--page=2]
//     --route    先切到该哈希路由（点侧栏链接，避免与路由初始化竞争）
//     --settings 打开设置弹窗
//     --tab      设置弹窗里切到该分类：playback / appearance / lyrics / online / about
//     --search   在在线搜索页真的搜一次并等出结果（要看结果列表/翻页栏时用）
//     --page     搜完再点 N-1 次「下一页」（用于给翻页后的状态截图）
//
// 会额外输出一张 `*.bottom.png`：把弹窗主体滚到底再截一张，
// 便于查看设置页下半部分（弹窗主体是内部滚动的，单张图看不全）。
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 9226;
const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "screenshot.png");
const route = (args.find((a) => a.startsWith("--route=")) || "").replace("--route=", "");
const openSettings = args.includes("--settings");
const searchKw = (args.find((a) => a.startsWith("--search=")) || "").replace("--search=", "");
const targetPage = Number((args.find((a) => a.startsWith("--page=")) || "").replace("--page=", "")) || 1;
// 设置页分类（按左侧标签顺序的下标定位）：playback / appearance / lyrics / online / about
const settingsTab = (args.find((a) => a.startsWith("--tab=")) || "").replace("--tab=", "");
const TAB_ORDER = ["playback", "appearance", "lyrics", "online", "about"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 端口未就绪 */
    }
    await sleep(500);
  }
  throw new Error("等待 SPA 超时");
}

(async () => {
  // --no-sandbox --disable-gpu：受限环境里 Chromium 的 GPU/沙箱进程起不来会直接 FATAL
  const proc = spawn(ELECTRON, ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${PORT}`, ROOT], {
    cwd: ROOT,
    stdio: "ignore",
  });
  let ws = null;
  try {
    const page = await waitForPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP 连接失败"));
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const done = pending.get(m.id);
      if (done) {
        pending.delete(m.id);
        done(m);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = (expression) =>
      send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    for (let i = 0; i < 60; i++) {
      const r = await evaluate("!!document.querySelector('.app-shell')");
      if (r.result.value) break;
      await sleep(500);
    }

    if (route) {
      await evaluate(`(async () => {
        for (let i = 0; i < 60; i++) {
          if (location.hash === '#/songs') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const link = document.querySelector('a[href="${route}"]');
        if (link) link.click();
      })()`);
      await sleep(900);
    }

    if (openSettings) {
      await evaluate(`(() => {
        const gear = [...document.querySelectorAll('.traffic-btn')].find((b) => b.querySelector('.app-icon'));
        gear && gear.click();
      })()`);
      for (let i = 0; i < 40; i++) {
        const r = await evaluate("!!document.querySelector('.settings')");
        if (r.result.value) break;
        await sleep(250);
      }
      await sleep(400);

      // 切到指定分类标签（设置页各分类高度应一致，切标签不该让弹窗跳动）
      if (settingsTab) {
        await evaluate(`(() => {
          const tabs = [...document.querySelectorAll('.settings__tab')];
          const idx = ${JSON.stringify(TAB_ORDER)}.indexOf(${JSON.stringify(settingsTab)});
          if (idx >= 0 && tabs[idx]) tabs[idx].click();
        })()`);
        await sleep(500);
      }
    }

    // 真的搜一次：翻页栏在结果列表末尾，不搜就截不到。
    if (searchKw) {
      await evaluate(`(async () => {
        const input = document.querySelector('.online-view__input');
        if (!input) return;
        input.value = ${JSON.stringify(searchKw)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        const btn = document.querySelector('.online-view__go');
        if (btn && !btn.disabled) btn.click();
      })()`);
      for (let i = 0; i < 80; i++) {
        const r = await evaluate("document.querySelectorAll('.online-row').length");
        if (r.result.value > 0) break;
        await sleep(500);
      }
      // 翻到目标页
      for (let p = 1; p < targetPage; p++) {
        const r = await evaluate(`(() => {
          const pager = document.querySelector('.online-view__pager');
          const next = pager ? [...pager.querySelectorAll('button')].pop() : null;
          if (!next || next.disabled) return 'stop';
          next.click();
          return 'ok';
        })()`);
        if (r.result.value === "stop") break;
        await sleep(2500);
      }
      // 滚到列表末尾，让翻页栏进入视野（否则截图上只有一堆行，看不到下一页按钮）
      await evaluate(`(() => {
        const s = document.querySelector('.online-view__scroll');
        if (s) s.scrollTop = s.scrollHeight;
      })()`);
      await sleep(600);
    }

    const shot = async (file) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("已保存:", file);
    };

    await shot(out);

    if (openSettings) {
      const bottom = out.replace(/\.png$/i, "") + ".bottom.png";
      await evaluate(`(() => {
        const body = document.querySelector('.app-modal__body');
        if (body) body.scrollTop = body.scrollHeight;
      })()`);
      await sleep(500);
      await shot(bottom);
    }
  } catch (e) {
    console.log("FAIL:", e.message);
    process.exitCode = 1;
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    proc.kill();
  }
})();
