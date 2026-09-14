# -*- coding: utf-8 -*-
"""后端入口自检：python tests/backend-port.test.py

锁住 `electron_backend.py` 的命令行契约：主进程会传 `--port=<选定端口>`，
而单独跑 `npm run dev:backend`（不带参数）必须仍然是 5000。

**为什么要动态端口**：固定端口时「同时开着两个实例」（便携版 + 安装版）会互相串后端 ——
后启动的抢不到端口，它的窗口就连到先启动实例的后端，数据被写进对方的数据目录，
用户看到的就是「数据莫名错乱/丢失」。
"""

import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from electron_backend import parse_port  # noqa: E402

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def main() -> int:
    ok("不带参数时默认 5000（npm run dev:backend 直接用）", parse_port([]) == 5000, str(parse_port([])))
    ok("主进程传 --port 时以传入值为准", parse_port(["--port=51234"]) == 51234, str(parse_port(["--port=51234"])))
    ok("支持 --port 空格写法", parse_port(["--port", "51235"]) == 51235, str(parse_port(["--port", "51235"])))

    # 端口号非法时必须直接报错退出，而不是悄悄退回 5000 ——
    # 悄悄退回会让两个实例又抢同一个端口，正是要避免的情况
    try:
        parse_port(["--port=not-a-number"])
        ok("端口非法时报错（不静默退回默认值）", False, "没有报错")
    except SystemExit:
        ok("端口非法时报错（不静默退回默认值）", True)

    print("\n自检结束")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
