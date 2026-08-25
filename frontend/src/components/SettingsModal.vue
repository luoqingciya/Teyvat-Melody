<template>
  <AppModal
    :model-value="modelValue"
    :title="t('header.settings')"
    :confirm-text="t('settings.done')"
    :width="540"
    :mask-closable="false"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="emit('update:modelValue', false)"
  >
    <div class="settings">
      <div class="settings__group">
        <h4 class="settings__label">{{ t("settings.playback") }}</h4>

        <label class="settings__row">
          <span>{{ t("settings.playMode") }}</span>
          <select v-model="player.playMode" class="settings__select ui-select">
            <option value="list">{{ t("settings.modeList") }}</option>
            <option value="single">{{ t("settings.modeSingle") }}</option>
            <option value="shuffle">{{ t("settings.modeShuffle") }}</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.speed") }}</span>
          <select v-model="config.playbackRate" class="settings__select ui-select" @change="applyPlaybackRate">
            <option v-for="r in SPEEDS" :key="r" :value="r">{{ r }}x</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.volume", { p: Math.round(config.volume * 100) }) }}</span>
          <input
            v-model.number="config.volume"
            class="settings__range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            @input="applyVolume"
          />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.autoplayNext") }}</span>
          <input v-model="config.autoplayNext" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.startupResume") }}</span>
          <input v-model="config.startupResume" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.resumeQueue") }}</span>
          <input v-model="config.resumeQueue" class="settings__switch" type="checkbox" :disabled="!config.startupResume" />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.globalHotkeys") }}</span>
          <input v-model="config.globalHotkeys" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.songNotification") }}</span>
          <input v-model="config.songNotification" class="settings__switch" type="checkbox" />
        </label>
      </div>

      <div class="settings__group">
        <h4 class="settings__label">{{ t("settings.advanced") }}</h4>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.crossfade") }}</span>
          <input v-model="config.crossfade" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row">
          <span>{{ config.crossfade ? t("settings.crossfadeDuration", { s: config.crossfadeDuration }) : t("settings.crossfade") }}</span>
          <input
            v-model.number="config.crossfadeDuration"
            class="settings__range"
            type="range"
            min="0.2"
            max="3"
            step="0.1"
            :disabled="!config.crossfade"
          />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.skipSilence") }}</span>
          <input v-model="config.skipSilence" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row">
          <span>{{ t("settings.volumeGain", { v: (config.volumeGain >= 0 ? "+" : "") + config.volumeGain }) }}</span>
          <input
            v-model.number="config.volumeGain"
            class="settings__range"
            type="range"
            min="-12"
            max="12"
            step="1"
            @change="config.pushAudioFx()"
          />
        </label>
      </div>

      <div class="settings__group">
        <h4 class="settings__label">{{ t("settings.appearance") }}</h4>
        <label class="settings__row">
          <span>{{ t("settings.language") }}</span>
          <select v-model="config.language" class="settings__select ui-select">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.theme") }}</span>
          <div class="settings__themes">
            <button
              v-for="th in themes"
              :key="th.key"
              class="settings__theme"
              :class="{ 'settings__theme--on': config.theme === th.key }"
              :title="t('theme.' + th.key)"
              :aria-label="t('theme.' + th.key)"
              :aria-pressed="config.theme === th.key"
              @click="config.setTheme(th.key)"
            >
              <AppIcon :name="th.icon" :size="16" />
            </button>
          </div>
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.glassFx") }}</span>
          <input
            v-model="config.glassFx"
            class="settings__switch"
            type="checkbox"
            @change="config.setGlassFx(config.glassFx)"
          />
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.accentLink") }}</span>
          <input v-model="config.accentLinkTheme" class="settings__switch" type="checkbox" />
        </label>

        <div class="settings__row settings__row--col">
          <span>{{ t("settings.accentColor") }}</span>
          <div class="settings__colors">
            <label class="settings__color">
              <span>{{ t("settings.accentCustom") }}</span>
              <input
                type="color"
                class="settings__colorpicker"
                :value="config.accentColor || defaultAccent"
                @input="config.setAccent($event.target.value)"
              />
            </label>
            <button
              v-if="config.accentColor"
              class="settings__accent-reset"
              :title="t('settings.accentReset')"
              :aria-label="t('settings.accentReset')"
              @click="config.setAccent('')"
            >
              {{ t("settings.accentReset") }}
            </button>
          </div>
        </div>

        <label class="settings__row">
          <span>{{ t("settings.uiScale", { p: Math.round(config.uiScale * 100) }) }}</span>
          <input
            v-model.number="config.uiScale"
            class="settings__range"
            type="range"
            min="0.8"
            max="1.3"
            step="0.05"
            @change="config.setUiPrefs()"
          />
        </label>

        <label class="settings__row">
          <span>{{ t("settings.uiBaseFontSize", { d: config.uiBaseFontSize }) }}</span>
          <input
            v-model.number="config.uiBaseFontSize"
            class="settings__range"
            type="range"
            min="12"
            max="18"
            step="1"
            @change="config.setUiPrefs()"
          />
        </label>
      </div>

      <div class="settings__group">
        <h4 class="settings__label">{{ t("settings.lyrics") }}</h4>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.showTranslation") }}</span>
          <input v-model="config.showTranslation" class="settings__switch" type="checkbox" />
        </label>

        <label class="settings__row">
          <span>{{ t("settings.fsFontSize", { d: config.fsFontSize }) }}</span>
          <input
            v-model.number="config.fsFontSize"
            class="settings__range"
            type="range"
            min="12"
            max="32"
            step="1"
          />
        </label>

        <div class="settings__row settings__row--col">
          <span>{{ t("settings.dlColors") }}</span>
          <div class="settings__colors">
            <label class="settings__color">
              <span>{{ t("settings.dlActive") }}</span>
              <input v-model="config.dlActiveColor" type="color" class="settings__colorpicker" />
            </label>
            <label class="settings__color">
              <span>{{ t("settings.dlNormal") }}</span>
              <input v-model="config.dlTextColor" type="color" class="settings__colorpicker" />
            </label>
          </div>
        </div>

        <label class="settings__row">
          <span>{{ t("settings.dlFontSize", { d: config.dlFontSize }) }}</span>
          <input
            v-model.number="config.dlFontSize"
            class="settings__range"
            type="range"
            min="16"
            max="40"
            step="1"
          />
        </label>

        <label class="settings__row">
          <span>{{ t("settings.dlFontFamily") }}</span>
          <select v-model="config.dlFontFamily" class="settings__select ui-select">
            <option value="Microsoft YaHei">微软雅黑</option>
            <option value="SimSun">宋体</option>
            <option value="KaiTi">楷体</option>
            <option value="SimHei">黑体</option>
            <option value="FangSong">仿宋</option>
            <option value="Consolas">Consolas（等宽）</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.dlBgMode") }}</span>
          <select v-model="config.dlBgMode" class="settings__select ui-select">
            <option value="transparent">{{ t("settings.dlBgTransparent") }}</option>
            <option value="card">{{ t("settings.dlBgCard") }}</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.lyricOffset", { ms: config.lyricOffset }) }}</span>
          <input
            v-model.number="config.lyricOffset"
            class="settings__range"
            type="range"
            min="-1000"
            max="1000"
            step="50"
          />
        </label>

        <label class="settings__row">
          <span>{{ t("settings.dlKaraoke") }}</span>
          <select v-model="config.dlKaraokeMode" class="settings__select ui-select">
            <option value="line">{{ t("settings.dlKaraokeLine") }}</option>
            <option value="karaoke">{{ t("settings.dlKaraokeWord") }}</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.dlLine") }}</span>
          <select v-model="config.dlLineMode" class="settings__select ui-select">
            <option value="single">{{ t("settings.dlLineSingle") }}</option>
            <option value="dual">{{ t("settings.dlLineDual") }}</option>
            <option value="multi">{{ t("settings.dlLineMulti") }}</option>
          </select>
        </label>

        <label class="settings__row settings__row--switch">
          <span>{{ t("settings.dlShowProgress") }}</span>
          <input v-model="config.dlShowProgress" class="settings__switch" type="checkbox" />
        </label>
      </div>

      <div class="settings__group">
        <h4 class="settings__label">{{ t("settings.fonts") }}</h4>

        <label class="settings__row">
          <span>{{ t("settings.uiFontFamily") }}</span>
          <select v-model="config.uiFontFamily" class="settings__select ui-select" @change="applyFont">
            <option v-for="o in fontOptions" :key="o.value || 'default'" :value="o.value">{{ o.label }}</option>
          </select>
        </label>

        <label class="settings__row">
          <span>{{ t("settings.fsFontFamily") }}</span>
          <select v-model="config.fsFontFamily" class="settings__select ui-select">
            <option v-for="o in fontOptions" :key="o.value || 'default'" :value="o.value">{{ o.label }}</option>
          </select>
        </label>

        <div class="settings__row settings__row--col">
          <span>{{ t("settings.customFonts") }}</span>
          <label class="settings__upload">
            {{ t("settings.uploadFont") }}
            <input type="file" accept=".ttf,.otf,.woff,.woff2" @change="onFontFile" />
          </label>
        </div>

        <ul v-if="config.customFonts.length" class="settings__fonts">
          <li v-for="f in config.customFonts" :key="f.id">
            <span>{{ f.label }}</span>
            <button class="settings__fontdel" :title="t('settings.removeFont')" :aria-label="t('settings.removeFont')" @click="removeFont(f)">✕</button>
          </li>
        </ul>
      </div>

      <div class="settings__reset">
        <button class="settings__reset-btn" @click="resetSettings">{{ t("settings.reset") }}</button>
      </div>
    </div>
  </AppModal>
