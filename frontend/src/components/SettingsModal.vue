<template>
  <AppModal
    :model-value="modelValue"
    :title="t('header.settings')"
    :confirm-text="t('settings.done')"
    :width="900"
    :height="560"
    :mask-closable="false"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="emit('update:modelValue', false)"
  >
    <!-- 分类标签 + 内容区：设置项多了以后一长条滚到底很难找，
         改成一栏分类、点一下只显示这一类。左侧标签常驻，右侧独立滚动。 -->
    <div class="settings">
      <nav class="settings__tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="settings__tab"
          :class="{ 'settings__tab--on': activeTab === tab.key }"
          role="tab"
          :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key"
        >
          <AppIcon :name="tab.icon" :size="15" />
          <span class="settings__tab-label">{{ t(tab.label) }}</span>
          <!-- 有小红点的事项（如源加载失败）在标签上先提示，不用点进去才发现 -->
          <span v-if="tab.key === 'online' && sourceCount" class="settings__tab-badge">{{ sourceCount }}</span>
        </button>
      </nav>

      <div class="settings__panes">
        <!-- ============ 播放 ============ -->
        <div v-show="activeTab === 'playback'" class="settings__pane">
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

            <label class="settings__row" :class="{ 'settings__row--dim': !config.crossfade }">
              <!-- 关闭时不要重复显示开关的名字（上面那行已经是「切歌淡入淡出」了），
                   而是继续显示「时长」并置灰，用户才知道这个滑块是干什么的。 -->
              <span>{{ t("settings.crossfadeDuration", { s: config.crossfadeDuration }) }}</span>
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
        </div>

        <!-- ============ 外观 ============ -->
        <div v-show="activeTab === 'appearance'" class="settings__pane">
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
        </div>

        <!-- ============ 歌词 ============ -->
        <div v-show="activeTab === 'lyrics'" class="settings__pane">
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
          </div>

          <div class="settings__group">
            <h4 class="settings__label">{{ t("settings.desktopLyrics") }}</h4>

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
        </div>

        <!-- ============ 在线播放 ============ -->
        <div v-show="activeTab === 'online'" class="settings__pane">
          <!-- 自定义源：在线播放能力全靠它，所以放在最前面 -->
          <div class="settings__group">
            <h4 class="settings__label">{{ t("settings.sources") }}</h4>
            <p class="settings__tip">{{ t("settings.sourcesTip") }}</p>

            <div class="settings__row settings__row--col">
              <button class="ui-btn ui-btn--ghost settings__action" @click="onImportSource">
                {{ t("settings.importSource") }}
              </button>
              <span v-if="sourceMsg" class="settings__tip" :class="{ 'settings__tip--err': sourceMsgErr }">{{ sourceMsg }}</span>
            </div>

            <ul v-if="sources.length" class="settings__fonts settings__srcs">
              <li v-for="s in sources" :key="s.id" class="settings__src">
                <div class="settings__srcinfo">
                  <div class="settings__srcname">
                    <span>{{ s.name }}</span>
                    <span v-if="s.version" class="settings__srcver">v{{ s.version }}</span>
                    <span v-if="s.updateInfo" class="settings__srcbadge settings__srcbadge--upd" :title="s.updateInfo.log">{{ t("settings.sourceUpdate") }}</span>
                  </div>
                  <div v-if="s.author" class="settings__srcmeta">{{ s.author }}</div>
                  <div v-if="s.error" class="settings__srcerr">{{ t("settings.sourceError") }}：{{ s.error }}</div>
                  <div v-else class="settings__srcbadges">
                    <span v-for="(decl, key) in s.sources" :key="key" class="settings__srcbadge" :title="(decl.qualitys || []).join(' / ')">
                      {{ key }}<template v-if="decl.qualitys && decl.qualitys.length"> · {{ decl.qualitys[decl.qualitys.length - 1] }}</template>
                    </span>
                  </div>
                </div>
                <div class="settings__srcops">
                  <button class="settings__fontdel" :title="t('settings.sourceReload')" :aria-label="t('settings.sourceReload')" @click="onReloadSource(s)">↻</button>
                  <button class="settings__fontdel" :title="t('settings.sourceRemove')" :aria-label="t('settings.sourceRemove')" @click="onRemoveSource(s)">✕</button>
                  <input
                    class="settings__switch"
                    type="checkbox"
                    :checked="s.enabled"
                    :title="s.enabled ? t('settings.sourceDisable') : t('settings.sourceEnable')"
                    @change="onToggleSource(s, $event.target.checked)"
                  />
                </div>
              </li>
            </ul>
            <span v-else class="settings__tip">{{ t("settings.noSources") }}</span>
          </div>

          <!-- 在线播放缓存 -->
          <div class="settings__group">
            <h4 class="settings__label">{{ t("settings.onlineCache") }}</h4>
            <p class="settings__tip">{{ t("settings.cacheTip") }}</p>

            <label class="settings__row settings__row--switch">
              <span>{{ t("settings.cacheEnable") }}</span>
              <input
                class="settings__switch"
                type="checkbox"
                :checked="cache.enabled"
                @change="onToggleCache($event.target.checked)"
              />
            </label>

            <div class="settings__row">
              <span>{{ t("settings.cacheLimit") }}</span>
              <select
                class="ui-select settings__select"
                :value="cache.maxBytes"
                :disabled="!cache.enabled"
                @change="onCacheLimit($event.target.value)"
              >
                <option v-for="opt in cache.maxBytesOptions || []" :key="opt" :value="opt">
                  {{ formatBytes(opt) }}
                </option>
              </select>
            </div>

            <div class="settings__row">
              <span class="settings__tip">
                {{ t("settings.cacheUsed", { size: formatBytes(cache.bytes) }) }}<template
                  v-if="cache.partialBytes"
                >{{ t("settings.cachePartial", { size: formatBytes(cache.partialBytes) }) }}</template>
                <template v-if="cache.lyricsBytes"
                >　·　{{ t("settings.cacheLyrics", { n: cache.lyricsFiles || 0, size: formatBytes(cache.lyricsBytes) }) }}</template>
              </span>
              <button
                class="ui-btn ui-btn--ghost settings__action"
                :disabled="!cache.totalBytes"
                @click="onClearCache"
              >
                {{ t("settings.cacheClear") }}
              </button>
            </div>

            <span v-if="cacheMsg" class="settings__tip">{{ cacheMsg }}</span>
          </div>
        </div>

        <!-- ============ 网络设置（HTTP 代理） ============ -->
        <!-- 单独一个分类：它不只影响在线播放 —— 检查更新、源脚本取数据全都走它 -->
        <div v-show="activeTab === 'network'" class="settings__pane">
          <!-- HTTP 代理：在线播放要连各平台接口与 CDN，被墙/需要代理时全靠这里 -->
          <div class="settings__group">
            <h4 class="settings__label">{{ t("settings.network") }}</h4>
            <p class="settings__tip">{{ t("settings.proxyTip") }}</p>

            <label class="settings__row settings__row--switch">
              <span>{{ t("settings.proxyEnable") }}</span>
              <input v-model="proxy.enabled" class="settings__switch" type="checkbox" />
            </label>

            <!-- 主机与端口并排：端口只有 4~5 位，单独占一整行太空；挪在一起也顺带
                 让人一眼看出「这两个是一组」 -->
            <div class="settings__row settings__row--col">
              <span>{{ t("settings.proxyAddr") }}</span>
              <div class="settings__proxyaddr">
                <input
                  v-model.trim="proxy.host"
                  class="ui-input settings__input settings__input--host"
                  type="text"
                  :disabled="!proxy.enabled"
                  placeholder="127.0.0.1"
                  spellcheck="false"
                />
                <span class="settings__proxycolon">:</span>
                <input
                  v-model.trim="proxy.port"
                  class="ui-input settings__input settings__input--port"
                  type="text"
                  inputmode="numeric"
                  :disabled="!proxy.enabled"
                  placeholder="7890"
                  spellcheck="false"
                />
              </div>
            </div>

            <div class="settings__row settings__row--end settings__actions">
              <button
                class="ui-btn ui-btn--ghost settings__action"
                :disabled="!proxy.enabled || testing"
                @click="onTestProxy"
              >
                {{ testing ? t("settings.proxyTesting") : t("settings.proxyTest") }}
              </button>
              <button
                class="ui-btn settings__action"
                :disabled="!proxyDirty"
                @click="onSaveProxy"
              >
                {{ t("settings.proxySave") }}
              </button>
            </div>

            <!-- 测试结果 / 保存反馈：成功绿色、失败红色（沿用 tip--err） -->
            <span
              v-if="proxyMsg"
              class="settings__tip"
              :class="{ 'settings__tip--err': proxyMsgErr, 'settings__tip--ok': !proxyMsgErr }"
            >{{ proxyMsg }}</span>
          </div>
        </div>

        <!-- ============ 关于与更新 ============ -->
        <div v-show="activeTab === 'about'" class="settings__pane">
          <div class="settings__group">
            <h4 class="settings__label">{{ t("update.title") }}</h4>

            <div class="settings__row">
              <span>{{ t("update.current") }}</span>
              <span class="settings__value">v{{ appVersion || "—" }}</span>
            </div>

            <!-- 数据目录：装的是安装版还是免安装版、数据落在哪里，用户应该能自己看到
                 （两种分发方式数据都跟 EXE 同级，升级靠 NSIS 宏保住 —— 见 dataRoot.js） -->
            <div v-if="dataDir" class="settings__row">
              <span>{{ t("settings.dataDir") }}</span>
              <span class="settings__value settings__value--path" :title="dataDir">{{ dataDir }}</span>
            </div>
            <div v-if="dataDir" class="settings__row settings__row--end">
              <button class="ui-btn ui-btn--ghost settings__action" @click="openDataDir">
                {{ t("settings.openDataDir") }}
              </button>
            </div>

            <!-- 按钮自身已说明用途，左侧不再重复放一个同名标签 -->
            <div class="settings__row settings__row--end">
              <button
                class="ui-btn ui-btn--ghost settings__action"
                :disabled="updater.checking.value"
                @click="onCheckUpdate"
              >
                {{ updater.checking.value ? t("update.checking") : t("update.check") }}
              </button>
            </div>

            <p v-if="updater.error.value" class="settings__tip settings__tip--err">{{ updater.error.value }}</p>

            <template v-else-if="updater.info.value?.ok">
              <p v-if="!updater.info.value.hasUpdate" class="settings__tip">{{ t("update.upToDate") }}</p>
              <template v-else>
                <div class="settings__notice">
                  <span class="settings__notice-title">{{ t("update.available", { v: updater.info.value.latest }) }}</span>
                  <span v-if="updater.info.value.publishedAt" class="settings__notice-date">
                    {{ updater.info.value.publishedAt.slice(0, 10) }}
                  </span>
                </div>

                <!-- 下载进度 -->
                <div v-if="updater.downloading.value" class="settings__progress">
                  <div class="settings__progress-bar" :style="{ width: updater.progress.value + '%' }"></div>
                  <span class="settings__progress-text">{{ t("update.downloading", { p: updater.progress.value }) }}</span>
                </div>

                <div class="settings__actions">
                  <button
                    class="ui-btn settings__action"
                    :disabled="updater.downloading.value"
                    @click="updater.downloadAndInstall()"
                  >
                    {{ updater.info.value.installed ? t("update.downloadInstall") : t("update.download") }}
                  </button>
                  <button
                    class="ui-btn ui-btn--ghost settings__action"
                    :disabled="updater.downloading.value"
                    @click="updater.openPage(updater.info.value.pageUrl)"
                  >
                    {{ t("update.openPage") }}
                  </button>
                  <button class="ui-btn ui-btn--ghost settings__action" @click="onSkipUpdate">
                    {{ t("update.skip") }}
                  </button>
                </div>

                <details v-if="updater.info.value.notes" class="settings__notes">
                  <summary>{{ t("update.notes") }}</summary>
                  <pre>{{ updater.info.value.notes }}</pre>
                </details>
              </template>
            </template>

            <p v-if="config.skipUpdateVersion" class="settings__tip">
              {{ t("update.skipped", { v: config.skipUpdateVersion }) }}
            </p>
          </div>

          <div class="settings__group">
            <h4 class="settings__label">{{ t("settings.reset") }}</h4>
            <p class="settings__tip">{{ t("settings.resetTip") }}</p>
            <div class="settings__row settings__row--end">
              <button class="settings__reset-btn" @click="resetSettings">{{ t("settings.reset") }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppModal>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from "vue";import AppModal from "./AppModal.vue";
import { useConfigStore } from "@/stores/config";
import { usePlayerStore } from "@/stores/player";
import { useI18n } from "@/utils/i18n";
import { registerFont, setAppFont } from "@/utils/fonts";
import { useUpdater } from "@/composables/useUpdater";
import { useApi } from "@/composables/useApi";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /**
   * 打开时先切到哪个分类（如空状态卡片引导用户去看「在线」）。
   * 为空则沿用上次停留的分类。**只作用于"打开那一刻"** ——
   * 用户手动切过之后不该被这个 prop 拽回去。
   */
  initialTab: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const config = useConfigStore();
const player = usePlayerStore();
const { t } = useI18n();

// ---- 分类标签 ----
// 设置项变多（播放/外观/歌词/在线源/关于）后，一长条滚到底既难找也难回顾，
// 改成左侧分类、右侧只显示当前这一类。图标沿用项目既有 AppIcon 名称。
const TABS = [
  { key: "playback", label: "settings.tabPlayback", icon: "play" },
  { key: "appearance", label: "settings.tabAppearance", icon: "palette" },
  { key: "lyrics", label: "settings.tabLyrics", icon: "list-music" },
  { key: "online", label: "settings.tabOnline", icon: "cloud" },
  { key: "network", label: "settings.tabNetwork", icon: "globe" },
  { key: "about", label: "settings.tabAbout", icon: "info" },
];
// 记住上次停留的分类（弹窗关掉再开回到原处，不用每次重新点）
const TAB_KEY = "teyvat-melody:settingsTab";
const activeTab = ref(localStorage.getItem(TAB_KEY) || "playback");
watch(activeTab, (v) => {
  try {
    localStorage.setItem(TAB_KEY, v);
  } catch {
    /* 忽略配额错误 */
  }
});

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

// ---- 自定义源（洛雪源脚本） ----
const sources = ref([]);
const sourceMsg = ref("");
const sourceMsgErr = ref(false);
let sourceMsgTimer = 0;
// 侧栏标签上的数量徽标：不用点进「在线播放」也知道导了几个源
const sourceCount = computed(() => sources.value.length);

// ---- 关于与更新 ----
const updater = useUpdater();
const appVersion = ref("");
const dataDir = ref("");

async function loadAppVersion() {
  const api = window.pywebview?.api;
  if (!api || typeof api.getAppVersion !== "function") return;
  try {
    appVersion.value = await api.getAppVersion();
  } catch {
    /* 拿不到版本号不影响其它功能 */
  }
}

/** 取数据目录（data / music / cache / sources 都在它下面）。
 *  安装版的数据放在 %LOCALAPPDATA% 而不是安装目录 —— 因为安装目录在升级时会被
 *  旧版卸载程序整个删掉（详见 electron/dataRoot.js）。用户应该能自己看到它在哪。 */
async function loadDataDir() {
  const api = window.pywebview?.api;
  if (!api || typeof api.getDataDir !== "function") return;
  try {
    dataDir.value = await api.getDataDir();
  } catch {
    /* 拿不到就不显示这一行 */
  }
}

/** 在系统资源管理器里打开数据目录 */
function openDataDir() {
  const api = window.pywebview?.api;
  if (api && typeof api.openDataDir === "function") {
    try {
      api.openDataDir();
    } catch {
      /* 忽略 */
    }
  }
}

function onCheckUpdate() {
  updater.check();
}

function onSkipUpdate() {
  const v = updater.info.value?.latest;
  if (v) updater.skip(v);
}

// ---- 在线播放缓存 ----
const { getOnlineCache, clearOnlineCache, setOnlineCacheConfig } = useApi();
const cache = ref({
  enabled: true,
  maxBytes: 0,
  maxBytesOptions: [],
  bytes: 0,
  files: 0,
  partialBytes: 0,
  lyricsBytes: 0,
  lyricsFiles: 0,
  totalBytes: 0,
});
const cacheMsg = ref("");

/** 字节 → 易读单位（上限选项与占用展示共用）。
 *  小体积要走 KB/B —— 歌词缓存通常只有几 KB，一律取整到 MB 会显示成「0 MB」，
 *  看起来像「什么都没缓存」。 */
function formatBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "0 MB";
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(v % 1024 ** 3 ? 1 : 0)} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

