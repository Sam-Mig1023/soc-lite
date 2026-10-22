"""SOC-Lite · Router de incidentes y acciones de respuesta."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, IncidentReader, IncidentWriter
from app.models import Alert, Incident, IncidentAction, IncidentAlert
from app.models.enums import AlertStatus, AuditAction, IncidentStatus, PriorityLevel, SeverityLevel
from app.schemas.common import MessageResponse, Page
from app.schemas.incident import (
    IncidentActionCreate,
    IncidentAlertLink,
    IncidentCreate,
    IncidentDetail,
    IncidentListItem,
    IncidentTicket,
    IncidentUpdate,
)
from app.services.audit_service import AuditService

router = APIRouter(prefix="/incidents", tags=["Incidentes"])

_LOAD = (
    selectinload(Incident.actions),
    selectinload(Incident.alert_links),
    selectinload(Incident.owner),
)


async def _next_code(db: DbSession) -> str:
    year = datetime.now(timezone.utc).year
    count = (await db.execute(select(func.count(Incident.id)))).scalar_one()
    return f"INC-{year}-{count + 1:05d}"


async def _get_or_404(db: DbSession, incident_id: int) -> Incident:
    incident = (
        await db.execute(select(Incident).options(*_LOAD).where(Incident.id == incident_id))
    ).scalar_one_or_none()
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incidente no encontrado")
    return incident


@router.get("", response_model=Page[IncidentListItem], summary="Listar incidentes")
async def list_incidents(
    db: DbSession,
    current: IncidentReader,
    status_: IncidentStatus | None = Query(None, alias="status"),
    priority: PriorityLevel | None = None,
    severity: SeverityLevel | None = None,
    owner_id: int | None = None,
    q: str | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> Page[IncidentListItem]:
    filters = []
    if status_:
        filters.append(Incident.status == status_)
    if priority:
        filters.append(Incident.priority == priority)
    if severity:
        filters.append(Incident.severity == severity)
    if owner_id is not None:
        filters.append(Incident.owner_id == owner_id)
    if q:
        filters.append(Incident.title.ilike(f"%{q}%"))
    if date_from:
        filters.append(Incident.detected_at >= date_from)
    if date_to:
        filters.append(Incident.detected_at <= date_to)

    total = (await db.execute(select(func.count(Incident.id)).where(*filters))).scalar_one()
    rows = (
        await db.execute(
            select(Incident).options(*_LOAD).where(*filters)
            .order_by(Incident.detected_at.desc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    items = []
    for inc in rows:
        item = IncidentListItem.model_validate(inc)
        item.alert_count = len(inc.alert_links)
        item.mttr_seconds = inc.mttr_seconds
        items.append(item)

    await AuditService(db).log(
        module="incidents", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="incident", detail=f"Listado de incidentes (total={total})",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/incidents", http_status=200,
    )
    return Page.build(items, total, page, page_size)


@router.post("", response_model=IncidentDetail, status_code=status.HTTP_201_CREATED, summary="Crear incidente")
async def create_incident(body: IncidentCreate, db: DbSession, current: IncidentWriter) -> IncidentDetail:
    incident = Incident(
        incident_code=await _next_code(db),
        title=body.title,
        description=body.description,
        status=IncidentStatus.OPEN,
        priority=body.priority,
        severity=body.severity,
        category=body.category,
        mitre_tactics=body.mitre_tactics,
        detected_at=body.detected_at or datetime.now(timezone.utc),
        owner_id=body.owner_id or current.id,
        impact=body.impact,
        created_by=current.id,
    )
    db.add(incident)
    await db.flush()

    for alert_id in body.alert_ids:
        alert = (await db.execute(select(Alert).where(Alert.id == alert_id, Alert.deleted_at.is_(None)))).scalar_one_or_none()
        if alert is None:
            continue
        db.add(IncidentAlert(incident_id=incident.id, alert_id=alert_id, linked_by=current.id))
        alert.status = AlertStatus.ESCALATED
    await db.flush()

    incident = await _get_or_404(db, incident.id)
    detail = IncidentDetail.model_validate(incident)
    detail.alert_count = len(incident.alert_links)
    detail.mttr_seconds = incident.mttr_seconds

    await AuditService(db).log(
        module="incidents", action=AuditAction.CREATE, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident.id,
        detail=f"Creación del incidente {incident.incident_code} con {len(body.alert_ids)} alerta(s) vinculada(s)",
        after={"code": incident.incident_code, "priority": incident.priority.value,
               "severity": incident.severity.value, "alert_ids": body.alert_ids},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path="/api/v1/incidents", http_status=201, severity="warning",
    )
    return detail


@router.get("/{incident_id}", response_model=IncidentDetail, summary="Detalle de incidente")
async def get_incident(incident_id: int, db: DbSession, current: IncidentReader) -> IncidentDetail:
    incident = await _get_or_404(db, incident_id)
    detail = IncidentDetail.model_validate(incident)
    detail.alert_count = len(incident.alert_links)
    detail.mttr_seconds = incident.mttr_seconds
    await AuditService(db).log(
        module="incidents", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident_id, detail=f"Consulta del incidente {incident.incident_code}",
        ip_address=current.ip_address, http_method="GET", http_path=f"/api/v1/incidents/{incident_id}",
        http_status=200, commit=False,
    )
    return detail


@router.put("/{incident_id}", response_model=IncidentDetail, summary="Actualizar incidente")
async def update_incident(incident_id: int, body: IncidentUpdate, db: DbSession, current: IncidentWriter) -> IncidentDetail:
    incident = await _get_or_404(db, incident_id)
    before = {
        "status": incident.status.value, "priority": incident.priority.value,
        "severity": incident.severity.value, "owner_id": incident.owner_id,
    }
    now = datetime.now(timezone.utc)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(incident, field, value)

    if body.status == IncidentStatus.CONTAINED and incident.contained_at is None:
        incident.contained_at = now
    if body.status == IncidentStatus.RESOLVED and incident.resolved_at is None:
        incident.resolved_at = now
    if body.status == IncidentStatus.CLOSED and incident.closed_at is None:
        incident.closed_at = now
    await db.flush()

    incident = await _get_or_404(db, incident_id)
    detail = IncidentDetail.model_validate(incident)
    detail.alert_count = len(incident.alert_links)
    detail.mttr_seconds = incident.mttr_seconds

    await AuditService(db).log(
        module="incidents", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident_id, detail=f"Actualización del incidente {incident.incident_code}",
        before=before,
        after={"status": incident.status.value, "priority": incident.priority.value,
               "severity": incident.severity.value, "owner_id": incident.owner_id},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="PUT", http_path=f"/api/v1/incidents/{incident_id}", http_status=200, severity="warning",
    )
    return detail


@router.post("/{incident_id}/alerts", response_model=IncidentDetail, summary="Vincular alertas al incidente")
async def link_alerts(incident_id: int, body: IncidentAlertLink, db: DbSession, current: IncidentWriter) -> IncidentDetail:
    incident = await _get_or_404(db, incident_id)
    linked = 0
    for alert_id in body.alert_ids:
        exists = (
            await db.execute(
                select(IncidentAlert).where(
                    IncidentAlert.incident_id == incident_id, IncidentAlert.alert_id == alert_id
                )
            )
        ).scalar_one_or_none()
        if exists:
            continue
        alert = (await db.execute(select(Alert).where(Alert.id == alert_id, Alert.deleted_at.is_(None)))).scalar_one_or_none()
        if alert is None:
            continue
        db.add(IncidentAlert(incident_id=incident_id, alert_id=alert_id, linked_by=current.id))
        alert.status = AlertStatus.ESCALATED
        linked += 1
    await db.flush()

    await AuditService(db).log(
        module="incidents", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident_id,
        detail=f"Vinculación de {linked} alerta(s) al incidente {incident.incident_code}",
        after={"linked_alert_ids": body.alert_ids}, ip_address=current.ip_address,
        http_method="POST", http_path=f"/api/v1/incidents/{incident_id}/alerts", http_status=200,
    )
    incident = await _get_or_404(db, incident_id)
    detail = IncidentDetail.model_validate(incident)
    detail.alert_count = len(incident.alert_links)
    detail.mttr_seconds = incident.mttr_seconds
    return detail


@router.post("/{incident_id}/actions", response_model=IncidentDetail, summary="Registrar acción de respuesta")
async def add_action(incident_id: int, body: IncidentActionCreate, db: DbSession, current: IncidentWriter) -> IncidentDetail:
    incident = await _get_or_404(db, incident_id)
    now = datetime.now(timezone.utc)
    action = IncidentAction(
        incident_id=incident_id,
        action_type=body.action_type,
        description=body.description,
        status=body.status,
        automated=body.automated,
        performed_by=current.id,
        started_at=now,
        finished_at=now if body.status == "done" else None,
        result=body.result,
    )
    db.add(action)
    await db.flush()

    await AuditService(db).log(
        module="incidents", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident_id,
        detail=f"Acción de respuesta registrada: {body.action_type} — {body.description[:120]}",
        after={"action_type": body.action_type, "status": body.status, "automated": body.automated},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path=f"/api/v1/incidents/{incident_id}/actions", http_status=200,
        severity="critical" if body.action_type in ("isolate_host", "block_ip", "reset_credentials") else "warning",
    )
    incident = await _get_or_404(db, incident_id)
    detail = IncidentDetail.model_validate(incident)
    detail.alert_count = len(incident.alert_links)
    detail.mttr_seconds = incident.mttr_seconds
    return detail


@router.get("/{incident_id}/ticket", response_model=IncidentTicket, summary="Ticket externo del incidente")
async def get_ticket(incident_id: int, db: DbSession, current: IncidentReader) -> IncidentTicket:
    incident = await _get_or_404(db, incident_id)
    provider = None
    if incident.external_ticket_url:
        provider = "osticket" if "osticket" in incident.external_ticket_url.lower() else "redmine"
    await AuditService(db).log(
        module="incidents", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="incident", entity_id=incident_id, detail="Consulta de ticket externo",
        ip_address=current.ip_address, commit=False,
    )
    return IncidentTicket(
        external_ticket_id=incident.external_ticket_id,
        external_ticket_url=incident.external_ticket_url,
        provider=provider,
        status="linked" if incident.external_ticket_id else "not_created",
    )
