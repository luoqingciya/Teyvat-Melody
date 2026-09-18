# -*- coding: utf-8 -*-
"""维护类接口：目前只有「导出数据库快照」（给备份用）。

⚠️ 为什么不直接拷 `data/library.db`：
后端一直在跑，SQLite 用的是 WAL 模式 —— **最近的写入可能还在 `-wal` 里没并进主库**。
直接拷主库会得到一个「旧」的库；把 `-wal`/`-shm` 一起拷，又可能正好拷在写入中途，
得到一个撕裂的库。备份的意义就是「能还原」，拷出一个坏库等于白做。

`VACUUM INTO` 由 SQLite 自己保证一致性，而且顺带把库压实（体积也更小）。
"""

import sqlite3
from pathlib import Path

from flask import Blueprint, jsonify, request

from app.models.database import DB_PATH

bp = Blueprint("maintenance", __name__)


@bp.post("/backup/snapshot")
def backup_snapshot():
    """把数据库导出一份一致的快照到指定路径。

    请求体：`{"dest": "<绝对路径>"}`。目标文件不能已存在（SQLite 的要求）。
    """
    data = request.get_json(silent=True) or {}
    dest = str(data.get("dest") or "").strip()
    if not dest:
        return jsonify({"code": 400, "message": "dest required"}), 400

    target = Path(dest)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()
    except OSError as exc:
        return jsonify({"code": 500, "message": f"准备目标路径失败: {exc}"}), 500

    if not Path(DB_PATH).exists():
        return jsonify({"code": 404, "message": "数据库还不存在"}), 404

    conn = sqlite3.connect(str(DB_PATH))
    try:
        # 用参数绑定而不是拼字符串：路径里可能有单引号（用户目录名很常见）
        conn.execute("VACUUM INTO ?", (str(target),))
    except sqlite3.Error as exc:
        return jsonify({"code": 500, "message": f"导出快照失败: {exc}"}), 500
    finally:
        conn.close()

    try:
        size = target.stat().st_size
    except OSError:
        size = 0
    return jsonify({"code": 200, "message": "success", "data": {"path": str(target), "bytes": size}})
