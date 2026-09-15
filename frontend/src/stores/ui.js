// uiStore：**跨组件的界面意图**（不是业务数据，不持久化）。
//
// 为什么需要它：空状态引导卡片要能"替用户点下一步" —— 比如"打开设置里的音源管理"、
// "把光标送到左侧扫描输入框"。但设置弹窗的开关原本是 TheHeader 里的一个局部 ref、
// 扫描输入框在 Sidebar 里，空状态卡片在 SongList / OnlineSearchView 里 ——
// 三者互不相识。与其层层透传 props/事件，不如把这类**瞬时的界面意图**集中放这里：
// 谁想发起，谁就灌一个标记；谁负责那块 UI，谁就监听并消费它。
//
// ⚠️ 这里只放"意图"，不放业务状态（曲库、播放、歌单属于各自的 store）。
// ⚠️ 不持久化：这些标记是"这次要点开哪个面板"，重启后再留着只会莫名其妙地弹窗。
import { defineStore } from "pinia";

export const useUiStore = defineStore("ui", {
  state: () => ({
    /**
     * 设置弹窗要打开的**分类键**。null = 不请求打开。
     * 由空状态卡片写入（如 "online" 引导用户去导入音源）。
     * 消费方：TheHeader 监听它并打开 SettingsModal，然后调 clearSettingsRequest()。
     */
    requestedSettingsTab: null,
    /**
     * 请求把焦点送到「扫描音乐库」的输入框（空状态卡片 → Sidebar）。
     * 用一个自增计数而不是布尔值：连点两次也要能再次触发（布尔值第二次没变化就无效）。
     */
    focusScanInput: 0,
  }),
  actions: {
    /** 请求打开设置弹窗并切到指定分类（如 "online"）。 */
    openSettings(tab = "playback") {
      this.requestedSettingsTab = tab;
    },
    /** 消费完请求后清掉，避免下次打开设置时被上次的请求覆盖。 */
    clearSettingsRequest() {
      this.requestedSettingsTab = null;
    },
    /** 请求把焦点送到侧栏扫描输入框。 */
    requestFocusScanInput() {
      this.focusScanInput += 1;
    },
  },
});
