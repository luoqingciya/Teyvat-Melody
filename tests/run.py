# -*- coding: utf-8 -*-
"""统一测试入口：串行运行 tests/*.test.py，任一文件失败则整体失败。

用法：uv run python tests/run.py   （JS 侧由 tests/run.js 承担）

与 tests/run.js 同一套约定：只认 `*.test.py`，本文件自身不以 .test.py 结尾，不会自我递归。
"""
import subprocess
import sys
from pathlib import Path

# Windows 控制台默认 cp1252，打印中文会 UnicodeEncodeError（断言全过但退出码非 0）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    here = Path(__file__).resolve().parent
    files = sorted(here.glob("*.test.py"))
    if not files:
        print("未找到任何 *.test.py")
        return 1

    failed = 0
    for f in files:
        # 子进程直接继承 stdout，父进程若用块缓冲会出现「子进程输出排在下一个标题之后」
        # 的错位现象（看起来像某个文件没跑），故显式 flush。
        print(f"\n===== {f.name} =====", flush=True)
        r = subprocess.run([sys.executable, str(f)], cwd=str(here.parent))
        if r.returncode != 0:
            failed += 1

    print(f"\n{len(files) - failed}/{len(files)} 个测试文件通过", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
