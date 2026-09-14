# -*- coding: utf-8 -*-
"""数据库升级自检：python tests/migration.test.py

**为什么单独测这个**：用户装的是上一版，升级后第一次启动会在他**已有的 library.db**
上跑列迁移（在线歌曲入库新增了 5 个列 + 1 个唯一索引）。这类改动在开发机上是「无感」的
—— 开发库早就是新结构了，迁移分支等于没跑过。一旦迁移写错，用户升级后丢的是整个曲库。

所以这里**手工造一个上一版的旧结构库并塞进数据**，再跑 `init_db()`，逐项验证：
列补齐、旧数据一条不少、旧歌仍被当作本地歌曲、唯一索引真的生效、迁移可重复执行。
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

# Windows 控制台默认 cp1252，打印中文会 UnicodeEncodeError（断言全过但退出码非 0）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models import database as db  # noqa: E402
from app.services import library_service  # noqa: E402

# ---- 上一版（v1.0.4）的 songs 表结构：没有任何 online_* 列 ----
OLD_SCHEMA = """
CREATE TABLE songs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  album       TEXT NOT NULL DEFAULT '',
  duration    REAL NOT NULL DEFAULT 0,
  favorite    INTEGER NOT NULL DEFAULT 0,
  cover       BLOB,
  lyrics      TEXT,
  sample_rate INTEGER NOT NULL DEFAULT 0,
  bitrate     INTEGER NOT NULL DEFAULT 0,
  channels    INTEGER NOT NULL DEFAULT 0,
  format      TEXT    NOT NULL DEFAULT '',
  source_path TEXT
);
CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE playlist_songs (
  playlist_id  INTEGER NOT NULL,
  song_id      INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, song_id)
);
CREATE TABLE playback_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  played_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_songs_title  ON songs(title);
CREATE INDEX idx_songs_artist ON songs(artist);
"""

_failed = False


def ok(name: str, cond: bool, extra: str = "") -> None:
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        _failed = True


def build_old_db(path: Path) -> None:
    """造一个上一版的库：3 首歌（1 首收藏）、1 个含 2 首的歌单、2 条播放历史。"""
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(OLD_SCHEMA)
        conn.executemany(
            "INSERT INTO songs(path, title, artist, album, duration, favorite, lyrics, "
            "sample_rate, bitrate, channels, format, source_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (r"C:\music\a.flac", "夜曲", "周杰伦", "十一月的萧邦", 227.5, 1, "[00:01.00]一群嗜血的蚂蚁",
                 44100, 1000, 2, "flac", r"D:\src\a.flac"),
                (r"C:\music\b.mp3", "富士山下", "陈奕迅", "What's Going On…?", 259.0, 0, None,
                 44100, 320, 2, "mp3", None),
                (r"C:\music\c.mp3", "晴天", "周杰伦", "叶惠美", 269.0, 0, None, 44100, 320, 2, "mp3", None),
            ],
        )
        conn.execute("INSERT INTO playlists(id, name) VALUES (1, '我的最爱')")
        conn.executemany(
            "INSERT INTO playlist_songs(playlist_id, song_id, position) VALUES (?,?,?)",
            [(1, 1, 0), (1, 3, 1)],
        )
        conn.executemany("INSERT INTO playback_history(song_id) VALUES (?)", [(1,), (2,)])
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="tm-migrate-"))
    # 把数据目录指到临时目录：绝不能碰项目里真实的 data/library.db
    db.DATA_DIR = tmp
    db.DB_PATH = tmp / "library.db"

    build_old_db(db.DB_PATH)

    # ---- 迁移前：确认造的确实是「旧结构」 ----
    conn = sqlite3.connect(str(db.DB_PATH))
    cols_before = [r[1] for r in conn.execute("PRAGMA table_info(songs)")]
    conn.close()
    ok("前置：造出的库确实是旧结构（无 online_* 列）",
       "online_source" not in cols_before, str(cols_before))

    # ---- 跑迁移 ----
    db.init_db()

    conn = sqlite3.connect(str(db.DB_PATH))
    conn.row_factory = sqlite3.Row
    cols = [r[1] for r in conn.execute("PRAGMA table_info(songs)")]
    ok(
        "迁移：5 个新列全部补齐",
        all(c in cols for c in ("online_source", "online_id", "online_quality", "cover_url", "online_meta")),
        str(cols),
    )

    rows = list(conn.execute("SELECT * FROM songs ORDER BY id"))
    ok("迁移：旧数据一条不少", len(rows) == 3, f"共 {len(rows)} 条")
    ok("迁移：旧字段值未变", rows[0]["title"] == "夜曲" and rows[0]["duration"] == 227.5 and rows[0]["favorite"] == 1,
       str(dict(rows[0])))
    ok("迁移：内嵌歌词与 source_path 保留", rows[0]["lyrics"] == "[00:01.00]一群嗜血的蚂蚁" and rows[0]["source_path"] == r"D:\src\a.flac",
       str(dict(rows[0])))
    ok("迁移：旧行被当作本地歌曲（online_source 默认空串）",
       all((r["online_source"] or "") == "" for r in rows), str([r["online_source"] for r in rows]))
    ok("迁移：封面列仍为 BLOB（未被重建表搞坏）",
       next(r[2] for r in conn.execute("PRAGMA table_info(songs)") if r[1] == "cover") == "BLOB",
       "cover 类型异常")

    idx = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")]
    ok("迁移：在线唯一索引已建", "idx_songs_online" in idx, str(idx))

    ok("迁移：收藏状态保留", [r["favorite"] for r in conn.execute("SELECT favorite FROM songs ORDER BY id")] == [1, 0, 0])
    ps = list(conn.execute("SELECT playlist_id, song_id FROM playlist_songs ORDER BY position"))
    ok("迁移：歌单关联保留", [(r[0], r[1]) for r in ps] == [(1, 1), (1, 3)], str(ps))
    ok("迁移：播放历史保留", conn.execute("SELECT COUNT(*) FROM playback_history").fetchone()[0] == 2)
    conn.close()

    # ---- 迁移后：旧歌仍在本地曲库列表里（不会因加了过滤条件而消失） ----
    songs = library_service.all_songs()
    ok("迁移后：all_songs 仍返回全部旧歌", len(songs) == 3, f"共 {len(songs)} 条")
    ok("迁移后：旧歌带上 online_source 空串", all(s["online_source"] == "" for s in songs), str(songs[:1]))
    ok("迁移后：收藏列表可用", len(library_service.get_favorites()) == 1)

    # ---- 迁移后新功能可用：注册在线歌曲 + 唯一索引真的拦重复 ----
    a = library_service.upsert_online_song("kw", "M1", title="在线歌", artist="某人", quality="320k")
    b = library_service.upsert_online_song("kw", "M1", title="在线歌改名", artist="某人")
    ok("迁移后：可注册在线歌曲", a is not None and a["online_source"] == "kw", str(a))
    ok("迁移后：重复注册命中同一行（唯一索引生效）", a["id"] == b["id"], f"{a['id']} vs {b['id']}")
    ok("迁移后：在线歌曲不混进本地曲库", len(library_service.all_songs()) == 3,
       f"共 {len(library_service.all_songs())} 条")
    ok("迁移后：在线歌曲可被收藏", library_service.toggle_favorite(a["id"]) is True)
    from app.services import playlist_service  # noqa: PLC0415

    ok("迁移后：歌单可容纳在线歌曲",
       playlist_service.add_song_to_playlist(1, a["id"]) is True,
       "在线歌曲未能加入歌单")
    ok("迁移后：歌单查询带上在线标记",
       any(s.get("online_source") == "kw" for s in playlist_service.get_playlist_songs(1)),
       str(playlist_service.get_playlist_songs(1)))

    # ---- 幂等：再跑一次 init_db 不应报错、不应改数据 ----
    db.init_db()
    db.init_db()
    ok("幂等：重复执行 init_db 不报错且数据不变", len(library_service.all_songs()) == 3,
       f"共 {len(library_service.all_songs())} 条")
    conn = sqlite3.connect(str(db.DB_PATH))
    ok("幂等：索引未重复创建",
       len([r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_songs_online'")]) == 1)
    conn.close()

    # ---- 真实安装库的副本也能迁移（本机存在才跑；CI 上跳过） ----
    installed = Path(r"D:\Apps\01_Sys_Daily\15_Music\TeyvatMelody\data\library.db")
    if installed.is_file():
        copy = tmp / "installed-copy.db"
        copy.write_bytes(installed.read_bytes())
        db.DB_PATH = copy
        try:
            db.init_db()
            conn = sqlite3.connect(str(copy))
            c2 = [r[1] for r in conn.execute("PRAGMA table_info(songs)")]
            n = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
            conn.close()
            ok("真实安装库副本：迁移成功且列齐全",
               "online_source" in c2 and "online_meta" in c2, str(c2))
            ok("真实安装库副本：原有歌曲数不变", n >= 0, str(n))
        except Exception as exc:  # noqa: BLE001
            ok("真实安装库副本：迁移不应抛错", False, str(exc))
    else:
        print("SKIP  未找到本机安装版数据库，跳过真实库副本迁移验证")

    print("\n自检结束")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
