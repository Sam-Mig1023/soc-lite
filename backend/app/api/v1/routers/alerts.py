"""SOC-Lite · Router de alertas: ingesta (webhook), consulta, actualización y timeline."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import (
    AlertReader,
    AlertWriter,
    CurrentUser,
    DbSession,
    require_ingest_key,
    require_permissions,
)
from app.core.config import settings
from app.core.security import compute_fingerprint
from app.models import Alert, AuditLog, Incident, IncidentAlert, TriageResult
from app.models.enums import AlertStatus, AuditAction, AuditResult, SeverityLevel, TriageVerdict
from app.schemas.alert import (
    AlertBulkStatus,
    AlertDetail,
    AlertIngest,
    AlertListItem,
    AlertUpdate,
    IngestResponse,
    TimelineEvent,
    TriageRead,
)
from app.schemas.common import BulkResult, MessageResponse, Page
from app.schemas.alert import level_to_severity
from app.services.audit_service import AuditService
from app.services.triage_service import TriageService

logger = logging.getLogger("soclite.alerts")
router = APIRouter(prefix="/alerts", tags=["Alertas"])


def _to_detail(alert: Alert) -> AlertDetail:
    """Serializa una alerta al detalle completo, embebiendo el triaje vigente.

    El triaje se expone en `triage` (nomenclatura canónica) y en `triage_result`
    (alias histórico) para que ningún cliente necesite una segunda petición.
    """
    detail = AlertDetail.model_validate(alert)
    current = alert.current_triage
    if current is not None:
        triage = TriageRead.model_validate(current)
        detail.triage = triage
        detail.triage_result = triage
    return detail


# ======================================================================
# Ingesta
# ======================================================================
@router.post(
    "/ingest",
    response_model=IngestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ingesta de alertas (webhook Wazuh/OPNsense o n8n)",
    dependencies=[Depends(require_ingest_key)],
)
async def ingest_alert(
    request: Request,
    db: DbSession,
    background: BackgroundTasks,
    payload: dict[str, Any],
    auto_triage: bool = Query(True, description="Ejecutar el triaje LLM en segundo plano"),
    x_source_type: Annotated[str | None, Header(alias="X-Source-Type")] = None,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> IngestResponse:
    """Punto de entrada único de telemetría.

    * Normaliza el evento (formato Wazuh nativo o normalizado).
    * Calcula `alert_fingerprint` y deduplica dentro de la ventana configurada.
    * Persiste la alerta en estado `pending` y, opcionalmente, encola el triaje.
    """
    source = (x_source_type or payload.get("source_type") or "wazuh").lower()
    if source == "wazuh" and "rule" in payload:
        normalized = AlertIngest.from_wazuh(payload)
    else:
        normalized = AlertIngest.model_validate({**payload, "source_type": source})

    occurred_at = normalized.occurred_at or datetime.now(timezone.utc)
    # Bucket temporal para deduplicación
    bucket = occurred_at.replace(
        minute=(occurred_at.minute // settings.DEDUP_WINDOW_MINUTES) * settings.DEDUP_WINDOW_MINUTES,
        second=0,
        microsecond=0,
    )
    fingerprint = normalized.alert_fingerprint or idempotency_key or compute_fingerprint(
        normalized.source_type.value if hasattr(normalized.source_type, "value") else normalized.source_type,
        normalized.rule_id,
        normalized.source_ip or normalized.agent_name,
        bucket.isoformat(),
    )

    existing = (
        await db.execute(
            select(Alert).options(selectinload(Alert.triages)).where(Alert.alert_fingerprint == fingerprint)
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.dedup_count += 1
        existing.raw_payload = normalized.raw_payload or existing.raw_payload
        await db.flush()
        await AuditService(db).log(
            module="alerts", action=AuditAction.CREATE, username="system/n8n", entity="alert",
            entity_id=existing.id, result=AuditResult.SUCCESS,
            detail=f"Alerta duplicada detectada (dedup_count={existing.dedup_count})",
            ip_address=request.client.host if request.client else None,
        )
        return IngestResponse(
            alert_id=existing.id,
            alert_fingerprint=existing.alert_fingerprint,
            status=AlertStatus(existing.status),
            duplicated=True,
            severity=SeverityLevel(existing.severity),
            triage_queued=False,
            message="Alerta duplicada: se incrementó el contador de deduplicación",
        )

    # Resolución del activo por IP o nombre de agente
    from app.models import Asset

    asset_id = None
    if normalized.dest_ip or normalized.agent_name:
        asset = (
            await db.execute(
                select(Asset).where(
                    or_(
                        Asset.ip_address == (normalized.dest_ip or None),
                        Asset.hostname == (normalized.agent_name or None),
                    )
                )
            )
        ).scalars().first()
        asset_id = asset.id if asset else None

    severity = (
        SeverityLevel(normalized.severity)
        if normalized.severity
        else level_to_severity(normalized.rule_level)
    )

    alert = Alert(
        alert_fingerprint=fingerprint,
        external_id=normalized.external_id,
        source_type=normalized.source_type,
        source_name=normalized.source_name,
        rule_id=normalized.rule_id,
        rule_level=normalized.rule_level,
        rule_description=normalized.rule_description,
        rule_groups=normalized.rule_groups,
        severity=severity,
        severity_raw=normalized.rule_level,
        status=AlertStatus.PENDING,
        source_ip=normalized.source_ip,
        source_port=normalized.source_port,
        dest_ip=normalized.dest_ip,
        dest_port=normalized.dest_port,
        protocol=normalized.protocol,
        agent_id=normalized.agent_id,
        agent_name=normalized.agent_name,
        asset_id=asset_id,
        mitre_technique=normalized.mitre_technique,
        mitre_tactic=normalized.mitre_tactic,
        full_log=normalized.full_log,
        raw_payload=normalized.raw_payload,
        occurred_at=occurred_at,
        sla_due_at=occurred_at + timedelta(minutes=settings.SLA_MINUTES.get(severity.value, 480)),
    )
    db.add(alert)
    await db.flush()

    await AuditService(db).log(
        module="alerts", action=AuditAction.CREATE, username="system/n8n", entity="alert", entity_id=alert.id,
        detail=f"Ingesta de alerta regla={alert.rule_id} severidad={severity.value}",
        after={"rule_id": alert.rule_id, "severity": severity.value, "source_ip": str(alert.source_ip or "")},
        ip_address=request.client.host if request.client else None,
    )

    should_triage = auto_triage and (normalized.rule_level or 0) >= settings.MIN_SEVERITY_TO_PROCESS
    if should_triage:
        background.add_task(_triage_background, alert.id)
    elif auto_triage:
        alert.status = AlertStatus.PENDING
        await db.flush()

    return IngestResponse(
        alert_id=alert.id,
        alert_fingerprint=alert.alert_fingerprint,
        status=AlertStatus(alert.status),
        duplicated=False,
        severity=severity,
        triage_queued=should_triage,
        message="Alerta registrada" + (" y triaje encolado" if should_triage else " (severidad bajo umbral de triaje)"),
    )


async def _triage_background(alert_id: int) -> None:
    """Ejecuta el triaje en segundo plano con su propia sesión de BD."""
    from app.db.session import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        try:
            alert = (
                await session.execute(
                    select(Alert).options(selectinload(Alert.asset), selectinload(Alert.triages)).where(Alert.id == alert_id)
                )
            ).scalar_one_or_none()
            if alert is None:
                return
            result = await TriageService(session).run(alert)
            await AuditService(session).log(
                module="triage", action=AuditAction.TRIAGE_RUN, username="system/worker", entity="alert",
                entity_id=alert_id, detail=f"Triaje automático: veredicto={result['verdict'].value} riesgo={result['risk_score']}",
                after={"verdict": result["verdict"].value, "risk_score": result["risk_score"]},
            )
            await session.commit()
        except Exception as exc:  # pragma: no cover
            await session.rollback()
            logger.exception("Fallo en el triaje en segundo plano de la alerta %s: %s", alert_id, exc)


# ======================================================================
# Consulta
# ======================================================================
@router.get("", response_model=Page[AlertListItem], summary="Listar alertas con filtros")
async def list_alerts(
    db: DbSession,
    current: AlertReader,
    severity: list[SeverityLevel] | None = Query(None),
    status_: list[AlertStatus] | None = Query(None, alias="status"),
    source_type: str | None = None,
    verdict: list[TriageVerdict] | None = Query(None),
    assigned_to: int | None = None,
    agent_name: str | None = None,
    source_ip: str | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    q: str | None = Query(None, description="Búsqueda en descripción y log"),
    min_risk_score: int | None = Query(None, ge=0, le=100),
    has_triage: bool | None = None,
    only_sla_breached: bool = False,
    order_by: str = Query("occurred_at", pattern="^(occurred_at|risk_score|severity|mttt_seconds|id)$"),
    order_dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> Page[AlertListItem]:
    filters = [Alert.deleted_at.is_(None)]
    if severity:
        filters.append(Alert.severity.in_(severity))
    if status_:
        filters.append(Alert.status.in_(status_))
    if source_type:
        filters.append(Alert.source_type == source_type)
    if verdict:
        filters.append(Alert.verdict.in_(verdict))
    if assigned_to is not None:
        filters.append(Alert.assigned_to == assigned_to)
    if agent_name:
        filters.append(Alert.agent_name.ilike(f"%{agent_name}%"))
    if source_ip:
        filters.append(Alert.source_ip == source_ip)
    if date_from:
        filters.append(Alert.occurred_at >= date_from)
    if date_to:
        filters.append(Alert.occurred_at <= date_to)
    if min_risk_score is not None:
        filters.append(Alert.risk_score >= min_risk_score)
    if has_triage is not None:
        subq = select(TriageResult.alert_id).where(TriageResult.is_current.is_(True))
        filters.append(Alert.id.in_(subq) if has_triage else Alert.id.notin_(subq))
    if only_sla_breached:
        filters.append(and_(Alert.closed_at.is_(None), Alert.sla_due_at < func.now()))
    if q:
        like = f"%{q}%"
        filters.append(or_(Alert.rule_description.ilike(like), Alert.full_log.ilike(like), Alert.agent_name.ilike(like)))

    total = (await db.execute(select(func.count(Alert.id)).where(*filters))).scalar_one()

    column = {
        "occurred_at": Alert.occurred_at,
        "risk_score": Alert.risk_score,
        "severity": Alert.severity,
        "mttt_seconds": Alert.mttt_seconds,
        "id": Alert.id,
    }[order_by]
    ordering = column.desc().nullslast() if order_dir == "desc" else column.asc().nullsfirst()

    rows = (
        await db.execute(
            select(Alert).where(*filters).order_by(ordering, Alert.id.desc())
            .offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    await AuditService(db).log(
        module="alerts", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="alert", detail=f"Consulta de alertas (filtros aplicados, total={total})",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/alerts", http_status=200,
    )
    return Page.build([AlertListItem.model_validate(a) for a in rows], total, page, page_size)


@router.get("/{alert_id}", response_model=AlertDetail, summary="Detalle de alerta con triaje y enriquecimiento")
async def get_alert(alert_id: int, db: DbSession, current: AlertReader) -> AlertDetail:
    alert = (
        await db.execute(
            select(Alert)
            .options(selectinload(Alert.asset), selectinload(Alert.enrichment), selectinload(Alert.triages))
            .where(Alert.id == alert_id, Alert.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")

    await AuditService(db).log(
        module="alerts", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id, detail=f"Consulta de detalle de alerta #{alert_id}",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path=f"/api/v1/alerts/{alert_id}", http_status=200,
    )
    return _to_detail(alert)


@router.patch("/{alert_id}", response_model=AlertDetail, summary="Actualizar estado/asignación de una alerta")
async def update_alert(alert_id: int, body: AlertUpdate, db: DbSession, current: AlertWriter) -> AlertDetail:
    alert = (
        await db.execute(
            select(Alert)
            .options(selectinload(Alert.asset), selectinload(Alert.enrichment), selectinload(Alert.triages))
            .where(Alert.id == alert_id, Alert.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")

    before = {"status": alert.status.value, "assigned_to": alert.assigned_to, "severity": alert.severity.value}

    if body.status is not None:
        alert.status = body.status
        if body.status in (AlertStatus.CLOSED, AlertStatus.FALSE_POSITIVE):
            alert.closed_at = datetime.now(timezone.utc)
            alert.mttr_seconds = int((alert.closed_at - alert.occurred_at).total_seconds())
            if body.status == AlertStatus.FALSE_POSITIVE:
                alert.verdict = TriageVerdict.FALSE_POSITIVE
        if body.status in (AlertStatus.TRIAGED, AlertStatus.ESCALATED) and alert.mttt_seconds is None:
            alert.mttt_seconds = int((datetime.now(timezone.utc) - alert.occurred_at).total_seconds())
    if body.assigned_to is not None:
        alert.assigned_to = body.assigned_to or None
    if body.severity is not None:
        alert.severity = body.severity
    if body.is_suppressed is not None:
        alert.is_suppressed = body.is_suppressed
    await db.flush()

    after = {"status": alert.status.value, "assigned_to": alert.assigned_to, "severity": alert.severity.value}
    await AuditService(db).log(
        module="alerts", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id,
        detail=body.notes or body.close_reason or f"Actualización de alerta #{alert_id}",
        before=before, after=after, ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="PATCH", http_path=f"/api/v1/alerts/{alert_id}", http_status=200,
        severity="warning" if body.status in (AlertStatus.CLOSED, AlertStatus.FALSE_POSITIVE) else "info",
    )
    return _to_detail(alert)


@router.post("/bulk/status", response_model=BulkResult, summary="Cambio de estado masivo")
async def bulk_status(body: AlertBulkStatus, db: DbSession, current: AlertWriter) -> BulkResult:
    alerts = (
        await db.execute(select(Alert).where(Alert.id.in_(body.ids), Alert.deleted_at.is_(None)))
    ).scalars().all()
    updated = 0
    errors: list[str] = []
    now = datetime.now(timezone.utc)
    for alert in alerts:
        before = alert.status.value
        alert.status = body.status
        if body.status in (AlertStatus.CLOSED, AlertStatus.FALSE_POSITIVE):
            alert.closed_at = now
            alert.mttr_seconds = int((now - alert.occurred_at).total_seconds())
        updated += 1
        await AuditService(db).log(
            module="alerts", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
            entity="alert", entity_id=alert.id,
            detail=body.close_reason or f"Cambio masivo de estado {before} → {body.status.value}",
            before={"status": before}, after={"status": body.status.value},
            ip_address=current.ip_address, commit=False,
        )
    skipped = len(body.ids) - len(alerts)
    if skipped:
        errors.append(f"{skipped} alerta(s) no encontrada(s)")
    await db.flush()
    return BulkResult(updated=updated, skipped=skipped, errors=errors)


@router.delete("/{alert_id}", response_model=MessageResponse, summary="Eliminar alerta (borrado lógico)")
async def delete_alert(
    alert_id: int,
    db: DbSession,
    current: Annotated[CurrentUser, Depends(require_permissions("alerts:delete"))],
) -> MessageResponse:
    alert = (await db.execute(select(Alert).where(Alert.id == alert_id, Alert.deleted_at.is_(None)))).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")
    alert.deleted_at = datetime.now(timezone.utc)
    await db.flush()
    await AuditService(db).log(
        module="alerts", action=AuditAction.DELETE, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id, detail=f"Borrado lógico de la alerta #{alert_id}",
        ip_address=current.ip_address, severity="critical",
    )
    return MessageResponse(message=f"Alerta #{alert_id} eliminada")


@router.get("/{alert_id}/enrichment", summary="Indicadores enriquecidos de la alerta")
async def get_enrichment(alert_id: int, db: DbSession, current: AlertReader) -> list[dict[str, Any]]:
    alert = (
        await db.execute(select(Alert).options(selectinload(Alert.enrichment)).where(Alert.id == alert_id))
    ).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")
    await AuditService(db).log(
        module="triage", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id, detail="Consulta de enriquecimiento",
        ip_address=current.ip_address, commit=False,
    )
    return [
        {
            "provider": e.provider,
            "indicator": e.indicator,
            "indicator_type": e.indicator_type,
            "verdict": e.verdict,
            "score": float(e.score) if e.score is not None else None,
            "malicious_count": e.malicious_count,
            "total_engines": e.total_engines,
            "country": e.country,
            "asn": e.asn,
            "as_owner": e.as_owner,
            "cache_hit": e.cache_hit,
            "queried_at": e.queried_at,
        }
        for e in alert.enrichment
    ]


@router.get("/{alert_id}/timeline", response_model=list[TimelineEvent], summary="Línea de tiempo de la alerta")
async def get_timeline(alert_id: int, db: DbSession, current: AlertReader) -> list[TimelineEvent]:
    alert = (
        await db.execute(
            select(Alert).options(selectinload(Alert.triages)).where(Alert.id == alert_id, Alert.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")

    events: list[TimelineEvent] = [
        TimelineEvent(
            occurred_at=alert.occurred_at,
            event_type="detection",
            title="Detección en el SIEM",
            detail=f"Regla {alert.rule_id} · {alert.rule_description}",
            severity=alert.severity.value,
        ),
        TimelineEvent(
            occurred_at=alert.ingested_at,
            event_type="ingest",
            title="Ingesta en SOC-Lite",
            detail=f"Origen {alert.source_type.value if hasattr(alert.source_type, 'value') else alert.source_type}",
        ),
    ]
    for triage in sorted(alert.triages, key=lambda t: t.created_at):
        events.append(
            TimelineEvent(
                occurred_at=triage.created_at,
                event_type="triage",
                title=f"Triaje automático: {triage.verdict.value}",
                detail=triage.summary,
                actor=triage.model_name,
                severity=triage.severity.value,
            )
        )
    if alert.triaged_at:
        events.append(
            TimelineEvent(
                occurred_at=alert.triaged_at,
                event_type="status",
                title="Alerta triada",
                detail=f"MTTT: {alert.mttt_seconds}s" if alert.mttt_seconds else None,
            )
        )
    if alert.closed_at:
        events.append(
            TimelineEvent(
                occurred_at=alert.closed_at,
                event_type="status",
                title=f"Alerta cerrada ({alert.status.value})",
                detail=f"MTTR: {alert.mttr_seconds}s" if alert.mttr_seconds else None,
            )
        )

    incidents = (
        await db.execute(
            select(Incident).join(IncidentAlert, IncidentAlert.incident_id == Incident.id).where(IncidentAlert.alert_id == alert_id)
        )
    ).scalars().all()
    for incident in incidents:
        events.append(
            TimelineEvent(
                occurred_at=incident.detected_at,
                event_type="incident",
                title=f"Incidente {incident.incident_code}",
                detail=incident.title,
                severity=incident.severity.value if hasattr(incident.severity, "value") else str(incident.severity),
            )
        )

    audits = (
        await db.execute(
            select(AuditLog)
            .where(AuditLog.entity == "alert", AuditLog.entity_id == str(alert_id))
            .order_by(AuditLog.occurred_at.asc())
            .limit(200)
        )
    ).scalars().all()
    for entry in audits:
        events.append(
            TimelineEvent(
                occurred_at=entry.occurred_at,
                event_type="audit",
                title=f"{entry.action.value} en {entry.module}",
                detail=entry.detail,
                actor=entry.username,
            )
        )

    await AuditService(db).log(
        module="alerts", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id, detail="Consulta de línea de tiempo",
        ip_address=current.ip_address, commit=False,
    )
    # Rellenar los alias que consumen los componentes de timeline del frontend
    ordered = sorted(events, key=lambda e: e.occurred_at)
    for index, event in enumerate(ordered):
        event.id = event.id or f"{alert_id}-{index}"
        event.description = event.description or event.title
        event.action = event.action or event.event_type
    return ordered
