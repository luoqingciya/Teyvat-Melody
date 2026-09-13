# -*- coding: utf-8 -*-
"""Electron 模式的后端入口：只启动 Flask 服务，不创建任何窗口。

由 Electron 主进程 spawn 本脚本（开发：.venv 的 python；发布：PyInstaller 打包的 exe）。
前端数据类调用（扫描/字体等）经 Electron preload → /api/rpc → app.py_api.Api。
"""
from app.server import create_app

if __name__ == "__main__":
    # threaded=True：音频流（/stream 本地文件、/api/online/proxy 在线转发）是长连接，
    # 单线程下一条流会占满 worker，把 /api/songs 等请求全部堵死（表现为界面卡住不响应）。
    # 各请求内自建 SQLite 连接，扫描任务已用 _scan_lock 保护，多线程安全。
    create_app().run(
        host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True
    )