async function loadCache() {
  try {
    const data = await getOnlineCache();
    if (data) cache.value = data;
  } catch {
    /* 后端不可用时保持默认值，不打扰用户 */
  }
}

async function onToggleCache(enabled) {
  const data = await setOnlineCacheConfig({ enabled });
  if (data) cache.value = data;
}

async function onCacheLimit(value) {
  const data = await setOnlineCacheConfig({ maxBytes: Number(value) });
  if (data) cache.value = data;
}

async function onClearCache() {
  const r = await clearOnlineCache();
  await loadCache();
  if (r) {
    cacheMsg.value = t("settings.cacheCleared", { size: formatBytes(r.freed) });
    setTimeout(() => (cacheMsg.value = ""), 4000);
  }
}

// ---- HTTP 代理 ----
// 配置由**主进程**持有（写在 <数据根>/cache/config.json，见 appConfig.js），
// 不走 config store 的 localStorage —— 后端与源脚本也得读到它。
const proxy = ref({ enabled: false, host: "", port: "" });
const proxySaved = ref({ enabled: false, host: "", port: "" });
const proxyMsg = ref("");
const proxyMsgErr = ref(false);
const testing = ref(false);
let proxyMsgTimer = 0;

/** 与已保存的值是否有差异 —— 决定「保存」按钮是否可点，避免无意义写入 */
const proxyDirty = computed(
  () =>
    !!proxy.value.enabled !== !!proxySaved.value.enabled ||
    String(proxy.value.host || "") !== String(proxySaved.value.host || "") ||
    String(proxy.value.port || "") !== String(proxySaved.value.port || "")
);