</template>

<script setup>
import { computed } from "vue";
import AppModal from "./AppModal.vue";
import { useConfigStore } from "@/stores/config";
import { usePlayerStore } from "@/stores/player";
import { useI18n } from "@/utils/i18n";
import { registerFont, setAppFont } from "@/utils/fonts";

defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(["update:modelValue"]);

const config = useConfigStore();
const player = usePlayerStore();
const { t } = useI18n();

// 自定义主题主色未设置时，取色器需要一个合法的 #rrggbb 回退值。
// 用当前主题的默认金色，避免把空字符串绑到 <input type="color"> 触发控制台告警。
const THEME_GOLD = { mondstadt: "#FFD76B", liyue: "#E8B465", inazuma: "#C9A0FF" };
const defaultAccent = computed(() => THEME_GOLD[config.theme] || "#FFD76B");

const themes = [
  { key: "mondstadt", label: "蒙德", icon: "anemo" },
  { key: "liyue", label: "璃月", icon: "geo" },
  { key: "inazuma", label: "稻妻", icon: "electro" },
];

// 可选的播放速度档位（与底部播放器按钮保持一致）
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// 系统字体 + 已上传自定义字体，供「界面字体 / 全屏歌词字体」两个下拉共用
const baseFonts = [
  { value: "", label: "系统默认" },
  { value: "'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif", label: "微软雅黑 / 鸿蒙" },
  { value: "'Source Han Sans SC', 'Noto Sans SC', sans-serif", label: "思源黑体" },
  { value: "'Source Han Serif SC', 'Noto Serif SC', serif", label: "思源宋体" },
  { value: "'Courier New', monospace", label: "等宽" },
];
const fontOptions = computed(() => [
  ...baseFonts,
  ...config.customFonts.map((f) => ({ value: `'${f.family}', sans-serif`, label: f.label })),
]);

