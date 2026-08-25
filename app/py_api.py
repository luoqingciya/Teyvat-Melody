# -*- coding: utf-8 -*-
"""后端 API（Electron 模式下由 Flask POST /api/rpc 调用）。

仅保留前端实际调用（preload 的 RPC_METHODS）对应的方法，保持架构纯净：
- hello：联通性自检（useApi）
- scanLibrary：扫描音乐目录（useApi / Sidebar）
- saveFont / removeFont：自定义字体（SettingsModal）
窗口控制与桌面歌词显隐在 Electron 里走 IPC，不经由此处。
"""


class Api:
    def __init__(self) -> None:
        pass

    @staticmethod
    def hello() -> dict:
        """联通性自检。"""
        from datetime import datetime

        return {
            "message": "来自提瓦特大陆的回响：后端连接成功",
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    @staticmethod
    def scanLibrary(path: str) -> dict:
        """扫描音乐目录并入库（SQLite 持久化）。"""
        from pathlib import Path

        from app.services import library_service

        added = library_service.scan_and_register(Path(path))
        return {"path": path, "added": added, "count": len(added)}

    # ---- 自定义字体：保存 / 删除 上传的字体文件 ----
    def saveFont(self, filename: str, base64data: str) -> dict:
        """把前端上传的字体文件（base64）写入 <data>/fonts，返回可持久化的元信息。"""
        import base64
        import os
        import uuid

        from app.utils.paths import data_dir

        ext = os.path.splitext(filename)[1].lower()
        if ext not in (".ttf", ".otf", ".woff", ".woff2"):
            return {"ok": False, "error": "unsupported font format"}

        fonts_dir = data_dir() / "fonts"
        fonts_dir.mkdir(parents=True, exist_ok=True)
        # 内部文件名用 uuid，规避中文/空格导致的路径与 URL 编码问题；展示名保留原始
        internal = f"{uuid.uuid4().hex}{ext}"
        try:
            fonts_dir.joinpath(internal).write_bytes(base64.b64decode(base64data))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

        label = os.path.splitext(filename)[0] or internal
        return {
            "ok": True,
            "id": internal,
            "family": label,
            "label": label,
            "url": f"/fonts/{internal}",
        }

    def removeFont(self, font_id: str) -> dict:
        """删除指定字体文件（font_id 即内部文件名）。"""
        from app.utils.paths import data_dir

        target = (data_dir() / "fonts" / font_id).resolve()
        fonts_dir = (data_dir() / "fonts").resolve()
        if target.parent == fonts_dir and target.exists():
            try:
                target.unlink()
            except OSError:
                pass
        return {"ok": True}