function setProxyMsg(text, isErr = false) {
  proxyMsg.value = text;
  proxyMsgErr.value = !!isErr;
  clearTimeout(proxyMsgTimer);
  proxyMsgTimer = setTimeout(() => (proxyMsg.value = ""), 5000);
}

async function loadProxy() {
  const api = window.pywebview?.api;
  if (!api?.getProxy) return;
  try {
    const r = await api.getProxy();
    if (r?.ok) {
      const p = r.proxy || {};
      proxy.value = { enabled: !!p.enabled, host: p.host || "", port: p.port ? String(p.port) : "" };
      proxySaved.value = { ...proxy.value };
    }
  } catch {
    /* 读不到就保持默认，不打扰用户 */
  }
}

async function onSaveProxy() {
  const api = window.pywebview?.api;
  if (!api?.setProxy) return;
  const r = await api.setProxy({
    enabled: proxy.value.enabled,
    host: proxy.value.host,
    port: proxy.value.port,
  });
  if (!r?.ok) {
    setProxyMsg(r?.message || t("settings.proxySaveFailed"), true);
    return;
  }
  // 归一化后的值回填：端口可能被转成数字、前后空格被去掉，回填能让界面与真实配置一致
  const p = r.proxy || {};
  proxy.value = { enabled: !!p.enabled, host: p.host || "", port: p.port ? String(p.port) : "" };
  proxySaved.value = { ...proxy.value };
  setProxyMsg(
    proxy.value.enabled
      ? t("settings.proxySavedOn", { addr: `${proxy.value.host}:${proxy.value.port}` })
      : t("settings.proxySavedOff")
  );
}

