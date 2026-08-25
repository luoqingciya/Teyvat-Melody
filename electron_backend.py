# -*- coding: utf-8 -*-
"""Electron 模式的后端入口：只启动 Flask 服务，不创建任何窗口。

由 Electron 主进程 spawn 本脚本（开发：.venv 的 python；发布：PyInstaller 打包的 exe）。
前端数据类调用（扫描/字体等）经 Electron preload → /api/rpc → app.py_api.Api。
"""
from app.server import create_app

if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)
