# -*- coding: utf-8 -*-
"""LRC 歌词解析：将 LRC 文本解析为带时间戳的歌词行列表。

返回格式：{"lines": [{"t": <秒>, "text": <str>}, ...]}
支持 [mm:ss.xx] 多时间戳行，纯文本行聚到最近的歌词行。
"""
import re
from typing import Optional

_TIMESTAMP_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]")


def parse_lrc(text: Optional[str]) -> list[dict]:
    """将 LRC 文本解析为按时间升序的 {t, text} 列表。"""
    if not text:
        return []

    rows: list[dict] = []
    for raw in text.splitlines():
        matches = list(_TIMESTAMP_RE.finditer(raw))
        if not matches:
            continue
        # 最后一个时间戳之后的文字部分
        body = raw[matches[-1].end():].strip()
        if not body:
            continue
        for m in matches:
            minutes = int(m.group(1))
            seconds = int(m.group(2))
            frac = m.group(3) or "0"
            ms = int((frac.ljust(3, "0"))[:3])
            t = minutes * 60 + seconds + ms / 1000.0
            rows.append({"t": round(t, 3), "text": body})

    rows.sort(key=lambda r: r["t"])
    # 合并同时间的歌词行
    merged: list[dict] = []
    for row in rows:
        if merged and merged[-1]["t"] == row["t"]:
            merged[-1]["text"] += " " + row["text"]
        else:
            merged.append(row)
    return merged