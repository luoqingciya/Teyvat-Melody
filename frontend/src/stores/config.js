// configStore：用户配置（默认持久化到 localStorage）。
import { defineStore } from "pinia";
import { ensure as ensureAudioFx } from "@/utils/audioFx";

export const useConfigStore = defineStore("config", {
  persist: true, // Pinia 持久化插件：主题 / 窗口尺寸 / 最近播放 / 自定义配置
  state: () => ({
    theme: "mondstadt", // mondstadt 蒙德 / liyue 璃月 / inazuma 稻妻
    language: "zh", // 界面语言：zh 中文 / en English
    recentSongs: [],
    // ---- 自定义设置 ----
    playMode: "list", // 默认播放模式：list 列表循环 / single 单曲循环 / shuffle 随机
    volume: 0.8, // 默认音量（0~1）
    autoplayNext: true, // 播完自动切下一首
    startupResume: false, // 启动时自动继续播放最近一首
    resumeQueue: true, // 启动时恢复上次播放队列与当前位置（需 startupResume 开启才自动播放）
    playbackRate: 1, // 播放速度（0.5/0.75/1/1.25/1.5/2），默认 1 倍速
    glassFx: true, // 整体玻璃（毛玻璃）质感开关
    hidePlaylistBanners: false, // 预留
    // ---- 全屏播放页字体 ----
    fsFontFamily: "", // 空表示跟随系统默认（或界面字体）
    fsFontSize: 16, // 歌词基准字号（px）
    // ---- 桌面歌词颜色 ----
    dlTextColor: "#FFFFFF", // 普通歌词（下一行/非高亮行）颜色
    dlActiveColor: "#20D9D0", // 当前行/高亮行歌词颜色（酷狗式青绿，透明背景上醒目）
    // ---- 桌面歌词外观 ----
    dlFontSize: 24, // 横版当前行字号（竖排按比例缩小）
    dlFontFamily: "Microsoft YaHei", // 桌面歌词字体（系统字体名）
    dlBgMode: "card", // transparent 全透明 / card 深色卡片（默认卡片，仿 QQ/网易云）
    // ---- 桌面歌词渲染模式 ----
    dlKaraokeMode: "line", // line 整行高亮（默认）/ karaoke 逐字卡拉OK
    dlLineMode: "dual", // single 单行 / dual 双行（当前行+下一句/翻译）/ multi 多行
    dlShowProgress: true, // 是否显示桌面歌词进度条
    lyricOffset: 0, // 歌词偏移校准（毫秒，正=歌词提前，负=歌词延后）
    showTranslation: true, // 翻译/双语歌词：显示主歌词后的翻译/副歌词行
    // ---- 界面字体（系统字体 / 自定义字体文件） ----
    uiFontFamily: "", // 空表示跟随系统默认；否则为 CSS font-family 值（含引号与回退）
    customFonts: [], // [{ id, family, label, url }] 已上传字体（url 指向 /fonts/...，可跨会话复用）
    // ---- 音效（Web Audio 均衡器 + 预设） ----
    audioFxEnabled: false, // 音效总开关
    eqPreset: "off", // 当前预设：off/flat/bass/vocal/live/game/classic/pop/custom
    eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 10 段自定义增益（dB）
    globalHotkeys: false, // 系统级全局快捷键（后台/最小化时可遥控播放）
    songNotification: false, // 切歌系统通知
    // ---- 进阶功能 ----
    crossfade: false, // 切歌淡入淡出（短促交叉过渡）
    crossfadeDuration: 0.6, // 淡入淡出时长（秒）
    skipSilence: false, // 跳过静音（自动探测静音段并前跳）
    volumeGain: 0, // 播放增益（dB，-12~12，轻量响度归一）
    accentColor: "", // 自定义主题主色（空=跟随当前主题默认金色）
    accentLinkTheme: true, // 主题主色联动：切换主题时清空自定义主色，使主色跟随新主题
    uiScale: 1, // 界面缩放（0.8~1.3）
    uiBaseFontSize: 14, // 界面基准字号（px，12~18）
  }),
  actions: {
    setTheme(theme) {
      this.theme = theme;
      // 主题主色联动开启时，切主题自动清空自定义主色（主色跟随新主题默认金色）
      if (this.accentLinkTheme && this.accentColor) {
        const el = document.documentElement;
        el.style.removeProperty("--teyvat-gold");
        this.accentColor = "";
      }
      // 通过 <html data-theme> 属性切换：三套主题 CSS 均已静态载入，可无限循环切换
      const el = document.documentElement;
      if (theme === "mondstadt") {
        el.removeAttribute("data-theme");
      } else {
        el.setAttribute("data-theme", theme);
      }
    },
    /** 启动时应用已持久化的主题（历史会话可能是非默认主题） */
    applyTheme() {
      this.setTheme(this.theme);
    },
    /** 玻璃质感开关：关闭时给 <html> 加 glass-off，由全局 CSS 统一移除 backdrop-filter */
    setGlassFx(v) {
      this.glassFx = !!v;
      document.documentElement.classList.toggle("glass-off", !this.glassFx);
    },
    /** 启动时应用持久化的玻璃设置 */
    applyGlassFx() {
      this.setGlassFx(this.glassFx);
    },
    pushRecent(songId) {
      this.recentSongs = [songId, ...this.recentSongs.filter((id) => id !== songId)];
      this.recentSongs = this.recentSongs.slice(0, 50);
    },
    /** 把当前音效状态推送到 Web Audio 链路（供 FxPanel 与启动时调用）。 */
    pushAudioFx() {
      ensureAudioFx({
        enabled: this.audioFxEnabled,
        preset: this.eqPreset,
        bands: this.eqBands,
        gain: this.volumeGain,
      });
    },
    /** 设置自定义主题主色：空串 = 恢复跟随当前主题默认金色。
     *  inline 样式比任何 `:root` 声明优先级更高，可直接覆盖三套主题的 --teyvat-gold。 */
    setAccent(color) {
      this.accentColor = color || "";
      const el = document.documentElement;
      if (color) el.style.setProperty("--teyvat-gold", color);
      else el.style.removeProperty("--teyvat-gold");
    },
    /** 启动时应用已持久化的主题主色 */
    applyAccent() {
      this.setAccent(this.accentColor);
    },
    /** 应用界面缩放与基准字号（用 Chromium 的 zoom 缩放整体布局，字号覆盖根字体）。 */
    setUiPrefs() {
      const el = document.documentElement;
      el.style.zoom = String(this.uiScale);
      el.style.fontSize = `${this.uiBaseFontSize}px`;
    },
    /** 启动时应用持久化的界面缩放 */
    applyUiPrefs() {
      this.setUiPrefs();
    },
    /** 恢复默认设置：重置所有用户可调项为初始值，并即时重应用外观/音效/主色。
     *  保留 recentSongs（最近播放）等应用态。 */
    resetDefaults() {
      const d = {
        theme: "mondstadt",
        language: "zh",
        playMode: "list",
        volume: 0.8,
        autoplayNext: true,
        startupResume: false,
        resumeQueue: true,
        playbackRate: 1,
        glassFx: true,
        hidePlaylistBanners: false,
        fsFontFamily: "",
        fsFontSize: 16,
        dlTextColor: "#FFFFFF",
        dlActiveColor: "#20D9D0",
        dlFontSize: 24,
        dlFontFamily: "Microsoft YaHei",
        dlBgMode: "card",
        dlKaraokeMode: "line",
        dlLineMode: "dual",
        dlShowProgress: true,
        lyricOffset: 0,
        showTranslation: true,
        uiFontFamily: "",
        customFonts: [],
        audioFxEnabled: false,
        eqPreset: "off",
        eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        globalHotkeys: false,
        songNotification: false,
        crossfade: false,
        crossfadeDuration: 0.6,
        skipSilence: false,
        volumeGain: 0,
        accentColor: "",
        accentLinkTheme: true,
        uiScale: 1,
        uiBaseFontSize: 14,
      };
      Object.assign(this, d);
      this.applyTheme();
      this.applyGlassFx();
      this.setAccent(this.accentColor);
      this.applyUiPrefs();
      this.pushAudioFx();
    },
  },
});
