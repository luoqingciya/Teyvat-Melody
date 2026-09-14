# -*- coding: utf-8 -*-
"""Electron 模式的后端入口：只启动 Flask 服务，不创建任何窗口。

由 Electron 主进程 spawn 本脚本（开发：.venv 的 python；发布：PyInstaller 打包的 exe）。
前端数据类调用（扫描/字体等）经 Electron preload → /api/rpc → app.py_api.Api。

**端口由主进程指定**（`--port`，缺省 5000 供 `npm run dev:backend` 直接用）。
固定端口会让「同时开着两个实例」（例如便携版 + 安装版）互相串后端：
后启动的那个抢不到端口，它的窗口就会连到先启动实例的后端，
于是数据被写进**对方的数据目录** —— 看起来就像「数据莫名消失/错乱」。
"""
import argparse

from app.server import create_app


def parse_port(argv=None) -> int:
    parser = argparse.ArgumentParser(description="提瓦特旋律后端服务")
    parser.add_argument("--port", type=int, default=5000, help="监听端口（缺省 5000）")
    return parser.parse_args(argv).port


if __name__ == "__main__":
    port = parse_port()
    # threaded=True：音频流（/stream 本地文件、/api/online/proxy 在线转发）是长连接，
    # 单线程下一条流会占满 worker，把 /api/songs 等请求全部堵死（表现为界面卡住不响应）。
    # 各请求内自建 SQLite 连接，扫描任务已用 _scan_lock 保护，多线程安全。
    create_app().run(
        host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True
    )
