# -*- coding: utf-8 -*-
"""验证 NSIS 宏 `customRemoveFiles` 真的能保住用户数据：
python tools/verify-nsis-keep-data.py

**为什么必须单独验**：安装版的数据就放在 EXE 同级（$INSTDIR），而升级时安装器会先执行
旧版卸载程序，卸载程序默认 `RMDir /r $INSTDIR` —— 数据会被删光（这是真实发生过的缺陷）。
修复手段是 electron-builder 的 `customRemoveFiles` 宏（见 resources/installer.nsh）。
这段 NSIS 代码是「保数据」的唯一屏障，写错了就等于没修，而它在常规测试里完全跑不到。

做法：用 electron-builder 自带的 makensis 编译一个**独立测试脚本**，
它 `!include` 真实的 resources/installer.nsh，造出「应用文件 + 数据目录」的结构，
分别在「升级」（带 --updated）与「真正卸载」（不带）两种情况下执行宏，再检查文件系统：

  · 升级：应用文件被清掉、**数据目录与文件内容原封不动**
  · 卸载：全部清空、不留残留

`isUpdated` 条件的生成方式与 electron-builder 完全一致
（NsisScriptGenerator.flags：`!macro _isUpdated` + `${StdUtils.TestParameter}`），
所以这里测到的就是真实安装器里的行为。
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
MACRO_FILE = ROOT / "resources" / "installer.nsh"
STDUTILS_DIR = ROOT / "node_modules" / "app-builder-lib" / "templates" / "nsis" / "include"
# StdUtils 是 electron-builder 自带的 NSIS 插件（isUpdated 条件靠它读命令行），
# 编译时要把它所在目录加进插件搜索路径，否则报 "Plugin not found"
NSIS_PLUGIN_DIR = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "electron-builder" / "Cache" / "nsis" / "nsis-resources-3.4.1" / "plugins" / "x86-unicode"
)

# 假安装目录的结构：应用文件（应被删）+ 数据目录（升级时必须保留）
APP_FILES = [
    "TeyvatMelody.exe",
    "ffmpeg.dll",
    "resources.pak",
    "icudtl.dat",
    "README.txt",
    "vk_swiftshader_icd.json",
    "Uninstall TeyvatMelody.exe",
]
APP_SUBDIRS = {
    "locales": ["zh-CN.pak", "en-US.pak"],
    "resources": ["app.asar", "backend/TeyvatBackend.exe"],
}
DATA_SUBDIRS = {
    "data": ["library.db", "library.db-wal"],
    "music": ["周杰伦 - 晴天.mp3"],
    "sources": ["src_abc.js", "sources.json"],
    "cache": ["audio/deadbeef.flac"],
    ".appdata": ["Local Storage/leveldb/CURRENT"],
}

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def find_makensis():
    cache = Path(os.environ.get("LOCALAPPDATA", "")) / "electron-builder" / "Cache" / "nsis"
    if cache.is_dir():
        found = sorted(cache.rglob("makensis.exe"))
        if found:
            return found[0]
    env = os.environ.get("MAKENSIS")
    if env and Path(env).is_file():
        return Path(env)
    which = shutil.which("makensis.exe") or shutil.which("makensis")
    return Path(which) if which else None


def _make_files(prefix: str, rels: list) -> str:
    """生成 NSIS 片段：逐个创建文件（父目录由调用方保证）。"""
    out = []
    for rel in rels:
        win = rel.replace("/", "\\")
        out.append(
            f'  FileOpen $9 "$INSTDIR\\{prefix}\\{win}" w\n'
            f'  FileWrite $9 "x"\n'
            f'  FileClose $9'
        )
    return "\n".join(out)


def build_nsi(tmp: Path, inst_dir: Path) -> Path:
    parts = [
        "Unicode true",
        f'!addincludedir "{STDUTILS_DIR}"',
        f'!addplugindir "{NSIS_PLUGIN_DIR}"',
        '!include "StdUtils.nsh"',
        '!include "LogicLib.nsh"',
        f'!include "{MACRO_FILE}"',
        'Name "keep-data-test"',
        f'OutFile "{tmp / "harness.exe"}"',
        "RequestExecutionLevel user",
        "SilentInstall silent",
        "",
        "# 与 electron-builder 生成的 isUpdated 条件完全一致",
        "# （app-builder-lib/out/targets/nsis/nsisScriptGenerator.js 的 flags()）",
        "!macro _isUpdated _a _b _t _f",
        '  ${StdUtils.TestParameter} $R9 "updated"',
        '  StrCmp "$R9" "true" `${_t}` `${_f}`',
        "!macroend",
        '!define isUpdated `"" isUpdated ""`',
        "",
        'Section "run"',
        f'  StrCpy $INSTDIR "{inst_dir}"',
        "  # 应用顶层文件",
    ]
    for rel in APP_FILES:
        parts.append(
            f'  FileOpen $9 "$INSTDIR\\{rel}" w\n  FileWrite $9 "x"\n  FileClose $9'
        )
    # 应用子目录
    for d, files in APP_SUBDIRS.items():
        for rel in files:
            parent = str(Path(d) / Path(rel).parent).replace("/", "\\").rstrip("\\")
            parts.append(f'  CreateDirectory "$INSTDIR\\{parent}"')
        parts.append(_make_files(d, files))
    # 数据目录
    for d, files in DATA_SUBDIRS.items():
        for rel in files:
            parent = str(Path(d) / Path(rel).parent).replace("/", "\\").rstrip("\\")
            parts.append(f'  CreateDirectory "$INSTDIR\\{parent}"')
        parts.append(_make_files(d, files))
    parts += [
        "",
        "  # ── 执行被测宏（resources/installer.nsh 里真实的那段）──",
        "  !insertmacro customRemoveFiles",
        "SectionEnd",
        "",
    ]
    out = tmp / "harness.nsi"
    out.write_text("\n".join(parts), encoding="utf-8-sig")  # NSIS 需要 BOM
    return out


def run_case(makensis: Path, tmp: Path, *, updated: bool) -> dict:
    inst = tmp / ("inst-updated" if updated else "inst-uninstall")
    if inst.exists():
        shutil.rmtree(inst, ignore_errors=True)
    inst.mkdir(parents=True)

    nsi = build_nsi(tmp, inst)
    exe = tmp / "harness.exe"
    exe.unlink(missing_ok=True)
    r = subprocess.run([str(makensis), "/V1", str(nsi)], capture_output=True, text=True)
    if r.returncode != 0 or not exe.is_file():
        return {"compile_error": ((r.stdout or "") + (r.stderr or ""))[-600:]}

    subprocess.run([str(exe)] + (["--updated"] if updated else []), capture_output=True, text=True)

    top_files = sorted(p.name for p in inst.glob("*") if p.is_file())
    top_dirs = sorted(p.name for p in inst.glob("*") if p.is_dir())
    data_intact = all(
        (inst / d / rel).is_file() for d, files in DATA_SUBDIRS.items() for rel in files
    )
    return {"top_files": top_files, "top_dirs": top_dirs, "data_intact": data_intact}


def main() -> int:
    makensis = find_makensis()
    if makensis is None:
        print("SKIP  未找到 makensis（先跑一次打包，或用 MAKENSIS 环境变量指定 makensis.exe）")
        return 0
    if not MACRO_FILE.is_file():
        print(f"FAIL  找不到宏文件：{MACRO_FILE}")
        return 1
    print(f"makensis : {makensis}")
    print(f"被测宏   : {MACRO_FILE.relative_to(ROOT)}")

    tmp = Path(tempfile.mkdtemp(prefix="tm-nsis-"))
    try:
        print("\n=== 情形一：升级（安装器带 --updated 调用旧卸载程序）→ 必须保住数据 ===")
        up = run_case(makensis, tmp, updated=True)
        if "compile_error" in up:
            ok("宏可编译", False, up["compile_error"])
            return 1
        ok("宏可编译", True)
        ok("升级：应用顶层文件被清掉", up["top_files"] == [], str(up["top_files"]))
        ok("升级：应用子目录（locales / resources）被清掉",
           not ({"locales", "resources"} & set(up["top_dirs"])), str(up["top_dirs"]))
        ok(
            "升级：**数据目录一个不少**（data / music / sources / cache / .appdata）",
            set(up["top_dirs"]) == set(DATA_SUBDIRS.keys()),
            str(up["top_dirs"]),
        )
        ok("升级：**数据文件内容原封不动**", up["data_intact"] is True, "有数据文件被删")

        print("\n=== 情形二：真正卸载（不带 --updated）→ 应全部清空 ===")
        un = run_case(makensis, tmp, updated=False)
        if "compile_error" in un:
            ok("宏可编译（卸载分支）", False, un["compile_error"])
            return 1
        ok(
            "卸载：安装目录已清空、不留残留",
            un["top_dirs"] == [] and un["top_files"] == [],
            str(un),
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n验证结束")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
