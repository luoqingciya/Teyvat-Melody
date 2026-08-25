# -*- coding: utf-8 -*-
"""音乐库管理服务：递归扫描目录、元数据解析入库与检索。

Phase 4 起由 SQLite（app.models.database）提供持久化存储，
封面以 BLOB 内嵌，列表查询不返回 cover 大字段。
"""
import shutil
import threading
import time
from pathlib import Path
from typing import Iterable, Optional

from app.models import database as db
from app.services import metadata_parser
from app.utils import paths


# ---- 扫描进度（异步扫描用，线程安全） ----
_scan_lock = threading.Lock()
_scan_counter = 0
_scan_jobs: dict[str, dict] = {}


def _next_scan_id() -> str:
    global _scan_counter
    with _scan_lock:
        _scan_counter += 1
        return str(_scan_counter)


def _push_scan(scan_id: str, patch: dict) -> None:
    with _scan_lock:
        if scan_id in _scan_jobs:
            _scan_jobs[scan_id].update(patch)


def get_scan_status(scan_id: str) -> Optional[dict]:
    """按 id 获取扫描进度；不存在返回 None。"""
    with _scan_lock:
        st = _scan_jobs.get(scan_id)
        if st is None:
            return None
        out = dict(st)
        out.pop("_ts", None)
    _prune_scan_jobs()  # 顺带清理旧任务
    return out


def _prune_scan_jobs() -> None:
    """清理已完成超 1 小时的扫描任务，避免 _scan_jobs 无限增长。"""
    now = time.time()
    with _scan_lock:
        for k in [
            k
            for k, v in _scan_jobs.items()
            if v.get("finished") and now - v.get("_ts", 0) > 3600
        ]:
            _scan_jobs.pop(k, None)


def start_scan(root: Path) -> str:
    """异步启动扫描：立即返回 scan_id，进度经 get_scan_status 轮询。"""
    scan_id = _next_scan_id()
    _scan_jobs[scan_id] = {
        "id": scan_id,
        "running": True,
        "finished": False,
        "done": 0,
        "total": 0,
        "current": "",
        "added": 0,
        "failed": [],
        "_ts": time.time(),
    }
    _prune_scan_jobs()
    threading.Thread(target=_scan_worker, args=(scan_id, str(root)), daemon=True).start()
    return scan_id


def _scan_worker(scan_id: str, root: str) -> None:
    """后台扫描主循环：逐文件入库并更新进度；单个文件失败记录不中断整体。"""
    failed: list[dict] = []

    def _cb(done: int, total: int, current: str) -> None:
        _push_scan(scan_id, {"done": done, "total": total, "current": current, "failed": failed})

    try:
        added = scan_and_register(Path(root), on_progress=_cb, failed_holder=failed)
        _push_scan(scan_id, {"added": len(added)})
    except Exception as exc:  # noqa: BLE001
        failed.append({"path": str(root), "error": str(exc)})
        _push_scan(scan_id, {"failed": failed})
    finally:
        _push_scan(scan_id, {"running": False, "finished": True, "failed": failed})


