# -*- coding: utf-8 -*-
"""验证**打包后**（frozen）的数据目录选址：python tools/verify-frozen-paths.py

为什么需要这个脚本：`app/utils/paths.py` 的选址规则有「开发」和「打包」两条分支，
而 `tests/paths.test.py` 只能测纯函数（把 frozen/exe/LOCALAPPDATA 当参数注入）。
真正打包运行时才会走到的部分是：`sys.frozen`、`sys.executable` 的真实位置、
PyInstaller onedir 的 `resources/backend/TeyvatBackend/` 布局、以及环境变量读取。
这条路径一旦算错，安装版的数据又会落回安装目录 —— 也就是「更新丢光数据」复发。

用法：
    python tools/verify-frozen-paths.py [后端 exe 路径]
    （默认 backend-dist/TeyvatBackend/TeyvatBackend.exe，需先
      uv run pyinstaller build.spec --noconfirm --distpath backend-dist --workpath build-temp）

做法：把打包好的后端分别放进两棵**模拟安装树**里各跑一次，看它把数据库写到哪里。
用临时的 LOCALAPPDATA 指向临时目录，全程不碰真实用户目录。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = ROOT / "backend-dist" / "TeyvatBackend" / "TeyvatBackend.exe"

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_tree(base: Path, src_dist: Path, *, installed: bool) -> Path:
    """造一棵模拟安装树：<base>/FakeApp/{TeyvatMelody.exe, Uninstall?, resources/backend/...}"""
    app = base / "FakeApp"
    backend = app / "resources" / "backend" / "TeyvatBackend"
    backend.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_dist, backend)
    (app / "TeyvatMelody.exe").write_bytes(b"")  # 主进程 exe（占位）
    if installed:
        (app / "Uninstall TeyvatMelody.exe").write_bytes(b"")
    return app


def run_backend_and_wait(app: Path, local_app_data: Path):
    """跑起打包后端，等它响应 /api/hello，再拉一次 /api/songs 促使数据库落盘。"""
    exe = app / "resources" / "backend" / "TeyvatBackend" / "TeyvatBackend.exe"
    port = free_port()
    env = {**os.environ, "LOCALAPPDATA": str(local_app_data)}
    proc = subprocess.Popen(
        [str(exe), f"--port={port}"],
        cwd=str(exe.parent),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 60
        alive = False
        while time.time() < deadline:
            if proc.poll() is not None:
                return {"started": False, "port": port, "exit": proc.returncode}
            try:
                with urllib.request.urlopen(base + "/api/hello", timeout=2) as r:
                    if r.status == 200:
                        alive = True
                        break
            except (urllib.error.URLError, OSError):
                time.sleep(0.4)
        if not alive:
            return {"started": False, "port": port, "exit": None}
        with urllib.request.urlopen(base + "/api/songs", timeout=10) as r:
            payload = json.loads(r.read().decode("utf-8"))
        return {"started": True, "port": port, "songs": len(payload.get("data") or [])}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_EXE
    if not exe.is_file():
        print(f"SKIP  未找到打包后的后端：{exe}")
        print("      先执行：uv run pyinstaller build.spec --noconfirm --distpath backend-dist --workpath build-temp")
        return 0
    src_dist = exe.parent

    tmp = Path(tempfile.mkdtemp(prefix="tm-frozen-"))
    try:
        # ---- 情形一：安装版（同级有 Uninstall *.exe）→ 数据也在软件目录（跟 EXE 同级）----
        # 注意：安装版**不能**把数据写到 %LOCALAPPDATA%，也不能漏写进安装目录 ——
        # 数据必须在安装目录里，并由 NSIS 的 customRemoveFiles 宏在升级时保住
        # （那段 NSIS 由 tools/verify-nsis-keep-data.py 验证）。
        inst_app = make_tree(tmp / "installed", src_dist, installed=True)
        inst_local = tmp / "installed-localappdata"
        r1 = run_backend_and_wait(inst_app, inst_local)
        ok("安装版：打包后端能起来（--port 生效）", r1.get("started") is True, json.dumps(r1))
        if r1.get("started"):
            ok("安装版：接口可正常访问", r1.get("songs") == 0, json.dumps(r1))
            ok(
                "安装版：数据库落在软件目录（EXE 同级）",
                (inst_app / "data" / "library.db").is_file(),
                str(inst_app / "data"),
            )
            ok(
                "安装版：不往 %LOCALAPPDATA% 写数据（v1.0.6 的旧做法已废弃）",
                not (inst_local / "TeyvatMelody").exists(),
                str(inst_local / "TeyvatMelody"),
            )

        # ---- 情形二：免安装版（没有卸载程序）→ 数据同样在软件目录 ----
        port_app = make_tree(tmp / "portable", src_dist, installed=False)
        port_local = tmp / "portable-localappdata"
        r2 = run_backend_and_wait(port_app, port_local)
        ok("免安装版：打包后端能起来", r2.get("started") is True, json.dumps(r2))
        if r2.get("started"):
            ok(
                "免安装版：数据库落在软件目录（整个文件夹仍可搬移）",
                (port_app / "data" / "library.db").is_file(),
                str(port_app / "data"),
            )
            ok(
                "免安装版：不往 LOCALAPPDATA 写东西",
                not (port_local / "TeyvatMelody").exists(),
                str(port_local / "TeyvatMelody"),
            )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n验证结束")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
