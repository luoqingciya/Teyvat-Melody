# -*- coding: utf-8 -*-
"""mutagen 元数据解析：MP3 / FLAC / M4A / WAV 的标题、艺术家、专辑、时长、封面与歌词。"""
from pathlib import Path
from typing import Optional

try:
    import mutagen
    from mutagen.flac import FLAC, Picture
    from mutagen.mp4 import MP4, MP4Tags
    from mutagen.mp3 import MP3
except ImportError:  # 打包环境中 optional 依赖
    mutagen = None
    FLAC = MP4 = MP3 = Picture = MP4Tags = None


# 支持的音频扩展名
SUPPORTED_EXTS = {".mp3", ".flac", ".wav", ".m4a"}


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTS


def parse(path: Path) -> dict:
    """解析单文件元数据，返回统一字典。解析失败时降级为核心字段。"""
    info: dict = {
        "id": None,
        "path": str(path),
        "title": path.stem,
        "artist": "",
        "album": "",
        "duration": 0,
        "cover": None,
        "lyrics": None,
        "tags": [],
        "sample_rate": 0,
        "bitrate": 0,
        "channels": 0,
        "format": path.suffix.lower().lstrip("."),
    }
    if mutagen is None:
        return info

    try:
        audio = mutagen.File(path)
        if audio is None:
            return info
    except Exception:
        return info

    _apply_duration(info, audio)
    _apply_quality(info, audio)
    _apply_tags(info, audio)
    _apply_cover_and_lyrics(info, audio)
    return info


def _apply_quality(info: dict, audio) -> None:
    """提取采样率 / 码率 / 声道数。FLAC 等缺失码率时按 体积÷时长 估算。"""
    stream = getattr(audio, "info", None)
    if stream is None:
        return
    try:
        info["sample_rate"] = int(getattr(stream, "sample_rate", 0) or 0)
    except Exception:
        pass
    try:
        info["channels"] = int(getattr(stream, "channels", 0) or 0)
    except Exception:
        pass
    try:
        info["bitrate"] = int(getattr(stream, "bitrate", 0) or 0)
    except Exception:
        pass
    if not info["bitrate"] and info["duration"]:
        try:
            size_bits = Path(info["path"]).stat().st_size * 8
            info["bitrate"] = int(size_bits / 1000 / info["duration"])
        except OSError:
            pass


def _apply_duration(info: dict, audio) -> None:
    try:
        info["duration"] = int(round(getattr(audio.info, "length", 0) or 0))
    except Exception:
        pass


def _apply_tags(info: dict, audio) -> None:
    tags = getattr(audio, "tags", None)
    if tags is None:
        return
    try:
        if isinstance(audio, (FLAC, MP3)):
            info["title"] = _text(tags, "title") or info["title"]
            info["artist"] = _text(tags, "artist") or ""
            info["album"] = _text(tags, "album") or ""
        elif isinstance(audio, MP4):
            info["title"] = _text(tags, "©nam") or info["title"]
            info["artist"] = _text(tags, "©ART") or ""
            info["album"] = _text(tags, "©alb") or ""
    except Exception:
        pass


def _apply_cover_and_lyrics(info: dict, audio) -> None:
    info["cover"] = _extract_cover_data(audio)
    try:
        lyrics = _extract_lyrics_data(audio)
        info["lyrics"] = lyrics or None
    except Exception:
        pass


def _text(tags, key: str) -> Optional[str]:
    """兼容 ID3 帧对象与 Vorbis/MP4 标签列表的取文本。"""
    if tags is None:
        return None
    try:
        obj = tags.get(key) or tags.get(key.upper())
        if obj is None:
            return None
        if hasattr(obj, "text"):  # ID3 帧
            t = obj.text[0] if obj.text else None
        elif isinstance(obj, (list, tuple)):  # Vorbis / MP4
            t = obj[0]
        else:
            t = obj
        if hasattr(t, "decode"):
            t = t.decode("utf-8", "ignore")
        return str(t).strip() or None
    except Exception:
        return None


def _extract_cover_data(audio) -> Optional[bytes]:
    """按格式提取内嵌封面（APIC / FLAC picture / MP4 covr）。"""
    if mutagen is None:
        return None
    try:
        if isinstance(audio, FLAC):
            pics = audio.pictures
            if pics:
                return bytes(pics[0].data)
        tags = getattr(audio, "tags", None)
        if tags is None:
            return None
        if isinstance(audio, MP4):
            covr = tags.get("covr")
            if covr:
                return bytes(covr[0])
        if isinstance(tags, mutagen.id3.ID3):  # type: ignore[attr-defined]
            for key in ("APIC:", "APIC"):
                frame = tags.get(key)
                if frame is not None:
                    return bytes(frame.data)
    except Exception:
        return None
    return None


def _extract_lyrics_data(audio) -> Optional[str]:
    """按格式提取嵌入歌词（MP3 USLT / M4A ©lyr / FLAC lyrics）。"""
    if mutagen is None:
        return None
    try:
        tags = getattr(audio, "tags", None)
        if tags is None:
            return None
        if isinstance(audio, MP4):
            return _joined(tags.get("©lyr"))
        if isinstance(tags, mutagen.id3.ID3):  # type: ignore[attr-defined]
            uslt = tags.getall("USLT")
            if uslt:
                return str(uslt[0].text)
        if isinstance(audio, FLAC):
            return _joined(tags.get("lyrics"))
    except Exception:
        return None
    return None


def _joined(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        parts = []
        for v in value:
            if hasattr(v, "decode"):
                v = v.decode("utf-8", "ignore")
            parts.append(str(v))
        return "\n".join(parts) if parts else None
    if hasattr(value, "decode"):
        value = value.decode("utf-8", "ignore")
    return str(value)


def extract_cover(path: Path) -> Optional[bytes]:
    """外部接口：按文件路径提取封面字节。"""
    if mutagen is None:
        return None
    try:
        audio = mutagen.File(path)
        if audio is None:
            return None
        return _extract_cover_data(audio)
    except Exception:
        return None


def extract_lyrics(path: Path) -> Optional[str]:
    """外部接口：按文件路径提取歌词文本。"""
    if mutagen is None:
        return None
    try:
        audio = mutagen.File(path)
        if audio is None:
            return None
        return _extract_lyrics_data(audio)
    except Exception:
        return None


def write_tags(path: Path, title: str = "", artist: str = "", album: str = "") -> bool:
    """把标题 / 艺术家 / 专辑写回音频文件标签（MP3 / FLAC / M4A）。

    仅当字段非空时写入，空字段保留原值，避免误清空。成功返回 True，
    失败（不支持的格式 / 文件不可写）返回 False。
    """
    if mutagen is None:
        return False
    try:
        audio = mutagen.File(path)
        if audio is None:
            return False
        tags = getattr(audio, "tags", None)
        if isinstance(audio, (FLAC, MP3)):
            if tags is None:
                audio.add_tags()
                tags = audio.tags
            if title:
                tags["title"] = title
            if artist:
                tags["artist"] = artist
            if album:
                tags["album"] = album
        elif isinstance(audio, MP4):
            if tags is None:
                audio.add_tags()
                tags = audio.tags
            if title:
                tags["©nam"] = title
            if artist:
                tags["©ART"] = artist
            if album:
                tags["©alb"] = album
        else:
            return False
        audio.save()
        return True
    except Exception:
        return False