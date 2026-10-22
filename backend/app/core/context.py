"""SOC-Lite · Contexto de request por `contextvars`.

Permite que el servicio de auditoría conozca los metadatos de la petición
(IP, user-agent, trace-id, usuario) sin propagarlos por toda la pila de
llamadas, y que el middleware sepa si el endpoint ya registró un evento de
negocio (evitando así duplicar entradas en la bitácora).
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RequestAuditContext:
    trace_id: str | None = None
    user_id: int | None = None
    username: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    method: str = "GET"
    path: str = "/"
    module: str = "settings"
    started_at: float = 0.0
    written: bool = False
    events: list[Any] = field(default_factory=list)


audit_context: ContextVar[RequestAuditContext | None] = ContextVar("audit_context", default=None)


def get_audit_context() -> RequestAuditContext | None:
    return audit_context.get()


def mark_audit_written() -> None:
    ctx = audit_context.get()
    if ctx is not None:
        ctx.written = True
