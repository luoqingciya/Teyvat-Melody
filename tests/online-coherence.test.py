# -*- coding: utf-8 -*-
"""本地 / 在线歌曲一致性自检：python tests/online-coherence.test.py

盯住三条「同一首歌必须只有一条记录」的不变量：

  1. **下载不产生第二行**：在线歌曲在 songs 表已占一行，收藏 / 歌单 / 最近播放 /
     播放统计全挂在那个 id 上。下载时若另插一行本地记录，同一首歌就有两行 ——
     「全部音乐」里出现两份（一份仅本地、一份仅在线），且下载前后的收藏不是同一条。
     正确做法是**就地转成本地行**（清 online_source/online_id，保留 id 与 favorite）。

  2. **转成本地行之后再入库，仍然复用同一行**：靠 `source_path = online://…` 认出来。
     否则用户下载后再收藏一次，重复问题原样复发。

  3. **在线播放必须能被记进历史**：最近播放与播放统计都挂在 songs.id 上，
     而搜索结果的 id 是平台字符串 —— 所以记录接口要先入库再记，否则
     「最近播放里看不到在线歌曲」。
"""
import json
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 曲库 / 音乐目录指向临时目录，别污染项目根
_LIB_TMP = Path(tempfile.mkdtemp(prefix="tm-coh-"))
from app.models import database as _db  # noqa: E402

_db.DATA_DIR = _LIB_TMP / "data"
_db.DB_PATH = _db.DATA_DIR / "library.db"

from app.utils import paths as _paths  # noqa: E402

_paths.music_dir = lambda: _LIB_TMP / "music"

from app.server import create_app  # noqa: E402
from app.services import library_service as ls  # noqa: E402

FAILED = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global FAILED
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        FAILED = 1


def make_file(name: str) -> Path:
    """造一个占位音频文件（register_file 要求文件真实存在；解析失败会降级，不影响断言）"""
    d = _LIB_TMP / "music"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_bytes(b"\x00" * 64)
    return p


def rows_by_title(title: str) -> list[dict]:
    return _db.fetch_all("SELECT * FROM songs WHERE title = ?", (title,))