async function onTestProxy() {
  const api = window.pywebview?.api;
  if (!api?.testProxy) return;
  testing.value = true;
  proxyMsg.value = "";
  try {
    const r = await api.testProxy({ host: proxy.value.host, port: proxy.value.port });
    setProxyMsg(r?.message || (r?.ok ? t("settings.proxyOk") : t("settings.proxyFailed")), !r?.ok);
  } catch (e) {
    setProxyMsg(e.message, true);
  } finally {
    testing.value = false;
  }
}

function flashSourceMsg(text, isErr) {
  sourceMsg.value = text;
  sourceMsgErr.value = !!isErr;
  clearTimeout(sourceMsgTimer);
  sourceMsgTimer = setTimeout(() => (sourceMsg.value = ""), 4000);
}

async function loadSources() {
  const api = window.pywebview?.api;
  if (!api || typeof api.listSources !== "function") return;
  try {
    const r = await api.listSources();
    sources.value = r?.list ?? [];
  } catch {
    sources.value = [];
  }
}

async function onImportSource() {
  const api = window.pywebview?.api;
  if (!api || typeof api.importSource !== "function") return;
  try {
    const r = await api.importSource();
    if (r?.canceled) return;
    if (r?.ok) {
      flashSourceMsg(t("settings.sourceImportOk", { n: r.source.name }));
      await loadSources();
    } else {
      flashSourceMsg(t("settings.sourceImportFail", { m: r?.message || "unknown" }), true);
    }
  } catch (e) {
    flashSourceMsg(t("settings.sourceImportFail", { m: e.message }), true);
  }
}

