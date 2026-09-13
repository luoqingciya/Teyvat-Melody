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
import re
import threading
import urllib.error
import urllib.request

from flask import Blueprint, Response, jsonify, request, send_file, stream_with_context

from app.services import online_cache

bp = Blueprint("online", __name__)

# 正在后台补完缓存的键，避免同一首重复起后台任务
_finishing: set[str] = set()
_finishing_lock = threading.Lock()

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
_IMAGE_MAX = 8 * 1024 * 1024  # 封面最大 8MB：避免本地代理被当成大文件下载器


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


_FULL_RANGE = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+)")


def _is_full_body(status: int, headers) -> bool:
    """上游是否返回了**完整内容** —— 只有完整内容才值得写入缓存。

    200 显然是完整的；206 则要看 Content-Range 是否从 0 一直到末尾
    （Chromium 首次请求音频就是 `Range: bytes=0-`，这种也是完整内容）。
    """
    if status == 200:
        return True
    if status == 206:
        m = _FULL_RANGE.match(str(headers.get("Content-Range") or ""))
        if m and int(m.group(1)) == 0 and int(m.group(2)) == int(m.group(3)) - 1:
            return True
    return False


def _total_bytes(headers) -> int:
    """上游声明的总字节数（200 看 Content-Length，206 看 Content-Range 的总量）。"""
    m = _FULL_RANGE.match(str(headers.get("Content-Range") or ""))
    if m:
        return int(m.group(3))
    try:
        return int(headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        return 0


def _worth_finishing(received: int, total: int) -> bool:
    """客户端提前断开后，是否值得在后台把剩下的读完。

    判断依据：已经下了不少才继续 —— 避免用户「点一下立刻切歌」时，
    我们还在后台悄悄把整首歌拉下来（那是用户没要求的流量）。
    """
    if received < 1024 * 1024:  # 不足 1MB 直接放弃
        return False
    return total <= 0 or received >= total * 0.3


def _finish_in_background(key: str, tmp, fh, upstream, content_type: str) -> None:
    """客户端提前断开（seek / 切歌）时，复用同一条上游连接把剩余内容读完再转正。

    这样缓存仍能完成，而且**不额外增加流量** —— 已下的部分不会白费。
    """
    with _finishing_lock:
        if key in _finishing:
            # 已有同键任务在补完，本次连接直接丢弃（避免重复下载）
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass
            online_cache.discard(tmp)
            return
        _finishing.add(key)

    def _run():
        ok = False
        try:
            while True:
                chunk = upstream.read(_CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
            ok = True
        except Exception:  # noqa: BLE001  网络中断等：放弃这次缓存
            ok = False
        finally:
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass
            if ok:
                online_cache.commit(key, tmp, content_type)
            else:
                online_cache.discard(tmp)
            with _finishing_lock:
                _finishing.discard(key)

    threading.Thread(target=_run, daemon=True).start()


@bp.route("/proxy", methods=["GET", "HEAD"])
def proxy():
    url = (request.args.get("url") or "").strip()
    source = (request.args.get("source") or "").strip().lower()
    # 稳定缓存键（平台:平台ID:音质）。CDN 地址带时效签名、每次播放都不同，
    # 拿它当缓存键永远命不中；音频字节本身是稳定的，所以用这个键。
    key = (request.args.get("key") or "").strip()
    if not url:
        return _err("url required", 400)
    if not url.lower().startswith(("http://", "https://")):
        return _err("only http/https url allowed", 400)

    # 1) 命中磁盘缓存：直接由本地文件提供（send_file 自带 Range/206，seek 也走本地）
    if key and request.method == "GET" and online_cache.enabled():
        hit = online_cache.cached_path(key)
        if hit is not None:
            return send_file(
                str(hit),
                conditional=True,
                mimetype=online_cache.mimetype_for(hit),
                max_age=0,
            )

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
    # 音频 URL 时效短，不让浏览器缓存；本地缓存由上面的 key 机制负责
    out["Cache-Control"] = "no-store"

    if request.method == "HEAD":
        upstream.close()
        return Response(b"", status=upstream.status, headers=out)

    # 2) 边转发边写缓存：读完才转正，中途中断（客户端 seek/关闭）就丢弃临时文件，
    #    绝不让半个文件冒充缓存。
    content_type = str(upstream.headers.get("Content-Type") or "")
    cacheable = (
        bool(key)
        and request.method == "GET"
        and online_cache.enabled()
        and _is_full_body(upstream.status, upstream.headers)
    )
    tmp = None
    fh = None
    if cacheable:
        try:
            tmp = online_cache.temp_path(key)
            fh = open(tmp, "wb")
        except OSError:
            tmp, fh = None, None
    received = 0
    total = _total_bytes(upstream.headers)
    completed = False

    def _iter():
        nonlocal completed, received
        try:
            while True:
                chunk = upstream.read(_CHUNK)
                if not chunk:
                    break
                received += len(chunk)
                if fh is not None:
                    try:
                        fh.write(chunk)
                    except OSError:
                        pass  # 写缓存失败不影响本次播放
                yield chunk
            completed = True
        finally:
            if completed:
                # 正常读完 → 转正缓存
                try:
                    upstream.close()
                except Exception:  # noqa: BLE001
                    pass
                if fh is not None:
                    try:
                        fh.close()
                    except Exception:  # noqa: BLE001
                        pass
                    online_cache.commit(key, tmp, content_type)
            elif fh is not None and _worth_finishing(received, total):
                # 客户端提前断开（seek / 切歌）：已下了不少，交给后台读完，
                # 缓存仍能完成且不额外增加流量（复用同一条上游连接）
                _finish_in_background(key, tmp, fh, upstream, content_type)
            else:
                try:
                    upstream.close()
                except Exception:  # noqa: BLE001
                    pass
                if fh is not None:
                    try:
                        fh.close()
                    except Exception:  # noqa: BLE001
                        pass
                online_cache.discard(tmp)

    return Response(
        stream_with_context(_iter()),
        status=upstream.status,
        headers=out,
        direct_passthrough=True,
    )


# ---------------- 缓存管理（设置页） ----------------


@bp.get("/cache")
def cache_stats():
    """缓存占用与配置（供设置页展示）。"""
    return jsonify({"code": 200, "message": "success", "data": online_cache.stats()})


@bp.post("/cache/clear")
def cache_clear():
    """清空缓存（含未完成的临时文件）。"""
    return jsonify({"code": 200, "message": "success", "data": online_cache.clear()})


@bp.post("/cache/config")
def cache_config():
    """更新缓存开关 / 容量上限；调小上限后立即淘汰到新上限内。"""
    data = request.get_json(silent=True) or {}
    online_cache.save_config(data)
    online_cache.evict()
    return jsonify({"code": 200, "message": "success", "data": online_cache.stats()})


@bp.get("/image")
def image():
    """在线封面代理：远程封面经本机同源转发。

    渲染进程的 CSP 是 `img-src 'self' data: blob:`，直接引用远程图片会被拦截；
    走同源代理即可**保持 CSP 不放宽**（与音频代理同一思路）。
    封面内容稳定，故允许浏览器缓存，减少重复流量。
    """
    url = (request.args.get("url") or "").strip()
    source = (request.args.get("source") or "").strip().lower()
    if not url:
        return _err("url required", 400)
    if not url.lower().startswith(("http://", "https://")):
        return _err("only http/https url allowed", 400)

    req = urllib.request.Request(url, headers=_upstream_headers(source), method="GET")
    try:
        upstream = urllib.request.urlopen(req, timeout=_TIMEOUT)
    except urllib.error.HTTPError as exc:
        try:
            exc.close()
        except Exception:  # noqa: BLE001
            pass
        return _err(f"upstream {exc.code}", exc.code)
    except Exception as exc:  # noqa: BLE001
        return _err(f"upstream unreachable: {exc}", 502)

    ctype = upstream.headers.get("Content-Type") or "image/jpeg"
    if not ctype.lower().startswith("image/"):
        upstream.close()
        return _err("not an image", 415)

    try:
        data = upstream.read(_IMAGE_MAX + 1)
    finally:
        try:
            upstream.close()
        except Exception:  # noqa: BLE001
            pass
    if len(data) > _IMAGE_MAX:
        return _err("image too large", 413)

    resp = Response(data, status=200, content_type=ctype)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp
