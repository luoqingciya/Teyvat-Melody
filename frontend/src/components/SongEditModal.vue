<template>
  <AppModal :model-value="visible" :title="song?.title || '编辑歌曲信息'" :width="520" @update:model-value="close">
    <div v-if="song" class="song-edit">
      <div class="song-edit__fields">
        <label class="song-edit__field">
          <span class="song-edit__label">标题</span>
          <input v-model="form.title" class="song-edit__input ui-input" type="text" placeholder="歌曲标题" />
        </label>
        <label class="song-edit__field">
          <span class="song-edit__label">艺术家</span>
          <input v-model="form.artist" class="song-edit__input ui-input" type="text" placeholder="艺术家" />
        </label>
        <label class="song-edit__field">
          <span class="song-edit__label">专辑</span>
          <input v-model="form.album" class="song-edit__input ui-input" type="text" placeholder="专辑" />
        </label>
      </div>

      <div class="song-edit__lyrics">
        <div class="song-edit__lyrics-head">
          <span class="song-edit__label">歌词（LRC）</span>
          <span class="song-edit__tip">支持 [mm:ss.xx] 时间轴，留空则清除内嵌歌词</span>
        </div>
        <textarea
          v-model="form.lyrics"
          class="song-edit__textarea"
          placeholder="[00:00.00] 歌词内容…"
          spellcheck="false"
        ></textarea>
      </div>

      <div class="song-edit__actions">
        <button class="song-edit__btn ui-btn ui-btn--ghost" @click="close()">取消</button>
        <button class="song-edit__btn ui-btn" :disabled="saving" @click="save()">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>
  </AppModal>
</template>

<script setup>
import { reactive, ref, watch } from "vue";
import AppModal from "./AppModal.vue";
import { useApi } from "@/composables/useApi";

const props = defineProps({
  visible: { type: Boolean, default: false },
  song: { type: Object, default: null },
});
const emit = defineEmits(["close", "saved"]);

const { updateSong, updateLyrics, getLyrics } = useApi();
const saving = ref(false);

const form = reactive({
  title: "",
  artist: "",
  album: "",
  lyrics: "",
});

watch(
  () => props.visible,
  async (v) => {
    if (!v || !props.song) return;
    const s = props.song;
    form.title = s.title || "";
    form.artist = s.artist || "";
    form.album = s.album || "";
    form.lyrics = "";
    try {
      const res = await getLyrics(s.id);
      const lines = res?.data?.lines || [];
      form.lyrics = lines.length
        ? lines.map((l) => (Number.isFinite(l.t) ? `[${fmt(l.t)}]${l.text}` : l.text)).join("\n")
        : "";
    } catch (_) {
      form.lyrics = "";
    }
  }
);

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

async function save() {
  if (!props.song || saving.value) return;
  saving.value = true;
  try {
    const changed =
      form.title !== (props.song.title || "") ||
      form.artist !== (props.song.artist || "") ||
      form.album !== (props.song.album || "");
    if (changed) {
      await updateSong(props.song.id, {
        title: form.title.trim(),
        artist: form.artist.trim(),
        album: form.album.trim(),
      });
    }
    await updateLyrics(props.song.id, form.lyrics);
    emit("saved");
    close();
  } catch (e) {
    alert("保存失败：" + (e?.message || e));
  } finally {
    saving.value = false;
  }
}

function close(v) {
  emit("close", v);
}
</script>

<style scoped>
.song-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.song-edit__fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.song-edit__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.song-edit__label {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.song-edit__lyrics {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.song-edit__lyrics-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
.song-edit__tip {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
}
.song-edit__textarea {
  min-height: 180px;
  resize: vertical;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-bg-dark) 40%, transparent);
  color: var(--teyvat-text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  outline: none;
}
.song-edit__textarea:focus {
  border-color: var(--teyvat-gold);
}
.song-edit__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
</style>