async function onRemoveSource(s) {
  const api = window.pywebview?.api;
  if (!api) return;
  await api.removeSource(s.id);
  await loadSources();
}

async function onToggleSource(s, enabled) {
  const api = window.pywebview?.api;
  if (!api) return;
  s.enabled = enabled;
  await api.toggleSource(s.id, enabled);
}

async function onReloadSource(s) {
  const api = window.pywebview?.api;
  if (!api) return;
  await api.reloadSource(s.id);
  await loadSources();
}

// 打开设置弹窗时刷新源列表、版本号与缓存占用（状态可能已变化）。
// 弹窗开着时缓存还在持续增长（后台补完、边播边写），所以开个轻量轮询 ——
// 否则用户盯着数字不动，会以为缓存坏了。
let cacheTimer = null;

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      // 只在"打开这一刻"套用请求的分类，之后不再干预（否则用户手动切 tab 会被拽回来）
      if (props.initialTab && TABS.some((x) => x.key === props.initialTab)) {
        activeTab.value = props.initialTab;
      }
      loadSources();
      loadAppVersion();
      loadDataDir();
      loadCache();
      loadProxy();
      clearInterval(cacheTimer);
      cacheTimer = setInterval(loadCache, 2000);
    } else {
      clearInterval(cacheTimer);
      cacheTimer = null;
    }
  }
);

