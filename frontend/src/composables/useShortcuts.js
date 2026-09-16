// useShortcuts：快捷键的**运行期**部分（监听按键、查表执行动作、录制新键）。
//
// 分两层：
//   · 软件内快捷键 —— 窗口聚焦时，自己监听 window 的 keydown。
//   · 全局快捷键 —— 交给主进程的 globalShortcut 注册；触发后主进程只回传「哪个动作」，
//     具体做什么仍然查**同一张动作表**（见 utils/shortcuts.js 的 ACTIONS）。
//     这样动作逻辑只有一份，不会出现「软件内能切歌、全局切歌行为不一样」。
//
// ⚠️ 全局快捷键必须在主进程注册，渲染进程的 keydown 在窗口失焦/隐藏时收不到。
import { computed, ref } from "vue";
import { useConfigStore } from "@/stores/config";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { toastError } from "@/utils/toast";
import {
  eventToAccelerator,
  findConflicts,
  formatAccelerator,
  matchesEvent,
  mergeWithDefaults,
  normalizeAccelerator,
} from "@/utils/shortcuts";

const bridge = () => window.pywebview?.api;

// 正在录制快捷键的动作（{ scope, id } 或 null）。录制期间不执行任何动作，
// 否则用户按 Ctrl+F5 想改键，结果先把歌暂停了。
const recording = ref(null);
// 上次注册全局快捷键的结果：哪些没注册上（被别的程序占用 / 系统不允许）
const globalFailures = ref([]);
let installed = false;

/** 某作用域当前的按键表（用户配置与默认值合并后） */
function useMaps() {
  const config = useConfigStore();
  const inApp = computed(() => mergeWithDefaults(config.shortcuts?.inApp, "inApp"));
  const globalMap = computed(() => mergeWithDefaults(config.shortcuts?.global, "global"));
  return { config, inApp, globalMap };
}

/** 执行一个动作。所有快捷键（软件内 + 全局）最终都走这里。 */
function runAction(id) {
  const player = usePlayerStore();
  const library = useLibraryStore();
  const api = bridge();

  switch (id) {
    case "playPause":
      player.toggle();
      break;
    case "prev":
      player.prev();
      break;
    case "next":
      player.next();
      break;
    case "seekBack":
      player.seek(Math.max(0, player.progress - 5));
      break;
    case "seekForward":
      player.seek(player.progress + 5);
      break;
    case "volumeUp":
      player.setVolume(Math.min(1, Math.round((player.volume + 0.05) * 100) / 100));
      break;
    case "volumeDown":
      player.setVolume(Math.max(0, Math.round((player.volume - 0.05) * 100) / 100));
      break;
    case "mute":
      player.toggleMute();
      break;
    case "favorite":
    case "unfavorite": {
      const song = player.currentSong;
      if (!song) break;
      // 「收藏」和「取消收藏」是两个独立动作，各自只做自己那件事 ——
      // 都用 toggle 的话，已经收藏过的歌再按「收藏」反而会被取消，很反直觉。
      const want = id === "favorite";
      if (!!song.favorite !== want) library.toggleFavorite(song);
      break;
    }
    case "toggleLyrics":
      api?.toggleDesktopLyrics?.();
      break;
    case "lyricsLock":
      api?.toggleLyricsLock?.();
      break;
    case "lyricsTopmost":
      api?.toggleLyricsTopmost?.();
      break;
    case "focusSearch": {
      const focus = () => document.querySelector(".song-search")?.focus();
      if (!document.querySelector(".song-search")) {
        location.hash = "#/songs";
        setTimeout(focus, 300);
      } else {
        focus();
      }
      break;
    }
    case "minimizeRestore":
      api?.minimize?.();
      break;
    case "toggleWindow":
      api?.toggleMainWindow?.();
      break;
    case "quit":
      api?.quitApp?.();
      break;
    default:
      break;
  }
}

