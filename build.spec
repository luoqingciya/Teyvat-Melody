# -*- mode: python ; coding: utf-8 -*-
# Teyvat Melody 后端打包配置（Electron 模式）：把 Flask 服务打成独立 exe。
# 产物： backend-dist/TeyvatBackend/TeyvatBackend.exe（COLLECT 目录；含依赖，Electron 主进程 spawn，无窗口）
#       主进程 main.js 的 findBackendExe 会递归查找 resources/backend 下的 TeyvatBackend.exe，
#       因此兼容本目录形态与“单文件”两种布局。
# 用法： uv run pyinstaller build.spec --noconfirm --distpath backend-dist

from pathlib import Path

ROOT = Path(SPECPATH)

a = Analysis(
    ["electron_backend.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        # 前端构建产物：Electron 模式下 Flask 托管 SPA（开发也可直接用）
        (str(ROOT / "frontend" / "dist"), "frontend/dist"),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 应用不使用且拖体积的模块（保留 tkinter：目录选择 pick_folder 依赖它）
        "unittest",
        "pydoc",
        "doctest",
        "matplotlib",
        "numpy",
        "scipy",
        "pandas",
        "PyQt5",
        "PySide2",
        "IPython",
        "jedi",
        "pywebview",
        "pystray",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TeyvatBackend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # Windowed 模式：无控制台黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="TeyvatBackend",
)
