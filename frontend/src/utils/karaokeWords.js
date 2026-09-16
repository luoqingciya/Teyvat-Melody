// karaokeWords：把一行歌词的逐字时间轴按当前播放时刻切成「逐字分段」。
//
// 抽成纯函数是为了能直接单测 —— 逐字渲染依赖在线歌词（KRC / lxlyric 解析出的 words），
// 而第三方源能不能解析是波动的，靠界面验证会时灵时不灵。分段计算本身与网络无关，
// 放在这里就能稳定覆盖边界（未开始 / 正在唱 / 已唱完 / 无时长）。

/**
 * @param {Array<{t:number,d:number,text:string}>} words 逐字时间轴（t/d 单位为秒）
 * @param {number} time 当前播放时刻（秒，已含歌词偏移）
 * @returns {Array<{text:string, frac:number}>} frac∈[0,1]：0=未唱、1=唱完、之间=正在唱
 */
export function buildWordSpans(words, time) {
  if (!Array.isArray(words) || !words.length) return [];
  const t = Number(time) || 0;
  return words.map((w) => {
    // 无时长（或时长为 0）时给一个极小值兜底：该字立即算「唱完」，而不是除零变 NaN
    const dur = w && w.d > 0 ? w.d : 0.001;
    const frac = (t - (w ? w.t : 0)) / dur;
    return { text: (w && w.text) || "", frac: Math.max(0, Math.min(1, frac)) };
  });
}
