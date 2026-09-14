# -*- coding: utf-8 -*-
"""应用根目录 / 数据目录的统一定位。

**为什么安装版不能把数据放在安装目录里**：安装版升级时，NSIS 安装器会先执行旧版的
卸载程序（`app-builder-lib/templates/nsis/installSection.nsh` 的 `uninstallOldVersion`），
而卸载程序会 `RMDir /r $INSTDIR`（`uninstaller.nsh`）—— 把安装目录整个删掉。
数据若放在里面，**每次更新都会丢光**（这是真实发生过的缺陷）。

于是按分发方式分开：

  - **免安装版 / 开发模式** → 软件根目录（`<根目录>/data`、`music`…），
    整个文件夹可以随意搬移 —— 这正是免安装版的立足点。
  - **安装版** → `%LOCALAPPDATA%/TeyvatMelody`，升级与卸载都不会碰它。

判据：exe 同级目录里有没有 `Uninstall *.exe`（只有安装版才带卸载程序）。
旧版本遗留在安装目录里的数据，由 Electron 主进程在启动时搬到新位置
（见 `electron/main.js` 的 `migrateLegacyData`）——后端启动时读到的已经是搬好的目录。
"""

import os
import sys
from pathlib import Path
from typing import Optional

# 安装版的数据目录名（%LOCALAPPDATA% 下）
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
    """
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if not frozen:
        return False
    root = _install_dir(exe or Path(sys.executable))
    try:
        return any(root.glob("Uninstall *.exe"))
    except OSError:
        return False


def _resolve_app_root(
    *,
    frozen: bool,
    exe: Path,
    local_app_data: Optional[str],
    project_root: Path,
) -> Path:
    """决定数据根目录（纯函数，便于自检）。"""
    if not frozen:
        return project_root
    install = _install_dir(exe)
    if is_installed_build(exe, frozen=True):
        if not local_app_data:
            # 拿不到 LOCALAPPDATA（非 Windows / 异常环境）就退回安装目录本身 ——
            # 注意不能再套一层 TeyvatMelody 子目录：那样数据仍在安装目录内、升级照样被删，
            # 只是多了一层让人困惑的嵌套。这里退化为「老行为」，至少能正常用。
            return install
        return (Path(local_app_data) / APP_DIR_NAME).resolve()
    return install


def app_root() -> Path:
    """返回数据根目录（其下存放 data/、music/、cache/ 等）。"""
    return _resolve_app_root(
        frozen=bool(getattr(sys, "frozen", False)),
        exe=Path(sys.executable),
        local_app_data=os.environ.get("LOCALAPPDATA"),
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
