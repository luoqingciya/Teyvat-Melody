# -*- coding: utf-8 -*-
"""在线音频磁盘缓存。

**为什么需要**：源脚本解析出的 CDN 地址带时效签名，每次播放都不一样 —— 浏览器据此无法命中缓存
（缓存键每次都变）。但同一首歌的音频字节本身是稳定的，所以缓存以「平台 + 平台ID + 音质」
构成的**稳定键**为准，与 CDN 签名无关。

**策略**：播放时顺手写盘，**不阻塞本次播放** —— 首次播放照旧边下边播，同时把完整流写入临时文件，
读完才转正为缓存；下次播放同一首直接由本地文件提供（`send_file(conditional=True)` 天然支持 Range，
所以 seek 也走本地，比重新联网快得多）。

**淘汰**：按「最近最少使用」—— 命中时刷新 mtime，超出容量上限时从最旧的开始删。

**位置**：`<软件根目录>/cache/`（与 data / music 一致，便于整目录搬移）。
"""
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

from app.utils.paths import cache_dir as _root_cache_dir

DEFAULT_MAX_BYTES = 1024 ** 3  # 1 GiB
# 可选容量上限（设置页下拉用），单位字节
MAX_BYTES_OPTIONS = [256 * 1024 ** 2, 512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3]

_evict_lock = threading.Lock()

# 缓存文件扩展名 → 回传给 <audio> 的 MIME
_EXT_MIME = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
}


def cache_dir() -> Path:
    return _root_cache_dir() / "audio"


def lyrics_dir() -> Path:
    """歌词缓存目录（由主进程写入，Flask 只负责统计与清空）。"""
    return _root_cache_dir() / "lyrics"


def _config_path() -> Path:
    return _root_cache_dir() / "config.json"


def load_config() -> dict:
    """读取缓存配置（缺省：开启、上限 1 GiB、代理未启用）。

    ⚠️ 这个文件是**跨进程共享**的（主进程也直接读它，见 electron/appConfig.js），
    往 schema 里加键时两边都要同步 —— 尤其 `save_config()` 是白名单实现。
    """
    try:
        raw = json.loads(_config_path().read_text("utf-8"))
    except Exception:  # noqa: BLE001  文件不存在 / 损坏都退回默认
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    try:
        max_bytes = int(raw.get("maxBytes", DEFAULT_MAX_BYTES))
    except (TypeError, ValueError):
        max_bytes = DEFAULT_MAX_BYTES
    return {
        "enabled": bool(raw.get("enabled", True)),
        "maxBytes": max(0, max_bytes),
        "proxy": _normalize_proxy(raw.get("proxy")),
    }


def _normalize_proxy(raw) -> dict:
    """归一化代理配置。**任何不完整/非法的组合都退回「未启用」** ——
    半填的配置若被判为「已启用」，会让整个应用连不上网，比不生效糟得多。
    判据必须与 electron/proxy.js 的 normalizeProxy 完全一致。"""
    off = {"enabled": False, "host": "", "port": 0}
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return off
    host = str(raw.get("host") or "").strip()
    if not host:
        return off
    try:
        port = int(raw.get("port"))
    except (TypeError, ValueError):
        return off
    if port < 1 or port > 65535:
        return off
    return {"enabled": True, "host": host, "port": port}


