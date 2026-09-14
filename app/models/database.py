# -*- coding: utf-8 -*-
"""SQLite 数据访问层：表结构初始化与基础行映射。

Phase 4 将歌曲库 / 歌单从内存注册表迁移到 SQLite 持久化。
DB 文件位于 <项目根>/data/library.db，封面以 BLOB 内嵌存储，
列表查询不返回 cover 大字段，仅提供 has_cover 布尔标记。
"""
import sqlite3
from typing import Any, Iterable, Optional

from app.utils import paths


def _default_data_dir():
    """数据目录定位：<应用根目录>/data（随软件一起存放）。"""
    return paths.data_dir()


DATA_DIR = _default_data_dir()
DB_PATH = DATA_DIR / "library.db"

# 列表返回需要的列（不含 cover 大字段）。
# 后四列是「在线歌曲」标记：本地文件为空串，在线歌曲记录来源平台 / 平台 ID /
# 首选音质 / 封面远程地址，前端据此把行还原成在线歌曲对象（见 frontend/src/utils/songShape.js）。
SONG_COLS = (
    "id, path, title, artist, album, duration, favorite, "
    "sample_rate, bitrate, channels, format, "
    "online_source, online_id, online_quality, cover_url, online_meta, "
    "cover IS NOT NULL AS has_cover"
)

# 带表别名 s. 的版本：用于 JOIN songs 的查询，避免裸列名（如 id）在两表同时存在时
# 触发 SQLite 的 "ambiguous column name" 错误。
SONG_COLS_Q = (
    "s.id, s.path, s.title, s.artist, s.album, s.duration, s.favorite, "
    "s.sample_rate, s.bitrate, s.channels, s.format, "
    "s.online_source, s.online_id, s.online_quality, s.cover_url, s.online_meta, "
    "s.cover IS NOT NULL AS has_cover"
)

# 本地曲库过滤条件：在线歌曲记录（无本地文件）不应出现在「音乐库」列表里。
# 它们由 /api/online/library 单独列出，但**共用收藏与歌单**（正是入库的目的）。
LOCAL_ONLY = "online_source = ''"
LOCAL_ONLY_Q = "s.online_source = ''"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
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
  source_path TEXT,
  online_source  TEXT NOT NULL DEFAULT '',
  online_id      TEXT,
  online_quality TEXT,
  cover_url      TEXT,
  online_meta    TEXT
);

CREATE TABLE IF NOT EXISTS playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id  INTEGER NOT NULL,
  song_id      INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, song_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id)     REFERENCES songs(id)     ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playback_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  played_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_songs_title  ON songs(title);
CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
CREATE INDEX IF NOT EXISTS idx_ps_playlist  ON playlist_songs(playlist_id);
CREATE INDEX IF NOT EXISTS idx_ph_song      ON playback_history(song_id);
CREATE INDEX IF NOT EXISTS idx_ph_time      ON playback_history(played_at);
"""


def init_db() -> None:
    """建库建表（幂等）。应用启动时调用一次。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        # WAL：写不阻塞读，扫描写库与前端列表读可并发，显著改善加载/扫描体验
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """对旧库执行轻量列迁移（幂等，列已存在则忽略）。"""
    for ddl in (
        "ALTER TABLE songs ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE songs ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE songs ADD COLUMN bitrate INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE songs ADD COLUMN channels INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE songs ADD COLUMN format TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE songs ADD COLUMN source_path TEXT",
        # 在线歌曲入库（Phase 5）：本地文件为空串，在线歌曲记录来源与平台 ID
        "ALTER TABLE songs ADD COLUMN online_source TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE songs ADD COLUMN online_id TEXT",
        "ALTER TABLE songs ADD COLUMN online_quality TEXT",
        "ALTER TABLE songs ADD COLUMN cover_url TEXT",
        # 在线歌曲的完整 musicInfo（JSON）：源脚本要的字段各平台不同（kw 的 DC_TARGETID、
        # kg 的 album_id、tx 的 media_mid…），只存一个 id 不足以在下次播放时还原请求。
        "ALTER TABLE songs ADD COLUMN online_meta TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # 列已存在
    # 唯一索引在旧库上补建（新库同样由这里建 —— 不能放进 _SCHEMA，
    # 因为旧库的 songs 表此刻还没有 online_source 列，executescript 会直接报错）。
    # 作用：同一首在线歌被重复「收藏/入库」时命中同一行，收藏状态与歌单归属不会分裂。
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_online "
            "ON songs(online_source, online_id) WHERE online_source <> ''"
        )
    except sqlite3.OperationalError:
        pass


def get_conn() -> sqlite3.Connection:
    """返回一个 row_factory=Row 的连接，调用方负责 commit/close。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL 下用 NORMAL 同步即可：崩溃时最多丢最后一次事务，读写更快
    conn.execute("PRAGMA synchronous = NORMAL")
    # 写锁忙等 5s：扫描写库时前端读不立即报错，避免报 database is locked
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def fetch_one(sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None


def fetch_all(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """执行写操作（无返回行），返回 lastrowid。"""
    with get_conn() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid
