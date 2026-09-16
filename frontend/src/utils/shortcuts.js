// shortcuts：快捷键的**纯逻辑**（动作清单、按键串解析与显示、冲突检测）。
//
// 抽成纯函数是为了能直接单测 —— 这里全是字符串处理与边界判定，
// 而真正按键的那套（监听 keydown、调 globalShortcut）没法在单测里跑。
//
// 按键串格式沿用 Electron accelerator（`globalShortcut.register` 直接吃这个格式）：
//   · 修饰键在前、固定顺序：Ctrl / Alt / Shift / Super
//   · 单个主键在后：F1、ArrowLeft、A、1、Space、-、=
//   · 例：`Ctrl+Alt+ArrowLeft`、`F1`、`Ctrl+F5`
// 显示时再转成人看的样子（`Ctrl + Alt + ←`）。

/** 修饰键的固定顺序（同时决定显示顺序） */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"];

/** 单个字符键 → Electron accelerator 里的写法 */
const CHAR_TO_TOKEN = {
  " ": "Space",
  "+": "Plus",
  "-": "-",
  "=": "=",
  "[": "[",
  "]": "]",
  ";": ";",
  "'": "'",
  ",": ",",
  ".": ".",
  "/": "/",
  "\\": "\\",
  "`": "`",
};

/** 显示用：把主键换成更直观的符号 */
const DISPLAY_KEY = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "空格",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

const DISPLAY_KEY_EN = { ...DISPLAY_KEY, Space: "Space" };

/**
 * 快捷键动作清单。**这是唯一的动作表** ——
 * 主进程只负责把「按下了哪个动作」转发回来，具体做什么全在这里查表执行，
 * 避免同一套动作在主进程和渲染进程各写一遍（那种重复迟早会走岔）。
 *
 * `inApp` / `global` 是各自作用域的默认按键；空串表示默认未设置。
 * `globalOnly` 表示该动作只能在全局作用域用（窗口都没显示时才有意义的那些）。
 */
const ACTIONS = [
  // ---- 播放控制 ----
  { id: "playPause", label: "shortcut.playPause", inApp: "Ctrl+F5", global: "Ctrl+Alt+F5" },
  { id: "prev", label: "shortcut.prev", inApp: "Ctrl+ArrowLeft", global: "Ctrl+Alt+ArrowLeft" },
  { id: "next", label: "shortcut.next", inApp: "Ctrl+ArrowRight", global: "Ctrl+Alt+ArrowRight" },
  { id: "seekBack", label: "shortcut.seekBack", inApp: "", global: "" },
  { id: "seekForward", label: "shortcut.seekForward", inApp: "", global: "" },
  // ---- 音量 ----
  { id: "volumeUp", label: "shortcut.volumeUp", inApp: "", global: "Ctrl+Alt+ArrowUp" },
  { id: "volumeDown", label: "shortcut.volumeDown", inApp: "", global: "Ctrl+Alt+ArrowDown" },
  { id: "mute", label: "shortcut.mute", inApp: "", global: "" },
  // ---- 收藏 ----
  { id: "favorite", label: "shortcut.favorite", inApp: "", global: "" },
  { id: "unfavorite", label: "shortcut.unfavorite", inApp: "", global: "" },
  // ---- 桌面歌词 ----
  { id: "toggleLyrics", label: "shortcut.toggleLyrics", inApp: "", global: "Ctrl+Alt+0" },
  { id: "lyricsLock", label: "shortcut.lyricsLock", inApp: "", global: "Ctrl+Alt+-" },
  { id: "lyricsTopmost", label: "shortcut.lyricsTopmost", inApp: "", global: "Ctrl+Alt+=" },
  // ---- 界面 / 窗口 ----
  { id: "focusSearch", label: "shortcut.focusSearch", inApp: "F1", global: "" },
  { id: "minimizeRestore", label: "shortcut.minimizeRestore", inApp: "", global: "", globalOnly: true },
  { id: "toggleWindow", label: "shortcut.toggleWindow", inApp: "", global: "", globalOnly: true },
  { id: "quit", label: "shortcut.quit", inApp: "", global: "" },
];

/** 作用域 → 该作用域下的默认按键表 */
function defaultMap(scope) {
  const key = scope === "global" ? "global" : "inApp";
  const out = {};
  for (const a of ACTIONS) {
    if (scope === "global" && a.globalOnly === undefined && a[key] === undefined) continue;
    out[a.id] = a[key] || "";
  }
  return out;
}

/** 某作用域里可配置的动作（globalOnly 的动作不进「软件内」列表） */
function actionsFor(scope) {
  return ACTIONS.filter((a) => (scope === "global" ? true : !a.globalOnly));
}

