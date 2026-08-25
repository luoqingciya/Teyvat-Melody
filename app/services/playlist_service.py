# -*- coding: utf-8 -*-
"""歌单管理服务：歌单与歌单内歌曲的增删改查（SQLite 持久化）。"""
from __future__ import annotations

from typing import Optional

from app.models import database as db

SONG_JOIN_COLS = (
    "s.id, s.path, s.title, s.artist, s.album, s.duration, s.favorite, "
    "s.sample_rate, s.bitrate, s.channels, s.format, "
    "s.cover IS NOT NULL AS has_cover"
)


def _playlist_summary(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "song_count": row["song_count"],
    }


def list_playlists(category: Optional[str] = None) -> list[dict]:
    """返回全部歌单（含各自歌曲数）。"""
    rows = db.fetch_all(
        "SELECT p.id, p.name, p.created_at, "
        "COALESCE((SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id), 0) AS song_count "
        "FROM playlists p ORDER BY p.created_at DESC"
    )
    return [_playlist_summary(r) for r in rows]


def create_playlist(name: str) -> dict:
    playlist_id = db.execute("INSERT INTO playlists(name) VALUES (?)", (name,))
    row = db.fetch_one(
        "SELECT id, name, created_at, 0 AS song_count FROM playlists WHERE id = ?",
        (playlist_id,),
    )
    return _playlist_summary(row)


def rename_playlist(playlist_id: int, name: str) -> bool:
    if not db.fetch_one("SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)):
        return False
    db.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, playlist_id))
    return True


def delete_playlist(playlist_id: int) -> None:
    with db.get_conn() as conn:
        conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        conn.commit()


def get_playlist_songs(playlist_id: int) -> list[dict]:
    """返回歌单内歌曲（按 position 排序）。"""
    rows = db.fetch_all(
        f"SELECT {SONG_JOIN_COLS} FROM playlist_songs ps "
        "JOIN songs s ON s.id = ps.song_id "
        "WHERE ps.playlist_id = ? ORDER BY ps.position",
        (playlist_id,),
    )
    return rows


def set_playlist_songs(playlist_id: int, song_ids: list[int]) -> list[dict]:
    """以给定顺序整体替换歌单内容。"""
    # 仅保留库中真实存在的歌曲，避免非法 song_id 触发外键异常让整单回滚/返回 500
    existing_ids = {r["id"] for r in db.fetch_all("SELECT id FROM songs")}
    valid = [sid for sid in song_ids if sid in existing_ids]
    with db.get_conn() as conn:
        conn.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))
        conn.executemany(
            "INSERT INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, ?)",
            [(playlist_id, sid, pos) for pos, sid in enumerate(valid)],
        )
        conn.commit()
    return get_playlist_songs(playlist_id)


def add_song_to_playlist(playlist_id: int, song_id: int) -> bool:
    """向歌单追加一首歌（已存在则忽略）。"""
    if not db.fetch_one("SELECT 1 FROM songs WHERE id = ?", (song_id,)):
        return False
    exists = db.fetch_one(
        "SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?",
        (playlist_id, song_id),
    )
    if exists:
        return False
    with db.get_conn() as conn:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_songs WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, ?)",
            (playlist_id, song_id, pos),
        )
        conn.commit()
    return True


def export_playlist_m3u(playlist_id: int) -> Optional[str]:
    """导出歌单为 m3u 文本；歌单不存在返回 None。"""
    if not db.fetch_one("SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)):
        return None
    songs = get_playlist_songs(playlist_id)
    if not songs:
        return "#EXTM3U\n"
    lines = ["#EXTM3U"]
    for s in songs:
        dur = int(s.get("duration") or 0)
        title = s.get("title") or ""
        artist = s.get("artist") or ""
        meta = f"{dur},{title}" + (f" - {artist}" if artist else "")
        fmt = s.get("format") or ""
        lines.append(f"#EXTINF:{meta}" + (f" [{fmt}]" if fmt else ""))
        lines.append(s.get("path") or "")
    return "\n".join(lines) + "\n"


def _normalize_import_entry(entry: str) -> str:
    """标准化 m3u 路径条目：去引号、去首尾空白、磁盘转义。"""
    entry = (entry or "").strip().strip('"').strip("'")
    if entry.lower().startswith("file://"):
        entry = entry[7:]
    return entry.strip()


def import_playlist_m3u(playlist_id: int, text: str) -> int:
    """解析 m3u 文本并把匹配到的歌曲加入歌单，返回新增数量。

    匹配策略：先按绝对路径精确匹配库内 path，失败再回退按文件名 + 扩展名匹配。
    已存在的歌曲自动跳过。
    """
    if not db.fetch_one("SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)):
        return 0
    from pathlib import Path

    all_songs = db.fetch_all("SELECT id, path, title, artist FROM songs")
    by_path = {s["path"]: s["id"] for s in all_songs}
    by_name = {}
    for s in all_songs:
        key = Path(s["path"]).name
        by_name.setdefault(key, []).append(s["id"])

    added = 0
    lines = (text or "").splitlines()
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entry = _normalize_import_entry(line)
        if not entry:
            continue
        song_id = by_path.get(entry)
        if song_id is None:
            candidates = by_name.get(Path(entry).name, [])
            song_id = candidates[0] if candidates else None
        if song_id is not None:
            if add_song_to_playlist(playlist_id, song_id):
                added += 1
    return added