onUnmounted(() => clearInterval(cacheTimer));
</script>

<style scoped>
/* 两栏：左侧分类标签（常驻），右侧内容区独立滚动。
   弹窗高度固定（AppModal 的 height），所以切换分类时窗口不会一跳一跳的；
   内容多的分类在右侧**内部**滚动，标签栏始终可见。 */
.settings {
  display: grid;
  grid-template-columns: 132px 1fr;
  gap: var(--space-5);
  height: 100%; /* 撑满 AppModal 固定高度的 body */
  min-height: 0; /* 关键：让子项的 overflow 生效，否则内容会把容器顶高 */
}

/* ---- 分类标签 ---- */
.settings__tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--teyvat-card-border);
  padding-right: var(--space-2);
  overflow-y: auto; /* 分类多了也不会把标签栏顶出可视区 */
  flex-shrink: 0;
}
.settings__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--teyvat-text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
/* ⚠️ 标签文字「永不换行」。这一栏实测可用宽度只有 ~75px（127px 栏宽里减去
   图标 15 + gap 8 + 左右内边距 24），而「在线播放」这类四字标签约 48px。
   本身放得下，但**一旦带上右侧的数字徽标（17px）就会被挤到折行** —— 曾出现
   「在线播放」独占两行、比其他标签高出一截，整列参差不齐。宁可省略也不折行。 */
.settings__tab-label {
  min-width: 0; /* 让 text-overflow 在 flex 子项上生效 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings__tab:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 7%, transparent);
  color: var(--teyvat-text-primary);
}
.settings__tab--on {
  background: color-mix(in srgb, var(--teyvat-gold) 14%, transparent);
  color: var(--teyvat-gold);
  font-weight: var(--font-weight-semibold);
}
/* 数量徽标（当前只用于自定义源个数） */
.settings__tab-badge {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-text-secondary) 22%, transparent);
  color: var(--teyvat-text-primary);
  font-size: 11px;
  font-weight: var(--font-weight-normal);
  text-align: center;
  line-height: 16px;
}
.settings__tab--on .settings__tab-badge {
  background: color-mix(in srgb, var(--teyvat-gold) 26%, transparent);
}

