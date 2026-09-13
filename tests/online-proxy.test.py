# -*- coding: utf-8 -*-
"""在线音频代理自检：python tests/online-proxy.test.py

用本地支持 Range 的测试服务器扮演音频 CDN，覆盖：
无 Range 全量、Range 分段（206 + Content-Range）、HEAD、防盗链头注入、
非法 scheme 拒绝、缺参拒绝、上游错误透传、Cache-Control。
"""
import http.server
import sys
import threading
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.server import create_app  # noqa: E402

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

    server.shutdown()
    return 1 if globals().get("_failed") else 0


if __name__ == "__main__":
    code = main()
    print("\n自检结束")
    sys.exit(code)
