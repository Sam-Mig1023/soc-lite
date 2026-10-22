"""SOC-Lite · Router de bitácora de auditoría (consulta, estadísticas, verificación, export)."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from app.api.deps import AuditExporter, AuditReader, DbSession
from app.models import AuditLog
from app.models.enums import AuditAction, AuditResult
from app.schemas.common import Page
from app.schemas.dashboard import AuditLogDetail, AuditLogRead, AuditStats
from app.services.audit_service import AuditService

router = APIRouter(prefix="/audit", tags=["Bitácora de auditoría"])


@router.get("/logs", response_model=Page[AuditLogRead], summary="Consultar bitácora de auditoría")
async def list_logs(
    db: DbSession,
    current: AuditReader,
    user_id: int | None = None,
    username: str | None = None,
    module: str | None = None,
    action: AuditAction | None = None,
    result: AuditResult | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    severity: str | None = Query(None, pattern="^(info|warning|critical)$"),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    q: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
) -> Page[AuditLogRead]:
    if username:
        user_row = (
            await db.execute(select(AuditLog.user_id).where(AuditLog.username == username).limit(1))
        ).scalar_one_or_none()
        user_id = user_id or user_row

    page_data = await AuditService(db).search(
        user_id=user_id, module=module, action=action, result=result, entity=entity, entity_id=entity_id,
        date_from=date_from, date_to=date_to, q=q, severity=severity, page=page, page_size=page_size,
    )
    # La consulta a la bitácora también se audita (auditar al auditor)
    await AuditService(db).log(
        module="audit", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="audit_log", detail=f"Consulta de bitácora (total={page_data.total}, filtros: module={module}, action={action})",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/audit/logs", http_status=200,
    )
    return Page.build([AuditLogRead.model_validate(r) for r in page_data.items], page_data.total, page, page_size)


@router.get("/logs/{log_id}", response_model=AuditLogDetail, summary="Detalle de un evento con diff antes/después")
async def get_log(log_id: int, db: DbSession, current: AuditReader) -> AuditLogDetail:
    entry = (await db.execute(select(AuditLog).where(AuditLog.id == log_id))).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento de auditoría no encontrado")
    return AuditLogDetail.model_validate(entry)


@router.get("/stats", response_model=AuditStats, summary="Estadísticas de la bitácora")
async def audit_stats(
    db: DbSession,
    current: AuditReader,
    days: int = Query(30, ge=1, le=365),
) -> AuditStats:
    since = datetime.now(timezone.utc) - timedelta(days=days)

    by_module = (
        await db.execute(
            select(AuditLog.module, func.count(AuditLog.id)).where(AuditLog.occurred_at >= since)
            .group_by(AuditLog.module).order_by(func.count(AuditLog.id).desc())
        )
    ).all()
    by_action = (
        await db.execute(
            select(AuditLog.action, func.count(AuditLog.id)).where(AuditLog.occurred_at >= since)
            .group_by(AuditLog.action).order_by(func.count(AuditLog.id).desc())
        )
    ).all()
    by_result = (
        await db.execute(
            select(AuditLog.result, func.count(AuditLog.id)).where(AuditLog.occurred_at >= since)
            .group_by(AuditLog.result)
        )
    ).all()
    by_user = (
        await db.execute(
            select(AuditLog.username, func.count(AuditLog.id)).where(AuditLog.occurred_at >= since)
            .group_by(AuditLog.username).order_by(func.count(AuditLog.id).desc()).limit(20)
        )
    ).all()
    per_day = (
        await db.execute(
            select(func.date_trunc("day", AuditLog.occurred_at).label("d"), func.count(AuditLog.id))
            .where(AuditLog.occurred_at >= since).group_by("d").order_by("d")
        )
    ).all()
    failed_logins = (
        await db.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.occurred_at >= since, AuditLog.action == AuditAction.LOGIN_FAILED
            )
        )
    ).scalar_one()
    denied = (
        await db.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.occurred_at >= since, AuditLog.result == AuditResult.DENIED
            )
        )
    ).scalar_one()
    total = (await db.execute(select(func.count(AuditLog.id)).where(AuditLog.occurred_at >= since))).scalar_one()

    await AuditService(db).log(
        module="audit", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="audit_stats", detail=f"Consulta de estadísticas de bitácora ({days} días)",
        ip_address=current.ip_address, commit=False,
    )

    return AuditStats(
        period={"from": since, "to": datetime.now(timezone.utc)},
        total_events=total,
        by_module=[{"module": m, "count": n} for m, n in by_module],
        by_action=[{"action": a.value if hasattr(a, "value") else str(a), "count": n} for a, n in by_action],
        by_result={(r.value if hasattr(r, "value") else str(r)): n for r, n in by_result},
        by_user=[{"username": u or "—", "count": n} for u, n in by_user],
        failed_logins=failed_logins,
        denied_actions=denied,
        events_per_day=[{"date": d.date().isoformat(), "count": n} for d, n in per_day],
    )


@router.get("/verify-chain", summary="Verificar integridad de la cadena de hashes de la bitácora")
async def verify_chain(db: DbSession, current: AuditReader, limit: int = Query(5000, ge=100, le=50000)) -> dict:
    result = await AuditService(db).verify_chain(limit=limit)
    await AuditService(db).log(
        module="audit", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="audit_log", detail=f"Verificación de integridad de bitácora: intacta={result['intact']}",
        ip_address=current.ip_address, severity="warning" if not result["intact"] else "info",
    )
    return result


@router.get("/logs/export", summary="Exportar bitácora (CSV/XLSX)")
async def export_logs(
    db: DbSession,
    current: AuditExporter,
    export_format: str = Query("csv", alias="format", pattern="^(csv|xlsx)$"),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    module: str | None = None,
    action: AuditAction | None = None,
    result: AuditResult | None = None,
):
    page_data = await AuditService(db).search(
        module=module, action=action, result=result,
        date_from=date_from, date_to=date_to, page=1, page_size=50000,
    )
    rows = page_data.items
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    if export_format == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Bitacora"
        ws.append(["ID", "Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad",
                   "ID entidad", "IP", "Método", "Ruta", "Estado HTTP", "Duración (ms)", "Detalle", "Hash sha256"])
        for r in rows:
            ws.append([
                r.id, r.occurred_at.isoformat(), r.username, r.module,
                r.action.value if hasattr(r.action, "value") else str(r.action),
                r.result.value if hasattr(r.result, "value") else str(r.result),
                r.entity, r.entity_id, str(r.ip_address or ""), r.http_method, r.http_path,
                r.http_status, r.duration_ms, r.detail, r.hash_self,
            ])
        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        content, media, filename = buffer.read(), MEDIA_XLSX, f"bitacora_{stamp}.xlsx"
    else:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["ID", "Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad",
                         "ID entidad", "IP", "Método", "Ruta", "Estado HTTP", "Duración (ms)", "Detalle", "Hash sha256"])
        for r in rows:
            writer.writerow([
                r.id, r.occurred_at.isoformat(), r.username, r.module,
                r.action.value if hasattr(r.action, "value") else str(r.action),
                r.result.value if hasattr(r.result, "value") else str(r.result),
                r.entity, r.entity_id, str(r.ip_address or ""), r.http_method, r.http_path,
                r.http_status, r.duration_ms, r.detail, r.hash_self,
            ])
        content, media, filename = buf.getvalue().encode("utf-8-sig"), "text/csv", f"bitacora_{stamp}.csv"

    await AuditService(db).log(
        module="audit", action=AuditAction.EXPORT, user_id=current.id, username=current.username,
        entity="audit_log", detail=f"Exportación de bitácora ({len(rows)} eventos) en formato {export_format}",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/audit/logs/export", http_status=200, severity="warning",
    )
    return StreamingResponse(
        io.BytesIO(content) if isinstance(content, bytes) else io.StringIO(content),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


MEDIA_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
