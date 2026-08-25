# -*- coding: utf-8 -*-
"""歌曲相关接口。"""
import io

from flask import Blueprint, Response, abort, request

from app.models.schemas import ok, fail
from app.services import library_service

bp = Blueprint("songs", __name__)


@bp.get("/songs")
def list_songs():
    """获取全量歌曲列表（进行中支持分页 / 搜索）。"""
    return ok(library_service.all_songs())


@bp.get("/songs/<int:song_id>")
def get_song(song_id: int):
    """获取单首歌曲元数据；不存在返回 404。"""
    song = library_service.get_song(song_id)
    if song is None:
        return fail("song not found", 404)
    return ok(song)


@bp.get("/songs/<int:song_id>/cover")
def get_cover(song_id: int):
    """返回专辑封面图片字节流；无封面返回 404。"""

    cover = library_service.get_song_cover(song_id)
    if cover is None:
        abort(404)
    return Response(io.BytesIO(cover).getvalue(), mimetype=_image_mimetype(cover))


def _image_mimetype(data: bytes) -> str:
    """按字节魔数判断图片真实格式，避免把 PNG/JPG 混用导致浏览器破图。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:2] == b"BM":
        return "image/bmp"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"  # 兜底：让浏览器按内容嗅探


@bp.get("/lyrics/<int:song_id>")
def get_lyrics(song_id: int):
    """返回该歌的 LRC 歌词解析结果。

    歌词来源优先音频内嵌（<stem>.lrc 之外），内嵌缺失时回退读取
    与音频同目录的同名 .lrc 文件。
    """
    from app.services import library_service
    from app.utils import lrc

    raw = library_service.get_song_lyrics(song_id)
    if not raw:
        raw = library_service.get_song_lrc_file(song_id)
    if raw is None:
        return ok({"song_id": song_id, "lines": []})
    lines = lrc.parse_lrc(raw)
    if not lines:  # 非 LRC 的纯文本，作为单行无时间轴歌词
        lines = [{"t": 0, "text": raw.strip()}]
    return ok({"song_id": song_id, "lines": lines})


@bp.get("/favorites")
def list_favorites():
    """获取收藏歌曲列表。"""
    from app.services import library_service

    return ok(library_service.get_favorites())


@bp.post("/favorites/<int:song_id>")
def toggle_favorite(song_id: int):
    """切换单曲收藏状态。"""
    from app.services import library_service

    state = library_service.toggle_favorite(song_id)
    if state is None:
        return fail("song not found", 404)
    return ok({"song_id": song_id, "favorite": state})


# ---- 播放历史 / 统计 ----

@bp.post("/songs/<int:song_id>/play")
def record_play(song_id: int):
    """记录一次播放（前端切歌 / 播放时调用）。"""
    library_service.record_play(song_id)
    return ok({"song_id": song_id})


@bp.get("/playback/history")
def playback_history():
    """获取最近播放历史（默认 100 条）。"""
    limit = request.args.get("limit", 100, type=int)
    return ok(library_service.get_playback_history(limit))


@bp.get("/playback/stats")
def playback_stats():
    """获取播放统计报告（默认近 30 天）。"""
    days = request.args.get("days", 30, type=int)
    return ok(library_service.get_playback_stats(days))


# ---- 重复歌曲检测 ----

@bp.get("/duplicates")
def duplicates():
    """检测并返回疑似重复歌曲分组。"""
    return ok(library_service.get_duplicates())


# ---- 标签编辑 / 歌词编辑（写回文件 + 数据库） ----

@bp.put("/songs/<int:song_id>")
def update_song(song_id: int):
    """编辑歌曲标签（title / artist / album，非空字段写回文件）。"""
    data = request.get_json(silent=True) or {}
    song = library_service.update_song_metadata(
        song_id,
        title=(data.get("title") or "").strip() or None,
        artist=(data.get("artist") or "").strip() or None,
        album=(data.get("album") or "").strip() or None,
    )
    if song is None:
        return fail("song not found", 404)
    return ok(song)


@bp.put("/lyrics/<int:song_id>")
def update_lyrics(song_id: int):
    """编辑歌词文本并写回 .lrc + 数据库。"""
    data = request.get_json(silent=True) or {}
    song = library_service.set_song_lyrics(song_id, data.get("text") or "")
    if song is None:
        return fail("song not found", 404)
    return ok(song)