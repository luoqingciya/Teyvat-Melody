// 自检：优先音质排序 + 播放出错自动切歌的刹车。
// 两条都是纯函数，直接打函数；不依赖 Electron / Audio。
import { buildQualityChain, QUALITY_CHAIN } from "../electron/sourceManager.js";
import { autoSkipDecision, MAX_AUTO_SKIP } from "../frontend/src/utils/autoSkip.js";
import { buildWordSpans } from "../frontend/src/utils/karaokeWords.js";

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

console.log("---- 优先音质：buildQualityChain ----");

// 默认（全部勾选）→ 与降级链一致
ok(
  "默认全勾选时顺序 = 降级链",
  JSON.stringify(buildQualityChain(QUALITY_CHAIN, "", QUALITY_CHAIN)) === JSON.stringify(QUALITY_CHAIN),
  JSON.stringify(buildQualityChain(QUALITY_CHAIN, "", QUALITY_CHAIN))
);

// 只勾 128k：它排最前，其余仍在后面兜底（关键：不做过滤，否则会「搜得到播不了」）
{
  const c = buildQualityChain(QUALITY_CHAIN, "", ["128k"]);
  ok("只勾 128k 时它排最前", c[0] === "128k", JSON.stringify(c));
  ok("⚠️ 未勾选的音质仍保留在后面兜底（不做过滤）", c.length === QUALITY_CHAIN.length, JSON.stringify(c));
  ok("兜底部分仍是高→低", JSON.stringify(c.slice(1)) === JSON.stringify(["flac24bit", "flac", "320k"]), JSON.stringify(c));
}

// 只勾中间档
{
  const c = buildQualityChain(QUALITY_CHAIN, "", ["320k", "128k"]);
  ok("勾 320k+128k → 这两档在前且按高→低", JSON.stringify(c.slice(0, 2)) === JSON.stringify(["320k", "128k"]), JSON.stringify(c));
}

// 单曲偏好最优先，且不被全局列表挤掉
{
  const c = buildQualityChain(QUALITY_CHAIN, "flac", ["128k"]);
  ok("单曲偏好排在全局优先之前", c[0] === "flac", JSON.stringify(c));
}

// 源只声明部分音质 → 只出现支持的
{
  const c = buildQualityChain(["128k"], "", QUALITY_CHAIN);
  ok("源只支持 128k 时链里只有 128k", JSON.stringify(c) === JSON.stringify(["128k"]), JSON.stringify(c));
}

// 源声明了非标准音质 → 排在最后，仍可尝试
{
  const c = buildQualityChain(["320k", "hires"], "", ["320k"]);
  ok("非标准音质排在最后", c[c.length - 1] === "hires", JSON.stringify(c));
}

// 源什么都没声明 → 兜底一个，不能返回空链（空链会直接播不出来）
{
  ok("源未声明音质时不返回空链", buildQualityChain([], "", []).length === 1, JSON.stringify(buildQualityChain([], "", [])));
  ok("源未声明且无偏好 → 兜底 128k", buildQualityChain([], "", [])[0] === "128k", JSON.stringify(buildQualityChain([], "", [])));
}

// 重复项不应出现
{
  const c = buildQualityChain(QUALITY_CHAIN, "flac", ["flac", "320k"]);
  ok("链内无重复项", new Set(c).size === c.length, JSON.stringify(c));
}

// 全局列表传空数组 = 不启用该功能
ok(
  "优先列表为空时退回默认链",
  JSON.stringify(buildQualityChain(QUALITY_CHAIN, "", [])) === JSON.stringify(QUALITY_CHAIN)
);

console.log("\n---- 播放出错自动切歌 ----");

ok(
  "开关关闭 → 不切歌也不提示",
  (() => {
    const r = autoSkipDecision({ enabled: false, consecutiveErrors: 1, title: "X" });
    return r.skip === false && r.warn === "";
  })()
);

ok(
  "第 1 次失败 → 切歌并提示歌名",
  (() => {
    const r = autoSkipDecision({ enabled: true, consecutiveErrors: 1, title: "晴天" });
    return r.skip === true && r.warn.includes("晴天");
  })()
);

ok(
  `达到上限（第 ${MAX_AUTO_SKIP} 次）仍会切`,
  autoSkipDecision({ enabled: true, consecutiveErrors: MAX_AUTO_SKIP, title: "X" }).skip === true
);

ok(
  `⚠️ 超过上限（第 ${MAX_AUTO_SKIP + 1} 次）→ 停止切歌并提示一次`,
  (() => {
    const r = autoSkipDecision({ enabled: true, consecutiveErrors: MAX_AUTO_SKIP + 1, title: "X" });
    return r.skip === false && r.warn.includes("停止自动切歌");
  })()
);

ok(
  "⚠️ 再往后（第 N 次）→ 不再重复刷同一句提示",
  (() => {
    const r = autoSkipDecision({ enabled: true, consecutiveErrors: MAX_AUTO_SKIP + 5, title: "X" });
    return r.skip === false && r.warn === "";
  })()
);

ok(
  "自定义上限生效",
  autoSkipDecision({ enabled: true, consecutiveErrors: 2, title: "X", max: 1 }).skip === false
);

console.log("\n---- 逐字歌词分段 ----");

const W = [
  { t: 0, d: 1, text: "晴" },
  { t: 1, d: 1, text: "天" },
  { t: 2, d: 2, text: "好" },
];

ok("无 words 时返回空数组", buildWordSpans(null, 1).length === 0 && buildWordSpans([], 1).length === 0);

{
  const s = buildWordSpans(W, 0);
  ok("行首：第一个字 frac=0（未唱），其余也是 0", s[0].frac === 0 && s[2].frac === 0, JSON.stringify(s));
  ok("分段数与原字数一致", s.length === 3);
  ok("文本原样保留", s.map((x) => x.text).join("") === "晴天好");
}

{
  const s = buildWordSpans(W, 0.5);
  ok("第一个字唱到一半 → frac=0.5", Math.abs(s[0].frac - 0.5) < 1e-9, JSON.stringify(s));
  ok("后面的字仍未开始", s[1].frac === 0 && s[2].frac === 0);
}

{
  const s = buildWordSpans(W, 1);
  ok("第一个字唱完 → frac=1", s[0].frac === 1, JSON.stringify(s));
  ok("第二个字刚好开始 → frac=0", s[1].frac === 0, JSON.stringify(s));
}

{
  const s = buildWordSpans(W, 99);
  ok("远超结尾时全部 frac=1（不会溢出）", s.every((x) => x.frac === 1), JSON.stringify(s));
}

ok(
  "负时间（偏移把时间拉回负数）不会出现负 frac",
  buildWordSpans(W, -5).every((x) => x.frac === 0)
);

{
  // 无时长/缺字段不能变成 NaN（NaN 会让 CSS 的 --p 失效、整行变色错乱）
  const s = buildWordSpans([{ t: 0, d: 0, text: "甲" }, { t: 1, text: "乙" }], 0.5);
  ok("d=0 时立即算唱完，且不是 NaN", s[0].frac === 1 && !Number.isNaN(s[0].frac), JSON.stringify(s));
  ok("缺 d 字段时也不是 NaN", !Number.isNaN(s[1].frac), JSON.stringify(s));
}

{
  const s = buildWordSpans(W, 2.5);
  ok("第三个字（t=2,d=2）在 2.5s 时 frac=0.25", Math.abs(s[2].frac - 0.25) < 1e-9, JSON.stringify(s));
}

console.log("\n自检结束");
process.exit(FAILED);
