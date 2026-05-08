"""
Centralized exception handling.

Converts framework / validation / custom errors into the standard
JSON envelope defined in shared.responses.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.shared.responses import error_response

logger = logging.getLogger(__name__)


class APIError(Exception):
    """Domain-level error raised by services / routes."""

    def __init__(
        self,
        message: str,
        status_code: int = 400,
        errors: Optional[List[Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.errors = errors


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def _handle_api_error(_: Request, exc: APIError):
        return error_response(exc.message, errors=exc.errors, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(_: Request, exc: RequestValidationError):
        return error_response(
            "Validation failed",
            errors=exc.errors(),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_error(_: Request, exc: StarletteHTTPException):
        return error_response(
            exc.detail if isinstance(exc.detail, str) else "HTTP error",
            status_code=exc.status_code,
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected_error(request: Request, exc: Exception):
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return error_response(
            "Internal server error",
            errors=[str(exc)],
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
