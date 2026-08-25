<template>
  <footer class="player-controls">
    <!-- 起止控制 -->
    <div class="pc-left">
      <button class="pc-btn" :title="t('player.prev')" :aria-label="t('player.prev')" @click="player.prev()"><AppIcon name="prev" :size="18" /></button>
      <PlayButton />
      <button class="pc-btn" :title="t('player.next')" :aria-label="t('player.next')" @click="player.next()"><AppIcon name="next" :size="18" /></button>
    </div>

    <!-- 当前歌曲 -->
    <div class="pc-now">
      <span class="pc-now__title">{{ player.currentSong?.title || t("player.nowPlaying") }}</span>
      <span class="pc-now__artist">{{ player.currentSong?.artist || "" }}</span>
    </div>

    <!-- 进度与时间 -->
    <div class="pc-progress">
      <TimeDisplay :time="player.currentTimeText" />
      <ProgressBar :value="player.progress" :max="player.duration" @seek="player.seek" />
      <TimeDisplay :time="player.durationText" />
    </div>

    <!-- 播放模式 + 音量 -->
    <div class="pc-right">
      <div class="pc-queue">
        <button
          class="pc-btn pc-btn--toggle"
          :class="{ 'pc-btn--active': showQueue }"
          :title="t('player.queue', { n: player.queue.length })"
          :aria-label="t('player.queue', { n: player.queue.length })"
          :aria-pressed="showQueue"
          @click="showQueue = !showQueue"
        >
          <AppIcon name="queue" :size="18" />
        </button>
        <QueuePanel v-if="showQueue" class="pc-queue__pop" />
      </div>
      <div class="pc-sleep">
        <button
          class="pc-btn pc-btn--toggle"
          :class="{ 'pc-btn--active': showSleep }"
          :title="player.sleepLabel"
          :aria-label="player.sleepLabel"
          :aria-pressed="player.sleepActive"
          @click="showSleep = !showSleep"
        >
          <AppIcon :name="player.sleepActive ? 'moon-pause' : 'moon'" :size="18" />
        </button>
        <SleepTimerPanel v-if="showSleep" class="pc-sleep__pop" />
      </div>
      <div class="pc-fx">
        <button
          class="pc-btn pc-btn--toggle"
          :class="{ 'pc-btn--active': config.audioFxEnabled }"
          :title="t('player.fx')"
          :aria-label="t('player.fx')"
          :aria-pressed="config.audioFxEnabled"
          @click="showFx = !showFx"
        >
          <AppIcon name="equalizer" :size="18" />
        </button>
        <FxPanel v-if="showFx" class="pc-fx__pop" />
      </div>
      <button class="pc-btn" :title="t('player.fullscreen')" :aria-label="t('player.fullscreen')" @click="player.toggleFullscreen()">
        <AppIcon name="maximize" :size="18" />
      </button>
      <button
        class="pc-btn pc-btn--toggle"
        :class="{ 'pc-btn--active': desktopOn }"
        :title="t('player.desktopLyrics')"
        :aria-label="t('player.desktopLyrics')"
        :aria-pressed="desktopOn"
        @click="toggleDesktop"
      >
        <AppIcon name="desktop-text" :size="18" />
      </button>
      <button
        class="pc-btn pc-btn--toggle"
        :class="{ 'pc-btn--active': miniOn }"
        :title="t('player.miniMode')"
        :aria-label="t('player.miniMode')"
        :aria-pressed="miniOn"
        @click="toggleMini"
      >
        <AppIcon name="mini" :size="18" />
      </button>
      <button class="pc-btn pc-btn--mode" :title="t('player.mode', { m: player.modeLabel })" :aria-label="t('player.mode', { m: player.modeLabel })" @click="player.toggleMode()">
        <AppIcon :name="modeIcon" :size="18" />
      </button>
      <div class="pc-speed">
        <button
          class="pc-btn pc-btn--speed"
          :title="t('player.speed')"
          :aria-label="t('player.speed')"
          :aria-haspopup="true"
          :aria-expanded="speedOpen"
          @click="speedOpen = !speedOpen"
        >
          {{ speedLabel }}
        </button>
        <div v-if="speedOpen" class="pc-speed__menu">
          <button
            v-for="s in SPEEDS"
            :key="s"
            class="pc-speed__opt"
            :class="{ 'pc-speed__opt--on': Math.abs((config.playbackRate || 1) - s) < 0.01 }"
            @click="chooseSpeed(s)"
          >
            {{ s }}x
          </button>
        </div>
      </div>
      <VolumeControl />
    </div>
  </footer>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import PlayButton from "./PlayButton.vue";
import TimeDisplay from "./TimeDisplay.vue";
import ProgressBar from "./ProgressBar.vue";
import VolumeControl from "./VolumeControl.vue";
import FxPanel from "./FxPanel.vue";
import QueuePanel from "./QueuePanel.vue";
import SleepTimerPanel from "./SleepTimerPanel.vue";
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";
import { useI18n } from "@/utils/i18n";

const player = usePlayerStore();
const config = useConfigStore();
const { t } = useI18n();

