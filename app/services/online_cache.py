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


def _config_path() -> Path:
    return _root_cache_dir() / "config.json"


def load_config() -> dict:
    """读取缓存配置（缺省：开启、上限 1 GiB）。"""
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
    return {"enabled": bool(raw.get("enabled", True)), "maxBytes": max(0, max_bytes)}


def save_config(patch: dict) -> dict:
    """更新缓存配置（仅接受 enabled / maxBytes），返回最新配置。"""
    cfg = load_config()
    if "enabled" in patch:
        cfg["enabled"] = bool(patch["enabled"])
    if "maxBytes" in patch:
        try:
            cfg["maxBytes"] = max(0, int(patch["maxBytes"]))
        except (TypeError, ValueError):
            pass
    try:
        _config_path().parent.mkdir(parents=True, exist_ok=True)
        _config_path().write_text(json.dumps(cfg, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    return cfg


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


def _iter_entries():
    d = cache_dir()
    if not d.is_dir():
        return
    for p in d.glob("*"):
        if p.suffix == ".part":
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        yield st.st_mtime, st.st_size, p


def evict() -> None:
    """超出容量上限时，从最久未使用的开始删，直到回到上限内。"""
    cfg = load_config()
    limit = cfg["maxBytes"]
    if limit <= 0:
        return
    with _evict_lock:
        entries = list(_iter_entries())
        total = sum(size for _mtime, size, _p in entries)
        if total <= limit:
            return
        entries.sort()  # mtime 升序 = 最旧的在前
        for _mtime, size, p in entries:
            if total <= limit:
                break
            try:
                p.unlink()
                total -= size
            except OSError:
                pass


def stats() -> dict:
    """缓存占用情况（设置页展示）。"""
    cfg = load_config()
    total = 0
    count = 0
    for _mtime, size, _p in _iter_entries():
        total += size
        count += 1
    return {
        "enabled": cfg["enabled"],
        "maxBytes": cfg["maxBytes"],
        "maxBytesOptions": MAX_BYTES_OPTIONS,
        "bytes": total,
        "files": count,
    }


def clear() -> dict:
    """清空缓存（含未完成的临时文件）。"""
    removed = 0
    freed = 0
    d = cache_dir()
    if d.is_dir():
        for p in d.glob("*"):
            try:
                freed += p.stat().st_size
                p.unlink()
                removed += 1
            except OSError:
                pass
    return {"removed": removed, "freed": freed}
