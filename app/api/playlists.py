# -*- coding: utf-8 -*-
"""歌单相关接口。"""
from flask import Blueprint, request

from app.models.schemas import fail, ok
from app.services import playlist_service

bp = Blueprint("playlists", __name__)


@bp.get("/playlists")
def list_playlists():
    """获取歌单列表（含歌曲数）。"""
    return ok(playlist_service.list_playlists())


@bp.post("/playlists")
def create_playlist():
    """创建歌单。"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return fail("name is required")
    return ok(playlist_service.create_playlist(name))


@bp.put("/playlists/<int:playlist_id>")
def rename_playlist(playlist_id: int):
    """重命名歌单。"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return fail("name is required")
    if not playlist_service.rename_playlist(playlist_id, name):
        return fail("playlist not found", 404)
    return ok({"id": playlist_id, "name": name})


@bp.delete("/playlists/<int:playlist_id>")
def delete_playlist(playlist_id: int):
    """删除歌单（级联删除其内歌曲关联）。"""
    playlist_service.delete_playlist(playlist_id)
    return ok({"id": playlist_id})


@bp.get("/playlists/<int:playlist_id>/songs")
def get_playlist_songs(playlist_id: int):
    """获取歌单内歌曲（按顺序）。"""
    return ok(playlist_service.get_playlist_songs(playlist_id))


@bp.put("/playlists/<int:playlist_id>/songs")
def update_playlist_songs(playlist_id: int):
    """批量设置歌单内歌曲顺序（整体替换）。"""
    data = request.get_json(silent=True) or {}
    song_ids = data.get("song_ids") or []
    return ok(playlist_service.set_playlist_songs(playlist_id, [int(s) for s in song_ids]))


@bp.post("/playlists/<int:playlist_id>/songs")
def add_playlist_song(playlist_id: int):
    """向歌单追加一首歌。"""
    data = request.get_json(silent=True) or {}
    song_id = data.get("song_id")
    if not song_id:
        return fail("song_id is required")
    added = playlist_service.add_song_to_playlist(playlist_id, int(song_id))
    return ok({"added": added})


@bp.get("/playlists/<int:playlist_id>/export")
def export_playlist(playlist_id: int):
    """导出歌单为 m3u 文本。"""
    m3u = playlist_service.export_playlist_m3u(playlist_id)
    if m3u is None:
        return fail("playlist not found", 404)
    return ok({"m3u": m3u})


@bp.post("/playlists/<int:playlist_id>/import")
def import_playlist(playlist_id: int):
    """从 m3u 文本导入歌曲到歌单。"""
    data = request.get_json(silent=True) or {}
    m3u = data.get("m3u") or ""
    added = playlist_service.import_playlist_m3u(playlist_id, m3u)
    return ok({"added": added})