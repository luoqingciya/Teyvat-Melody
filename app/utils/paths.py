# -*- coding: utf-8 -*-
"""应用根目录 / 数据目录的统一定位。

约定：软件运行产生的一切数据（数据库、音乐库副本、日志等）都放在
"软件自己的根目录"下：
  - 打包运行（frozen, onedir）：exe 所在目录（<根目录>/TeyvatMelody.exe）
  - 开发模式：项目根目录（<项目根>/app 的上一级）
"""

import sys
from pathlib import Path


def app_root() -> Path:
    """返回应用根目录（该目录下存放 data/、music/ 等）。

    打包后后端子进程 TeyvatBackend.exe 位于 <根目录>/resources/backend[/TeyvatBackend]/，
    sys.executable 的父目录并非软件根目录。因此从 executable 逐级向上寻找名为
    resources 的目录，其上一级即软件根目录（exe 所在目录）；找不到则回退到 executable 父目录。
    """
    if getattr(sys, "frozen", False):
        cur = Path(sys.executable).resolve().parent
        while cur != cur.parent:
            if cur.name == "resources":
                return cur.parent
            cur = cur.parent
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent.parent


def data_dir() -> Path:
    """数据库所在目录：<根目录>/data。"""
    return app_root() / "data"


def music_dir() -> Path:
    """扫描入库时保存音乐副本的目录：<根目录>/music。"""
    return app_root() / "music"