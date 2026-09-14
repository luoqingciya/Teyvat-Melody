# -*- coding: utf-8 -*-
"""数据根目录选址自检：python tests/paths.test.py

与 `tests/data-root.test.js` 是同一套规则的两种语言实现 —— 后端（Flask）必须独立算出
与 Electron 主进程**完全一致**的数据目录，否则会出现「主进程写 data/、后端读另一个 data/」
这种更隐蔽的故障。两边都要有自检，改规则时一起改。

规则：**数据一律放在软件目录（EXE 同级）** —— 免安装版与安装版都一样，整个目录自包含、
可整体搬移。⚠️ 安装版能这么做的前提是 NSIS 的 customRemoveFiles 宏在升级时保住数据目录
（见 resources/installer.nsh），那段 NSIS 代码由 tools/verify-nsis-keep-data.py 验证。
"""

import shutil
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.utils import paths  # noqa: E402

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def make_tree(base: Path, *, installed: bool) -> dict:
    """造一棵假的安装目录树。

    真实布局：<根>/TeyvatMelody.exe 与 <根>/resources/backend/TeyvatBackend/TeyvatBackend.exe，
    后端子进程要沿路向上找到软件根目录。
    """
    exe_dir = base / "TeyvatMelody"
    backend_dir = exe_dir / "resources" / "backend" / "TeyvatBackend"
    backend_dir.mkdir(parents=True, exist_ok=True)
    (exe_dir / "TeyvatMelody.exe").write_text("", "utf-8")
    (backend_dir / "TeyvatBackend.exe").write_text("", "utf-8")
    if installed:
        (exe_dir / "Uninstall TeyvatMelody.exe").write_text("", "utf-8")
    return {"exe_dir": exe_dir, "backend_exe": backend_dir / "TeyvatBackend.exe"}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="tm-paths-"))
    try:
        portable = make_tree(tmp / "portable", installed=False)
        installed = make_tree(tmp / "installed", installed=True)
        # 期望值一律 resolve()：Windows 上 mkdtemp 可能给 8.3 短名（LUOQIN~1），
        # 而 _install_dir 内部会 resolve，不统一就没法直接比字符串
        p_root = portable["exe_dir"].resolve()
        i_root = installed["exe_dir"].resolve()

        ok("_install_dir：从后端 exe 上溯到软件根目录",
           paths._install_dir(portable["backend_exe"]) == p_root,
           str(paths._install_dir(portable["backend_exe"])))
        ok("_install_dir：主进程 exe（就在根下）也能定位到根",
           paths._install_dir(portable["exe_dir"] / "TeyvatMelody.exe") == p_root,
           str(paths._install_dir(portable["exe_dir"] / "TeyvatMelody.exe")))
        ok("安装版判定：有 Uninstall *.exe → True",
           paths.is_installed_build(installed["backend_exe"], frozen=True) is True)
        ok("免安装版判定：没有卸载程序 → False",
           paths.is_installed_build(portable["backend_exe"], frozen=True) is False)
        ok("安装版判定：非 frozen（开发模式）一律 False",
           paths.is_installed_build(installed["backend_exe"], frozen=False) is False)

        ok(
            "开发模式：数据根目录 = 项目根目录",
            paths._resolve_app_root(
                frozen=False, exe=portable["backend_exe"], project_root=Path("/proj"),
            ) == Path("/proj"),
        )
        ok(
            "免安装版：数据根目录 = 软件目录（整个文件夹可搬移）",
            paths._resolve_app_root(
                frozen=True, exe=portable["backend_exe"], project_root=Path("/proj"),
            ) == p_root,
            str(paths._resolve_app_root(frozen=True, exe=portable["backend_exe"], project_root=Path("/proj"))),
        )
        ok(
            "安装版：数据根目录也 = 软件目录（跟 EXE 同级）",
            paths._resolve_app_root(
                frozen=True, exe=installed["backend_exe"], project_root=Path("/proj"),
            ) == i_root,
            str(paths._resolve_app_root(frozen=True, exe=installed["backend_exe"], project_root=Path("/proj"))),
        )

        # 三个数据子目录都必须挂在同一个根下 —— 否则会出现「主进程写一处、后端读另一处」
        root = tmp / "root"
        ok("data_dir / music_dir / cache_dir 同根",
           all(p.parent == root for p in (root / "data", root / "music", root / "cache")))
        ok("paths.data_dir 用的是 app_root()",
           str(paths.data_dir()).endswith(str(Path(paths.app_root().name) / "data")),
           str(paths.data_dir()))
        ok("APP_DIR_NAME 常量仍在（v1.0.6 旧位置识别要用）",
           paths.APP_DIR_NAME == "TeyvatMelody", paths.APP_DIR_NAME)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n自检结束")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
