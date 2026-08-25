# -*- coding: utf-8 -*-
"""扫描目录相关接口。"""
from pathlib import Path

from flask import Blueprint, request

from app.models.schemas import ok, fail
from app.services import library_service

bp = Blueprint("scan", __name__)


@bp.post("/scan")
def scan_library():
    """同步扫描指定目录，返回新增歌曲列表（保留兼容旧前端调用）。"""
    data = request.get_json(silent=True) or {}
    path = data.get("path", "")
    if not path:
        return ok({"path": path, "added": [], "count": 0})
    try:
        added = library_service.scan_and_register(Path(path))
    except OSError as exc:
        return ok({"path": path, "added": [], "count": 0, "error": str(exc)})
    return ok({"path": path, "added": added, "count": len(added)})


@bp.post("/scan/start")
def scan_library_async():
    """异步启动扫描，立即返回 scan_id，进度经 /scan/status/<id> 轮询。"""
    data = request.get_json(silent=True) or {}
    path = data.get("path", "")
    if not path:
        return fail("path is required")
    node = Path(path)
    if not node.is_dir():
        return fail("path is not a directory")
    scan_id = library_service.start_scan(node)
    return ok({"scan_id": scan_id})


@bp.get("/scan/status/<scan_id>")
def scan_library_status(scan_id: str):
    """按 id 轮询扫描进度；任何时刻仅需前端主动查询。"""
    st = library_service.get_scan_status(scan_id)
    if st is None:
        return fail("scan not found", 404)
    return ok(st)
