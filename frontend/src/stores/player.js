// playerStore：播放核心引擎。
// 队列播放、播放模式、音量持久化；底层共用 utils/audioElement 的全局 <audio> 实例。
import { defineStore } from "pinia";
import { getAudio } from "@/utils/audioElement";
import {
  resume as resumeAudioFx,
  muteFade,
  fadeIn,
  getLevel,
  isSupported as isAudioFxSupported,
} from "@/utils/audioFx";
import { useConfigStore } from "@/stores/config";
import { useApi } from "@/composables/useApi";
import { getProgress, saveProgress, clearProgress } from "@/utils/playbackProgress";
import { saveLastQueue, loadLastQueue, clearLastQueue } from "@/utils/lastQueue";

// 睡眠定时非响应式计时器句柄（避免进入 Pinia state）
let sleepTimerId = 0;
let sleepAfterTrack = false;
// 静音前记住的上一次非零音量（取消静音时恢复，而不是固定跳到 0.5）
let lastVolume = 0.5;

// 「跳过静音」临时状态（非响应式，避免污染 Pinia state）
let silenceSince = 0; // 连续静音起始时间戳（performance.now），0=未进入静音
let silenceTries = 0; // 本曲已自动跳过的次数（防死循环）

export const usePlayerStore = defineStore("player", {
  persist: ["playMode"], // 仅持久化播放模式；音量统一走 config（持久化）
  state: () => {
    // 音量以 config（持久化）为单一来源，避免底部控制条/设置滑块两套值互相覆盖
    const cfg = useConfigStore();
    return {
      currentSong: null,
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      progress: 0,
      duration: 0,
      volume: Math.min(Math.max(cfg.volume, 0), 1),
      muted: cfg.volume <= 0,
      playMode: "list", // list 列表循环 / single 单曲循环 / shuffle 随机
      fullscreen: false, // 沉浸式全屏播放（左侧封面 / 右侧歌词）
      // ---- 歌词（收拢到 store，主界面与桌面歌词子窗口共用同一份） ----
      lyrics: [], // 解析后的 [{ t: 秒, text }]
      lyricLoading: false,
      // ---- 睡眠定时（null=关闭；{ mode: "track" } 播完本曲停止；{ mode: "minutes", minutes } 限时停止） ----
      sleep: null,
    };
  },

  getters: {
    modeLabel(state) {
      const map = { list: "列表", single: "单曲", shuffle: "随机" };
      return map[state.playMode] || "列表";
    },
    currentTimeText: (state) => formatTime(state.progress),
    durationText: (state) => formatTime(state.duration),
    /** 当前进度对应的高亮歌词行索引（供主界面与桌面歌词共用）。
     *  应用 lyricOffset(ms) 校准：正=歌词提前，负=歌词延后。 */
    activeLyricIndex(state) {
      if (!state.lyrics.length) return -1;
      const offset = useConfigStore().lyricOffset || 0;
      const t = state.progress + offset / 1000;
      let idx = -1;
      for (let i = 0; i < state.lyrics.length; i++) {
        if (t >= state.lyrics[i].t) idx = i;
        else break;
      }
      return idx;
    },
    /** 睡眠定时当前标签（供控制条按钮 title 显示） */
    sleepLabel(state) {
      if (!state.sleep) return "睡眠定时";
      if (state.sleep.mode === "track") return "播完本曲停止";
      return `${state.sleep.minutes} 分钟后停止`;
    },
    /** 是否有正在生效的睡眠定时 */
    sleepActive(state) {
      return !!state.sleep;
    },
  },

  actions: {
    /** 初始化（App 挂载时调用一次）：绑定 audio 事件 */
    init() {
      const audio = getAudio();
      if (audio.__bound) return;
      audio.__bound = true;

      audio.addEventListener("timeupdate", () => {
        this.progress = audio.currentTime;
        this._persistProgress();
        this._maybeSkipSilence();
      });
      audio.addEventListener("loadedmetadata", () => {
        this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      });
      audio.addEventListener("play", () => (this.isPlaying = true));
      audio.addEventListener("pause", () => (this.isPlaying = false));
      audio.addEventListener("ended", () => this._onEnded());

      // 应用记忆的音量
      audio.volume = this.volume;
      audio.muted = this.muted;
      // 应用记忆的播放速度
      audio.playbackRate = useConfigStore().playbackRate || 1;
      // 应用播放增益到音效链路（若链尚未构建，play 时 resume 会解锁）
      useConfigStore().pushAudioFx();
    },

    /** 播放整个队列中的第 index 首 */
    playQueue(list, index = 0) {
      if (!list || !list.length) return;
      this.queue = list;
      this._loadAt(index);
    },

    /** 播放单曲（可选附列表以便 next/prev） */
    playSong(song, list = null) {
      if (!song) return;
      if (list && list.length) {
        const idx = list.findIndex((s) => s.id === song.id);
        this.playQueue(list, idx >= 0 ? idx : 0);
      } else {
        this.currentSong = song;
        this.currentIndex = -1;
        this._registerRecent(song.id);
        this.loadLyrics(song.id);
        this._play();
      }
    },

    /** 记录最近播放（仅在此集中处理，避免多处重复） */
    _registerRecent(songId) {
      if (songId == null) return;
      useConfigStore().pushRecent(songId);
    },

    /** 拉取并解析当前歌曲歌词（写入 store.lyrics，供主界面/桌面歌词共用） */
    async loadLyrics(id) {
      this.lyrics = [];
      if (id == null) return;
      this.lyricLoading = true;
      try {
        const res = await useApi().getLyrics(id);
        this.lyrics = res?.data?.lines ?? [];
      } catch {
        this.lyrics = [];
      } finally {
        this.lyricLoading = false;
      }
    },

    toggle() {
      // 未选歌时 <audio> 无 src，audio.play() 会 reject（NotSupportedError）。直接忽略，避免未处理异常。
      if (!this.currentSong) return;
      const audio = getAudio();
      if (this.isPlaying) audio.pause();
      else audio.play();
    },

    next() {
      if (!this.queue.length) return;
      this._loadAt(this._nextIndex(+1));
    },

    prev() {
      if (!this.queue.length) return;
      this._loadAt(this._nextIndex(-1));
    },

    seek(t) {
      getAudio().currentTime = t;
    },

    setVolume(v) {
      const vol = Math.min(Math.max(v, 0), 1);
      if (vol > 0) lastVolume = vol; // 记住最后一次非零音量，取消静音时恢复
      const audio = getAudio();
      audio.volume = vol;
      audio.muted = vol <= 0;
      this.volume = vol;
      this.muted = vol <= 0;
      // 同步到配置（持久化），保证底部控制条与设置-默认音量是同一份值
      useConfigStore().volume = vol;
    },

    toggleMute() {
      if (this.muted) {
        this.setVolume(lastVolume > 0 ? lastVolume : 0.5);
      } else {
        lastVolume = this.volume > 0 ? this.volume : 0.5;
        this.setVolume(0);
      }
    },

    toggleMode() {
      const modes = ["list", "single", "shuffle"];
      this.playMode = modes[(modes.indexOf(this.playMode) + 1) % modes.length];
    },

    /** 跳转到队列指定位置（队列面板点击） */
    jumpTo(index) {
      if (index >= 0 && index < this.queue.length) {
        this._loadAt(index);
      }
    },

    /** 把歌曲追加到队列末尾（右键「加入队列」） */
    addToQueue(song) {
      if (!song) return;
      this.queue.push(song);
      this._persistQueue();
    },

    /** 歌曲「下一首播放」：插入到当前曲目之后 */
    playNext(song) {
      if (!song) return;
      // 队列为空时先以当前列表建立队列，保证 next/prev 可用
      if (!this.queue.length) {
        this.queue = this.currentSong ? [this.currentSong] : [];
      }
      const at = this.currentIndex >= 0 ? this.currentIndex + 1 : this.queue.length;
      this.queue.splice(at, 0, song);
      this._persistQueue();
    },

    /** 移除队列中第 index 首（队列面板） */
    removeFromQueue(index) {
      if (index < 0 || index >= this.queue.length) return;
      if (index === this.currentIndex) {
        // 移除当前播放项 → 播放同位置下一首（或空结束）
        this.queue.splice(index, 1);
        if (this.queue.length) {
          this._loadAt(Math.min(index, this.queue.length - 1));
        } else {
          getAudio().pause();
          this.currentSong = null;
          this.currentIndex = -1;
          this.isPlaying = false;
          this.progress = 0;
          this.duration = 0;
          this.lyrics = [];
        }
        this._persistQueue();
        return;
      }
      this.queue.splice(index, 1);
      if (this.currentIndex > index) this.currentIndex--;
      this._persistQueue();
    },

    /** 清空队列并停止播放（队列面板） */
    clearQueue() {
      getAudio().pause();
      this.queue = [];
      this.currentSong = null;
      this.currentIndex = -1;
      this.isPlaying = false;
      this.progress = 0;
      this.duration = 0;
      this.lyrics = [];
      clearLastQueue();
    },

    /** 设置播放速度（语速），并持久化到配置，供下次启动复用 */
    setPlaybackRate(v) {
      const rate = Math.min(Math.max(Number(v) || 1, 0.25), 3);
      getAudio().playbackRate = rate;
      useConfigStore().playbackRate = rate;
    },

    openFullscreen() {
      this.fullscreen = true;
      this._setNativeFullscreen(true);
    },
    closeFullscreen() {
      this.fullscreen = false;
      this._setNativeFullscreen(false);
    },
    toggleFullscreen() {
      this.fullscreen = !this.fullscreen;
      this._setNativeFullscreen(this.fullscreen);
    },
    /** 沉浸全屏时同步 Electron 原生全屏：覆盖任务栏，并在拖动标题时保持窗口不内缩 */
    _setNativeFullscreen(v) {
      const api = window.pywebview?.api;
      if (api && typeof api.setFullscreen === "function") {
        try {
          api.setFullscreen(!!v);
        } catch {
          /* 纯浏览器环境忽略 */
        }
      }
    },

    /** 加载并播放队列 index */
    _loadAt(index) {
      const song = this.queue[index];
      if (!song) {
        getAudio().pause();
        this.currentSong = null;
        this.isPlaying = false;
        return;
      }
      this.currentSong = song;
      this.currentIndex = index;
      this.progress = 0;
      this.duration = 0;
      this._registerRecent(song.id);
      this.loadLyrics(song.id);
      this._play();
      this._persistQueue();
    },

    /** 触发真正播放 */
    _play() {
      const audio = getAudio();
      if (this.currentSong && this.currentSong.id != null) {
        resumeAudioFx(); // 用户手势内解锁 AudioContext，确保音效链路输出
        const cfg = useConfigStore();
        silenceSince = 0;
        silenceTries = 0;
        // 上报播放统计（同曲 5s 内后端去重），供播放统计页聚合
        useApi().recordPlay(this.currentSong.id).catch(() => {});
        audio.src = `/stream/${this.currentSong.id}`;
        // 切歌淡入淡出：先瞬间静音旧残响，播放新歌再平滑淡入（避免倍速/切歌爆音）
        if (cfg.crossfade) {
          muteFade();
          audio.play();
          fadeIn(cfg.crossfadeDuration || 0.6);
        } else {
          audio.play();
        }
        // 仅"启动续播"恢复该首历史进度（_pendingRestore 由启动流程置位并消费一次）；
        // 手动切歌 / 自动下一首 / 点选歌曲一律从头播放，避免从上次进度跳到中途
        if (this._pendingRestore) {
          this._pendingRestore = false;
          this._restoreProgress(this.currentSong.id);
        }
      }
    },

    /** 把当前歌曲进度持久化（节流到整秒；临近结尾不记，避免“播完还残留断点”） */
    _persistProgress() {
      const song = this.currentSong;
      if (!song || song.id == null) return;
      const audio = getAudio();
      const t = audio.currentTime;
      if (!Number.isFinite(t) || t <= 0) return;
      if (this.duration > 0 && t >= this.duration - 4) return; // 已近结尾，视为将播完
      saveProgress(song.id, t);
    },

    /** 跳过静音：持续静音超过阈值时自动前跳，避免长时间空白。
     *  仅在支持电平检测(音效链路已构建)且用户开启 skipSilence 时生效。
     *  同一曲最多尝试 12 次，防止在真正安静的长前奏里来回跳（死循环）。 */
    _maybeSkipSilence() {
      const cfg = useConfigStore();
      if (!cfg.skipSilence || !isAudioFxSupported()) return;
      const audio = getAudio();
      if (audio.paused || !this.isPlaying) return;
      const dur = this.duration;
      const t = audio.currentTime;
      if (!Number.isFinite(t) || !Number.isFinite(dur) || dur <= 0) return;
      if (t >= dur - 0.5 || silenceTries >= 12) return;
      const level = getLevel();
      const now = performance.now();
      if (level < 0.004) {
        if (!silenceSince) silenceSince = now;
        else if (now - silenceSince > 5000) {
          const target = Math.min(dur - 0.3, t + 3);
          audio.currentTime = target;
          silenceTries += 1;
          silenceSince = 0;
        }
      } else {
        silenceSince = 0;
      }
    },

    /** 恢复某首歌曲上次的进度（精确到秒）。需在 audio.src 变更后调用。 */
    _restoreProgress(songId) {
      const saved = getProgress(songId);
      if (!saved || saved < 1) return;
      const audio = getAudio();
      const doSeek = () => {
        // 快速切歌时防止把进度跳到错误的歌
        if (this.currentSong?.id !== songId) return;
        const dur = this.duration || audio.duration || 0;
        // 预留 0.3s，避免 seek 到末尾直接触发 ended
        const target = dur > 0 ? Math.min(saved, Math.max(0, dur - 0.3)) : saved;
        if (target > 0) audio.currentTime = target;
      };
      if (audio.readyState >= 1) {
        doSeek();
      } else {
        audio.addEventListener("loadedmetadata", doSeek, { once: true });
      }
    },

    /** 持久化「上次播放队列」快照（启动时可恢复队列与当前位置） */
    _persistQueue() {
      saveLastQueue({
        queueIds: this.queue.map((s) => s.id).filter((id) => id != null),
        currentIndex: this.currentIndex,
        currentSongId: this.currentSong?.id ?? null,
      });
    },

    /** 启动时恢复上次队列：把持久化的歌曲 id 序列映射回曲库实体。
     *  命中歌曲尽数保留；当前索引越界时收拢到末尾。 */
    restoreQueue(songs) {
      const saved = loadLastQueue();
      if (!saved || !Array.isArray(saved.queueIds) || !saved.queueIds.length) return false;
      const map = new Map((songs || []).map((s) => [s.id, s]));
      const restored = saved.queueIds.map((id) => map.get(id)).filter(Boolean);
      if (!restored.length) return false;
      this.queue = restored;
      let idx = saved.currentIndex;
      if (!Number.isInteger(idx) || idx < 0) idx = 0;
      if (idx >= restored.length) idx = restored.length - 1;
      this.currentIndex = idx;
      this.currentSong = restored[idx];
      return true;
    },

    /** 设置睡眠定时。opt 为空/关 => 关闭；{ mode: "track" } 播完本曲停止；{ mode: "minutes", minutes } 限时停止。 */
    setSleep(opt) {
      this._clearSleep();
      if (!opt) return;
      if (opt.mode === "track") {
        sleepAfterTrack = true;
        this.sleep = { mode: "track" };
      } else if (opt.mode === "minutes") {
        const minutes = Math.max(1, Math.min(Number(opt.minutes) || 15, 180));
        this.sleep = { mode: "minutes", minutes };
        sleepTimerId = setTimeout(() => this._triggerSleep(), minutes * 60 * 1000);
      }
    },

    /** 关闭当前睡眠定时 */
    _clearSleep() {
      if (sleepTimerId) {
        clearTimeout(sleepTimerId);
        sleepTimerId = 0;
      }
      sleepAfterTrack = false;
      this.sleep = null;
    },

    /** 睡眠定时到点：暂停播放并清除计时器 */
    _triggerSleep() {
      getAudio().pause();
      this._clearSleep();
    },

    /** 按下个曲目标 index（按播放模式） */
    _nextIndex(step) {
      const len = this.queue.length;
      if (!len) return -1;
      if (this.playMode === "shuffle") {
        if (len <= 1) return this.currentIndex;
        // 随机但不重复当前曲目，避免 shuffle 时"下一首"又抽回同一首
        let r;
        do {
          r = Math.floor(Math.random() * len);
        } while (r === this.currentIndex);
        return r;
      }
      return (this.currentIndex + step + len) % len;
    },

    /** 播放结束处理 */
    _onEnded() {
      if (this.currentSong) clearProgress(this.currentSong.id);
      // 睡眠定时「播完本曲停止」：停止播放，不再自动切下一首
      if (sleepAfterTrack) {
        getAudio().pause();
        this._clearSleep();
        return;
      }
      if (this.playMode === "single") {
        const audio = getAudio();
        audio.currentTime = 0;
        audio.play();
      } else if (this.queue.length) {
        const config = useConfigStore();
        if (config.autoplayNext) this._loadAt(this._nextIndex(+1));
      }
    },
  },
});

/** 秒 → mm:ss */
function formatTime(sec) {
  if (!sec || !Number.isFinite(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
