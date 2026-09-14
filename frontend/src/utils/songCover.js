// songCoverUrl：统一计算歌曲封面地址（返回同源相对路径）。
//
// - 本地歌曲：后端封面接口；无内嵌封面时返回空串，由 AlbumArt 显示占位图。
// - 在线歌曲：远程封面经本机同源代理转发 —— 渲染进程 CSP 是 `img-src 'self' data: blob:`，
//   直接引用远程图片会被拦截，走代理即可保持 CSP 不放宽（与音频代理同一思路）。
//
// 注意：迷你小窗加载自 file://，使用方需自行拼上主窗口 origin（见 miniModeBridge）。
export function songCoverUrl(song) {
  if (!song) return "";
  if (song.online) {
    // 搜索结果用 picUrl；入库后的行来自 cover_url（decorateSong 已统一到 picUrl，这里再兜一层）
    const url = song.picUrl || song.cover_url || "";
    if (!url) return "";
    return `/api/online/image?url=${encodeURIComponent(url)}&source=${encodeURIComponent(song.source || "")}`;
  }
  return song.has_cover ? `/api/songs/${song.id}/cover` : "";
}

export default songCoverUrl;