const showFx = ref(false);
const showQueue = ref(false);
const showSleep = ref(false);

// 点击面板外部关闭音效 / 队列 / 睡眠定时 / 倍速面板
function onDocClick(e) {
  if (showFx.value && !e.target.closest(".pc-fx")) {
    showFx.value = false;
  }
  if (showQueue.value && !e.target.closest(".pc-queue")) {
    showQueue.value = false;
  }
  if (showSleep.value && !e.target.closest(".pc-sleep")) {
    showSleep.value = false;
  }
  if (speedOpen.value && !e.target.closest(".pc-speed")) {
    speedOpen.value = false;
  }
}

// 播放模式图标
const modeIcon = computed(() => {
  const map = { list: "loop", single: "repeat-one", shuffle: "shuffle" };
  return map[player.playMode] || "loop";
});

// 播放速度（语速）：点击按钮弹出档位列表供选择并持久化
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedLabel = computed(() => `${config.playbackRate || 1}x`);
const speedOpen = ref(false);
function chooseSpeed(s) {
  player.setPlaybackRate(s);
  speedOpen.value = false;
}

// 桌面歌词：切换独立置顶透明窗口
const desktopOn = ref(false);
let unsubLyricsVis = null;

function toggleDesktop() {
  const api = window.pywebview?.api;
  if (!api || typeof api.toggleDesktopLyrics !== "function") {
    console.warn("当前环境不支持桌面歌词窗口");
    return;
  }
  Promise.resolve(api.toggleDesktopLyrics()).then((r) => {
    if (r && typeof r.visible === "boolean") desktopOn.value = r.visible;
  });
}

// 歌词窗口的 ✕ 关闭 / 托盘开关会广播可见性变化，同步主界面开关状态
function bindLyricsVisibility() {
  const api = window.pywebview?.api;
  if (!api || typeof api.onLyricsVisibility !== "function") return;
  unsubLyricsVis = api.onLyricsVisibility((v) => {
    desktopOn.value = !!v;
  });
  if (typeof api.getLyricsState === "function") {
    Promise.resolve(api.getLyricsState())
      .then((s) => {
        if (s && typeof s.visible === "boolean") desktopOn.value = s.visible;
      })
      .catch(() => {});
  }
}

// 迷你模式：切换置顶小窗播放器
const miniOn = ref(false);
let unsubMiniVis = null;

function toggleMini() {
  const api = window.pywebview?.api;
  if (!api || typeof api.toggleMini !== "function") {
    console.warn("当前环境不支持迷你模式窗口");
    return;
  }
  Promise.resolve(api.toggleMini()).then((r) => {
    if (r && typeof r.visible === "boolean") miniOn.value = r.visible;
  });
}

function bindMiniVisibility() {
  const api = window.pywebview?.api;
  if (!api || typeof api.onMiniVisibility !== "function") return;
  unsubMiniVis = api.onMiniVisibility((v) => {
    miniOn.value = !!v;
  });
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  bindLyricsVisibility();
  bindMiniVisibility();
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  unsubLyricsVis?.();
  unsubMiniVis?.();
});
</script>

<style scoped>
.player-controls {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 10px var(--space-4);
  min-height: 64px;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--teyvat-bg-dark) 46%, transparent);
  border-top: 1px solid var(--teyvat-card-border);
  backdrop-filter: blur(var(--blur-header)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--blur-header)) saturate(150%);
}

.pc-left,
.pc-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.pc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  font-size: 16px;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background var(--t-fast), color var(--t-fast), transform var(--t-fast);
}
.pc-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--teyvat-text-primary);
}
.pc-btn:active {
  transform: scale(0.92);
}
.pc-btn--toggle.pc-btn--active {
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 14%, transparent);
}
.pc-btn--mode {
  color: var(--teyvat-gold);
}
.pc-btn--speed {
  min-width: 46px;
  width: auto;
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.5px;
  color: var(--teyvat-text-secondary);
}
.pc-btn--speed:hover {
  color: var(--teyvat-gold);
}

.pc-queue,
.pc-sleep,
.pc-fx,
.pc-speed {
  position: relative;
  display: inline-flex;
}
.pc-queue__pop,
.pc-sleep__pop,
.pc-fx__pop,
.pc-speed__menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 600;
}

.pc-speed__menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 24%, var(--teyvat-bg-dark) 76%);
  box-shadow: var(--shadow-pop);
  backdrop-filter: blur(var(--blur-overlay));
}
.pc-speed__opt {
  min-width: 72px;
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--teyvat-text-primary);
  font-size: 12px;
  text-align: center;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.pc-speed__opt:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--teyvat-gold);
}
.pc-speed__opt--on {
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
}

.pc-now {
  display: flex;
  flex-direction: column;
  min-width: 150px;
  overflow: hidden;
}
.pc-now__title {
  font-size: 13px;
  color: var(--teyvat-text-primary);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-now__artist {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc-progress {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 960px) {
  .pc-now {
    display: none;
  }
}
@media (max-width: 760px) {
  .player-controls {
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .pc-right {
    gap: var(--space-1);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}
</style>