def scan_and_register(
    root: Path,
    on_progress=None,
    failed_holder: list | None = None,
) -> list[dict]:
    """递归扫描目录并把新音频文件登记入库，返回本次新增的歌曲列表。

    入库前先把音频复制到 <应用根目录>/music 保存副本（已在 music 内则跳过），
    因此库内 path 恒指向软件根目录下的副本。

    on_progress(done, total, current) 每次处理完一个文件回调一次；
    failed_holder（可选，list）用于收集失败文件 [{path,error}]。
    """
    added: list[dict] = []
    files = list(_walk_audio_files(root))
    total = len(files)
    conn = db.get_conn()
    music = paths.music_dir()
    # 一次性读取已有 path 集合，避免每个文件再发起一次 SELECT 查询
    existing_paths = {r["path"] for r in conn.execute("SELECT path FROM songs")}
    # 已登记过的原始源路径：重扫同一目录时据此跳过，避免反复复制出 "xxx (1).mp3" 并重复入库
    existing_sources = {
        r["source_path"]
        for r in conn.execute("SELECT source_path FROM songs WHERE source_path IS NOT NULL")
    }
    try:
        for i, file in enumerate(files, 1):
            source_key = str(file.resolve())
            if source_key in existing_sources:
                if on_progress:
                    on_progress(i, total, str(file))
                continue
            fail: Optional[dict] = None
            try:
                stored = _store_copy(file, music)
                meta = metadata_parser.parse(stored)
                cover = meta.pop("cover", None)
                stored_path = str(stored)
                is_new = stored_path not in existing_paths
                existing_paths.add(stored_path)
                existing_sources.add(source_key)
                cur = conn.execute(
                    "INSERT INTO songs(path, title, artist, album, duration, cover, lyrics, "
                    "sample_rate, bitrate, channels, format, source_path) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(path) DO UPDATE SET "
                    "title=excluded.title, artist=excluded.artist, album=excluded.album, "
                    "duration=excluded.duration, cover=excluded.cover, lyrics=excluded.lyrics, "
                    "sample_rate=excluded.sample_rate, bitrate=excluded.bitrate, "
                    "channels=excluded.channels, format=excluded.format, "
                    "source_path=excluded.source_path",
                    (
                        str(stored),
                        meta["title"],
                        meta["artist"],
                        meta["album"],
                        meta["duration"],
                        cover,
                        meta.get("lyrics"),
                        meta.get("sample_rate", 0),
                        meta.get("bitrate", 0),
                        meta.get("channels", 0),
                        meta.get("format", ""),
                        source_key,
                    ),
                )
                if is_new:
                    added.append(_row_or_meta(cur.lastrowid, meta, has_cover=cover is not None))
            except Exception as exc:  # noqa: BLE001
                fail = {"path": str(file), "error": str(exc)}
            if fail and failed_holder is not None:
                failed_holder.append(fail)
            if on_progress:
                on_progress(i, total, str(file))
        conn.commit()
    finally:
        conn.close()
    return added


