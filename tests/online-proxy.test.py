# -*- coding: utf-8 -*-
"""在线音频代理自检：python tests/online-proxy.test.py

用本地支持 Range 的测试服务器扮演音频 CDN，覆盖：
无 Range 全量、Range 分段（206 + Content-Range）、HEAD、防盗链头注入、
非法 scheme 拒绝、缺参拒绝、上游错误透传、Cache-Control。
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote

# Windows 控制台默认 cp1252，直接打印中文测试名会 UnicodeEncodeError ——
# 表现为「测试全部通过却因打印失败而退出码非 0」。统一改用 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001  旧版本或非常规 stdout（如被重定向为 None）时忽略
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.server import create_app  # noqa: E402
from app.services import online_cache  # noqa: E402

# 把缓存目录指向临时目录：测试不应污染项目根目录下的 cache/
_CACHE_TMP = Path(tempfile.mkdtemp(prefix="tm-cache-"))
online_cache._root_cache_dir = lambda: _CACHE_TMP

# 曲库与音乐目录同样指向临时目录：否则测试会往项目根目录的 data/ 与 music/ 里写东西
_LIB_TMP = Path(tempfile.mkdtemp(prefix="tm-lib-"))
from app.models import database as _db  # noqa: E402

_db.DATA_DIR = _LIB_TMP / "data"
_db.DB_PATH = _db.DATA_DIR / "library.db"

from app.utils import paths as _paths  # noqa: E402

_paths.music_dir = lambda: _LIB_TMP / "music"

PAYLOAD = bytes(range(256)) * 40  # 10240 字节确定性内容
IMAGE = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 4  # 伪 JPEG 字节
UPSTREAM = {}  # 记录上游最近一次收到的请求头


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, body: bytes, status: int, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _audio(self, body: bytes, status: int, extra: dict | None = None) -> None:
        self.send_response(status)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        UPSTREAM["headers"] = {k.lower(): v for k, v in self.headers.items()}
        UPSTREAM["path"] = self.path
        UPSTREAM["count"] = UPSTREAM.get("count", 0) + 1  # 用于验证缓存命中时不再打上游
        if self.path.startswith("/song.mp3"):
            # 只统计音频请求：封面/其它资源的请求不该影响「有没有重复取音频」的判断
            UPSTREAM["audio"] = UPSTREAM.get("audio", 0) + 1
        if self.path.startswith("/cover.jpg"):
            self._send(IMAGE, 200, "image/jpeg", {"Content-Length": str(len(IMAGE))})
            return
        if self.path.startswith("/notimage"):
            self._send(b"<html>hi</html>", 200, "text/html")
            return
        if not self.path.startswith("/song.mp3"):
            self._audio(b"", 404)
            return
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            start_s, _, end_s = rng[len("bytes="):].partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else len(PAYLOAD) - 1
            end = min(end, len(PAYLOAD) - 1)
            chunk = PAYLOAD[start:end + 1]
            self._audio(
                chunk,
                206,
                {
                    "Content-Range": f"bytes {start}-{end}/{len(PAYLOAD)}",
                    "Content-Length": str(len(chunk)),
                },
            )
            return
        self._audio(PAYLOAD, 200, {"Content-Length": str(len(PAYLOAD))})

    def do_HEAD(self):  # noqa: N802
        UPSTREAM["headers"] = {k.lower(): v for k, v in self.headers.items()}
        self._audio(b"", 200, {"Content-Length": str(len(PAYLOAD))})

    def log_message(self, *args):  # 静音访问日志
        pass


def ok(name: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        sys.exit_code = 1
        globals()["_failed"] = True


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    app = create_app()
    client = app.test_client()
    target = quote(f"http://127.0.0.1:{port}/song.mp3", safe="")

    # 1) 无 Range：全量透传
    r = client.get(f"/api/online/proxy?url={target}&source=kw")
    body = r.get_data()
    ok("无 Range → 200 全量", r.status_code == 200 and len(body) == len(PAYLOAD), f"{r.status_code} len={len(body)}")
    ok("回传 Content-Type", r.headers.get("Content-Type") == "audio/mpeg", str(r.headers.get("Content-Type")))
    ok("补上 Accept-Ranges", r.headers.get("Accept-Ranges") == "bytes", str(r.headers.get("Accept-Ranges")))
    ok("禁止缓存", r.headers.get("Cache-Control") == "no-store", str(r.headers.get("Cache-Control")))

    # 2) 防盗链头注入：上游应看到平台 Referer 与浏览器 UA
    ok("上游收到平台 Referer", UPSTREAM.get("headers", {}).get("referer") == "https://www.kuwo.cn/",
       str(UPSTREAM.get("headers", {}).get("referer")))
    ok("上游收到伪装 UA", "Mozilla" in UPSTREAM.get("headers", {}).get("user-agent", ""),
       str(UPSTREAM.get("headers", {}).get("user-agent")))

    # 3) Range：透传并回传 206 + Content-Range（seek 的关键）
    r2 = client.get(f"/api/online/proxy?url={target}&source=kw", headers={"Range": "bytes=100-199"})
    body2 = r2.get_data()
    ok("Range → 206", r2.status_code == 206, str(r2.status_code))
    ok("Range → Content-Range 正确",
       r2.headers.get("Content-Range") == f"bytes 100-199/{len(PAYLOAD)}",
       str(r2.headers.get("Content-Range")))
    ok("Range → 字节内容正确", body2 == PAYLOAD[100:200], f"len={len(body2)}")
    ok("Range 头已透传给上游", UPSTREAM.get("headers", {}).get("range") == "bytes=100-199",
       str(UPSTREAM.get("headers", {}).get("range")))

    # 4) HEAD：无响应体
    r3 = client.head(f"/api/online/proxy?url={target}&source=kw")
    ok("HEAD → 200 且无 body", r3.status_code == 200 and len(r3.get_data()) == 0,
       f"{r3.status_code} len={len(r3.get_data())}")

    # 5) 未收录平台：不注入 Referer，但仍可用
    r4 = client.get(f"/api/online/proxy?url={target}&source=unknown")
    ok("未知平台仍可转发", r4.status_code == 200, str(r4.status_code))
    ok("未知平台不注入 Referer", "referer" not in UPSTREAM.get("headers", {}),
       str(UPSTREAM.get("headers", {}).get("referer")))

    # 6) 非法 scheme 拒绝（防被源脚本当任意协议跳板）
    r5 = client.get("/api/online/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd")
    ok("拒绝 file:// 协议", r5.status_code == 400, str(r5.status_code))

    # 7) 缺 url
    r6 = client.get("/api/online/proxy")
    ok("缺 url → 400", r6.status_code == 400, str(r6.status_code))

    # 8) 上游错误透传
    bad = quote(f"http://127.0.0.1:{port}/missing.mp3", safe="")
    r7 = client.get(f"/api/online/proxy?url={bad}&source=kw")
    ok("上游 404 透传", r7.status_code == 404, str(r7.status_code))

    # 9) 上游不可达
    dead = quote("http://127.0.0.1:1/none.mp3", safe="")
    r8 = client.get(f"/api/online/proxy?url={dead}&source=kw")
    ok("上游不可达 → 502", r8.status_code == 502, str(r8.status_code))

    # ---- 封面代理 /api/online/image ----
    cover = quote(f"http://127.0.0.1:{port}/cover.jpg", safe="")
    r9 = client.get(f"/api/online/image?url={cover}&source=kg")
    ok("封面：正常返回图片", r9.status_code == 200 and r9.get_data() == IMAGE, f"{r9.status_code} len={len(r9.get_data())}")
    ok("封面：Content-Type 透传", r9.headers.get("Content-Type") == "image/jpeg", str(r9.headers.get("Content-Type")))
    ok("封面：可缓存", "max-age" in (r9.headers.get("Cache-Control") or ""), str(r9.headers.get("Cache-Control")))
    ok("封面：注入平台 Referer", UPSTREAM.get("headers", {}).get("referer") == "https://www.kugou.com/",
       str(UPSTREAM.get("headers", {}).get("referer")))

    notimg = quote(f"http://127.0.0.1:{port}/notimage", safe="")
    r10 = client.get(f"/api/online/image?url={notimg}")
    ok("封面：非图片 → 415", r10.status_code == 415, str(r10.status_code))

    r11 = client.get("/api/online/image")
    ok("封面：缺 url → 400", r11.status_code == 400, str(r11.status_code))

    r12 = client.get("/api/online/image?url=file%3A%2F%2F%2Fx")
    ok("封面：拒绝 file:// 协议", r12.status_code == 400, str(r12.status_code))

    missing = quote(f"http://127.0.0.1:{port}/missing.jpg", safe="")
    r13 = client.get(f"/api/online/image?url={missing}")
    ok("封面：上游 404 透传", r13.status_code == 404, str(r13.status_code))

    # ---- 在线播放缓存 ----
    song = quote(f"http://127.0.0.1:{port}/song.mp3", safe="")
    online_cache.clear()
    online_cache.save_config({"enabled": True, "maxBytes": 1024 ** 3})

    r20 = client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:1:320k")
    body20 = r20.get_data()
    ok("缓存：首次播放返回完整内容", r20.status_code == 200 and len(body20) == len(PAYLOAD), f"{r20.status_code} len={len(body20)}")
    ok("缓存：首次播放后已落盘", online_cache.stats()["files"] == 1, json.dumps(online_cache.stats()))

    mid = UPSTREAM.get("count", 0)
    r21 = client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:1:320k")
    ok("缓存：二次播放命中缓存且内容一致", r21.get_data() == body20)
    ok("缓存：命中时不再请求上游", UPSTREAM.get("count", 0) == mid, f"{mid} → {UPSTREAM.get('count', 0)}")
    # 命中走 send_file，会持有文件句柄；Windows 上不关就删不掉缓存文件（后续 clear/淘汰会失败）
    r21.close()

    r22 = client.get(
        f"/api/online/proxy?url={song}&source=kw&key=kw:1:320k", headers={"Range": "bytes=100-199"}
    )
    ok("缓存：命中后 Range 仍返回 206", r22.status_code == 206 and r22.get_data() == PAYLOAD[100:200], f"{r22.status_code} len={len(r22.get_data())}")
    ok(
        "缓存：命中后 Content-Range 正确",
        r22.headers.get("Content-Range") == f"bytes 100-199/{len(PAYLOAD)}",
        str(r22.headers.get("Content-Range")),
    )
    r22.close()

    # 子区间请求不写缓存：避免把「半个文件」当成完整缓存
    # 注意：测试客户端是惰性的，不读 body 流式生成器就不会跑完 → 必须 get_data() 才有意义
    online_cache.clear()
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:2:320k", headers={"Range": "bytes=0-99"}).get_data()
    ok("缓存：子区间请求不写缓存", online_cache.stats()["files"] == 0, json.dumps(online_cache.stats()))

    # 从 0 一直到末尾的 Range（Chromium 首次请求音频的形态）视为完整内容
    client.get(
        f"/api/online/proxy?url={song}&source=kw&key=kw:3:320k",
        headers={"Range": f"bytes=0-{len(PAYLOAD) - 1}"},
    ).get_data()
    ok("缓存：0..末尾的 Range 视为完整内容并落盘", online_cache.stats()["files"] == 1, json.dumps(online_cache.stats()))

    # 无 key（旧式调用）不写缓存
    online_cache.clear()
    client.get(f"/api/online/proxy?url={song}&source=kw").get_data()
    ok("缓存：不带 key 时不写缓存", online_cache.stats()["files"] == 0, json.dumps(online_cache.stats()))

    # 关闭缓存后不写
    online_cache.save_config({"enabled": False})
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:4:320k").get_data()
    ok("缓存：关闭后不写缓存", online_cache.stats()["files"] == 0, json.dumps(online_cache.stats()))
    online_cache.save_config({"enabled": True})

    # 容量上限淘汰：上限只放得下一个文件，写第二个后应淘汰最旧的
    online_cache.clear()
    online_cache.save_config({"maxBytes": len(PAYLOAD) + 10})
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:old:320k").get_data()
    time.sleep(0.05)  # 让两次写入的 mtime 可区分（LRU 依据）
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:new:320k").get_data()
    st = online_cache.stats()
    ok("缓存：超出上限时淘汰到上限内", st["bytes"] <= len(PAYLOAD) + 10, json.dumps(st))
    ok(
        "缓存：淘汰最久未使用的，保留最近的",
        online_cache.cached_path("kw:new:320k") is not None and online_cache.cached_path("kw:old:320k") is None,
        json.dumps(st),
    )
    online_cache.save_config({"maxBytes": 1024 ** 3})

    # 管理接口
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:clr:320k").get_data()
    r23 = client.post("/api/online/cache/clear")
    ok("缓存：清空接口生效", r23.status_code == 200 and online_cache.stats()["bytes"] == 0, json.dumps(online_cache.stats()))

    r24 = client.post("/api/online/cache/config", json={"maxBytes": 256 * 1024 ** 2})
    ok(
        "缓存：配置接口返回最新配置",
        r24.status_code == 200 and r24.get_json()["data"]["maxBytes"] == 256 * 1024 ** 2,
        json.dumps(r24.get_json()),
    )
    r25 = client.get("/api/online/cache")
    data25 = r25.get_json()["data"]
    ok("缓存：统计接口返回占用与可选上限", r25.status_code == 200 and "maxBytesOptions" in data25 and "bytes" in data25, json.dumps(data25))

    # ---- 完整内容判定 / 后台补完的取舍（纯函数）----
    from app.api.online import _is_full_body, _total_bytes, _worth_finishing

    ok("完整内容：200 视为完整", _is_full_body(200, {}))
    ok("完整内容：0..末尾的 206 视为完整", _is_full_body(206, {"Content-Range": "bytes 0-99/100"}))
    ok("完整内容：中间片段的 206 不算完整", not _is_full_body(206, {"Content-Range": "bytes 0-99/200"}))
    ok("完整内容：416 等其它状态不算完整", not _is_full_body(416, {}))

    ok("总字节：优先取 Content-Range 的总量", _total_bytes({"Content-Range": "bytes 0-99/12345"}) == 12345)
    ok("总字节：无 Range 时取 Content-Length", _total_bytes({"Content-Length": "999"}) == 999)
    ok("总字节：都没有时返回 0", _total_bytes({}) == 0)

    mb = 1024 * 1024
    ok("后台补完：不足 1MB 不值得继续（避免替用户偷跑流量）", not _worth_finishing(500 * 1024, 10 * mb))
    ok("后台补完：已下 30% 以上值得继续", _worth_finishing(4 * mb, 10 * mb))
    ok("后台补完：已下不足 30% 不值得继续", not _worth_finishing(2 * mb, 10 * mb))
    ok("后台补完：总量未知时按已下大小判断", _worth_finishing(2 * mb, 0))

    # ---- 占用统计必须含进行中的 .part ----
    # 否则播放期间 `.part` 一直在长大、界面上的数字却纹丝不动，用户会以为缓存没生效
    online_cache.clear()
    part = online_cache.temp_path("kw:part:320k")
    part.write_bytes(b"p" * 4096)
    st = online_cache.stats()
    ok("统计：进行中的 .part 计入占用", st["bytes"] == 4096 and st["files"] == 0, json.dumps(st))
    ok("统计：单独给出 partialBytes 供界面区分", st["partialBytes"] == 4096, json.dumps(st))

    # 淘汰只动已完成条目：删掉正在写的临时文件会打断当前播放
    online_cache.save_config({"maxBytes": 2048})  # 上限比 .part 还小
    online_cache.evict()
    ok("淘汰：不删除进行中的 .part", part.is_file(), "临时文件被误删")
    online_cache.save_config({"maxBytes": 1024 ** 3})

    # 被遗弃的 .part（应用被杀后残留、长时间无写入）应被清理
    stale = online_cache.temp_path("kw:stale:320k")
    stale.write_bytes(b"s" * 128)
    old_at = time.time() - online_cache._ABANDONED_PART_SECONDS - 10
    os.utime(stale, (old_at, old_at))
    online_cache.evict()
    ok("淘汰：清理被遗弃的 .part", not stale.is_file(), "陈旧临时文件未被清理")

    online_cache.clear()
    ok("清空后占用归零", online_cache.stats()["bytes"] == 0, json.dumps(online_cache.stats()))

    # ---- 歌词缓存也要被统计与清空 ----
    # 歌词缓存由主进程（Node）写入，Flask 只负责统计和清理 —— 但设置页展示的是同一个数字，
    # 所以必须算进来，否则「已用」会少一块，用户清空后仍看到文件残留。
    online_cache.clear()
    client.get(f"/api/online/proxy?url={song}&source=kw&key=kw:lyr:320k").get_data()
    lyr_dir = online_cache.lyrics_dir()
    lyr_dir.mkdir(parents=True, exist_ok=True)
    (lyr_dir / "abc123.json").write_text('{"lines":[{"t":1,"text":"x"}]}', "utf-8")
    (lyr_dir / "def456.json").write_text('{"lines":[{"t":2,"text":"y"}]}', "utf-8")
    st = online_cache.stats()
    ok("歌词缓存：单独统计份数与占用", st["lyricsFiles"] == 2 and st["lyricsBytes"] > 0, json.dumps(st))
    ok("歌词缓存：不并进音频 bytes（容量上限只管音频）", st["bytes"] == len(PAYLOAD), json.dumps(st))
    ok("歌词缓存：totalBytes 含音频与歌词", st["totalBytes"] == st["bytes"] + st["lyricsBytes"], json.dumps(st))

    r26 = client.get("/api/online/cache")
    ok(
        "歌词缓存：统计接口透出 lyricsBytes",
        "lyricsBytes" in r26.get_json()["data"] and "totalBytes" in r26.get_json()["data"],
        json.dumps(r26.get_json()),
    )

    r27 = client.post("/api/online/cache/clear")
    st = online_cache.stats()
    ok(
        "歌词缓存：清空接口一并清掉歌词",
        r27.status_code == 200 and st["lyricsBytes"] == 0 and st["bytes"] == 0 and not any(lyr_dir.glob("*")),
        json.dumps(st),
    )

    # ---- 在线歌曲入库：收藏 / 歌单 / 下载 ----
    # 目标：在线歌曲只需在 songs 表里占一行，就能复用既有收藏与歌单机制
    from app.services import library_service

    online_cache.clear()
    online_cache.save_config({"enabled": True, "maxBytes": 1024 ** 3})
    online_cache.clear()

    payload = {
        "source": "kw",
        "platformId": "MUSIC_7788",
        "title": "测试歌曲",
        "artist": "测试歌手",
        "album": "测试专辑",
        "duration": 215.4,
        "coverUrl": f"http://127.0.0.1:{port}/cover.jpg",
        "quality": "320k",
        # 完整 musicInfo：源脚本解析地址时要用到平台专有字段，必须原样存下来
        "meta": {"rid": "MUSIC_7788", "songmid": "MUSIC_7788", "DC_TARGETID": "MUSIC_7788"},
    }
    r30 = client.post("/api/online/register", json=payload)
    song = r30.get_json()["data"]
    sid = song["id"]
    ok("入库：注册在线歌曲返回本地 id", r30.status_code == 200 and isinstance(sid, int), json.dumps(song))
    ok("入库：来源与平台 ID 已记录", song["online_source"] == "kw" and song["online_id"] == "MUSIC_7788", json.dumps(song))
    ok("入库：首选音质已记录", song["online_quality"] == "320k", json.dumps(song))
    ok(
        "入库：完整 musicInfo 已留存（下次从收藏播放仍能解析）",
        json.loads(song["online_meta"])["DC_TARGETID"] == "MUSIC_7788",
        json.dumps(song.get("online_meta")),
    )

    r31 = client.post("/api/online/register", json=payload)
    ok("入库：重复注册幂等（同一行）", r31.get_json()["data"]["id"] == sid, json.dumps(r31.get_json()))

    r32 = client.post("/api/online/register", json={"source": "", "platformId": ""})
    ok("入库：缺 source/platformId → 400", r32.status_code == 400, str(r32.status_code))

    # 在线歌曲不应混进本地音乐库列表
    ids = [s["id"] for s in client.get("/api/songs").get_json()["data"]]
    ok("入库：在线歌曲不出现在本地音乐库", sid not in ids, f"ids={ids}")

    lib = client.get("/api/online/library").get_json()["data"]
    ok("入库：在线曲库能列出它", any(s["id"] == sid for s in lib), json.dumps(lib))

    # 收藏：复用既有 /api/favorites（这正是入库的目的）
    r33 = client.post(f"/api/favorites/{sid}")
    ok("收藏：在线歌曲可收藏", r33.status_code == 200 and r33.get_json()["data"]["favorite"] is True, json.dumps(r33.get_json()))
    fav_ids = [s["id"] for s in client.get("/api/favorites").get_json()["data"]]
    ok("收藏：出现在收藏列表里", sid in fav_ids, f"ids={fav_ids}")
    ok(
        "收藏：可按收藏过滤在线曲库",
        [s["id"] for s in client.get("/api/online/library?favorite=1").get_json()["data"]] == [sid],
        json.dumps(client.get("/api/online/library?favorite=1").get_json()),
    )

    # 歌单：同样复用既有接口
    pl_id = client.post("/api/playlists", json={"name": "在线测试歌单"}).get_json()["data"]["id"]
    r34 = client.post(f"/api/playlists/{pl_id}/songs", json={"song_id": sid})
    ok("歌单：在线歌曲可加入歌单", r34.status_code == 200 and r34.get_json()["data"]["added"] is True, json.dumps(r34.get_json()))
    pl_songs = client.get(f"/api/playlists/{pl_id}/songs").get_json()["data"]
    ok("歌单：歌单里能查到它", any(s["id"] == sid for s in pl_songs), json.dumps(pl_songs))
    # 歌单查询曾自己手抄一份列清单，漏掉 online_source 后在线歌曲会被前端当成
    # 「本地歌曲」去请求 /stream/<id>（文件不存在，直接播不出声）。这里锁住这个契约。
    ok(
        "歌单：返回行必须带在线标记（否则前端会当本地歌去读文件）",
        any(s.get("online_source") == "kw" for s in pl_songs),
        json.dumps(pl_songs),
    )
    ok(
        "歌单：返回行与 songs 表列定义同源（含完整 musicInfo）",
        any(s.get("online_meta") for s in pl_songs),
        json.dumps(pl_songs),
    )

    # 首选音质可改
    r35 = client.put(f"/api/online/songs/{sid}/quality", json={"quality": "flac"})
    ok("音质：可记住首选音质", r35.get_json()["data"]["online_quality"] == "flac", json.dumps(r35.get_json()))
    r36 = client.put("/api/online/songs/999999/quality", json={"quality": "flac"})
    ok("音质：非在线歌曲 → 404", r36.status_code == 404, str(r36.status_code))

    # ---- 下载：把在线音频真正取回本地并登记为本地歌曲 ----
    audio_url = f"http://127.0.0.1:{port}/song.mp3"
    dl_payload = {
        "url": audio_url,
        "source": "kw",
        "key": "kw:MUSIC_7788:320k",
        "quality": "320k",
        "platformId": "MUSIC_7788",
        "songId": sid,
        "meta": {
            "title": "测试歌曲",
            "artist": "测试歌手",
            "album": "测试专辑",
            "duration": 215.4,
            "coverUrl": f"http://127.0.0.1:{port}/cover.jpg",
        },
        "lyrics": "[00:01.00]测试歌词\n[00:03.00]第二行",
    }
    r40 = client.post("/api/online/download", json=dl_payload)
    dl_song = r40.get_json()["data"]
    # ⚠️⚠️ 关键不变量：下载必须**就地**把那一行在线记录转成本地行，而不是另插一行。
    # 另插一行会让「全部音乐」里出现两份（一份仅本地、一份仅在线），
    # 而且下载**前**收藏的那一份与下载**后**的文件不是同一条记录 —— 收藏/歌单/统计全对不上。
    ok(
        "下载：就地转成本地歌曲（沿用同一行 id，不新插一行）",
        r40.status_code == 200 and dl_song and dl_song["id"] == sid,
        json.dumps(r40.get_json())[:200],
    )
    _local_same = [s for s in client.get("/api/songs").get_json()["data"] if s["title"] == "测试歌曲"]
    _online_same = [s for s in client.get("/api/online/library").get_json()["data"] if s["title"] == "测试歌曲"]
    ok(
        "⚠️ 下载后「测试歌曲」在本地库只有一份、在线库已不含它（不再两份）",
        len(_local_same) == 1 and len(_online_same) == 0,
        f"本地 {len(_local_same)} 份 / 在线 {len(_online_same)} 份",
    )
    ok(
        "下载：收藏状态延续（下载前收藏的就是它）",
        sid in [s["id"] for s in client.get("/api/favorites").get_json()["data"]],
        json.dumps(client.get("/api/favorites").get_json())[:200],
    )
    ok(
        "下载：歌单归属延续到本地行",
        any(s["id"] == sid for s in client.get(f"/api/playlists/{pl_id}/songs").get_json()["data"]),
        json.dumps(client.get(f"/api/playlists/{pl_id}/songs").get_json())[:200],
    )
    ok("下载：本地歌曲不带在线标记", dl_song["online_source"] == "", json.dumps(dl_song))
    ok("下载：元数据取自在线信息（而非文件名）", dl_song["title"] == "测试歌曲" and dl_song["artist"] == "测试歌手", json.dumps(dl_song))
    ok("下载：封面已入库", bool(dl_song["has_cover"]), json.dumps(dl_song))
    ok("下载：时长已记录", abs(dl_song["duration"] - 215.4) < 0.01, json.dumps(dl_song))

    dest = Path(dl_song["path"])
    ok("下载：文件已落盘且大小与上游一致", dest.is_file() and dest.stat().st_size == len(PAYLOAD), f"{dest} {dest.stat().st_size if dest.is_file() else 'N/A'}")
    ok("下载：文件名含歌手与歌名", dest.name.startswith("测试歌手 - 测试歌曲"), dest.name)
    ok("下载：歌词已写成同名 .lrc", dest.with_suffix(".lrc").is_file() and "测试歌词" in dest.with_suffix(".lrc").read_text("utf-8"), str(dest.with_suffix(".lrc")))
    ok("下载：文件位于 music 目录内", dest.parent == _paths.music_dir(), str(dest.parent))

    local_ids = [s["id"] for s in client.get("/api/songs").get_json()["data"]]
    ok("下载：已出现在本地音乐库", dl_song["id"] in local_ids, f"ids={local_ids}")

    dl_keys = client.get("/api/online/downloaded").get_json()["data"]
    ok("下载：已下载键可查（供搜索页标「已下载」）", "kw:MUSIC_7788" in dl_keys, json.dumps(dl_keys))

    # 重名不覆盖：再下一次应生成 "(1)"
    r41 = client.post("/api/online/download", json=dl_payload)
    dest2 = Path(r41.get_json()["data"]["path"])
    ok("下载：重名不覆盖，自动加序号", dest2 != dest and dest2.name.endswith("(1).mp3"), str(dest2))

    # 播放缓存命中时直接复制，不再回上游
    online_cache.clear()
    client.get(f"/api/online/proxy?url={quote(audio_url, safe='')}&source=kw&key=kw:MUSIC_9999:320k").get_data()
    before = UPSTREAM.get("audio", 0)
    r42 = client.post(
        "/api/online/download",
        json={**dl_payload, "key": "kw:MUSIC_9999:320k", "meta": {**dl_payload["meta"], "title": "缓存直出"}},
    )
    ok(
        "下载：命中播放缓存时直接复制（不回上游）",
        r42.status_code == 200 and UPSTREAM.get("audio", 0) == before,
        f"audio {before} → {UPSTREAM.get('audio', 0)}",
    )
    ok("下载：缓存直出的文件大小正确", Path(r42.get_json()["data"]["path"]).stat().st_size == len(PAYLOAD))

    # 进度接口（下载是同步的，故结束后应看到 done）
    prog = client.get("/api/online/download/progress?key=kw:MUSIC_7788:320k").get_json()["data"]
    ok("下载：进度接口返回完成状态", prog and prog["done"] and prog["percent"] == 100, json.dumps(prog))
    ok("下载：未知键返回 null", client.get("/api/online/download/progress?key=none").get_json()["data"] is None)

    # ---- 并发闸与进度表上限 ----
    # 没有并发闸时，连点两下「下载」（或两个窗口同时点）会落出两份重复文件。
    # 前端把按钮置灰只是「尽量别让人点到」，真正说了算的是后端这道闸。
    from app.api.online import (  # noqa: E402
        _MAX_TRACKED_DOWNLOADS,
        _dl_claim,
        _dl_patch,
        _downloads,
    )

    _downloads.clear()
    ok("并发闸：首次抢占成功", _dl_claim("kw:DUP:320k", "DUP") is True)
    ok("并发闸：同键第二次被拒", _dl_claim("kw:DUP:320k", "DUP") is False)
    r50 = client.post("/api/online/download", json={**dl_payload, "key": "kw:DUP:320k"})
    ok("并发闸：正在下载中的同键请求返回 409", r50.status_code == 409, str(r50.status_code))
    _dl_patch("kw:DUP:320k", {"done": True})
    ok("并发闸：完成之后可以重新下载", _dl_claim("kw:DUP:320k", "DUP") is True)

    # 进度表是纯内存的临时状态，下载完就没用了；不设上限会随下载次数无限增长
    _downloads.clear()
    for i in range(_MAX_TRACKED_DOWNLOADS + 20):
        _dl_claim(f"kw:P{i}:320k", f"P{i}")
        _dl_patch(f"kw:P{i}:320k", {"done": True})
    ok("进度表：超出上限后自动清理已完成的记录", len(_downloads) <= _MAX_TRACKED_DOWNLOADS, str(len(_downloads)))

    # 但进行中的记录不能被清掉 —— 清了前端就再也轮询不到进度
    _downloads.clear()
    _dl_claim("kw:KEEP:320k", "KEEP")
    for i in range(_MAX_TRACKED_DOWNLOADS + 5):
        _dl_claim(f"kw:Q{i}:320k", f"Q{i}")
        _dl_patch(f"kw:Q{i}:320k", {"done": True})
    ok("进度表：不清理进行中的记录", "kw:KEEP:320k" in _downloads, f"共 {len(_downloads)} 条")
    _downloads.clear()

    # 非法参数
    ok("下载：缺 url → 400", client.post("/api/online/download", json={"source": "kw"}).status_code == 400)
    ok(
        "下载：拒绝 file:// 协议",
        client.post("/api/online/download", json={"url": "file:///etc/passwd"}).status_code == 400,
    )

    # 移出曲库：只影响**在线**记录。
    # ⚠️ 上面那首已经下载并就地转成本地行了，不再是「在线记录」，所以另起一首未下载的来验。
    r_new = client.post(
        "/api/online/register",
        json={"source": "kg", "platformId": "HASH_REMOVE", "title": "待移出", "artist": "测试"},
    )
    rid = r_new.get_json()["data"]["id"]
    r43 = client.delete(f"/api/online/songs/{rid}")
    ok(
        "移出：在线记录已删除",
        r43.status_code == 200
        and all(s["id"] != rid for s in client.get("/api/online/library").get_json()["data"]),
        json.dumps(r43.get_json())[:200],
    )
    # 已下载转成本地的那首不该被这个接口删掉 —— 它现在是本地歌，删它是「删本地歌曲」的事
    r44 = client.delete(f"/api/online/songs/{sid}")
    ok(
        "移出：已下载转本地的歌不受「移出在线」影响（接口只认在线行）",
        r44.status_code == 404 and any(s["id"] == sid for s in client.get("/api/songs").get_json()["data"]),
        f"{r44.status_code}",
    )
    ok("移出：已下载的本地歌曲仍在", dl_song["id"] in [s["id"] for s in client.get("/api/songs").get_json()["data"]])
    ok("移出：本地歌曲不可用该接口删", client.delete(f"/api/online/songs/{dl_song['id']}").status_code == 404)

    # 编辑在线歌曲的标签 / 歌词：没有本地文件，只落库，不应报错
    sid2 = client.post("/api/online/register", json={**payload, "platformId": "MUSIC_5566"}).get_json()["data"]["id"]
    r44 = client.put(f"/api/songs/{sid2}", json={"title": "改过的标题"})
    ok("编辑：在线歌曲标签可改（只落库）", r44.status_code == 200 and r44.get_json()["data"]["title"] == "改过的标题", json.dumps(r44.get_json()))
    r45 = client.put(f"/api/lyrics/{sid2}", json={"text": "[00:01.00]改过的歌词"})
    ok("编辑：在线歌曲歌词可改（只落库）", r45.status_code == 200 and r45.get_json()["data"]["title"] == "改过的标题")

    server.shutdown()
    return 1 if globals().get("_failed") else 0


if __name__ == "__main__":
    code = main()
    print("\n自检结束")
    sys.exit(code)
