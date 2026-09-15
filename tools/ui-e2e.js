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
      const page = targets.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
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

// 因外部条件不满足而无法验证的断言：不作为失败计（如第三方源当前不支持该平台）。
// 与 FAIL 分开，避免把「源的波动」误报成「功能回归」。
const skip = (name, why) => {
  console.log(`SKIP  ${name}${why ? "  → " + why : ""}`);
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
        const host = document.querySelector('.tm-toast-host');
        const err = document.querySelector('.tm-toast--error');
        return {
          rows: rows.length,
          first: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
          empty: empty ? empty.textContent.trim() : null,
          toast: host ? host.textContent.replace(/\\s+/g, ' ').trim() : '',
          toastErr: err ? err.textContent.replace(/\\s+/g, ' ').trim() : '',
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
    ok("搜索未报错", !state?.toastErr, state?.toastErr || state?.toast);
    if (!state?.rows) throw new Error("无结果，跳过播放验证");

    // 5b) 翻页：列表末尾应有「下一页」按钮，点它要**追加**更多结果。
    //     没有翻页时用户只能看到每页固定那几十条，会以为「只能搜到这些」。
    const pageBefore = await cdp.eval(`(() => {
      const pager = document.querySelector('.online-view__pager');
      const next = pager ? [...pager.querySelectorAll('button')].pop() : null;
      return {
        hasPager: !!pager,
        nextDisabled: next ? next.disabled : null,
        info: pager ? (pager.querySelector('.pager-info') || {}).textContent : null,
        rows: document.querySelectorAll('.online-row').length,
      };
    })()`);
    console.log("  翻页栏:", JSON.stringify(pageBefore));
    ok("结果列表有翻页栏", !!pageBefore.hasPager, "未找到 .online-view__pager");
    ok("翻页栏显示当前页码", /第\s*\d+\s*页|Page\s*\d+/.test(pageBefore.info || ""), pageBefore.info);

    if (pageBefore.hasPager && !pageBefore.nextDisabled) {
      const nextClicked = await cdp.eval(`(() => {
        const pager = document.querySelector('.online-view__pager');
        const next = [...pager.querySelectorAll('button')].pop();
        if (!next || next.disabled) return 'disabled';
        next.click();
        return 'clicked';
      })()`);
      ok("点击「下一页」", nextClicked === "clicked", nextClicked);

      let page2 = null;
      for (let i = 0; i < 40; i++) {
        page2 = await cdp.eval(`(() => {
          const pager = document.querySelector('.online-view__pager');
          return {
            rows: document.querySelectorAll('.online-row').length,
            info: pager ? (pager.querySelector('.pager-info') || {}).textContent : null,
          };
        })()`);
        // 等到条数增加（追加成功）或页码变成 2
        if (page2.rows > pageBefore.rows) break;
        await sleep(500);
      }
      console.log("  翻页后:", JSON.stringify(page2));
      ok("翻页后结果被追加（条数增加）", page2.rows > pageBefore.rows, `${pageBefore.rows} → ${page2?.rows}`);
      ok("页码已前进到第 2 页", /第\s*2\s*页|Page\s*2/.test(page2.info || ""), page2?.info);
    } else {
      console.log("  （下一页按钮不可用，跳过翻页断言 —— 可能只有一页结果）");
    }

    // 5c) 搜索现场持久化：切到「全部音乐」再切回「在线搜索」，结果与关键词都该还在。
    //     此前这些状态放在组件里，路由一卸载就全丢，用户点走进来还得重搜。
    const persisted = await cdp.eval(`(async () => {
      const rowsOf = () => document.querySelectorAll('.online-row').length;
      const kwOf = () => {
        const el = document.querySelector('.online-view__input');
        return el ? el.value : '';
      };
      const before = { rows: rowsOf(), kw: kwOf() };

      const other = document.querySelector('a[href="#/songs"]');
      if (!other) return { error: 'no-songs-link' };
      other.click();
      await new Promise((r) => setTimeout(r, 400));
      const gone = !document.querySelector('.online-view');

      const back = document.querySelector('a[href="#/online"]');
      if (!back) return { error: 'no-online-link' };
      back.click();
      // 等视图重新渲染出来
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('.online-row')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { before, gone, after: { rows: rowsOf(), kw: kwOf() } };
    })()`);
    console.log("  切页往返:", JSON.stringify(persisted));
    if (persisted?.error) {
      ok("搜索现场持久化（切页面往返）", false, persisted.error);
    } else {
      ok("切走后原视图确实已卸载（前提成立）", persisted.gone === true, String(persisted.gone));
      ok("切回后搜索结果仍在", persisted.after.rows === persisted.before.rows && persisted.after.rows > 0,
        `${persisted.before.rows} → ${persisted.after?.rows}`);
      ok("切回后搜索关键词仍在", persisted.after.kw === persisted.before.kw && !!persisted.after.kw,
        `${JSON.stringify(persisted.before.kw)} → ${JSON.stringify(persisted.after?.kw)}`);
    }

    // 5d) 平台勾选也要持久化：取消勾选一个平台 → 切走再切回 → 仍是取消状态。
    //     用户报过「平台选择记不住」：根因是默认全选只写在内存、从不落盘，
    //     且无法区分「用户主动全取消」与「还没选过」（两者结构上都是空数组）。
    const platState = await cdp.eval(`(async () => {
      const chipsOf = () => [...document.querySelectorAll('.plat-chip')];
      const onKeys = () => chipsOf().filter((c) => c.classList.contains('plat-chip--on')).map((c) => c.textContent.trim());
      const usable = chipsOf().filter((c) => !c.disabled);
      if (usable.length < 2) return { skip: '需要至少 2 个可用平台才能验证取消勾选' };

      const before = onKeys();
      // 点掉最后一个可用平台
      const target = usable[usable.length - 1];
      const targetName = target.textContent.trim();
      target.click();
      await new Promise((r) => setTimeout(r, 300));
      const afterClick = onKeys();

      // 切走再切回（组件会被卸载，只有落盘的状态能活下来）
      document.querySelector('a[href="#/songs"]').click();
      await new Promise((r) => setTimeout(r, 400));
      document.querySelector('a[href="#/online"]').click();
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('.plat-chip')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 500));
      return { before, afterClick, targetName, afterBack: onKeys() };
    })()`);
    console.log("  平台勾选:", JSON.stringify(platState));
    if (platState?.skip) {
      console.log("  （跳过平台持久化断言：" + platState.skip + "）");
    } else {
      ok(
        "取消勾选平台后立即生效",
        platState.afterClick.length === platState.before.length - 1 &&
          !platState.afterClick.includes(platState.targetName),
        `${JSON.stringify(platState.before)} → ${JSON.stringify(platState.afterClick)}`
      );
      ok(
        "平台勾选跨页面往返保留（不被重置成全选）",
        JSON.stringify(platState.afterBack) === JSON.stringify(platState.afterClick),
        `期望 ${JSON.stringify(platState.afterClick)}，实际 ${JSON.stringify(platState.afterBack)}`
      );
      // 复原：把取消掉的平台勾回去，避免影响后续断言（如播放失败警示）
      await cdp.eval(`(async () => {
        const chip = [...document.querySelectorAll('.plat-chip')].find((c) => c.textContent.trim() === ${JSON.stringify(
          platState.targetName
        )} && !c.disabled);
        if (chip && !chip.classList.contains('plat-chip--on')) {
          chip.click();
          await new Promise((r) => setTimeout(r, 300));
        }
      })()`);
    }

    // 6) 点第一条播放：验证在线播放链路（online:getUrl + 同源代理取流）
    //    判定要严：不能只看「行变高亮」——那只能说明 playQueue 被调用了，
    //    真正的失败（源解析不出地址）会晚几秒才以 toast 出现，且时长始终为 00:00。
    await cdp.eval("document.querySelector('.online-row').click()");
    let play = null;
    for (let i = 0; i < 40; i++) {
      play = await cdp.eval(`(() => {
        const row = document.querySelector('.online-row--active');
        // 控制条里两个 .time-display：前者当前时间，后者总时长
        const times = [...document.querySelectorAll('.time-display')].map((e) => e.textContent.trim());
        const host = document.querySelector('.tm-toast-host');
        const err = document.querySelector('.tm-toast--error');
        return {
          active: !!row,
          activeText: row ? row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
          current: times[0] || null,
          duration: times[1] || null,
          toast: host ? host.textContent.replace(/\\s+/g, ' ').trim() : '',
          toastErr: err ? err.textContent.replace(/\\s+/g, ' ').trim() : '',
        };
      })()`);
      if (play.toastErr) break; // 已报错，不必再等
      const gotMeta = play.duration && play.duration !== "00:00" && play.duration !== "--:--";
      const advancing = play.current && play.current !== "00:00";
      if (gotMeta && advancing) break;
      await sleep(500);
    }
    console.log("  播放状态:", JSON.stringify(play));
    ok("点击结果后该行变为当前播放项", !!play?.active, "未出现 .online-row--active");
    ok("播放未报错（源解析 + 代理取流成功）", !play?.toastErr, play?.toastErr || play?.toast);
    ok("已取得音频时长（说明流已接通）", !!play?.duration && play.duration !== "00:00" && play.duration !== "--:--", `duration=${play?.duration}`);
    ok("进度已推进（说明确实在播放）", !!play?.current && play.current !== "00:00", `current=${play?.current}`);

    // 6b) 播一个「源可能播不了」的平台：失败时应在筛选条上留下警示。
    //     ⚠️ 不要假定某个平台一定失败 —— 源后端对平台的支持会变
    //     （实测同一个源对网易云从「全部 unknow error」变成「可正常解析」）。
    //     所以：失败才断言警示，能播就记 SKIP。
    const wyClicked = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.online-row')].find((r) => /网易云/.test(r.textContent));
      if (!row) return 'no-wy-row';
      row.click();
      return 'clicked';
    })()`);
    if (wyClicked !== "clicked") {
      console.log(`SKIP  未找到网易云结果（${wyClicked}），跳过失败警示断言`);
    } else {
      let wyState = null;
      let sawToast = false;
      for (let i = 0; i < 40; i++) {
        wyState = await cdp.eval(`(() => {
          const host = document.querySelector('.tm-toast-host');
          const chip = [...document.querySelectorAll('.plat-chip')].find((c) => /网易云/.test(c.textContent));
          const times = [...document.querySelectorAll('.time-display')].map((e) => e.textContent.trim());
          return {
            toast: host ? host.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) : '',
            warned: !!(chip && chip.classList.contains('plat-chip--warn')),
            chipTitle: chip ? (chip.getAttribute('title') || '') : '',
            playing: !!times[1] && times[1] !== '00:00' && times[1] !== '--:--',
          };
        })()`);
        if (wyState.toast) sawToast = true;
        if (wyState.warned) break;
        // 已经报了错却迟迟没出现警示（刷新提示是异步的），再给几秒就判定失败
        if (sawToast && i > 12) break;
        await sleep(500);
      }
      console.log("  网易云结果:", JSON.stringify(wyState));
      if (wyState?.warned) {
        ok("播不了的平台在筛选条上留下警示（⚠）", true);
        ok("警示的 tooltip 带上失败原因", /失败/.test(wyState.chipTitle || ""), wyState.chipTitle);
      } else if (sawToast) {
        ok("播放失败时筛选条应留下警示", false, wyState?.toast);
      } else {
        console.log("SKIP  网易云本次可正常播放，跳过失败警示断言（源后端支持情况会变）");
      }
    }

    // 6c) 在线播放缓存：切歌/seek 会中断流，但已下的部分会由后台补完并落盘。
    //     这里直接查应用内的缓存统计接口，确认缓存真的写成了（而不是一直停在 .part）。
    let cacheState = null;
    for (let i = 0; i < 90; i++) {
      cacheState = await cdp.eval(`fetch('/api/online/cache').then((r) => r.json()).then((j) => j.data)`);
      if (cacheState && cacheState.files > 0) break;
      await sleep(1000);
    }
    console.log("  缓存状态:", JSON.stringify(cacheState));
    ok("在线播放后音频已缓存到本地", !!cacheState && cacheState.files > 0, JSON.stringify(cacheState));
    ok("缓存占用已统计到字节数", !!cacheState && cacheState.bytes > 0, JSON.stringify(cacheState));

    // 6d) 在线歌曲入库：右键菜单（音质 / 下载 / 加入歌单）+ 收藏 + 歌单 + 换音质 + 下载。
    //     这四项都要跨「渲染进程 → 主进程 → Flask → SQLite」多道边界，
    //     单元测试里都是打桩，只有真实界面点一遍才能确认真的通了。
    //     先把第一条设为当前播放项（6b 点过网易云，当前播放项可能已经不是它）。
    await cdp.eval("document.querySelector('.online-row').click()");
    await sleep(3000);

    const menuState = await cdp.eval(`(async () => {
      const row = document.querySelector('.online-row');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
      await new Promise((r) => setTimeout(r, 250));
      const menu = document.querySelector('.song-ctx');
      if (!menu) return { err: 'no-menu' };
      return {
        items: [...menu.querySelectorAll('.song-ctx__item')].map((b) => b.textContent.trim()),
        chips: [...menu.querySelectorAll('.quality-chip')].map((b) => b.textContent.trim()),
      };
    })()`);
    console.log("  在线歌曲右键菜单:", JSON.stringify(menuState));
    ok("右键菜单含「收藏」", !!menuState?.items?.some((s) => /收藏/.test(s)), JSON.stringify(menuState));
    ok("右键菜单含「加入歌单」", !!menuState?.items?.some((s) => /加入歌单/.test(s)), JSON.stringify(menuState));
    ok("右键菜单含「下载到本地」", !!menuState?.items?.some((s) => /下载/.test(s)), JSON.stringify(menuState));
    ok("右键菜单含音质选项（来自源声明）", !!menuState?.chips?.length, JSON.stringify(menuState?.chips));
    ok("本地歌曲专属项未出现在在线菜单里", !menuState?.items?.some((s) => /编辑信息/.test(s)), JSON.stringify(menuState?.items));

    // 关掉菜单（Esc），改用行内按钮收藏。
    // 收藏是**切换**语义，且上一轮跑测可能已经收藏过，所以断言「状态被切换」而不是「变成已收藏」——
    // 否则第二次跑就会误报（这正是最初踩到的坑）。
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await sleep(200);

    const favState = await cdp.eval(`(async () => {
      const lib = await fetch('/api/online/library').then((r) => r.json());
      // ⚠️ 必须盯着**与点击同一首**歌的状态。
      // 旧实现是「取 /api/online/library 的第一条」当观察目标，却点「搜索结果第一行的爱心」——
      // 两者常常不是同一首歌（搜索顺序 ≠ 入库顺序），于是 toggle 生效了而观测的那首没变，
      // 断言就随机失败。改成先取行首那首的标题，再按标题到库里找对应记录。
      const row = document.querySelector('.online-row');
      if (!row) return { err: 'no-row' };
      const title = row.querySelector('.col-title').textContent.replace(/在线音乐/g, '').trim();
      const libEntry = (lib.data || []).find((s) => title.includes(s.title) || s.title.includes(title));

      const favsBefore = await fetch('/api/favorites').then((r) => r.json());
      const wasFav = !!libEntry && (favsBefore.data || []).some((s) => s.id === libEntry.id);

      const btns = row.querySelectorAll('.op-btn');
      if (btns.length < 5) return { err: 'op-btn=' + btns.length };
      btns[3].click(); // 收藏
      await new Promise((r) => setTimeout(r, 3000));

      const [lib2, favsAfter] = await Promise.all([
        fetch('/api/online/library').then((r) => r.json()),
        fetch('/api/favorites').then((r) => r.json()),
      ]);
      // 观察目标必须还是「刚才点的那一首」：入库顺序一变，lib2[0] 就不是它了。
      // 用标题二次定位（若它刚被收藏，库里应已有它；若刚被取消收藏，库里这条记录仍在，
      // 收藏只是把 id 挂进 favorites，不会删除歌曲），所以按标题必定找得到。
      const after =
        (lib2.data || []).find((s) => s.id === (libEntry && libEntry.id)) ||
        (lib2.data || []).find((s) => title.includes(s.title) || s.title.includes(title)) ||
        null;
      const nowFav = !!after && (favsAfter.data || []).some((s) => s.id === after.id);
      // ⚠️ 一致性不能用「全局收藏总数」来验——旧的写法是
      //     nowFav ? favCount > 0 : favCount === 0，它默认「收藏列表里只有这首歌」。
      //   但开发机曲库里本来就有别的收藏（本地歌、上一次跑测留下的在线歌），
      //   于是「取消收藏这一首」后 nowFav=false 而 favCount 仍为 1 → 误报。
      //   正确的不变量是：**收藏列表里的每一条，其收藏状态都为真；反之亦然**（双向一致）。
      const favIds = (favsAfter.data || []).map((s) => s.id);
      const listIds = (lib2.data || []).map((s) => s.id);
      const inList = (id) => listIds.includes(id);
      const listConsistent = favIds.every((id) => inList(id)); // 收藏的必然在曲库
      const favSetMatches = !!after && favIds.includes(after.id) === nowFav; // 单曲状态与列表一致
      return {
        lib: (lib2.data || []).length,
        favCount: favIds.length,
        wasFav,
        nowFav,
        flipped: wasFav !== nowFav,
        firstTitle: after ? after.title : null,
        firstSource: after ? after.online_source : null,
        matched: !!after,
        listConsistent,
        favSetMatches,
      };
    })()`);
    console.log("  收藏结果:", JSON.stringify(favState));
    ok("收藏在线歌曲 → 已入库到曲库", favState?.lib > 0, JSON.stringify(favState));
    ok("收藏在线歌曲 → 观测到同一首歌（未被入库顺序错位）", favState?.matched === true, JSON.stringify(favState));
    ok("收藏在线歌曲 → 收藏状态被切换", favState?.flipped === true, JSON.stringify(favState));
    ok(
      "收藏列表与该曲收藏状态一致",
      favState?.favSetMatches === true,
      JSON.stringify(favState)
    );
    ok(
      "收藏列表里的歌都在曲库中（收藏不会指向不存在的歌）",
      favState?.listConsistent === true,
      JSON.stringify(favState)
    );
    ok("入库记录带有来源平台（说明不是本地歌曲）", !!favState?.firstSource, JSON.stringify(favState));

    // 5e)「全部音乐」应当同时列出本地曲库与已入库的在线歌曲，并能按来源筛选。
    //     此前这一页只列本地曲库，用户会问「我收藏的在线歌怎么不在全部里」。
    const allView = await cdp.eval(`(async () => {
      const go = (hash) => document.querySelector('a[href="' + hash + '"]').click();
      go('#/songs');
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('.src-chip')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 400));

      const chips = () => [...document.querySelectorAll('.src-chip')];
      const rows = () => [...document.querySelectorAll('.song-row')];
      // ⚠️ 此处**不能**用 .tag-online 判定在线歌曲：那一页已经有来源列，
      //    标题里的在线标记会被刻意隐藏（否则同一件事说两遍）。
      //    判据改为「来源列里不是『本地』」—— 也就是这一页自己的信息来源。
      //    （注意：这段是模板字符串里的代码，注释里也不能写反引号，否则会提前结束字符串。）
      const isOnlineRow = (r) => !!r.querySelector('.col-source .src-badge');
      const onlineRows = () => rows().filter(isOnlineRow).length;
      const sourceCells = () => rows().map((r) => {
        const b = r.querySelector('.src-badge');
        return b ? b.textContent.trim() : (r.querySelector('.src-local') ? '本地' : '');
      });

      const labels = chips().map((c) => c.textContent.replace(/\\s+/g, ' ').trim());
      // ⚠️ 不能拿 rows().length 当「总数」：这个列表是**虚拟滚动**的，
      //    渲染出来的行数只反映当前窗口 + 当前筛选，不是全量。
      //    曲库小的时候恰好全部渲染、断言看着能过；歌一多就必然失配
      //    （实测踩到：仅本地 24 + 仅在线 2 却 vs 全部 25）。
      //    筛选条 chip 上的数字才是权威的全量计数，断言一律以它为准。
      const chipCount = (label) => {
        const c = chips().find((x) => x.textContent.includes(label));
        if (!c) return null;
        const m = c.textContent.match(/(\\d+)/);
        return m ? Number(m[1]) : null;
      };
      const allCount = chipCount('全部');
      const allOnline = onlineRows();
      const hasSourceCol = !!document.querySelector('.col-source-h');
      const sources = sourceCells();
      // 音质列的文案（本地歌曲应显示短码率，而不是 "MP3 : 128000k · 44.1kHz" 这种探测直出）
      const qualities = rows().map((r) => r.querySelector('.col-quality')?.textContent.trim() || '');
      // 有了来源列之后，标题里的在线标记不应再出现（同一信息不重复表达）
      const inlineTags = rows().filter((r) => r.querySelector('.tag-online')).length;

      // 切到「仅在线」
      const onlyOnline = chips().find((c) => c.textContent.includes('仅在线'));
      if (onlyOnline) onlyOnline.click();
      await new Promise((r) => setTimeout(r, 400));
      const onlineOnly = { rows: rows().length, onlineRows: onlineRows(), count: chipCount('仅在线') };

      // 切到「仅本地」
      const onlyLocal = chips().find((c) => c.textContent.includes('仅本地'));
      if (onlyLocal) onlyLocal.click();
      await new Promise((r) => setTimeout(r, 400));
      const localOnly = { rows: rows().length, onlineRows: onlineRows(), count: chipCount('仅本地') };

      // 回到「全部」
      const all = chips().find((c) => /^全部/.test(c.textContent.trim()));
      if (all) all.click();
      await new Promise((r) => setTimeout(r, 300));

      return { labels, allCount, allOnline, hasSourceCol, sources, onlineOnly, localOnly, qualities, inlineTags };
    })()`);
    console.log("  全部音乐:", JSON.stringify(allView));
    ok("「全部音乐」有来源筛选条（全部 / 仅本地 / 仅在线）", (allView?.labels || []).length === 3, JSON.stringify(allView?.labels));
    ok("「全部音乐」有来源列", allView?.hasSourceCol === true);
    ok(
      "「全部音乐」列出了在线歌曲（本地+在线混排）",
      allView?.allOnline > 0,
      `在线行数=${allView?.allOnline} / 总行数=${allView?.allCount}`
    );
    ok(
      "本地歌曲的来源列标为「本地」",
      (allView?.sources || []).includes("本地"),
      JSON.stringify(allView?.sources)
    );
    ok(
      "在线歌曲的来源列标出平台名（不是「本地」）",
      (allView?.sources || []).some((s) => s && s !== "本地"),
      JSON.stringify(allView?.sources)
    );
    ok(
      "「仅在线」只留在线歌曲",
      allView?.onlineOnly?.rows > 0 && allView.onlineOnly.rows === allView.onlineOnly.onlineRows,
      JSON.stringify(allView?.onlineOnly)
    );
    ok(
      "「仅本地」不含任何在线歌曲",
      allView?.localOnly?.onlineRows === 0 && allView.localOnly.rows > 0,
      JSON.stringify(allView?.localOnly)
    );
    // 用筛选条上的计数核对（全量口径），不用渲染行数（虚拟滚动，只反映当前窗口）
    ok(
      "「仅本地」+「仅在线」= 全部",
      allView?.localOnly?.count != null &&
        allView?.onlineOnly?.count != null &&
        allView.localOnly.count + allView.onlineOnly.count === allView.allCount,
      `${allView?.localOnly?.count} + ${allView?.onlineOnly?.count} vs ${allView?.allCount}`
    );
    // 音质列只放一档短文案（128K / 320K / FLAC）：探测详情留给 title 悬浮。
    // 早先是 "MP3 : 128000k · 44.1kHz" 直出，列被撑满还比不出高低。
    // ⚠️ 这里是普通代码，不是模板字符串 —— 正则里写 \\d 会变成「匹配反斜杠+d」，
    //    必须写成 \d。（同一个坑在模板字符串里恰好相反，别混。）
    ok(
      "音质列文案简短（没有 kHz / 超长数字串）",
      (allView?.qualities || []).every((q) => !/kHz|\d{5,}/.test(q)),
      JSON.stringify((allView?.qualities || []).slice(0, 6))
    );
    ok(
      "音质列给出了可比较的档位（如 128K / 320K / FLAC）",
      (allView?.qualities || []).some((q) => /^\d+K$/.test(q) || /^(FLAC|Unknown|未知|—)$/.test(q)),
      JSON.stringify((allView?.qualities || []).slice(0, 6))
    );
    ok(
      "有来源列时不再重复显示标题内的在线标记",
      allView?.inlineTags === 0,
      `inlineTags=${allView?.inlineTags}`
    );

    // 5f) 无障碍：列表行必须能用键盘操作。
    //     此前整行是 div + @click，键盘用户既播不了歌、也调不出右键菜单。
    //     这里走真实键盘事件路径验证（而不是只看有没有 tabindex 属性）。
    const a11y = await cdp.eval(`(async () => {
      const rows = () => [...document.querySelectorAll('.song-row')];
      if (!rows().length) return { err: 'no-rows' };

      const listbox = document.querySelector('.song-scroll');
      const roleOk = listbox?.getAttribute('role') === 'listbox';
      const rowRole = rows()[0].getAttribute('role');
      const focusable = rows()[0].tabIndex === 0;

      // 用 ↑/↓ 移动焦点：先聚焦第一行，再按 ArrowDown
      const first = rows()[0];
      first.focus();
      const focusedFirst = document.activeElement === first;

      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));
      const afterDown = document.activeElement;
      const movedDown = afterDown && afterDown.classList.contains('song-row') && afterDown !== first;

      // End 跳到最后一行之前，先确认焦点仍可用 ↑ 回到上一行
      afterDown?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));
      const movedUp = document.activeElement === first;

      // 键盘唤起右键菜单（Shift+F10）：菜单应出现且焦点落在第一项
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      const menu = document.querySelector('.song-ctx');
      const menuRole = menu?.getAttribute('role') || '';
      const menuFocusedItem = !!document.activeElement?.closest('.song-ctx');

      // 菜单内 ↓ 导航
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 100));
      const menuMoved = !!document.activeElement?.closest('.song-ctx') && document.activeElement !== menu?.querySelector('button');

      // Esc 关闭菜单，避免影响后续断言。
      //
      // 实现细节（排查过，别再走弯路）：菜单把「点击外部 / 滚动 / Esc」的全局监听挂在 window 上，
      // 且是 setTimeout(...,0) 延迟挂载的（防「打开菜单的那次点击立刻把自己关掉」）。
      // 所以这里**必须往 window 派发**，派到 document 或行元素都到不了那个监听器。
      // 独立探针（同序列、5/5 通过）证明产品本身没问题；偶发不关闭是执行到此处时机的波动，
      // 因此这里做「重试 + 记录诊断」，而不是把等待时间一味调大去赌。
      const openBeforeEsc = !!document.querySelector('.song-ctx');
      const focusBeforeEsc = document.activeElement?.className || '';
      const escProbe = [];
      let openAfterEsc = openBeforeEsc;
      for (let attempt = 0; attempt < 3 && openAfterEsc; attempt++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 300));
        openAfterEsc = !!document.querySelector('.song-ctx');
        escProbe.push('第' + (attempt + 1) + '次→' + (openAfterEsc ? '仍开' : '已关'));
      }

      const focusedRowKey = first.getAttribute('tabindex');
      return {
        roleOk, rowRole, focusable, focusedFirst, movedDown, movedUp,
        menuRole, menuFocusedItem, menuMoved, focusedRowKey,
        openBeforeEsc, focusBeforeEsc, openAfterEsc,
        escProbe: escProbe.join(', '),
        menuClosed: !openAfterEsc,
      };
    })()`);
    console.log("  行键盘无障碍:", JSON.stringify(a11y));
    ok("列表容器有 listbox 语义", a11y?.roleOk === true);
    ok("列表行有 option 语义且可聚焦", a11y?.rowRole === "option" && a11y?.focusable === true, JSON.stringify(a11y));
    ok("列表行可以获得焦点", a11y?.focusedFirst === true);
    ok("↓ 把焦点移到下一行", a11y?.movedDown === true, JSON.stringify(a11y));
    ok("↑ 把焦点移回上一行", a11y?.movedUp === true, JSON.stringify(a11y));
    ok("Shift+F10 能唤起右键菜单", a11y?.menuRole === "menu", JSON.stringify(a11y));
    ok("菜单打开后焦点进入菜单项", a11y?.menuFocusedItem === true, JSON.stringify(a11y));
    ok("菜单内 ↓ 可切换菜单项", a11y?.menuMoved === true, JSON.stringify(a11y));
    ok("Esc 能关闭菜单", a11y?.menuClosed === true, JSON.stringify(a11y));

    // 回到在线搜索页，后续断言（加入歌单 / 换音质 / 下载）都在那一页
    await cdp.eval(`(async () => {
      document.querySelector('a[href="#/online"]').click();
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('.online-row')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    })()`);

    // 加入歌单：右键菜单 → 选择器 → 新建歌单并加入。
    // 歌单名带时间戳：既保证每轮都走「新建」分支，也避免历史遗留歌单干扰断言。
    const plName = `在线E2E歌单-${Date.now()}`;
    const plState = await cdp.eval(`(async () => {
      const NAME = ${JSON.stringify(plName)};
      const row = document.querySelector('.online-row');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
      await new Promise((r) => setTimeout(r, 250));
      const add = [...document.querySelectorAll('.song-ctx__item')].find((b) => /加入歌单/.test(b.textContent));
      if (!add) return { err: 'no-add-item' };
      add.click();
      await new Promise((r) => setTimeout(r, 800));
      const input = document.querySelector('.pick__input');
      if (!input) return { err: 'no-picker' };
      input.value = NAME;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('.pick__create .ui-btn').click();
      await new Promise((r) => setTimeout(r, 3500));

      const pls = await fetch('/api/playlists').then((r) => r.json());
      const target = (pls.data || []).find((p) => p.name === NAME);
      if (!target) return { err: 'playlist-not-created', names: (pls.data || []).map((p) => p.name) };
      const songs = await fetch('/api/playlists/' + target.id + '/songs').then((r) => r.json());
      const first = (songs.data || [])[0] || null;
      // 清理：测试歌单用完即删，别把开发机的歌单列表越堆越乱
      await fetch('/api/playlists/' + target.id, { method: 'DELETE' });
      return {
        playlistId: target.id,
        count: (songs.data || []).length,
        first: first ? { title: first.title, source: first.online_source } : null,
      };
    })()`);
    console.log("  加入歌单结果:", JSON.stringify(plState));
    ok("加入歌单：可从菜单新建歌单", !!plState?.playlistId, JSON.stringify(plState));
    ok("加入歌单：在线歌曲已进入歌单", plState?.count > 0, JSON.stringify(plState));
    ok("加入歌单：歌单内保留在线来源（否则会被当成本地歌去请求文件）", !!plState?.first?.source, JSON.stringify(plState));

    // 换音质：点音质 chip 后应重新解析地址并从原位置续播（不是从 00:00 重来）
    const qState = await cdp.eval(`(async () => {
      const row = document.querySelector('.online-row--active') || document.querySelector('.online-row');
      const before = document.querySelector('.pc-btn--quality') ? document.querySelector('.pc-btn--quality').textContent.trim() : null;
      const beforeTime = [...document.querySelectorAll('.time-display')][0]?.textContent.trim();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
      await new Promise((r) => setTimeout(r, 250));
      const chips = [...document.querySelectorAll('.quality-chip')];
      const target = chips.find((c) => /320K/.test(c.textContent)) || chips[chips.length - 1];
      if (!target) return { err: 'no-chip', chips: chips.map((c) => c.textContent.trim()) };
      const picked = target.textContent.trim();
      target.click();
      await new Promise((r) => setTimeout(r, 6000));
      const times = [...document.querySelectorAll('.time-display')].map((e) => e.textContent.trim());
      const toast = document.querySelector('.tm-toast-host');
      return {
        before,
        picked,
        after: document.querySelector('.pc-btn--quality') ? document.querySelector('.pc-btn--quality').textContent.trim() : null,
        beforeTime,
        current: times[0],
        duration: times[1],
        toast: toast ? toast.textContent.trim() : '',
      };
    })()`);
    console.log("  换音质结果:", JSON.stringify(qState));
    ok("控制条显示在线音质徽标", !!qState?.before, JSON.stringify(qState));
    ok("切换音质未报错", !qState?.toast, qState?.toast);
    ok("切换后仍有有效音质（重新解析成功）", !!qState?.after && qState.after !== "…", JSON.stringify(qState));
    ok(
      "切换后未从头播放（进度被保留）",
      !!qState?.current && qState.current !== "00:00",
      `before=${qState?.beforeTime} after=${qState?.current}`
    );

    // 下载到本地曲库：走「选音质 → 主进程解析地址 → 后端取流落盘 → 登记为本地歌曲」全链路。
    // 挑一条**还没下载过**的结果（已下载的按钮是禁用的，点它只会空转）——
    // 顺便验证「已下载时按钮禁用」这条防重复下载的约束。
    //
    // ⚠️ 必须**逐条换源重试**，不能只赌第一条：第三方的源对哪个平台可用是会变的，
    //    实测同一首歌今天能解析、明天返回 `unknow error`。若只挑第一条未下载的结果，
    //    断言「下载成功」就等于赌「搜索结果第一条恰好被当前源支持」——源一波动就误报红，
    //    而失败原因与被测功能毫无关系。（与「不内置第三方源」并列的老坑之一。）
    const dlState = await cdp.eval(`(async () => {
      const rows = [...document.querySelectorAll('.online-row')];
      const doneRow = rows.find((r) => r.querySelector('.tag-done'));
      const disabledWhenDone = doneRow ? doneRow.querySelectorAll('.op-btn')[4].disabled : null;
      // 候选：所有没下载过的结果，按界面上第一条开始逐条试
      const candidates = rows.filter((r) => !r.querySelector('.tag-done'));
      if (!candidates.length) return { err: 'all-downloaded' };

      const tried = [];
      let lastFail = '';
      for (const target of candidates.slice(0, 3)) {
        // 先在右键菜单里选 320K：验证「下载可指定音质」这条路
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
        await new Promise((r) => setTimeout(r, 250));
        const chip = [...document.querySelectorAll('.quality-chip')].find((c) => /320K/.test(c.textContent));
        if (!chip) return { err: 'no-320k-chip' };
        chip.click();
        await new Promise((r) => setTimeout(r, 700));

        const beforeSongs = ((await fetch('/api/songs').then((r) => r.json())).data || []).length;
        const beforeKeys = ((await fetch('/api/online/downloaded').then((r) => r.json())).data || []).length;

        // 连点两下：第二次必须被拦住，否则会落出两份重复文件（前端重入保护 + 后端同键闸）
        const dlBtn = target.querySelectorAll('.op-btn')[4];
        dlBtn.click();
        dlBtn.click();
        let toast = '';
        for (let i = 0; i < 200; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const host = document.querySelector('.tm-toast-host');
          toast = host ? host.textContent.replace(/\\s+/g, ' ').trim() : '';
          if (/已下载/.test(toast) || /下载失败/.test(toast)) break;
        }
        if (/下载失败/.test(toast)) {
          // 这条对应的平台当前源解析不了（源波动，非本功能缺陷）→ 换下一条重试
          tried.push((target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + ' → ' + toast.slice(0, 40));
          lastFail = toast.slice(0, 80);
          continue;
        }

        const songs = (await fetch('/api/songs').then((r) => r.json())).data || [];
        const keys = (await fetch('/api/online/downloaded').then((r) => r.json())).data || [];
        // 用 toast 里的歌名精确找到刚入库的那首，核对封面/时长确实写进去了
        const m = toast.match(/已下载《(.+?)》/);
        const added = m ? songs.find((s) => s.title === m[1]) : null;
        return {
          disabledWhenDone,
          toast: toast.slice(0, 80),
          beforeSongs,
          afterSongs: songs.length,
          beforeKeys,
          afterKeys: keys.length,
          tried,
          added: added ? { title: added.title, duration: added.duration, hasCover: !!added.has_cover } : null,
        };
      }
      // 前几条候选全部解析失败：如实记下来（此时确实无法验证下载链路）
      return { err: 'all-candidates-failed', tried, toast: lastFail, disabledWhenDone };
    })()`);
    console.log("  下载结果:", JSON.stringify(dlState));
    if (dlState?.err === "all-candidates-failed") {
      // 前几条候选的平台当前源都解析不了 —— 这是第三方源的可用性波动，不是本功能缺陷。
      // 报 SKIP 而非 FAIL：把「源今天不支持」和「下载功能坏了」明确区分开。
      skip("下载到本地曲库（整链路）", `源当前解析不了这些平台：${(dlState.tried || []).join(" | ")}`);
      skip("已下载的歌，下载按钮被禁用（防重复下载）", "同上，需先有一条能下载成功的结果");
    } else if (dlState?.err === "all-downloaded") {
      skip("下载到本地曲库（整链路）", "搜索结果已全部下载过，无可测目标");
    } else {
      if (dlState?.tried?.length) {
        console.log(`  （已跳过 ${dlState.tried.length} 条源解析失败的结果：${dlState.tried.join(" | ")}）`);
      }
      ok("已下载的歌，下载按钮被禁用（防重复下载）", dlState?.disabledWhenDone === true, JSON.stringify(dlState));
      ok("下载未失败", !/下载失败/.test(dlState?.toast || ""), dlState?.toast);
      ok("下载完成后进入本地音乐库", (dlState?.afterSongs ?? 0) > (dlState?.beforeSongs ?? 0), JSON.stringify(dlState));
      ok(
        "连点两下只落一份文件（重入保护生效）",
        (dlState?.afterSongs ?? 0) - (dlState?.beforeSongs ?? 0) === 1,
        `+${(dlState?.afterSongs ?? 0) - (dlState?.beforeSongs ?? 0)} 首`
      );
      ok("「已下载」标记可查（避免重复下载）", (dlState?.afterKeys ?? 0) > (dlState?.beforeKeys ?? 0), JSON.stringify(dlState));
      ok("下载的歌带时长（说明文件可解析）", (dlState?.added?.duration ?? 0) > 0, JSON.stringify(dlState));
      // 封面取决于该平台是否提供：酷我该字段常为空（回退占位图），不能强断言。
      // 「有封面时必定写进库」由 tests/online-proxy.test.py 用可控假封面确定性覆盖。
      if (dlState?.added?.hasCover) {
        ok("下载的歌带封面", true);
      } else {
        console.log("SKIP  该结果源未提供封面（酷我常见），跳过封面断言");
      }
    }

    // 歌词缓存：播放/下载后 lyrics 目录应有内容（设置页的占用统计会带上它）
    const lyricCache = await cdp.eval(`fetch('/api/online/cache').then((r) => r.json()).then((j) => j.data)`);
    console.log("  歌词缓存:", JSON.stringify(lyricCache));
    ok("歌词已缓存到本地", !!lyricCache && lyricCache.lyricsFiles > 0, JSON.stringify(lyricCache));
    ok("缓存统计含歌词与总计字节", !!lyricCache && lyricCache.totalBytes >= lyricCache.bytes, JSON.stringify(lyricCache));

    // 7) 设置页「关于与更新」：真实走一次 GitHub Release 检查
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.traffic-btn')].find((b) => b.title && b.title.length);
      // 设置按钮是标题栏里带 gear 图标的那个，这里按顺序取最后一个控制按钮前的那个
      const gear = [...document.querySelectorAll('.traffic-btn')].find((b) => b.querySelector('.app-icon'));
      (gear || btn)?.click();
    })()`);
    let settingsReady = false;
    for (let i = 0; i < 40; i++) {
      settingsReady = await cdp.eval("!!document.querySelector('.settings')");
      if (settingsReady) break;
      await sleep(250);
    }
    ok("设置弹窗已打开", settingsReady, "未找到 .settings");

    if (settingsReady) {
      // 分类标签：设置项按类分栏后，先确认标签栏存在，并给出「点标签切分类」的真实交互。
      // 不点标签的话，非默认分类的内容是 v-show 隐藏的，下面的断言会全部读不到。
      const tabs = await cdp.eval(`(() => {
        const nav = document.querySelector('.settings__tabs');
        if (!nav) return null;
        return {
          count: nav.querySelectorAll('.settings__tab').length,
          labels: [...nav.querySelectorAll('.settings__tab')].map((b) => b.textContent.trim()),
        };
      })()`);
      console.log("  设置分类标签:", JSON.stringify(tabs));
      ok("设置页有分类标签栏", !!tabs && tabs.count >= 4, JSON.stringify(tabs));

      /** 点某个分类标签，返回是否点中 */
      const clickTab = async (re) => {
        const r = await cdp.eval(`(() => {
          const btn = [...document.querySelectorAll('.settings__tab')]
            .find((b) => ${re}.test(b.textContent));
          if (!btn) return 'no-tab';
          btn.click();
          return 'clicked';
        })()`);
        await sleep(200);
        return r;
      };

      // 切到「播放」分类（默认就在这，显式点一次保证状态确定）
      await clickTab(/^(播放|Playback)$/);
      const playbackVisible = await cdp.eval(`(() => {
        const pane = document.querySelector('.settings__pane');
        const groups = [...document.querySelectorAll('.settings__group')]
          .filter((g) => g.offsetParent !== null);
        return groups.length > 0;
      })()`);
      ok("「播放」分类下有可见设置项", playbackVisible === true, String(playbackVisible));

      // 切到「关于与更新」分类（版本号 / 数据目录 / 检查更新都在这里）
      const aboutClicked = await clickTab(/关于|About/);
      ok("已切到「关于与更新」分类", aboutClicked === "clicked", aboutClicked);

      const version = await cdp.eval(`(() => {
        const row = [...document.querySelectorAll('.settings__row')]
          .find((r) => r.offsetParent !== null && /当前版本|Current version/.test(r.textContent));
        return row ? row.textContent.replace(/\\s+/g, ' ').trim() : null;
      })()`);
      ok("设置页显示当前版本", !!version && /\d+\.\d+\.\d+/.test(version), version);

      // 数据目录：用户得能自己确认「我的曲库/歌单到底存在哪」——
      // 两种分发方式数据都跟 EXE 同级（安装目录自包含），整目录可搬移（见 dataRoot.js）
      const dataDir = await cdp.eval(`(() => {
        const row = [...document.querySelectorAll('.settings__row')]
          .find((r) => r.offsetParent !== null && /数据目录|Data folder/.test(r.textContent));
        if (!row) return null;
        const v = row.querySelector('.settings__value');
        return v ? { text: v.textContent.trim(), title: v.getAttribute('title') || '' } : null;
      })()`);
      console.log("  数据目录:", JSON.stringify(dataDir));
      ok("设置页显示数据目录", !!dataDir?.text, JSON.stringify(dataDir));
      ok("数据目录是绝对路径", !!dataDir?.title && /^[A-Za-z]:[\\\\/]/.test(dataDir.title), JSON.stringify(dataDir));
      ok(
        "开发模式下数据目录 = 项目根（不误判为安装版）",
        !!dataDir?.title && /Teyvat-Melody/i.test(dataDir.title) && !/%LOCALAPPDATA%/i.test(dataDir.title),
        JSON.stringify(dataDir)
      );

      // 在线播放分类：自定义源 + 缓存占用都在这里
      const onlineClicked = await clickTab(/在线播放|Online/);
      ok("已切到「在线播放」分类", onlineClicked === "clicked", onlineClicked);

      const cacheGroup = await cdp.eval(`(() => {
        const g = [...document.querySelectorAll('.settings__group')]
          .find((x) => x.offsetParent !== null && /在线播放缓存|Online playback cache/.test(x.textContent));
        return g ? g.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : null;
      })()`);
      ok("设置页有「在线播放缓存」分组", !!cacheGroup, cacheGroup || "未找到");

      // 回到「关于与更新」再点检查更新（按钮在那个分类下）
      await clickTab(/关于|About/);

      const clickedCheck = await cdp.eval(`(() => {
        const btn = [...document.querySelectorAll('.settings__action')]
          .find((b) => b.offsetParent !== null && /检查更新|Check for updates/.test(b.textContent));
        if (!btn) return 'no-button';
        if (btn.disabled) return 'disabled';
        btn.click();
        return 'clicked';
      })()`);
      ok("已点击「检查更新」", clickedCheck === "clicked", clickedCheck);

      let checkState = null;
      for (let i = 0; i < 60; i++) {
        checkState = await cdp.eval(`(() => {
          const texts = [...document.querySelectorAll('.settings__group')].map((g) => g.textContent.replace(/\\s+/g, ' '));
          const joined = texts.join(' || ');
          return {
            upToDate: /已是最新版本|up to date/i.test(joined),
            available: /发现新版本|New version/i.test(joined),
            failed: /检查更新失败|Update check failed/i.test(joined),
          };
        })()`);
        if (checkState.upToDate || checkState.available || checkState.failed) break;
        await sleep(500);
      }
      console.log("  更新检查结果:", JSON.stringify(checkState));
      ok("更新检查返回了明确结果（非卡在检查中）", !!(checkState?.upToDate || checkState?.available || checkState?.failed), JSON.stringify(checkState));
      ok("更新检查未报错", !checkState?.failed, checkState?.failed);
    }
  } catch (e) {
    console.log(`FAIL  验证中断  → ${e.message}`);
    if (process.env.E2E_TRACE) console.log(e.stack);
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