/* ---- 网络代理：主机与端口并排，中间一个冒号看起来像地址 ---- */
.settings__proxyaddr {
  display: flex;
  align-items: center;
  gap: 4px;
}
.settings__proxycolon {
  color: var(--teyvat-text-secondary);
  font-size: 13px;
}
.settings__input {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-primary);
  font-size: 13px;
  transition: border-color var(--t-fast);
}
.settings__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--teyvat-gold) 60%, transparent);
}
.settings__input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 主机要放 IP 或域名，给宽些；端口固定 5 位足够 */
.settings__input--host {
  width: 150px;
}
.settings__input--port {
  width: 64px;
}
/* 成功提示（与 tip--err 相对） */
.settings__tip--ok {
  color: var(--teyvat-green, #4ade80);
}

/* ---- 内容区 ---- */
/* 用 grid + v-show 会同时展开所有 pane，所以这里让 panes 成为滚动容器，
   只有当前显示的 pane 参与布局（v-show 用 display:none 隐藏其它 pane）。 */
.settings__panes {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding-right: var(--space-2); /* 给滚动条留位置，避免贴住右边缘 */
}
.settings__panes::-webkit-scrollbar {
  width: var(--space-2);
}
/* 轨道显式设为透明：不写的话 Chromium 会用浅色默认轨道，
   在深色面板上会显出一条突兀的亮边（截图上很明显）。 */
.settings__panes::-webkit-scrollbar-track {
  background: transparent;
}
.settings__panes::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--teyvat-text-secondary) 36%, transparent);
  border-radius: var(--radius-full);
}
.settings__panes::-webkit-scrollbar-thumb:hover {
  background: var(--teyvat-gold);
}
.settings__pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.settings__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* 同一分类内多个板块之间加分隔线：靠留白已不足以区分 */
.settings__group + .settings__group {
  padding-top: var(--space-3);
  border-top: 1px solid var(--teyvat-card-border);
}
.settings__label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.6px;
  color: var(--teyvat-text-primary);
}
/* 标题前一道主题色装饰条，层级一眼可辨 */
.settings__label::before {
  content: "";
  flex-shrink: 0;
  width: 3px;
  height: 12px;
  border-radius: var(--radius-full);
  background: linear-gradient(180deg, var(--teyvat-gold), var(--teyvat-blue));
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
/* 依赖项关闭时，把从属的那一行整体压暗 —— 光靠滑块 disabled 不够明显 */
.settings__row--dim > span {
  opacity: 0.5;
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
/* 只有控件、不需要左侧标签的行（按钮自己说明用途） */
.settings__row--end {
  justify-content: flex-end;
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
.settings__tip {
  margin: 0;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.settings__tip--err {
  color: var(--teyvat-danger);
}
.settings__upload:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* 更新说明（可折叠，避免长 markdown 撑开弹窗） */
.settings__notes {
  margin: var(--space-1) 0 0;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.settings__notes summary {
  cursor: pointer;
  color: var(--teyvat-text-primary);
}
.settings__notes pre {
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in srgb, var(--teyvat-bg-dark) 22%, transparent);
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.6;
}

/* ---- 行内右侧的值（版本号等） ---- */
.settings__value {
  color: var(--teyvat-text-secondary);
  font-variant-numeric: tabular-nums;
}
/* 数据目录可能很长（安装版是 %LOCALAPPDATA% 下的路径）：截断显示，完整路径看 title */
.settings__value--path {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

/* ---- 按钮组：允许换行，避免窄窗里挤爆 ---- */
.settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.settings__action {
  padding: 6px 14px;
  font-size: 12px;
}

/* ---- 新版本提示条 ---- */
.settings__notice {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--teyvat-gold) 32%, transparent);
  background: color-mix(in srgb, var(--teyvat-gold) 10%, transparent);
}
.settings__notice-title {
  font-size: 13px;
  color: var(--teyvat-gold);
}
.settings__notice-date {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}

/* ---- 下载进度 ---- */
.settings__progress {
  position: relative;
  height: 18px;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.settings__progress-bar {
  height: 100%;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--teyvat-gold), var(--teyvat-blue));
  transition: width var(--t-base);
}
.settings__progress-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--teyvat-text-primary);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.settings__srcs li {
  align-items: flex-start;
}
.settings__src {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}
.settings__srcinfo {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.settings__srcname {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--teyvat-text-primary);
}
.settings__srcver {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
}
.settings__srcmeta {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
}
.settings__srcerr {
  font-size: 11px;
  color: var(--teyvat-danger);
  word-break: break-all;
}
.settings__srcbadges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.settings__srcbadge {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 14%, transparent);
  color: var(--teyvat-text-secondary);
  font-size: 11px;
  font-family: var(--font-mono, monospace);
}
.settings__srcbadge--upd {
  border-color: var(--teyvat-gold);
  color: var(--teyvat-gold);
}
.settings__srcops {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.settings__switch {
  accent-color: var(--teyvat-gold);
  cursor: pointer;
}
</style>
