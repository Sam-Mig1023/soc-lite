"""SOC-Lite · Router del dashboard: KPIs y series para los widgets del frontend."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import DashboardReader, DbSession
from app.models.enums import AuditAction, SeverityLevel
from app.schemas.dashboard import (
    AnalystWorkload,
    DashboardSummary,
    FpRateBreakdown,
    MtttTrendPoint,
    SeveritySeriesPoint,
    SlaComplianceItem,
    SlaComplianceResponse,
    TopItem,
)
from app.services.audit_service import AuditService
from app.services.metrics_service import MetricsService

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


def _resolve_range(date_from: datetime | None, date_to: datetime | None, default_days: int = 30) -> tuple[datetime, datetime]:
    to = date_to or datetime.now(timezone.utc)
    return (date_from or (to - timedelta(days=default_days))), to


@router.get("/summary", response_model=DashboardSummary, summary="KPIs principales del SOC")
async def summary(
    db: DbSession,
    current: DashboardReader,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    source_type: str | None = None,
) -> DashboardSummary:
    start, end = _resolve_range(date_from, date_to)
    data = await MetricsService(db).summary(start, end, source_type)

    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail="Consulta de KPIs del dashboard",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/dashboard/summary", http_status=200,
    )
    return DashboardSummary(**data)


@router.get("/alerts-by-severity", response_model=list[SeveritySeriesPoint], summary="Serie temporal por severidad")
async def alerts_by_severity(
    db: DbSession,
    current: DashboardReader,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    granularity: str = Query("day", pattern="^(hour|day|week|month)$"),
) -> list[SeveritySeriesPoint]:
    start, end = _resolve_range(date_from, date_to)
    rows = await MetricsService(db).alerts_by_severity(start, end, granularity)
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail=f"Serie de alertas por severidad ({granularity})",
        ip_address=current.ip_address, commit=False,
    )
    return [SeveritySeriesPoint(**row) for row in rows]


@router.get("/mttt-trend", response_model=list[MtttTrendPoint], summary="Evolución del MTTT vs objetivo SLA")
async def mttt_trend(
    db: DbSession,
    current: DashboardReader,
    days: int = Query(30, ge=1, le=365),
    severity: SeverityLevel | None = None,
) -> list[MtttTrendPoint]:
    rows = await MetricsService(db).mttt_trend(days, severity.value if severity else None)
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail=f"Tendencia de MTTT ({days} días)",
        ip_address=current.ip_address, commit=False,
    )
    return [MtttTrendPoint(**row) for row in rows]


@router.get("/top-sources", summary="Top orígenes de alertas (IP, activo, regla, MITRE)")
async def top_sources(
    db: DbSession,
    current: DashboardReader,
    limit: int = Query(10, ge=1, le=50),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
) -> dict[str, list[TopItem]]:
    start, end = _resolve_range(date_from, date_to)
    data = await MetricsService(db).top_sources(start, end, limit)
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail=f"Top orígenes (limit={limit})", ip_address=current.ip_address, commit=False,
    )
    return {k: [TopItem(**item) for item in v] for k, v in data.items()}


@router.get("/fp-rate", response_model=FpRateBreakdown, summary="Tasa de falsos positivos y precisión del modelo")
async def fp_rate(
    db: DbSession,
    current: DashboardReader,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
) -> FpRateBreakdown:
    start, end = _resolve_range(date_from, date_to)
    data = await MetricsService(db).fp_rate(start, end)
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail="Consulta de tasa de falsos positivos",
        ip_address=current.ip_address, commit=False,
    )
    data["by_rule"] = [TopItem(**i) for i in data["by_rule"]]
    data["by_model"] = [TopItem(**i) for i in data["by_model"]]
    return FpRateBreakdown(**data)


@router.get("/sla-compliance", response_model=SlaComplianceResponse, summary="Cumplimiento de SLA por severidad")
async def sla_compliance(
    db: DbSession,
    current: DashboardReader,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
) -> SlaComplianceResponse:
    start, end = _resolve_range(date_from, date_to)
    rows = await MetricsService(db).sla_detail(start, end)
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail="Consulta de cumplimiento SLA", ip_address=current.ip_address, commit=False,
    )
    return SlaComplianceResponse(
        items=[SlaComplianceItem(**row) for row in rows],
        by_severity={str(row["severity"]): float(row["compliance_rate"]) for row in rows},
        period={"from": start, "to": end},
    )


@router.get("/analyst-workload", response_model=list[AnalystWorkload], summary="Carga de trabajo por analista")
async def analyst_workload(db: DbSession, current: DashboardReader) -> list[AnalystWorkload]:
    rows = await MetricsService(db).analyst_workload()
    await AuditService(db).log(
        module="dashboard", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="dashboard", detail="Consulta de carga por analista", ip_address=current.ip_address, commit=False,
    )
    return [AnalystWorkload(**row) for row in rows]


@router.get("/verdicts", summary="Distribución de veredictos del triaje")
async def verdicts(
    db: DbSession,
    current: DashboardReader,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
) -> list[dict]:
    start, end = _resolve_range(date_from, date_to)
    return await MetricsService(db).verdict_distribution(start, end)


@router.post("/refresh-metrics", summary="Recalcular agregados diarios (uso interno/job)")
async def refresh_metrics(db: DbSession, current: DashboardReader) -> dict[str, int]:
    if not current.can("settings:write"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Se requiere el permiso settings:write para recalcular agregados",
        )
    rows = await MetricsService(db).refresh_daily_metrics()
    await AuditService(db).log(
        module="dashboard", action=AuditAction.CONFIG_CHANGE, user_id=current.id, username=current.username,
        entity="alert_metrics_daily", detail=f"Recálculo de agregados diarios ({rows} filas)",
        ip_address=current.ip_address, severity="warning",
    )
    return {"rows": rows}
