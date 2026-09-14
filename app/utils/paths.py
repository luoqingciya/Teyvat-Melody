# -*- coding: utf-8 -*-
"""应用根目录 / 数据目录的统一定位。

**数据一律放在软件目录（EXE 同级）** —— 免安装版与安装版都一样，这样整个目录是
自包含的：可以整体搬移、复制、备份，卸载也只是删掉这一个目录。

⚠️ 但安装版有个陷阱必须知道：**升级时安装器会先执行旧版的卸载程序**，而它默认会
`RMDir /r $INSTDIR` —— 把安装目录整个删掉，数据跟着没。所以「数据放在安装目录里」
这条约定**必须**配合 `resources/installer.nsh` 的 `customRemoveFiles` 宏才能成立
（该宏在升级时保留 data/music/sources/cache/.appdata，只在真正卸载时才删）。
那段 NSIS 代码由 `tools/verify-nsis-keep-data.py` 用真实 makensis 编译验证 ——
改这里的选址逻辑、或改那个 NSIS 宏，都要把该脚本跑一遍。

开发模式（未打包）下没有安装目录的概念，数据放项目根目录。

本文件的选址规则与 Electron 主进程的 `electron/dataRoot.js` 必须**完全一致**
（两边各自要独立算出数据目录），各自都有自检：
`tests/paths.test.py` / `tests/data-root.test.js`。
"""

import sys
from pathlib import Path
from typing import Optional

# 安装版的数据目录名。**仅用于识别 v1.0.6 的旧位置**（那一版曾把安装版数据放在
# %LOCALAPPDATA%/TeyvatMelody 以躲开卸载程序），启动时会把它搬回软件目录。
APP_DIR_NAME = "TeyvatMelody"

# 「这里是软件根目录」的标记：resources 下有 Electron 的 app.asar 或后端目录。
# 用标记而不是「目录名恰好叫 resources」—— 后者在用户把应用装进
# `D:\resources\TeyvatMelody` 这类路径时会向上误判到 `D:\`。
_ROOT_MARKERS = ("app.asar", "app", "backend")


def _install_dir(exe: Path) -> Path:
    """定位软件根目录（安装目录）。

    入参可以是**安装树里的任意一个可执行文件** —— 主进程是 `<根>/TeyvatMelody.exe`，
    后端是 `<根>/resources/backend/TeyvatBackend/TeyvatBackend.exe`，
    两种都能正确上溯到 `<根>`（与 `electron/dataRoot.js` 的 `installDir` 语义一致）。
    """
    start = exe.resolve().parent
    cur = start
    for _ in range(8):
        parent = cur.parent
        if parent == cur:
            break
        res = cur / "resources"
        if any((res / m).exists() for m in _ROOT_MARKERS):
            return cur
        cur = parent
    return start


def is_installed_build(exe: Optional[Path] = None, frozen: Optional[bool] = None) -> bool:
    """是否为「安装版」：exe 同级存在 `Uninstall *.exe`。

    免安装版解压出来没有卸载程序，所以这个判据天然区分两种分发方式。
    数据位置两者相同，这个判据现在只用于「更新时该下哪个包」。
    """
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if not frozen:
        return False
    root = _install_dir(exe or Path(sys.executable))
    try:
        return any(root.glob("Uninstall *.exe"))
    except OSError:
        return False


def _resolve_app_root(*, frozen: bool, exe: Path, project_root: Path) -> Path:
    """决定数据根目录（纯函数，便于自检）。"""
    if not frozen:
        return project_root
    return _install_dir(exe)


def app_root() -> Path:
    """返回数据根目录（其下存放 data/、music/、cache/ 等）。"""
    return _resolve_app_root(
        frozen=bool(getattr(sys, "frozen", False)),
        exe=Path(sys.executable),
        project_root=Path(__file__).resolve().parent.parent.parent,
    )


def data_dir() -> Path:
    """数据库所在目录：<数据根目录>/data。"""
    return app_root() / "data"


def music_dir() -> Path:
    """扫描入库时保存音乐副本的目录（在线下载的歌也存这里）：<数据根目录>/music。"""
    return app_root() / "music"


def cache_dir() -> Path:
    """在线播放的音频 / 歌词缓存目录：<数据根目录>/cache。

    可随时清空，删掉只会让下次播放重新联网取流。
    """
    return app_root() / "cache"
