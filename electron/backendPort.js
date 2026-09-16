// backendPort：后端端口的选择策略（纯函数，便于自检）。
//
// ⚠️⚠️ 端口必须**按数据根目录稳定**，不能每次随机。
//
// 渲染进程是从 `http://127.0.0.1:<端口>` 加载的，而 **localStorage 按 origin 隔离**
// （origin 含端口）。端口一变 origin 就变，用户所有设置（主题、字号、播放选项、
// 最近播放列表…）都会「重置」——数据其实还在磁盘上，只是挂在另一个 origin 下。
//
// 实测原来的 `listen(0)`（让系统随便给一个临时端口）每次启动都不同：
// 53375 / 53414 / 53446。应用常驻托盘、平时很少重启，所以用户只在**升级后**才注意到
// 「字体大小等设置被重置」。
//
// 用数据根目录做哈希：同一个安装 → 同一个端口（origin 稳定，设置得以留存）；
// 不同安装（便携版 + 安装版）→ 不同端口，仍然互不串后端 ——
// 这是当初改用动态端口的初衷，不能被破坏。
//
// 抽到这个模块是为了能直接单测：main.js 依赖 Electron，测不了。

/** 端口区间起点（避开常用端口与系统临时端口段） */
const PORT_RANGE_START = 41000;
/** 区间大小：41000 ~ 58999 */
const PORT_RANGE_SIZE = 18000;
/** 稳定端口被占时往后顺延的尝试次数 */
const PORT_TRIES = 20;

/**
 * 由数据根目录算出一个稳定的端口号（同输入必同输出）。
 * 用 FNV-1a：实现短、分布够均匀，且不依赖任何库（项目零运行时依赖）。
 */
function stablePortFor(root) {
  let h = 2166136261; // FNV-1a 偏移基数
  const s = String(root || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PORT_RANGE_START + (h % PORT_RANGE_SIZE);
}

/** 依次给出要尝试的端口：稳定端口 + 顺延（应对偶发占用） */
function candidatePorts(root, tries = PORT_TRIES) {
  const base = stablePortFor(root);
  const out = [];
  for (let i = 0; i < Math.max(1, tries); i++) out.push(base + i);
  return out;
}

module.exports = { stablePortFor, candidatePorts, PORT_RANGE_START, PORT_RANGE_SIZE, PORT_TRIES };