def main() -> int:
    app = create_app()
    client = app.test_client()

    # ================= 1) 下载：就地转成本地行，不产生第二行 =================
    online = ls.upsert_online_song(
        "kw",
        "MUSIC_1001",
        title="一致性测试曲",
        artist="测试歌手",
        album="测试专辑",
        duration=200,
        cover_url="https://example.com/c.jpg",
        quality="flac",
        meta={"songmid": "MUSIC_1001", "name": "一致性测试曲"},
    )
    ok("在线歌曲入库成功", bool(online) and online["online_source"] == "kw")
    online_id = online["id"]
    ls.toggle_favorite(online_id)
    ok("在线歌曲可被收藏", bool(ls.get_song(online_id)["favorite"]))

    dest = make_file("测试歌手 - 一致性测试曲.mp3")
    merged = ls.register_file(
        dest,
        {"title": "一致性测试曲", "artist": "测试歌手", "album": "测试专辑", "duration": 200,
         "source_path": ls.online_path("kw", "MUSIC_1001")},
        online_source="kw",
        online_id="MUSIC_1001",
        song_id=online_id,
    )
    ok("下载登记成功", bool(merged))
    ok("⚠️ 下载后仍是同一行（id 未变，没有新插一行）", merged and merged["id"] == online_id,
       f"{online_id} -> {merged and merged['id']}")
    ok("⚠️ 该标题在库中只有一条记录（不再出现「一份本地 + 一份在线」）",
       len(rows_by_title("一致性测试曲")) == 1, str(rows_by_title("一致性测试曲")))
    ok("已转成本地行（online_source 清空 → 播放走本地文件、不再算在线）",
       merged["online_source"] == "" and merged["online_id"] is None,
       json.dumps({k: merged[k] for k in ("online_source", "online_id")}, ensure_ascii=False))
    ok("保留了收藏状态（下载前后是同一条记录）", bool(merged["favorite"]))
    ok("path 指向真实文件", merged["path"] == str(dest))
    # source_path 不在 SONG_COLS 里（它是内部凭证，不对外暴露），直接查库
    sp = _db.fetch_one("SELECT source_path FROM songs WHERE id = ?", (online_id,))["source_path"]
    ok("source_path 留下来源凭证", sp == "online://kw/MUSIC_1001", str(sp))
    ok("本地曲库（全部音乐）能看到它", any(s["id"] == online_id for s in ls.all_songs()))
    ok("在线列表已不含它（它现在是本地歌）", all(s["id"] != online_id for s in ls.list_online_songs()))
    ok("「已下载」标记仍认得它（搜索页据此置灰下载按钮）", "kw:MUSIC_1001" in ls.downloaded_keys())

    # ================= 2) 转本地后再入库，仍复用同一行 =================
    again = ls.upsert_online_song("kw", "MUSIC_1001", title="一致性测试曲", artist="测试歌手")
    ok("⚠️ 下载后再入库（收藏/播放触发）仍命中同一行", again and again["id"] == online_id,
       f"{online_id} -> {again and again['id']}")
    ok("⚠️ 不会被改回在线行（否则又会分裂成两份）", again["online_source"] == "")
    ok("该标题始终只有一条记录", len(rows_by_title("一致性测试曲")) == 1)
    ok("音质偏好不会被写到本地行上（本地行没有「在线音质」的概念）",
       again["online_quality"] in (None, ""))

    # 播放记录接口带在线身份时也应命中同一行
    r = client.post("/api/playback/record", json={
        "source": "kw", "platformId": "MUSIC_1001",
        "title": "一致性测试曲", "artist": "测试歌手", "duration": 200,
        "meta": {"songmid": "MUSIC_1001"},
    })
    body = r.get_json()
    ok("播放记录接口（在线身份）返回 200", r.status_code == 200 and body.get("code") == 200, str(body))
    ok("⚠️ 接口也命中同一行，没有新建记录",
       body.get("data", {}).get("id") == online_id, str(body.get("data", {}).get("id")))
    ok("仍然只有一条记录", len(rows_by_title("一致性测试曲")) == 1)

    # ================= 3) 从未入库的在线歌曲：先入库再记播放 =================
    r = client.post("/api/playback/record", json={
        "source": "kg", "platformId": "HASH_2002",
        "title": "直接播放在线曲", "artist": "在线歌手", "album": "在线专辑",
        "duration": 180, "coverUrl": "https://example.com/d.jpg", "quality": "320k",
        "meta": {"hash": "HASH_2002", "name": "直接播放在线曲"},
    })
    body = r.get_json()
    new_id = (body.get("data") or {}).get("id")
    ok("未入库的在线歌曲：接口先入库再记录（返回整数 id）",
       r.status_code == 200 and isinstance(new_id, int), str(body))
    row = ls.get_song(new_id) if new_id else None
    ok("入库的是在线行（仍可继续走在线播放）", bool(row) and row["online_source"] == "kg")
    ok("元信息被保存下来（下次播放源脚本还要用）", bool(row) and bool(row["online_meta"]))

    hist = ls.get_playback_history(50)
    ids = [h["id"] for h in hist]
    ok("⚠️ 最近播放里能看到这首在线歌曲（修复「最近播放不显示在线歌」）",
       new_id in ids, str(ids[:10]))
    ok("⚠️ 最近播放里也能看到上面那首下载后的歌", online_id in ids, str(ids[:10]))
    ok("历史条目带得出标题（JOIN songs 正常）",
       all(h.get("title") for h in hist if h["id"] in (new_id, online_id)))

    stats = ls.get_playback_stats(30)
    ok("播放统计计入在线播放", stats["total_plays"] >= 2, str(stats["total_plays"]))
    ok("统计的 unique_songs 含在线歌曲", stats["unique_songs"] >= 2, str(stats["unique_songs"]))

    # ================= 4) 参数校验 =================
    # 注意：songs.py 沿用 ok()/fail() 约定 —— 失败也是 HTTP 200，错误码在 body.code 里
    r = client.post("/api/playback/record", json={})
    ok("既无 songId 也无在线身份 → 拒绝", r.status_code == 200 and r.get_json().get("code") == 400,
       str(r.get_json()))
    r = client.post("/api/playback/record", json={"source": "kw"})
    ok("只有 source 没有 platformId → 拒绝",
       r.status_code == 200 and r.get_json().get("code") == 400, str(r.get_json()))

    # 本地歌曲仍走老路径
    local = ls.register_file(make_file("本地歌手 - 本地曲.mp3"), {"title": "本地曲", "artist": "本地歌手"})
    r = client.post(f"/api/songs/{local['id']}/play")
    ok("本地歌曲的老接口仍然可用", r.status_code == 200, str(r.status_code))
    r = client.post("/api/playback/record", json={"songId": local["id"]})
    ok("新接口接受 songId（本地歌曲）", r.status_code == 200, str(r.status_code))

    # ================= 5) 重复播放不刷量（后端 5s 去重） =================
    before = len(ls.get_playback_history(200))
    for _ in range(3):
        client.post("/api/playback/record", json={"songId": local["id"]})
    after = len(ls.get_playback_history(200))
    ok("同一首 5 秒内连记三次只落一条（防刷量）", after - before <= 1, f"{before} -> {after}")

    # ================= 6) 历史遗留重复行的迁移 =================
    # 造出旧版会留下的状态：一行在线 + 一行同身份的本地行（source_path 指向在线来源）。
    # ⚠️ 顺序必须是「先在线行、后本地行」：新版 register_file 会就地合并，
    #    只有按旧版那样「不告诉它在线身份」才会另插一行 —— 这正是要迁移的历史数据形态。
    legacy_online = ls.upsert_online_song("tx", "TX_3003", title="迁移曲", artist="迁移歌手")
    legacy_local = ls.register_file(
        make_file("迁移歌手 - 迁移曲.mp3"),
        {"title": "迁移曲", "artist": "迁移歌手", "source_path": ls.online_path("tx", "TX_3003")},
    )
    ok("构造出旧版重复状态（本地 + 在线各一行）",
       legacy_local["id"] != legacy_online["id"], f"{legacy_local['id']} / {legacy_online['id']}")
    # 收藏 / 歌单 / 历史都挂在**在线行**上（旧版下载后，用户收藏的往往正是在线那份）
    ls.toggle_favorite(legacy_online["id"])
    pl2 = client.post("/api/playlists", json={"name": "迁移歌单"}).get_json()["data"]["id"]
    client.post(f"/api/playlists/{pl2}/songs", json={"song_id": legacy_online["id"]})
    client.post("/api/playback/record", json={"songId": legacy_online["id"]})
    hist_before_mig = len(ls.get_playback_history(500))

    def run_migration():
        conn = _db.get_conn()
        try:
            _db._merge_downloaded_online_duplicates(conn)
        finally:
            conn.close()

    run_migration()
    remaining = rows_by_title("迁移曲")
    ok("⚠️ 迁移后同一首歌只剩一行（历史遗留重复被合并）",
       len(remaining) == 1, str([r["id"] for r in remaining]))
    ok("保留的是本地行（它指向真实文件）",
       bool(remaining) and remaining[0]["id"] == legacy_local["id"] and remaining[0]["online_source"] == "",
       str(remaining and remaining[0]["id"]))
    ok("在线行上的收藏被搬到本地行", bool(remaining) and bool(remaining[0]["favorite"]))
    ok("歌单归属被搬到本地行",
       any(s["id"] == legacy_local["id"]
           for s in client.get(f"/api/playlists/{pl2}/songs").get_json()["data"]))
    ok("⚠️ 播放历史被搬到本地行（没有随删除被级联带走）",
       len(ls.get_playback_history(500)) == hist_before_mig,
       f"{hist_before_mig} -> {len(ls.get_playback_history(500))}")
    ok("在线行已不存在", all(s["id"] != legacy_online["id"] for s in ls.list_online_songs()))

    run_migration()
    ok("迁移幂等（再跑一次不改变任何东西）",
       len(rows_by_title("迁移曲")) == 1 and len(ls.get_playback_history(500)) == hist_before_mig)

    print("\n自检结束")
    return FAILED


if __name__ == "__main__":
    sys.exit(main())