function applyFont() {
  setAppFont(config.uiFontFamily);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onFontFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsDataURL(file);
  const b64 = dataUrl.split(",")[1];
  const api = window.pywebview?.api;
  let saved = null;
  try {
    if (api && typeof api.saveFont === "function") {
      saved = await api.saveFont(file.name, b64);
    } else {
      // 纯浏览器退化：用 object URL 注册，不持久化（刷新即失）
      const label = file.name.replace(/\.[^.]+$/, "");
      saved = { ok: true, id: String(Date.now()), family: label, label, url: URL.createObjectURL(file) };
    }
  } catch (err) {
    saved = null;
  }
  if (saved && saved.ok) {
    config.customFonts.push({ id: saved.id, family: saved.family, label: saved.label, url: saved.url });
    registerFont({ family: saved.family, url: saved.url });
    config.uiFontFamily = `'${saved.family}', sans-serif`;
    applyFont();
  }
  e.target.value = "";
}

function removeFont(f) {
  config.customFonts = config.customFonts.filter((x) => x.id !== f.id);
  const api = window.pywebview?.api;
  if (api && typeof api.removeFont === "function") {
    try {
      api.removeFont(f.id);
    } catch (e) {
      /* 忽略删除失败 */
    }
  }
  // 若当前界面字体正使用该字体，回退到系统默认
  if (config.uiFontFamily && config.uiFontFamily.includes(f.family)) {
    config.uiFontFamily = "";
    applyFont();
  }
}

function applyPlaybackRate() {
  player.setPlaybackRate(config.playbackRate);
}
function applyVolume() {
  player.setVolume(config.volume);
}
function resetSettings() {
  config.resetDefaults();
  player.setVolume(config.volume);
  player.setPlaybackRate(config.playbackRate);
  player.playMode = "list";
}
</script>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.settings__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.settings__label {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 1px;
  color: var(--teyvat-text-secondary);
  text-transform: uppercase;
}
.settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  font-size: 13px;
  color: var(--teyvat-text-primary);
}
.settings__select {
  min-width: 120px;
}
.settings__select option {
  background: var(--teyvat-bg-dark);
  color: var(--teyvat-text-primary);
}
.settings__number {
  width: 76px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.12);
  color: var(--teyvat-text-primary);
  font-size: 13px;
  outline: none;
}

.settings__range {
  width: 120px;
  accent-color: var(--teyvat-gold);
}
.settings__row--switch {
  cursor: pointer;
}
.settings__themes {
  display: flex;
  gap: var(--space-2);
}
.settings__theme {
  width: 30px;
  height: 30px;
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-card-bg) 10%, transparent);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.settings__theme:hover {
  color: var(--teyvat-text-primary);
}
.settings__theme--on {
  border-color: var(--teyvat-gold);
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
}
.settings__row--col {
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.settings__upload {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px dashed var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 12%, transparent);
  color: var(--teyvat-text-primary);
  cursor: pointer;
  font-size: 13px;
  transition: border-color var(--t-fast);
}
.settings__upload:hover {
  border-color: var(--teyvat-gold);
}
.settings__upload input {
  display: none;
}
.settings__fonts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.settings__colors {
  display: flex;
  gap: var(--space-5);
}
.settings__color {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--teyvat-text-secondary);
}
.settings__colorpicker {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}
.settings__accent-reset {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-card-bg) 14%, transparent);
  color: var(--teyvat-text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.settings__accent-reset:hover {
  border-color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
}
.settings__fonts li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-card-bg) 12%, transparent);
  font-size: 13px;
  color: var(--teyvat-text-primary);
}
.settings__fontdel {
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
}
.settings__fontdel:hover {
  color: var(--teyvat-danger);
  background: color-mix(in srgb, var(--teyvat-danger) 12%, transparent);
}
.settings__reset {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
  border-top: 1px solid var(--teyvat-card-border);
  margin-top: var(--space-1);
}
.settings__reset-btn {
  padding: var(--space-2) var(--space-5);
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-card-bg) 12%, transparent);
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.settings__reset-btn:hover {
  border-color: var(--teyvat-danger);
  color: var(--teyvat-danger);
  background: color-mix(in srgb, var(--teyvat-danger) 10%, transparent);
}
</style>
