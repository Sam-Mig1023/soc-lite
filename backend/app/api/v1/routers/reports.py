"""SOC-Lite · Router de reportes exportables (PDF, Word, Excel, CSV)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app.api.deps import AuditExporter, AuthenticatedUser, DbSession, ReportExporter, ReportReader
from app.core.config import settings
from app.models import GeneratedReport
from app.models.enums import AuditAction, AuditResult, ReportFormat
from app.schemas.common import Page
from app.schemas.dashboard import GeneratedReportRead
from app.services.audit_service import AuditService
from app.services.report_service import ReportService

router = APIRouter(prefix="/reports", tags=["Reportes"])

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
}


def _resolve_range(date_from: datetime | None, date_to: datetime | None, period: str | None) -> tuple[datetime, datetime]:
    to = date_to or datetime.now(timezone.utc)
    if date_from:
        return date_from, to
    defaults = {"daily": 1, "weekly": 7, "monthly": 30, "quarterly": 90}
    return to - timedelta(days=defaults.get(period or "monthly", 30)), to


async def _generate(
    db, current, report_type: str, fmt: ReportFormat, date_from, date_to, period, params,
    audit_module="reports", http_method="GET", http_path=None,
):
    service = ReportService(db)
    record = await service.generate(report_type, fmt, date_from, date_to, user=current.user, parameters=params)

    await AuditService(db).log(
        module=audit_module,
        action=AuditAction.EXPORT,
        user_id=current.id,
        username=current.username,
        entity="report",
        entity_id=record.id,
        detail=(
            f"Reporte {report_type} generado en formato {fmt.value} "
            f"({date_from:%Y-%m-%d} → {date_to:%Y-%m-%d}, {record.file_size} bytes)"
        ),
        after={"report_type": report_type, "format": fmt.value, "file": Path(record.file_path).name,
               "checksum_sha256": record.checksum_sha256, "parameters": params},
        ip_address=current.ip_address,
        user_agent=current.user_agent,
        http_method=http_method,
        http_path=http_path or f"/api/v1/reports/{report_type}",
        http_status=200,
        severity="warning",
    )
    return record


def _file_response(record: GeneratedReport) -> FileResponse:
    path = Path(record.file_path)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="El archivo del reporte ya no está disponible")
    fmt = record.report_format.value if hasattr(record.report_format, "value") else str(record.report_format)
    return FileResponse(
        path=str(path),
        media_type=MEDIA_TYPES.get(fmt, "application/octet-stream"),
        filename=path.name,
        headers={
            "X-Report-Id": str(record.id),
            "X-Report-Checksum": record.checksum_sha256 or "",
            "Content-Disposition": f'attachment; filename="{path.name}"',
        },
    )


@router.get("/operational", summary="Reporte operativo SOC (PDF/Word/Excel/CSV)")
async def operational_report(
    db: DbSession,
    current: ReportExporter,
    report_format: ReportFormat = Query(ReportFormat.PDF, alias="format"),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    period: str | None = Query("monthly", pattern="^(daily|weekly|monthly|quarterly)$"),
    include_raw_data: bool = Query(False),
):
    start, end = _resolve_range(date_from, date_to, period)
    record = await _generate(
        db, current, "operational", report_format, start, end, period,
        {"period": period, "include_raw_data": include_raw_data},
    )
    return _file_response(record)


class EmailReportRequest(BaseModel):
    report_type: str = Field(pattern="^(operational|management|audit)$")
    report_format: ReportFormat = Field(alias="format")
    to_email: EmailStr
    date_from: datetime | None = Field(None, alias="from")
    date_to: datetime | None = Field(None, alias="to")
    period: str | None = Field("monthly", pattern="^(daily|weekly|monthly|quarterly)$")

    model_config = {"populate_by_name": True}


@router.post("/email", summary="Generar un reporte y enviarlo por correo mediante n8n")
async def email_report(body: EmailReportRequest, db: DbSession, current: AuthenticatedUser):
    """Genera y audita el reporte con el usuario actual y delega el correo a n8n."""
    required_permission = "audit:export" if body.report_type == "audit" else "reports:export"
    if not current.can(required_permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permisos insuficientes. Requerido: {required_permission}",
            headers={"X-Required-Permissions": required_permission},
        )

    webhook_url = settings.N8N_REPORT_EMAIL_WEBHOOK_URL
    webhook_secret = settings.N8N_REPORT_EMAIL_WEBHOOK_SECRET
    if not webhook_url or not webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="El envío de reportes por correo no está configurado. Configura el webhook de n8n.",
        )

    start, end = _resolve_range(body.date_from, body.date_to, body.period)
    if body.report_type == "audit" and (end - start).days > 366:
        raise HTTPException(status_code=422, detail="El rango máximo para reportes de auditoría es de 366 días")

    params = {"period": body.period} if body.report_type != "audit" else {"scope": "audit_log"}
    record = await _generate(
        db, current, body.report_type, body.report_format, start, end, body.period, params,
        audit_module="audit" if body.report_type == "audit" else "reports",
        http_method="POST", http_path="/api/v1/reports/email",
    )
    file_path = Path(record.file_path)
    if not file_path.is_file():
        raise HTTPException(status_code=410, detail="El reporte se generó, pero su archivo no está disponible")

    fields = {
        "to_email": str(body.to_email),
        "from_email": settings.SMTP_FROM,
        "report_title": record.title,
        "report_id": str(record.id),
        "report_type": body.report_type,
        "period_from": start.isoformat(),
        "period_to": end.isoformat(),
        "checksum_sha256": record.checksum_sha256 or "",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            with file_path.open("rb") as report_file:
                response = await client.post(
                    webhook_url,
                    headers={"X-Report-Trigger-Key": webhook_secret},
                    data=fields,
                    files={"data": (file_path.name, report_file, MEDIA_TYPES.get(body.report_format.value, "application/octet-stream"))},
                )
        response.raise_for_status()
    except (httpx.HTTPError, OSError) as exc:
        # El reporte ya quedó generado e inventariado; solo falló la entrega por correo.
        await AuditService(db).log(
            module="audit" if body.report_type == "audit" else "reports",
            action=AuditAction.EXPORT,
            user_id=current.id,
            username=current.username,
            entity="report_email",
            entity_id=record.id,
            result=AuditResult.FAILURE,
            detail=f"Falló la entrega del reporte #{record.id} por correo vía n8n a {body.to_email}",
            after={"report_id": record.id, "to_email": str(body.to_email), "filename": file_path.name},
            ip_address=current.ip_address,
            user_agent=current.user_agent,
            http_method="POST",
            http_path="/api/v1/reports/email",
            http_status=502,
            severity="error",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"El reporte #{record.id} quedó generado, pero n8n no confirmó el envío del correo. Revisa n8n y vuelve a intentar.",
        ) from exc

    await AuditService(db).log(
        module="audit" if body.report_type == "audit" else "reports",
        action=AuditAction.EXPORT,
        user_id=current.id,
        username=current.username,
        entity="report_email",
        entity_id=record.id,
        detail=f"Reporte #{record.id} enviado por correo vía n8n a {body.to_email}",
        after={"report_id": record.id, "to_email": str(body.to_email), "filename": file_path.name},
        ip_address=current.ip_address,
        user_agent=current.user_agent,
        http_method="POST",
        http_path="/api/v1/reports/email",
        http_status=200,
        severity="warning",
    )

    return {
        "status": "sent",
        "report_id": record.id,
        "to_email": str(body.to_email),
        "filename": file_path.name,
        "message": f"Reporte #{record.id} enviado a {body.to_email}",
    }


@router.get("/management", summary="Reporte gerencial y de cumplimiento (PDF/Word/Excel)")
async def management_report(
    db: DbSession,
    current: ReportExporter,
    report_format: ReportFormat = Query(ReportFormat.PDF, alias="format"),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    period: str | None = Query("monthly", pattern="^(daily|weekly|monthly|quarterly)$"),
    include_charts: bool = Query(True),
):
    start, end = _resolve_range(date_from, date_to, period)
    record = await _generate(
        db, current, "management", report_format, start, end, period,
        {"period": period, "include_charts": include_charts},
    )
    return _file_response(record)


@router.get("/audit", summary="Extracto de bitácora de auditoría (PDF/Word/Excel/CSV)")
async def audit_report(
    db: DbSession,
    current: AuditExporter,
    report_format: ReportFormat = Query(ReportFormat.XLSX, alias="format"),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
):
    start, end = _resolve_range(date_from, date_to, "monthly")
    if (end - start).days > 366:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El rango máximo para reportes de auditoría es de 366 días",
        )
    record = await _generate(db, current, "audit", report_format, start, end, None, {"scope": "audit_log"}, audit_module="audit")
    return _file_response(record)


@router.get("/inventory", response_model=Page[GeneratedReportRead], summary="Historial de reportes generados")
async def inventory(
    db: DbSession,
    current: ReportReader,
    report_type: str | None = None,
    report_format: ReportFormat | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> Page[GeneratedReportRead]:
    filters = []
    if report_type:
        filters.append(GeneratedReport.report_type == report_type)
    if report_format:
        filters.append(GeneratedReport.report_format == report_format)

    total = (await db.execute(select(func.count(GeneratedReport.id)).where(*filters))).scalar_one()
    rows = (
        await db.execute(
            select(GeneratedReport).where(*filters).order_by(GeneratedReport.created_at.desc())
            .offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    await AuditService(db).log(
        module="reports", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="report", detail=f"Consulta del inventario de reportes (total={total})",
        ip_address=current.ip_address, commit=False,
    )
    return Page.build([GeneratedReportRead.model_validate(r) for r in rows], total, page, page_size)


@router.get("/{report_id}/download", summary="Descargar un reporte generado")
async def download_report(report_id: int, db: DbSession, current: ReportReader):
    record = (await db.execute(select(GeneratedReport).where(GeneratedReport.id == report_id))).scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reporte no encontrado")
    await AuditService(db).log(
        module="reports", action=AuditAction.EXPORT, user_id=current.id, username=current.username,
        entity="report", entity_id=report_id, detail=f"Descarga del reporte {record.title}",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path=f"/api/v1/reports/{report_id}/download", http_status=200, severity="warning",
    )
    return _file_response(record)
