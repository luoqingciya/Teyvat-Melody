// 用 CDP 截取真实界面的截图：做排版 / 样式改动时用来自查，比盲改可靠。
//
// 用法：
//   node tools/screenshot.js <输出文件.png> [--route=#/online] [--settings]
//     --route    先切到该哈希路由（点侧栏链接，避免与路由初始化竞争）
//     --settings 打开设置弹窗
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