def _store_copy(src: Path, dest_dir: Path) -> Path:
    """把音频复制到软件根目录 music 目录，返回复制后的路径。

    源已在 dest_dir 内则直接返回；重名时追加序号避免覆盖；
    复制失败（权限/占用）则回退返回原路径继续入库。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    if src.parent.resolve() == dest_dir.resolve():
        return src
    dest = dest_dir / src.name
    stem, suffix = src.stem, src.suffix
    counter = 1
    while dest.exists():
        dest = dest_dir / f"{stem} ({counter}){suffix}"
        counter += 1
    try:
        shutil.copy2(src, dest)
        # 同步复制源目录同名的 .lrc 歌词（若存在），保证外挂歌词随复制入库后仍能被找到
        src_lrc = src.with_suffix(".lrc")
        if src_lrc.is_file():
            try:
                shutil.copy2(src_lrc, dest.with_suffix(".lrc"))
            except OSError:
                pass
        return dest
    except OSError:
        return src


def all_songs() -> list[dict]:
    """获取全部歌曲（列表字段，不含 cover 大字段）。"""
    return db.fetch_all(
        f"SELECT {db.SONG_COLS} FROM songs ORDER BY title COLLATE NOCASE, artist"
    )


def get_song(song_id: int) -> Optional[dict]:
    """按 id 获取单曲；不存在返回 None。"""
    row = db.fetch_one(
        f"SELECT {db.SONG_COLS} FROM songs WHERE id = ?", (song_id,)
    )
    return row if row else None


def get_song_path(song_id: int) -> Optional[str]:
    """按 id 获取音频文件路径（流接口 / 标签写回用）。"""
    row = db.fetch_one("SELECT path FROM songs WHERE id = ?", (song_id,))
    return row["path"] if row else None


def get_song_cover(song_id: int) -> Optional[bytes]:
    """按 id 获取内嵌封面字节；无封面返回 None。"""
    row = db.fetch_one("SELECT cover FROM songs WHERE id = ?", (song_id,))
    return row["cover"] if row else None


def get_song_lyrics(song_id: int) -> Optional[str]:
    """按 id 获取歌词文本；无歌词返回 None。"""
    row = db.fetch_one("SELECT lyrics FROM songs WHERE id = ?", (song_id,))
    return row["lyrics"] if row else None


def get_song_lrc_file(song_id: int) -> Optional[str]:
    """按 id 读取与音频同目录同名的 .lrc 文件内容；不存在返回 None。

    仅作内嵌歌词缺失时的补充来源（UTF-8 / GBK 自动解码）。
    """
    path = get_song_path(song_id)
    if not path:
        return None
    lrc_path = Path(path).with_suffix(".lrc")
    if not lrc_path.is_file():
        return None
    for enc in ("utf-8", "gbk"):
        try:
            return lrc_path.read_text(encoding=enc)
        except (UnicodeDecodeError, OSError):
            continue
    try:
        return lrc_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def get_favorites() -> list[dict]:
    """获取收藏歌曲列表。"""
    return db.fetch_all(
        f"SELECT {db.SONG_COLS} FROM songs WHERE favorite = 1 "
        "ORDER BY title COLLATE NOCASE, artist"
    )


def toggle_favorite(song_id: int) -> Optional[bool]:
    """切换收藏状态，返回切换后的布尔值；歌曲不存在返回 None。"""
    cur = db.fetch_one("SELECT favorite FROM songs WHERE id = ?", (song_id,))
    if cur is None:
        return None
    new_state = 1 if not cur["favorite"] else 0
    db.execute("UPDATE songs SET favorite = ? WHERE id = ?", (new_state, song_id))
    return bool(new_state)


def update_song_metadata(song_id: int, title: str, artist: str, album: str) -> Optional[dict]:
    """编辑歌曲标签并写回文件 + 数据库。成功返回更新后的歌曲，失败返回 None。"""
    path = get_song_path(song_id)
    if not path:
        return None
    # 先写回文件；失败不阻断数据库更新（用户仍能保留编辑值）
    metadata_parser.write_tags(Path(path), title, artist, album)
    updates = []
    params = []
    if title is not None:
        updates.append("title = ?")
        params.append(title)
    if artist is not None:
        updates.append("artist = ?")
        params.append(artist)
    if album is not None:
        updates.append("album = ?")
        params.append(album)
    if updates:
        params.append(song_id)
        db.execute(f"UPDATE songs SET {', '.join(updates)} WHERE id = ?", params)
    return get_song(song_id)


def set_song_lyrics(song_id: int, text: str) -> Optional[dict]:
    """编辑歌词：写入与音频同目录的 <stem>.lrc 文件，并更新数据库 lyrics 字段。

    text 为空则表示清空内嵌歌词字段（不删除 lrc 文件）。成功返回更新后歌曲。
    """
    path = get_song_path(song_id)
    if not path:
        return None
    value = (text or "").strip() or None
    try:
        lrc_path = Path(path).with_suffix(".lrc")
        if value:
            lrc_path.write_text(value, encoding="utf-8")
        else:
            # 清空歌词：只删除应用自己管理的 music 歌词副本，避免误删用户源目录里的 .lrc
            try:
                if lrc_path.is_file() and lrc_path.parent.resolve() == paths.music_dir().resolve():
                    lrc_path.unlink()
            except OSError:
                pass
        db.execute("UPDATE songs SET lyrics = ? WHERE id = ?", (value, song_id))
    except OSError:
        # 写文件失败不阻断：仍更新数据库字段（用户编辑值可得保留）
        db.execute("UPDATE songs SET lyrics = ? WHERE id = ?", (value, song_id))
    return get_song(song_id)


def get_duplicates() -> list[dict]:
    """检测重复歌曲：同「标题 + 艺术家」（或仅标题）视为疑似重复。

    返回分组列表：[{ title, artist, count, songs: [...] }]，按 count 降序。
    """
    rows = db.fetch_all(
        f"SELECT {db.SONG_COLS} FROM songs ORDER BY title COLLATE NOCASE, artist"
    )
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        # 有 artist 时按 (title, artist)，否则退化为按 title 聚
        key = (r["title"].strip().lower(), (r["artist"] or "").strip().lower())
        if not key[1]:
            key = (key[0], "*")
        groups.setdefault(key, []).append(r)
    result = []
    for (t, a), songs in groups.items():
        if len(songs) > 1:
            result.append({
                "title": t,
                "artist": "" if a == "*" else a,
                "count": len(songs),
                "songs": songs,
            })
    result.sort(key=lambda g: g["count"], reverse=True)
    return result


def record_play(song_id: int) -> None:
    """记录一次播放（去重：同一歌 5 秒内只记一次，避免连点刷量）。"""
    if song_id is None:
        return
    last = db.fetch_one(
        "SELECT played_at FROM playback_history WHERE song_id = ? "
        "ORDER BY id DESC LIMIT 1",
        (song_id,),
    )
    if last:
        try:
            from datetime import datetime

            t = datetime.strptime(last["played_at"], "%Y-%m-%d %H:%M:%S")
            if (datetime.now() - t).total_seconds() < 5:
                return
        except (ValueError, TypeError):
            pass
    db.execute("INSERT INTO playback_history(song_id) VALUES (?)", (song_id,))


def get_playback_history(limit: int = 100) -> list[dict]:
    """返回最近播放历史（附歌曲信息），按时间倒序。"""
    rows = db.fetch_all(
        f"SELECT ph.id AS history_id, ph.played_at, {db.SONG_COLS_Q} "
        "FROM playback_history ph JOIN songs s ON s.id = ph.song_id "
        "ORDER BY ph.id DESC LIMIT ?",
        (max(1, int(limit)),),
    )
    return rows


def get_playback_stats(days: int = 30) -> dict:
    """聚合播放统计（报告用）：
    - total_plays 总播放次数
    - unique_songs 播放过的不同歌曲数
    - play_duration 累计播放时长（秒，按歌曲时长近似）
    - top_songs 播放最多的歌曲 TOP N
    - daily 最近 N 天每日播放次数
    - monthly 最近 12 个月每月播放次数
    """
    days = max(1, min(int(days), 365))
    total = db.fetch_one("SELECT COUNT(*) AS c FROM playback_history") or {}
    total_plays = total.get("c", 0)

    unique = db.fetch_one("SELECT COUNT(DISTINCT song_id) AS c FROM playback_history") or {}
    unique_songs = unique.get("c", 0)

    dur = db.fetch_one(
        "SELECT COALESCE(SUM(s.duration), 0) AS d "
        "FROM playback_history ph JOIN songs s ON s.id = ph.song_id"
    ) or {}
    play_duration = round(dur.get("d", 0), 1)

    top = db.fetch_all(
        "SELECT s.id, s.title, s.artist, COUNT(*) AS plays, s.duration "
        "FROM playback_history ph JOIN songs s ON s.id = ph.song_id "
        "GROUP BY s.id ORDER BY plays DESC LIMIT 10"
    )
    daily = db.fetch_all(
        "SELECT date(played_at) AS day, COUNT(*) AS plays "
        "FROM playback_history "
        f"WHERE played_at >= datetime('now', 'localtime', '-{days} days') "
        "GROUP BY day ORDER BY day"
    )

    monthly = db.fetch_all(
        "SELECT strftime('%Y-%m', played_at) AS month, COUNT(*) AS plays "
        "FROM playback_history "
        f"WHERE played_at >= datetime('now', 'localtime', '-12 months') "
        "GROUP BY month ORDER BY month"
    )

    return {
        "total_plays": total_plays,
        "unique_songs": unique_songs,
        "play_duration": play_duration,
        "days": days,
        "top_songs": top,
        "daily": daily,
        "monthly": monthly,
    }


def _row_or_meta(song_id: int, meta: dict, has_cover: bool) -> dict:
    return {
        "id": song_id,
        "path": meta["path"],
        "title": meta["title"],
        "artist": meta["artist"],
        "album": meta["album"],
        "duration": meta["duration"],
        "favorite": 0,
        "has_cover": has_cover,
        "sample_rate": meta.get("sample_rate", 0),
        "bitrate": meta.get("bitrate", 0),
        "channels": meta.get("channels", 0),
        "format": meta.get("format", ""),
    }


def _walk_audio_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    for p in root.rglob("*"):
        if p.is_file() and metadata_parser.is_supported(p):
            yield p
