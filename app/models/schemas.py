# -*- coding: utf-8 -*-
"""统一响应格式与数据模型（dataclass）。

所有 API 返回形如：
    {"code": 200, "data": {...}, "message": "success"}
"""
from typing import Any


def ok(data: Any = None, message: str = "success") -> dict:
    """构造 200 统一返回体。"""
    return {"code": 200, "data": data, "message": message}


def fail(message: str = "error", code: int = 400, data: Any = None) -> dict:
    """构造错误统一返回体。"""
    return {"code": code, "data": data, "message": message}