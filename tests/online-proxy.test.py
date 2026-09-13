# -*- coding: utf-8 -*-
"""在线音频代理自检：python tests/online-proxy.test.py

用本地支持 Range 的测试服务器扮演音频 CDN，覆盖：
无 Range 全量、Range 分段（206 + Content-Range）、HEAD、防盗链头注入、
非法 scheme 拒绝、缺参拒绝、上游错误透传、Cache-Control。
"""
import http.server
import json
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

    server.shutdown()
    return 1 if globals().get("_failed") else 0


if __name__ == "__main__":
    code = main()
    print("\n自检结束")
    sys.exit(code)