/**
 * 把 KeyboardEvent 转成 accelerator 字符串。
 *
 * @returns {string|null} 只有修饰键按下时返回 null（那不是一次完整按键）；
 *   主键是字母/数字且**没有修饰键**时也返回 null —— 那种组合会把打字全吃掉，
 *   录进来只会让程序没法用。
 */
function eventToAccelerator(e) {
  if (!e || !e.key) return null;
  const key = e.key;
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta" || key === "AltGraph") {
    return null;
  }

  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  let token;
  if (/^F\d{1,2}$/.test(key)) token = key; // F1..F24
  else if (key.startsWith("Arrow")) token = key;
  else if (key.length === 1) {
    token = CHAR_TO_TOKEN[key] || (/[a-z]/i.test(key) ? key.toUpperCase() : key);
  } else {
    // Enter / Escape / Backspace / Tab / Home / End / PageUp / PageDown / Delete / Insert …
    token = key;
  }

  // 裸字母/数字：会吃掉正常打字，拒绝
  const isPlainChar = token.length === 1 && /[A-Z0-9]/.test(token);
  if (!mods.length && isPlainChar) return null;

  return [...mods, token].join("+");
}

/** 规范化：修饰键按固定顺序、去重、主键原样。非法输入返回 ""。 */
function normalizeAccelerator(acc) {
  const raw = String(acc || "").trim();
  if (!raw) return "";
  const parts = raw.split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  const mods = [];
  const keys = [];
  for (const p of parts) {
    const hit = MODIFIER_ORDER.find((m) => m.toLowerCase() === p.toLowerCase());
    if (hit) {
      if (!mods.includes(hit)) mods.push(hit);
    } else {
      keys.push(p);
    }
  }
  if (keys.length !== 1) return ""; // 必须恰好一个主键
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  // 单字母主键统一大写：事件那边产出的是 "A"，配置里若写成 "a"，
  // 不归一化就会「看起来一样却匹配不上」。
  const main = keys[0].length === 1 && /[a-z]/i.test(keys[0]) ? keys[0].toUpperCase() : keys[0];
  return [...mods, main].join("+");
}

/** 显示用：`Ctrl+Alt+ArrowLeft` → `Ctrl + Alt + ←` */
function formatAccelerator(acc, lang = "zh") {
  const norm = normalizeAccelerator(acc);
  if (!norm) return "";
  const table = lang === "zh" ? DISPLAY_KEY : DISPLAY_KEY_EN;
  return norm
    .split("+")
    .map((p) => table[p] || p)
    .join(" + ");
}

/** 同一作用域内的重复快捷键。返回 { accelerator: [id, id] } */
function findConflicts(map) {
  const seen = {};
  for (const [id, acc] of Object.entries(map || {})) {
    const norm = normalizeAccelerator(acc);
    if (!norm) continue;
    (seen[norm] = seen[norm] || []).push(id);
  }
  const out = {};
  for (const [acc, ids] of Object.entries(seen)) {
    if (ids.length > 1) out[acc] = ids;
  }
  return out;
}

/** 把用户配置与默认值合并：只保留已知动作，缺的补默认值 */
function mergeWithDefaults(saved, scope) {
  const defs = defaultMap(scope);
  const out = { ...defs };
  for (const id of Object.keys(defs)) {
    if (saved && typeof saved[id] === "string") out[id] = normalizeAccelerator(saved[id]);
  }
  return out;
}

/** 按键串 → 用于比对的「修饰键集合 + 主键」 */
function parseAccelerator(acc) {
  const norm = normalizeAccelerator(acc);
  if (!norm) return null;
  const parts = norm.split("+");
  const mods = new Set();
  let key = "";
  for (const p of parts) {
    if (MODIFIER_ORDER.includes(p)) mods.add(p);
    else key = p;
  }
  return { mods, key };
}

/**
 * 判断一次按键事件是否命中某个快捷键。
 *
 * ⚠️ 修饰键必须**精确匹配**：`Ctrl+F5` 不该被 `Ctrl+Alt+F5` 触发（反之亦然），
 * 否则全局与软件内的默认键会互相串（它们正好差一个 Alt）。
 */
function matchesEvent(acc, e) {
  const parsed = parseAccelerator(acc);
  if (!parsed || !e || !e.key) return false;
  const evAcc = eventToAccelerator(e);
  if (!evAcc) return false;
  return normalizeAccelerator(evAcc) === normalizeAccelerator(acc);
}

export {
  ACTIONS,
  MODIFIER_ORDER,
  actionsFor,
  defaultMap,
  eventToAccelerator,
  normalizeAccelerator,
  formatAccelerator,
  findConflicts,
  mergeWithDefaults,
  parseAccelerator,
  matchesEvent,
};
