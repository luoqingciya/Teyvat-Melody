// autoSkip：播放出错后要不要自动切下一首。
//
// 抽成纯函数是为了能直接单测这条**有上限**的判定 —— 它是「整表都坏」时唯一的刹车：
// 音乐目录被移走、代理挂掉这类情况下，无上限地自动切歌会在几秒内把整个队列跑完，
// 并刷满一屏提示。这类边界只有在纯函数里才测得干净（player store 依赖真实 Audio 实例）。

/** 连续失败达到这个数就不再自动切歌 */
export const MAX_AUTO_SKIP = 3;

/**
 * @param {object} o
 * @param {boolean} o.enabled           用户是否开启「播放错误时自动切换歌曲」
 * @param {number}  o.consecutiveErrors 连续失败次数（已含本次）
 * @param {string}  [o.title]           出错的歌名（用于提示）
 * @param {number}  [o.max]             上限，默认 MAX_AUTO_SKIP
 * @returns {{skip: boolean, warn: string}} warn 非空时应提示用户；skip 为 false 且 warn 为空表示静默
 */
export function autoSkipDecision({ enabled, consecutiveErrors, title = "", max = MAX_AUTO_SKIP }) {
  if (!enabled) return { skip: false, warn: "" };
  if (consecutiveErrors > max) {
    // 只在「刚越过上限」的那一次提示，避免之后每次失败都重复刷同一句
    return {
      skip: false,
      warn: consecutiveErrors === max + 1 ? `连续 ${max} 首播放失败，已停止自动切歌` : "",
    };
  }
  return { skip: true, warn: `《${title}》播放失败，已自动切换下一首` };
}
