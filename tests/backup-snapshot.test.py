# -*- coding: utf-8 -*-
"""自检：数据库快照接口（python tests/backup-snapshot.test.py）

锁住的是备份的**正确性前提**：备份里的曲库必须是「一致」的一份，不能是旧数据或撕裂的库。

⚠️ 为什么不能直接拷 `data/library.db`：后端一直在跑，SQLite 是 WAL 模式，
最近的写入可能还在 `-wal` 里没并进主库。所以必须走 `VACUUM INTO`（由 SQLite 保证一致性）。
这里就验证：接口能产出文件、产出的确实是一个**可打开且数据完整**的 SQLite 库。
"""

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.server import create_app  # noqa: E402
from app.models.database import DB_PATH, init_db  # noqa: E402

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def main() -> None:
    init_db()
    app = create_app()
    client = app.test_client()

    tmp = Path(tempfile.mkdtemp(prefix="teyvat-snapshot-"))
    dest = tmp / "snapshot.db"

    print("---- 参数校验 ----")
    r = client.post("/api/backup/snapshot", json={})
    ok("缺少 dest → 400", r.status_code == 400, str(r.status_code))

    print("\n---- 导出快照 ----")
    r = client.post("/api/backup/snapshot", json={"dest": str(dest)})
    body = r.get_json()
    ok("导出成功", r.status_code == 200 and body.get("code") == 200, json.dumps(body, ensure_ascii=False)[:200])
    ok("文件真的生成了", dest.exists(), str(dest))
    ok("返回体带上大小", bool(body.get("data", {}).get("bytes")), json.dumps(body.get("data")))

    print("\n---- 快照本身是个可用的库 ----")
    # 能打开、能查询、表结构在 —— 说明不是半截文件
    conn = sqlite3.connect(str(dest))
    try:
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        ok("快照能被 SQLite 打开", True)
        ok("快照里有 songs 表", "songs" in names, ", ".join(sorted(names))[:160])
        ok("快照里至少有一张业务表", len(names) >= 1, ", ".join(sorted(names))[:160])
        # 主库里的歌曲数应当与快照一致（说明数据是完整的，不是空库）
        src = sqlite3.connect(str(DB_PATH))
        try:
            want = src.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        finally:
            src.close()
        got = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        ok("⚠️ 快照里的歌曲数与主库一致（不是空库/旧库）", got == want, f"快照 {got} / 主库 {want}")
    finally:
        conn.close()

    print("\n---- 目标已存在时不会炸 ----")
    r2 = client.post("/api/backup/snapshot", json={"dest": str(dest)})
    ok("重复导出到同一路径仍成功（会先删掉旧文件）", r2.status_code == 200, json.dumps(r2.get_json())[:160])

    print("\n---- 路径带单引号也不出错（用户目录名里很常见） ----")
    weird = tmp / "it's a dir" / "snap.db"
    r3 = client.post("/api/backup/snapshot", json={"dest": str(weird)})
    ok("含单引号的路径能导出", r3.status_code == 200 and weird.exists(), json.dumps(r3.get_json())[:200])

    print("\n自检结束")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
