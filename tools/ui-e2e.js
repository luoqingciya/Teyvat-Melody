// 真实 UI 端到端验证（需要图形界面，不进 CI）。
//
// 启动 Electron 并开远程调试端口，用 CDP 驱动渲染进程，**走真实界面路径**：
// 切到「在线搜索」→ 在输入框输入关键词 → 点击搜索按钮 → 读结果列表。
//
// 为什么必须走界面而不是直接调 preload API：搜索用的平台列表是 Vue 的 reactive 数组，
// 直接传普通数组不会触发结构化克隆问题。只有真实界面交互才能复现/验证该类缺陷
//（曾漏掉过一次：preload 的 searchOnline 未做深拷贝，界面上报 "An object could not be cloned."）。
//
// 用法：node tools/ui-e2e.js [关键词]
// 前置：frontend/dist 已构建；sources/ 下至少有一个可用源（否则搜索按钮不可点）。
const { spawn } = require("child_process");
const path = require("path");

const PORT = 9222;
const KEYWORD = process.argv[2] || "晴天 周杰伦";
const ROOT = path.join(__dirname, ".."); // tools/ 的上一级即项目根
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg);
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate 异常");
    return r.result.value;
  }
}

/** 轮询 CDP 目标列表，等 SPA 页面出现 */
async function waitForPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1:5000"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500);
  }
  throw new Error("等待 SPA 页面超时（后端可能未就绪）");
}

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  console.log("启动 Electron（会短暂弹出应用窗口）…");
  // --no-sandbox --disable-gpu：受限环境（沙箱/容器）里 Chromium 的 GPU 进程与沙箱起不来，
  // 会直接 FATAL "GPU process isn't usable"。仅本调试脚本需要，不影响应用本身。
  const proc = spawn(
    ELECTRON,
    ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${PORT}`, ROOT],
    { cwd: ROOT, stdio: "ignore" }
  );

  let cdp = null;
  try {
    const page = await waitForPage();
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    console.log("已连上渲染进程，等待 SPA 挂载…");

    // 1) SPA 挂载完成
    let mounted = false;
    for (let i = 0; i < 60; i++) {
      mounted = await cdp.eval("!!document.querySelector('.app-shell')");
      if (mounted) break;
      await sleep(500);
    }
    ok("SPA 已挂载", mounted);
    if (!mounted) throw new Error("SPA 未挂载");

    // 2) 切到在线搜索页：点侧栏真实导航链接（即用户路径）。
    //    不要直接改 location.hash / pushState：
    //    - 初始 hash 是 "#/"，路由还在做 "" → "/songs" 的重定向，抢先改会被它覆盖回去；
    //    - pushState 不触发 popstate，路由收不到通知，URL 变了但视图不换。
    const navClicked = await cdp.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (location.hash === '#/songs') break; // 等路由完成初始重定向
        await new Promise((r) => setTimeout(r, 100));
      }
      const link = document.querySelector('a[href="#/online"]');
      if (!link) return 'no-link';
      link.click();
      return 'clicked';
    })()`);
    ok("点击侧栏「在线搜索」入口", navClicked === "clicked", navClicked);

    let viewReady = false;
    for (let i = 0; i < 60; i++) {
      viewReady = await cdp.eval("!!document.querySelector('.online-view')");
      if (viewReady) break;
      await sleep(250);
    }
    if (!viewReady) {
      const diag = await cdp.eval(`(() => {
        const main = document.querySelector('.main-content');
        return {
          hash: location.hash,
          mainChildren: main ? [...main.children].map((c) => c.className) : [],
        };
      })()`);
      console.log("  现场诊断:", JSON.stringify(diag));
    }
    ok("在线搜索页已渲染", viewReady);
    if (!viewReady) throw new Error("在线搜索页未渲染");

    // 3) 平台筛选条：有启用源才可点搜索
    const plats = await cdp.eval(`(() => {
      const chips = [...document.querySelectorAll('.plat-chip')];
      return chips.map((c) => ({ label: c.textContent.trim(), disabled: c.disabled }));
    })()`);
    const usable = plats.filter((p) => !p.disabled);
    console.log("  平台筛选条:", JSON.stringify(plats));
    ok("存在可用平台（说明已加载到启用源）", usable.length > 0, "全部置灰 → sources/ 下没有启用的源");

    // 4) 真实交互：输入关键词并点击搜索
    const clicked = await cdp.eval(`(async () => {
      const input = document.querySelector('.online-view__input');
      if (!input) return 'no-input';
      input.value = ${JSON.stringify(KEYWORD)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const btn = document.querySelector('.online-view__go');
      if (!btn) return 'no-button';
      if (btn.disabled) return 'button-disabled';
      btn.click();
      return 'clicked';
    })()`);
    ok("已触发搜索（输入 + 点击按钮）", clicked === "clicked", clicked);
    if (clicked !== "clicked") throw new Error(`无法触发搜索：${clicked}`);

    // 5) 等结果：出现结果行，或落到终态文案
    let state = null;
    for (let i = 0; i < 80; i++) {
      state = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('.online-row')];
        const empty = document.querySelector('.online-view__empty');
        const toast = document.querySelector('.tm-toast-host');
        return {
          rows: rows.length,
          first: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
          empty: empty ? empty.textContent.trim() : null,
          toast: toast ? toast.textContent.trim() : '',
        };
      })()`);
      if (state.rows > 0) break;
      if (state.empty && state.empty !== "搜索中…") break;
      await sleep(500);
    }

    console.log("  界面状态:", JSON.stringify(state));
    ok("搜索未出现「could not be cloned」", !/cloned/i.test(`${state?.empty || ""} ${state?.toast || ""}`),
      `${state?.empty} ${state?.toast}`);
    ok("搜索结果已渲染到列表", state && state.rows > 0, state?.empty || "0 行");
    ok("结果行含歌名与来源", !!(state?.first && state.first.length > 3), state?.first);
    ok("无失败 toast", !state?.toast, state?.toast);
    if (!state?.rows) throw new Error("无结果，跳过播放验证");

    // 6) 点第一条播放：验证在线播放链路（online:getUrl + 同源代理取流）
    await cdp.eval("document.querySelector('.online-row').click()");
    let play = null;
    for (let i = 0; i < 40; i++) {
      play = await cdp.eval(`(() => {
        const row = document.querySelector('.online-row--active');
        const toast = document.querySelector('.tm-toast-host');
        // audio 元素是 new Audio() 创建、未挂到 DOM，故从界面状态判断
        const icon = document.querySelector('.op-btn .app-icon');
        return {
          active: !!row,
          activeText: row ? row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
          toast: toast ? toast.textContent.trim() : '',
        };
      })()`);
      if (play.toast || (play.active && play.activeText)) break;
      await sleep(500);
    }
    console.log("  播放状态:", JSON.stringify(play));
    ok("点击结果后该行变为当前播放项", !!play?.active, "未出现 .online-row--active");
    ok("播放未报错", !play?.toast, play?.toast);
  } catch (e) {
    console.log(`FAIL  验证中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    proc.kill();
    console.log("\n已关闭 Electron");
  }
})();
