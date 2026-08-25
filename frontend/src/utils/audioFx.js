// audioFx：基于 Web Audio API 的全局音效链路（图形均衡器 + 预设）。
//
// 链路：全局 Audio 元素
//   → MediaElementSource（每个媒体元素只能建一次，单例守护）
//   → preGain（前置增益，避免多段叠加削波）
//   → 10 段 BiquadFilter(peaking) 串联
//   → postGain（输出补偿）
//   → AudioContext.destination
//
// 设计要点：
// - 链路始终连接，关闭音效时把所有频段增益置 0（透明），避免「断开即静音」风险。
// - AudioContext 受浏览器自动播放策略限制，需在有用户手势（play）时 resume()。
// - 流式播放同源（127.0.0.1:5000），不存在 CORS 污染，可安全进入音频图。
import { getAudio } from "@/utils/audioElement";

// 10 段标准均衡频率（Hz）
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// 预设曲线（各频段增益，单位 dB）。custom 不在此处定义，跟随用户自定义 eqBands。
export const EQ_PRESETS = {
  off: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  vocal: [-1, -1, 0, 2, 3, 3, 2, 1, 0, 0],
  live: [3, 2, 1, 0, 0, 0, 1, 2, 3, 3],
  game: [4, 3, 1, 0, 0, 0, 1, 2, 3, 4],
  classic: [4, 3, 2, 0, 0, 0, 0, 2, 3, 4],
  pop: [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1],
};

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

let ctx = null;
let sourceNode = null;
let preGain = null;
let postGain = null;
let fadeNode = null;
let analyser = null;
let levelData = null;
let bands = [];
let built = false;
let supported = true;

function build() {
  if (built) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    supported = false;
    return;
  }
  try {
    ctx = new AudioCtx();
    const audio = getAudio();
    // 每个媒体元素只能创建一次 MediaElementSource，否则抛 InvalidStateError
    sourceNode = ctx.createMediaElementSource(audio);

    preGain = ctx.createGain();
    preGain.gain.value = 1;

    // 淡入淡出节点：切歌过渡用。默认恒为 1（不参与音量）。
    fadeNode = ctx.createGain();
    fadeNode.gain.value = 1;

    bands = EQ_FREQS.map((f) => {
      const node = ctx.createBiquadFilter();
      node.type = "peaking";
      node.frequency.value = f;
      node.Q.value = 1.1;
      node.gain.value = 0;
      return node;
    });

    postGain = ctx.createGain();
    postGain.gain.value = 1;

    // 输出实时电平分析：用于「跳过静音」的静音段探测（RMS，0~1）。
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    levelData = new Float32Array(analyser.fftSize);

    // 串联：source → preGain → fadeNode → band0 → … → band9 → postGain → analyser → destination
    let prev = sourceNode;
    prev.connect(preGain);
    prev = preGain;
    prev.connect(fadeNode);
    prev = fadeNode;
    for (const b of bands) {
      prev.connect(b);
      prev = b;
    }
    prev.connect(postGain);
    postGain.connect(analyser);
    analyser.connect(ctx.destination);

    built = true;
  } catch (e) {
    // 创建失败（如已存在 source）则降级为无音效直通
    supported = false;
    built = false;
    console.warn("audioFx 初始化失败，已降级为无音效：", e);
  }
}

function setBands(arr) {
  if (!built) return;
  for (let i = 0; i < bands.length; i++) {
    const g = arr?.[i] ?? 0;
    bands[i].gain.setTargetAtTime(g, ctx.currentTime, 0.02);
  }
}

/** 构建链路并应用一份完整状态。state: { enabled, preset, bands } */
export function ensure(state) {
  build();
  if (!built) return;
  applyState(state);
}

/** 在用户手势（play）中调用，解锁被挂起的 AudioContext。 */
export function resume() {
  if (built && ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

/** 把 dB 值转成线性增益（volumeGain 范围 -12~12 dB）。 */
function dbToLinear(db) {
  const v = Math.max(-20, Math.min(20, Number(db) || 0));
  return Math.pow(10, v / 20);
}

/** 根据完整状态刷新链路：关闭=全 0，自定义=用户曲线，否则=预设曲线。
 *  gain（dB）为额外的播放增益，加载到输出补偿节点。 */
export function applyState(state) {
  if (!built || !state) return;
  const { enabled, preset, bands: userBands, gain } = state;
  if (!enabled) {
    setBands(FLAT);
    if (postGain) postGain.gain.setTargetAtTime(dbToLinear(gain), ctx.currentTime, 0.02);
    return;
  }
  if (preset === "custom") {
    setBands(userBands && userBands.length === EQ_FREQS.length ? userBands : FLAT);
  } else {
    setBands(EQ_PRESETS[preset] || FLAT);
  }
  if (postGain) postGain.gain.setTargetAtTime(dbToLinear(gain), ctx.currentTime, 0.02);
}

/** 当前音效能力是否可用（不支持时 UI 应禁用相关控件）。 */
export function isSupported() {
  return supported;
}

/** 淡入淡出：把 fadeNode 增益平滑过渡到 level（0~1，duration 秒）。 */
export function setFade(level, duration = 0.3) {
  if (!built || !fadeNode) return;
  const t = ctx.currentTime;
  const dur = Math.max(0.01, Number(duration) || 0.3);
  const g = fadeNode.gain;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(Math.max(0, Math.min(1, level)), t, dur / 3);
}

/** 淡出：把增益平滑降到 0（切歌前半段旧歌渐弱）。 */
export function fadeOut(duration = 0.3) {
  setFade(0, duration);
}

/** 淡入：把增益从静音平滑回升到 1（新歌渐响起）。 */
export function fadeIn(duration = 0.3) {
  setFade(1, duration);
}

/** 立即静音（无过渡），用于切歌瞬间抑制旧歌残响。 */
export function muteFade() {
  if (!built || !fadeNode) return;
  fadeNode.gain.cancelScheduledValues(ctx.currentTime);
  fadeNode.gain.setValueAtTime(0, ctx.currentTime);
}

/** 当前输出实时电平（RMS，0~1）。用于「跳过静音」探测，未构建链路时返回 0。 */
export function getLevel() {
  if (!built || !analyser) return 0;
  analyser.getFloatTimeDomainData(levelData);
  let sum = 0;
  for (let i = 0; i < levelData.length; i++) {
    const v = levelData[i];
    sum += v * v;
  }
  return Math.sqrt(sum / levelData.length);
}