def save_config(patch: dict) -> dict:
    """更新配置（仅接受 enabled / maxBytes / proxy），返回最新配置。

    ⚠️ 白名单实现：新增可保存字段必须在这里放行，否则界面写进来会被**静默丢弃**。
    """
    cfg = load_config()
    if "enabled" in patch:
        cfg["enabled"] = bool(patch["enabled"])
    if "maxBytes" in patch:
        try:
            cfg["maxBytes"] = max(0, int(patch["maxBytes"]))
        except (TypeError, ValueError):
            pass
    if "proxy" in patch:
        # 只收合法配置；非法值原样保留（不写入），是否报错交给调用方决定 ——
        # save_config 是底层辅助函数，抛异常会波及别的调用方。
        # 面向用户的拒绝发生在 app/api/online.py 的 /cache/config（那里会返回 400）。
        ok_, _reason, normalized = validate_proxy_save(patch["proxy"])
        if ok_:
            cfg["proxy"] = normalized
    try:
        _config_path().parent.mkdir(parents=True, exist_ok=True)
        _config_path().write_text(json.dumps(cfg, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    return cfg


def proxy_config() -> dict:
    """当前代理配置（已归一化）。"""
    return load_config()["proxy"]


def validate_proxy_save(raw) -> tuple[bool, str, dict]:
    """保存代理配置前校验。返回 (是否接受, 拒绝原因, 归一化结果)。

    与 electron/proxy.js 的 validateProxySave 是**同一套判据**（跨语言镜像）。
    单独在写入口再拦一道的理由：后端也是 `cache/config.json` 的写入方，任何一方
    放行了非法配置，另一方读到的就是「看着有值、其实没设」。

    两种拒绝：
      ① 启用但填不全 → 拒（否则用户以为开了，实际直连）
      ② 没启用但**填了且填错** → 拒（否则存成空配置，输入框里却留着用户的字）
    只有「开关关着 + 两个框都空」才算正当清空。
    """
    src = raw if isinstance(raw, dict) else {}
    enabled = bool(src.get("enabled"))
    host = str(src.get("host") or "").strip()
    raw_port = src.get("port")
    port_s = "" if raw_port is None else str(raw_port).strip()

    # 判定「填错了」看字段本身是否有效，不能用 enabled=False 的归一化结果比对 ——
    # 那样会把「先填好、暂不启用」也误杀。
    as_on = _normalize_proxy({"enabled": True, "host": host, "port": raw_port})
    if enabled and not as_on["enabled"]:
        return False, "请填写有效的代理主机与端口（1-65535）", as_on
    touched = host != "" or port_s != ""
    if not enabled and touched and not as_on["enabled"]:
        return False, "代理主机或端口填写有误（端口需为 1-65535），请检查后再关闭", as_on
    # 接受时返回**按调用方 enabled 归一化**的结果：开关关着就该返回 enabled=False，
    # 不能把探测用的 as_on（恒为 True）透传出去 —— 那会让「先填好、暂不启用」变成真启用。
    return True, "", _normalize_proxy({"enabled": enabled, "host": host, "port": raw_port})


def proxy_url() -> Optional[str]:
    """代理的 `http://host:port` 形式；未启用时 None。"""
    cfg = proxy_config()
    return f"http://{cfg['host']}:{cfg['port']}" if cfg["enabled"] else None


def enabled() -> bool:
    return load_config()["enabled"]


def key_to_name(key: str) -> str:
    """稳定键 → 文件名（sha1，避免键里的冒号/中文落到路径上）。"""
    return hashlib.sha1(str(key).encode("utf-8")).hexdigest()


def ext_for(content_type: str) -> str:
    """按上游 Content-Type 决定缓存文件扩展名（用于回传正确的 MIME）。"""
    ct = (content_type or "").lower()
    if "flac" in ct:
        return ".flac"
    if "mp4" in ct or "m4a" in ct or "aac" in ct:
        return ".m4a"
    if "wav" in ct:
        return ".wav"
    if "ogg" in ct or "opus" in ct:
        return ".ogg"
    return ".mp3"


def mimetype_for(path: Path) -> str:
    return _EXT_MIME.get(path.suffix.lower(), "application/octet-stream")


def cached_path(key: str) -> Optional[Path]:
    """命中则返回缓存文件并刷新访问时间（LRU 依据）；未命中返回 None。"""
    if not key:
        return None
    stem = key_to_name(key)
    d = cache_dir()
    if not d.is_dir():
        return None
    for p in d.glob(stem + ".*"):
        if p.suffix == ".part":
            continue
        try:
            os.utime(p, None)  # 刷新 mtime = 最近使用
            return p
        except OSError:
            return None
    return None


def temp_path(key: str) -> Path:
    """写缓存用的临时文件路径（读完才转正，中途失败不会留下半个文件冒充缓存）。"""
    d = cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d / (key_to_name(key) + ".part")


def commit(key: str, tmp: Path, content_type: str = "") -> None:
    """把临时文件转正为缓存，随后按上限淘汰。"""
    if not key or not tmp.is_file():
        return
    try:
        tmp.replace(cache_dir() / (key_to_name(key) + ext_for(content_type)))
    except OSError:
        return
    evict()


def discard(tmp: Optional[Path]) -> None:
    """丢弃未完成的临时文件（客户端中断、上游出错等）。"""
    if not tmp:
        return
    try:
        tmp.unlink()
    except OSError:
        pass


def _iter_entries(include_partial: bool = False, directory: Optional[Path] = None):
    """遍历缓存文件。include_partial=True 时也带上未完成的 `.part`。

    `.part` 是「边播边写」的中间产物：播放中它一直在长大，但只有读完才转正。
    统计占用时必须算上它 —— 否则播放期间界面上看到的数字纹丝不动，
    用户会以为缓存没生效（这正是最初被报上来的现象）。
    """
    d = directory if directory is not None else cache_dir()
    if not d.is_dir():
        return
    for p in d.glob("*"):
        if p.suffix == ".part" and not include_partial:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        yield st.st_mtime, st.st_size, p


def _dir_usage(directory: Path) -> tuple[int, int]:
    """目录占用（字节数, 文件数）。目录不存在时返回 (0, 0)。"""
    total = 0
    count = 0
    for _mtime, size, _p in _iter_entries(include_partial=True, directory=directory):
        total += size
        count += 1
    return total, count


# 未完成的临时文件超过这个时长仍无写入，视为被遗弃（应用被杀等）
_ABANDONED_PART_SECONDS = 3600


def _clean_abandoned_parts() -> int:
    """清理被遗弃的 `.part`（应用异常退出后残留），返回清理个数。"""
    now = time.time()
    removed = 0
    for mtime, _size, p in _iter_entries(include_partial=True):
        if p.suffix != ".part":
            continue
        if now - mtime > _ABANDONED_PART_SECONDS:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def evict() -> None:
    """超出容量上限时，从最久未使用的开始删，直到回到上限内。"""
    _clean_abandoned_parts()
    cfg = load_config()
    limit = cfg["maxBytes"]
    if limit <= 0:
        return
    with _evict_lock:
        # 容量统计含 `.part`（它同样占盘），但淘汰只动已完成的条目 ——
        # 删掉正在写的临时文件会打断当前播放
        entries = list(_iter_entries(include_partial=True))
        total = sum(size for _mtime, size, _p in entries)
        if total <= limit:
            return
        removable = sorted((e for e in entries if e[2].suffix != ".part"))
        for _mtime, size, p in removable:
            if total <= limit:
                break
            try:
                p.unlink()
                total -= size
            except OSError:
                pass


def stats() -> dict:
    """缓存占用情况（设置页展示）。

    `bytes` 含进行中的 `.part`（同样是磁盘占用），另单独给出 `partialBytes`，
    便于界面区分「已缓存」与「正在下载」。

    `lyricsBytes` / `lyricsFiles` 是**歌词缓存**（主进程写入的 JSON，单文件几 KB）。
    它单独列出而不是并进 `bytes` —— 容量上限只约束音频，混在一起会让用户
    觉得「明明没超上限怎么就被清了」。`totalBytes` 才是磁盘总占用。
    """
    cfg = load_config()
    total = 0
    partial = 0
    count = 0
    for _mtime, size, p in _iter_entries(include_partial=True):
        total += size
        if p.suffix == ".part":
            partial += size
        else:
            count += 1
    lyrics_bytes, lyrics_files = _dir_usage(lyrics_dir())
    return {
        "enabled": cfg["enabled"],
        "maxBytes": cfg["maxBytes"],
        "maxBytesOptions": MAX_BYTES_OPTIONS,
        "bytes": total,
        "files": count,
        "partialBytes": partial,
        "lyricsBytes": lyrics_bytes,
        "lyricsFiles": lyrics_files,
        "totalBytes": total + lyrics_bytes,
    }


def clear(kind: str = "all") -> dict:
    """清空缓存。

    `kind`：`audio` 只清音频、`lyrics` 只清歌词、其它/缺省清全部。

    ⚠️ 分开清是有必要的：两者性质完全不同 —— 音频动辄几十 MB（容量上限只约束它），
    歌词只有几十 KB 但份数多。用户常常只想清其中一类（比如歌词对不上想重取，
    却不想把几十 MB 的音频也扔掉）。
    """
    dirs = {"audio": [cache_dir()], "lyrics": [lyrics_dir()]}.get(kind)
    if dirs is None:
        dirs = [cache_dir(), lyrics_dir()]
    removed = 0
    freed = 0
    for d in dirs:
        if not d.is_dir():
            continue
        for p in d.glob("*"):
            try:
                freed += p.stat().st_size
                p.unlink()
                removed += 1
            except OSError:
                pass
    return {"removed": removed, "freed": freed, "kind": kind}