/** 把全局快捷键下发给主进程注册，返回没能注册上的那些 */
async function applyGlobal() {
  const { config, globalMap } = useMaps();
  const api = bridge();
  if (!api?.setGlobalShortcuts) return [];
  try {
    const r = await api.setGlobalShortcuts({
      enabled: config.globalHotkeys !== false,
      shortcuts: { ...globalMap.value },
    });
    // 记下「哪个动作的哪个组合」没注册上 —— 只给 id 的话界面没法说清是哪个键冲突
    const map = globalMap.value;
    globalFailures.value = Array.isArray(r?.failed)
      ? r.failed.map((id) => ({ id, acc: map[id] || '' }))
      : [];
  } catch (e) {
    globalFailures.value = [];
    toastError(`全局快捷键注册失败：${e.message}`);
  }
  return globalFailures.value;
}

/** 录制快捷键。传入 null 取消录制。 */
function startRecording(scope, id) {
  recording.value = id ? { scope, id } : null;
}

/** 给某动作写入按键（空串 = 未设置）。会做冲突提示，但不阻止保存。 */
function setAccelerator(scope, id, acc) {
  const { config, inApp, globalMap } = useMaps();
  const norm = normalizeAccelerator(acc);
  const cur = scope === "global" ? globalMap.value : inApp.value;
  const next = { ...cur, [id]: norm };

  const conflicts = findConflicts(next);
  const hit = Object.values(conflicts).find((ids) => ids.includes(id));
  if (hit) {
    const other = hit.find((x) => x !== id);
    toastError(`「${formatAccelerator(norm)}」已经分配给别的动作了（${other}）`);
  }

  const store = config.shortcuts && typeof config.shortcuts === "object" ? config.shortcuts : {};
  config.shortcuts = { inApp: store.inApp || {}, global: store.global || {}, [scope]: next };

  if (scope === "global") applyGlobal();
  return norm;
}

function install() {
  if (installed) return;
  installed = true;

  // ---- 软件内快捷键 ----
  window.addEventListener(
    "keydown",
    (e) => {
      // 录制中：把这次按键吃下来当新键，且不执行任何动作
      if (recording.value) {
        e.preventDefault();
        e.stopPropagation();
        // Esc 取消录制（用户想改主意时不用去点按钮）
        if (e.key === "Escape") {
          recording.value = null;
          return;
        }
        const acc = eventToAccelerator(e);
        // 只按了修饰键（Ctrl/Alt…）不算，继续等真正的主键
        if (!acc) return;
        const { scope, id } = recording.value;
        recording.value = null;
        setAccelerator(scope, id, acc);
        return;
      }

      // 输入框里打字时不抢键 —— 否则「空格暂停」之类会把空格打不进去。
      // 但带修饰键的组合（Ctrl+F5）与功能键（F1）照常生效：那些不会用来打字。
      const t = e.target;
      const typing =
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
      const isFnKey = /^F\d{1,2}$/.test(e.key || "");
      if (typing && !hasModifier && !isFnKey) return;

      const { config, inApp } = useMaps();
      if (config.inAppHotkeys === false) return;
      for (const [id, acc] of Object.entries(inApp.value)) {
        if (!acc) continue;
        if (matchesEvent(acc, e)) {
          e.preventDefault();
          runAction(id);
          return;
        }
      }
    },
    true // 捕获阶段：别被组件里的 stopPropagation 拦掉
  );

  // ---- 全局快捷键：主进程转发过来的动作 ----
  bridge()?.onShortcutAction?.((id) => {
    if (recording.value) return;
    runAction(id);
  });

  // 启动时把已保存的全局快捷键注册上（首次运行时配置为空，用默认值）
  applyGlobal();
}

export function useShortcuts() {
  const { config, inApp, globalMap } = useMaps();
  return {
    recording,
    globalFailures,
    inApp,
    globalMap,
    config,
    install,
    runAction,
    applyGlobal,
    startRecording,
    setAccelerator,
  };
}
