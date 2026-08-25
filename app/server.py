# -*- coding: utf-8 -*-
"""Flask 应用工厂：注册 API 蓝图、静态资源与统一返回格式。"""
import sys
from pathlib import Path

from flask import Flask, jsonify, send_from_directory, abort
import mimetypes
from pathlib import Path

from app.api import playlists, scan, songs, stream
from app.models import database
from app.utils.paths import data_dir


def _dist_dir() -> Path:
    """前端构建产物目录定位。

    - 开发模式：<项目根>/frontend/dist
    - 打包运行（frozen）：<pyinstaller>/frontend/dist（随 --add-data 携带）
    """
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
        return base / "frontend" / "dist"
    return Path(__file__).resolve().parent.parent / "frontend" / "dist"


DIST_DIR = _dist_dir()


# ---- 原生目录选择（不依赖 pywebview，浏览器/桌面端通用） ----

_rpc_api = None  # Electron 模式的 Api 单例（main.Api，延迟初始化）


def pick_folder() -> str | None:
    """调起系统原生"选择文件夹"对话框，返回路径；取消返回 None。

    用标准库 tkinter（带父窗口置顶、路径解析稳定，规避 ctypes 调用
    SHBrowseForFolder 时 LPWSTR/unicode buffer 类型不匹配导致返回空路径的坑）。
    必须在独立线程创建对话框，避免与 Flask 请求线程的消息循环冲突。
    """
    import threading

    result: dict = {"path": None}

    def _run() -> None:
        try:
            # 开启进程 DPI 感知：未声明时 Windows 缩放会使系统对话框文字被位图拉伸而发虚
            try:
                import ctypes
                if ctypes.windll.shcore.SetProcessDpiAwareness(2) != 0:  # PER_MONITOR_DPI_AWARE
                    ctypes.windll.user32.SetProcessDPIAware()
            except Exception:  # noqa: BLE001
                pass
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            try:
                path = filedialog.askdirectory(title="选择音乐目录", parent=root)
                result["path"] = path or None
            finally:
                try:
                    root.destroy()
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            print("目录选择失败：", exc)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join()
    return result["path"]


def create_app() -> Flask:
    # 确保数据库与表结构存在（Phase 4 持久化）
    database.init_db()

    app = Flask(
        __name__,
        static_folder=str(DIST_DIR),
        static_url_path="",
    )

    # 注册 API 蓝图
    app.register_blueprint(songs.bp, url_prefix="/api")
    app.register_blueprint(scan.bp, url_prefix="/api")
    app.register_blueprint(playlists.bp, url_prefix="/api")

    # 音频流（无 /api 前缀，符合契约 /stream/<song_id>）
    app.register_blueprint(stream.bp, url_prefix="/stream")

    @app.post("/api/rpc")
    def rpc():
        """Electron 模式通用 RPC：调用 app.py_api.Api 实例的公开方法。

        前端的 `window.pywebview.api.*` 在 Electron 里由 preload 兼容层
        转发到这里（窗口控制类方法不走此路由，直接由 Electron IPC 处理）。
        """
        from flask import request

        global _rpc_api
        data = request.get_json(silent=True) or {}
        method = data.get("method") or ""
        args = data.get("args") or []
        if not method:
            return jsonify({"code": 400, "data": None, "message": "method required"}), 400

        try:
            from app.py_api import Api  # noqa: PLC0415

            if _rpc_api is None:
                _rpc_api = Api()
            fn = getattr(_rpc_api, method, None)
            if fn is None or method.startswith("_"):
                return jsonify({"code": 404, "data": None, "message": f"method {method} not found"}), 404
            result = fn(*args) if isinstance(args, list) else fn(args)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"code": 500, "data": None, "message": str(exc)}), 500
        return jsonify({"code": 200, "message": "success", "data": result})

    @app.get("/api/hello")
    def hello():
        """联通性自检（浏览器环境降级调用，pywebview 环境走 js_api）。"""
        from datetime import datetime

        return jsonify({
            "code": 200,
            "message": "success",
            "data": {
                "message": "来自提瓦特大陆的回响：后端连接成功",
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            },
        })

    @app.after_request
    def set_security_headers(resp):
        """统一 CSP：消除 Electron 的 Insecure Content-Security-Policy 警告。
        生产构建无内联脚本（script-src 'self'）；Vue 注入 <style> 需 style 内联；
        封面/字体/音频分别放行 data: blob:。"""
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; "
            "connect-src 'self'",
        )
        return resp

    @app.get("/api/pick-folder")
    def pick_folder_endpoint():
        """调起系统原生"选择文件夹"对话框，返回选中目录路径（取消则 null）。"""
        return jsonify({"code": 200, "message": "success", "data": pick_folder()})

    @app.get("/fonts/<filename>")
    def serve_font(filename):
        """提供已上传的自定义字体文件（存于 <data>/fonts）。仅允许该目录内文件，杜绝路径穿越。"""
        fonts_dir = data_dir() / "fonts"
        fonts_dir.mkdir(parents=True, exist_ok=True)
        target = (fonts_dir / filename).resolve()
        if target.parent != fonts_dir.resolve() or not target.exists():
            abort(404)
        mt = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return send_from_directory(str(fonts_dir), filename, mimetype=mt)

    @app.get("/")
    def index():
        """SPA 入口：根路径返回 Vue 构建产物 index.html。"""
        return app.send_static_file("index.html")

    @app.errorhandler(404)
    def not_found(_):
        return jsonify({"code": 404, "data": None, "message": "not found"}), 404

    @app.errorhandler(Exception)
    def server_error(e):
        return jsonify({"code": 500, "data": None, "message": str(e)}), 500

    return app