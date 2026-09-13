# -*- coding: utf-8 -*-
"""在线音频代理：GET /api/online/proxy?url=<encoded>&source=<平台key>。

第三方源脚本解析出的音频 URL 普遍带防盗链（校验 Referer / User-Agent）且时效很短，
渲染进程既跨域、又无法伪装 Referer，因此统一经本机 Flask 同源转发：

- **透传 Range / If-Range**，原样回传 206 与 Content-Range —— <audio> 才能拖动进度条 seek；
- **按平台注入 Referer / User-Agent**，绕过平台防盗链；
- **纯流式转发，不落盘、不缓存**（URL 时效短，缓存无意义且占空间）；
- 仅放行 http/https，避免被源脚本用作任意协议跳板。

媒体仍由同源提供，故 server.py 的 CSP `media-src 'self'` 无需放宽。
"""
import urllib.error
import urllib.request

from flask import Blueprint, Response, jsonify, request, stream_with_context

bp = Blueprint("online", __name__)

_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 各平台音频 CDN 的防盗链 Referer；未收录的平台只给通用 UA
_PLATFORM_REFERER = {
    "tx": "https://y.qq.com/",
    "kw": "https://www.kuwo.cn/",
    "kg": "https://www.kugou.com/",
    "wy": "https://music.163.com/",
    "mg": "https://music.migu.cn/",
}

# 需要原样回传给 <audio> 的响应头（Content-Range 是 seek 的关键）
_PASS_HEADERS = (
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Last-Modified",
    "ETag",
)

_CHUNK = 64 * 1024
_TIMEOUT = 15  # 上游连接/读取超时（秒）


def _upstream_headers(source: str) -> dict:
    """按平台构造上游请求头（防盗链伪装）。"""
    headers = {"User-Agent": _DEFAULT_UA, "Accept": "*/*"}
    referer = _PLATFORM_REFERER.get(source)
    if referer:
        headers["Referer"] = referer
    return headers


def _err(message: str, code: int):
    """统一错误返回（非 2xx 会让 <audio> 触发 error 事件，供上层降级/换源）。"""
    return jsonify({"code": code, "data": None, "message": message}), code


@bp.route("/proxy", methods=["GET", "HEAD"])
def proxy():
    url = (request.args.get("url") or "").strip()
    source = (request.args.get("source") or "").strip().lower()
    if not url:
        return _err("url required", 400)
    if not url.lower().startswith(("http://", "https://")):
        return _err("only http/https url allowed", 400)

    headers = _upstream_headers(source)
    # 透传 Range / If-Range：上游据此返回 206 + Content-Range
    for name in ("Range", "If-Range"):
        value = request.headers.get(name)
        if value:
            headers[name] = value

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        upstream = urllib.request.urlopen(req, timeout=_TIMEOUT)
    except urllib.error.HTTPError as exc:
        # 上游 416（Range 越界）等原样回传状态码，前端据此重置进度
        try:
            exc.close()
        except Exception:  # noqa: BLE001
            pass
        return _err(f"upstream {exc.code}", exc.code)
    except Exception as exc:  # noqa: BLE001
        return _err(f"upstream unreachable: {exc}", 502)

    out = {}
    for name in _PASS_HEADERS:
        value = upstream.headers.get(name)
        if value:
            out[name] = value
    # 上游未声明时补上，避免 <audio> 直接放弃 seek
    out.setdefault("Accept-Ranges", "bytes")
    # URL 时效短，明确禁止任何中间层缓存
    out["Cache-Control"] = "no-store"

    if request.method == "HEAD":
        upstream.close()
        return Response(b"", status=upstream.status, headers=out)

    def _iter():
        try:
            while True:
                chunk = upstream.read(_CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass

    return Response(
        stream_with_context(_iter()),
        status=upstream.status,
        headers=out,
        direct_passthrough=True,
    )
