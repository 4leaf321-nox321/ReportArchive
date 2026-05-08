"""
Standard JSON response envelope.

All API responses follow:
    { "success": bool, "data": ..., "message": ..., "errors": ... }

Keeping a stable envelope simplifies the frontend client.
"""
from __future__ import annotations

from typing import Any, List, Optional

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse


def success_response(
    data: Any = None,
    message: Optional[str] = None,
    status_code: int = 200,
) -> JSONResponse:
    payload: dict = {"success": True, "data": jsonable_encoder(data, by_alias=True)}
    if message:
        payload["message"] = message
    return JSONResponse(content=payload, status_code=status_code)


def error_response(
    message: str,
    errors: Optional[List[Any]] = None,
    status_code: int = 400,
) -> JSONResponse:
    payload: dict = {"success": False, "message": message}
    if errors:
        payload["errors"] = jsonable_encoder(errors, by_alias=True)
    return JSONResponse(content=payload, status_code=status_code)


def created_response(data: Any = None, message: str = "Created successfully") -> JSONResponse:
    return success_response(data, message, status_code=201)


def not_found_response(message: str = "Resource not found") -> JSONResponse:
    return error_response(message, status_code=404)
