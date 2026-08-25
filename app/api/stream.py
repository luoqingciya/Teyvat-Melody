# -*- coding: utf-8 -*-
"""音频流接口：/stream/<song_id>。

通过 werkzeug 的 conditional 请求处理返回 Range（206 Partial Content），
确保 HTML5 Audio 能进行进度拖拽与快速 seek。
"""
import mimetypes
from pathlib import Path

from flask import Blueprint, abort, send_file

from app.services import library_service

bp = Blueprint("stream", __name__)

# 常见音频扩展 → mimetype（mimetypes 对部分格式识别不全，显式兜底）
_AUDIO_MIMES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


@bp.get("/<int:song_id>")
def stream_song(song_id: int):
    """按 id 返回对应音频文件的字节流，支持 Range 请求。"""
    path = library_service.get_song_path(song_id)
    if not path:
        abort(404)
    try:
        mime = (
            _AUDIO_MIMES.get(Path(path).suffix.lower())
            or mimetypes.guess_type(path)[0]
            or "application/octet-stream"
        )
        # conditional=True 开启 If-Range / Range 处理，命中时返回 206
        return send_file(
            path,
            conditional=True,
            mimetype=mime,
            max_age=0,
        )
    except FileNotFoundError:
        abort(404)