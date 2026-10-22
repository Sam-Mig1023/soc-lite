"""SOC-Lite · Excepciones y manejadores de error uniformes."""
from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger("soclite.errors")


class SocLiteError(Exception):
    """Excepción base de dominio."""

    code = "SOCLITE_ERROR"
    http_status = status.HTTP_400_BAD_REQUEST

    def __init__(self, message: str, code: str | None = None, http_status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if http_status:
            self.http_status = http_status


class NotFoundError(SocLiteError):
    code = "NOT_FOUND"
    http_status = status.HTTP_404_NOT_FOUND


class ConflictError(SocLiteError):
    code = "CONFLICT"
    http_status = status.HTTP_409_CONFLICT


class PermissionDeniedError(SocLiteError):
    code = "PERMISSION_DENIED"
    http_status = status.HTTP_403_FORBIDDEN


class IntegrationError(SocLiteError):
    code = "INTEGRATION_ERROR"
    http_status = status.HTTP_502_BAD_GATEWAY


def _trace_id(request: Request) -> str:
    return getattr(request.state, "trace_id", None) or str(uuid.uuid4())


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(SocLiteError)
    async def _domain(request: Request, exc: SocLiteError) -> JSONResponse:
        logger.warning("Error de dominio: %s (%s)", exc.message, exc.code)
        return JSONResponse(
            status_code=exc.http_status,
            content={"detail": exc.message, "code": exc.code, "trace_id": _trace_id(request)},
        )

    @app.exception_handler(HTTPException)
    async def _http(request: Request, exc: HTTPException) -> JSONResponse:
        code = {
            401: "UNAUTHENTICATED",
            403: "PERMISSION_DENIED",
            404: "NOT_FOUND",
            409: "CONFLICT",
            422: "VALIDATION_ERROR",
            423: "ACCOUNT_LOCKED",
            429: "RATE_LIMITED",
        }.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": code, "trace_id": _trace_id(request)},
            headers=getattr(exc, "headers", None) or {},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "detail": "Error de validación en la petición",
                "code": "VALIDATION_ERROR",
                "trace_id": _trace_id(request),
                "errors": [
                    {"field": ".".join(str(x) for x in err["loc"][1:]), "message": err["msg"], "type": err["type"]}
                    for err in exc.errors()
                ],
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        trace = _trace_id(request)
        logger.exception("Error no controlado [trace=%s]: %s", trace, exc)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": "Error interno del servidor. Contacte al administrador con el identificador de traza.",
                "code": "INTERNAL_ERROR",
                "trace_id": trace,
            },
        )
