"""SOC-Lite · Router de triaje: ejecución, consulta, retroalimentación y estadísticas."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import AlertReader, DbSession, TriageReader, TriageRunner
from app.models import Alert, TriageResult
from app.models.enums import AlertStatus, AuditAction, AuditResult, TriageVerdict
from app.schemas.alert import (
    LatencyMetrics,
    ModelUsageEntry,
    TriageFeedback,
    TriageRead,
    TriageRunResponse,
    TriageStats,
    ToolUsageEntry,
)
from app.schemas.common import MessageResponse, Page
from app.services.audit_service import AuditService
from app.services.triage_service import TriageService, TriageServiceError

router = APIRouter(prefix="/triage", tags=["Triaje automático"])


@router.post("/{alert_id}/run", response_model=TriageRunResponse, summary="Ejecutar triaje con LLM")
async def run_triage(
    alert_id: int,
    db: DbSession,
    current: TriageRunner,
    force: bool = Query(False, description="Re-ejecutar aunque la alerta ya tenga triaje"),
) -> TriageRunResponse:
    alert = (
        await db.execute(
            select(Alert).options(selectinload(Alert.asset), selectinload(Alert.triages)).where(
                Alert.id == alert_id, Alert.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")

    if alert.current_triage and not force:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="La alerta ya tiene un triaje vigente; use ?force=true para volver a ejecutarlo",
        )

    try:
        result = await TriageService(db).run(alert, force=force)
    except TriageServiceError as exc:
        await AuditService(db).log(
            module="triage", action=AuditAction.TRIAGE_RUN, user_id=current.id, username=current.username,
            entity="alert", entity_id=alert_id, result=AuditResult.FAILURE,
            detail=f"Fallo del triaje: {exc}", ip_address=current.ip_address, severity="warning",
        )
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc

    await AuditService(db).log(
        module="triage", action=AuditAction.TRIAGE_RUN, user_id=current.id, username=current.username,
        entity="alert", entity_id=alert_id,
        detail=f"Triaje ejecutado: veredicto={result['verdict'].value} severidad={result['severity'].value} "
               f"riesgo={result['risk_score']} confianza={result['confidence']}",
        after={
            "verdict": result["verdict"].value,
            "severity": result["severity"].value,
            "risk_score": result["risk_score"],
            "confidence": result["confidence"],
            "model": getattr(alert.current_triage, "model_name", None),
        },
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path=f"/api/v1/triage/{alert_id}/run", http_status=200,
        duration_ms=result.get("latency_ms"),
    )
    return TriageRunResponse(**{k: v for k, v in result.items() if k in TriageRunResponse.model_fields})


@router.get("/results", response_model=Page[TriageRead], summary="Listar resultados de triaje")
async def list_results(
    db: DbSession,
    current: TriageReader,
    verdict: TriageVerdict | None = None,
    model_name: str | None = None,
    prompt_version: str | None = None,
    min_confidence: float | None = Query(None, ge=0, le=1),
    only_current: bool = True,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> Page[TriageRead]:
    filters: list[Any] = []
    if verdict:
        filters.append(TriageResult.verdict == verdict)
    if model_name:
        filters.append(TriageResult.model_name == model_name)
    if prompt_version:
        filters.append(TriageResult.prompt_version == prompt_version)
    if min_confidence is not None:
        filters.append(TriageResult.confidence >= min_confidence)
    if only_current:
        filters.append(TriageResult.is_current.is_(True))
    if date_from:
        filters.append(TriageResult.created_at >= date_from)
    if date_to:
        filters.append(TriageResult.created_at <= date_to)

    total = (await db.execute(select(func.count(TriageResult.id)).where(*filters))).scalar_one()
    rows = (
        await db.execute(
            select(TriageResult).where(*filters).order_by(TriageResult.created_at.desc())
            .offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    await AuditService(db).log(
        module="triage", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="triage_result", detail=f"Listado de triajes (total={total})",
        ip_address=current.ip_address, commit=False,
    )
    return Page.build([TriageRead.model_validate(r) for r in rows], total, page, page_size)


@router.get("/stats", response_model=TriageStats, summary="Estadísticas y precisión del triaje")
async def triage_stats(
    db: DbSession,
    current: TriageReader,
    days: int = Query(30, ge=1, le=365),
) -> TriageStats:
    since = datetime.now(timezone.utc) - timedelta(days=days)

    total = (await db.execute(select(func.count(TriageResult.id)).where(TriageResult.created_at >= since))).scalar_one()

    async def _group(column) -> dict[str, int]:
        rows = (
            await db.execute(
                select(column, func.count(TriageResult.id)).where(TriageResult.created_at >= since).group_by(column)
            )
        ).all()
        return {(k.value if hasattr(k, "value") else str(k)): n for k, n in rows}

    by_verdict = await _group(TriageResult.verdict)
    by_severity = await _group(TriageResult.severity)

    # Desglose por modelo/prompt: permite detectar deriva del modelo y comparar prompts
    model_rows = (
        await db.execute(
            select(
                TriageResult.model_name,
                func.max(TriageResult.prompt_version),
                func.count(TriageResult.id),
                func.avg(TriageResult.latency_ms),
                func.avg(TriageResult.confidence),
                func.sum(func.coalesce(TriageResult.tokens_in, 0)),
                func.sum(func.coalesce(TriageResult.tokens_out, 0)),
                func.sum(func.coalesce(TriageResult.cost_usd, 0)),
                func.count(case((TriageResult.verdict == TriageVerdict.FALSE_POSITIVE, 1))),
            )
            .where(TriageResult.created_at >= since)
            .group_by(TriageResult.model_name)
            .order_by(func.count(TriageResult.id).desc())
        )
    ).all()
    by_model = [
        {
            "model_name": name,
            "prompt_version": prompt,
            "runs": runs,
            "avg_latency_ms": round(float(lat), 1) if lat is not None else None,
            "avg_confidence": round(float(conf), 4) if conf is not None else None,
            "tokens_in": int(tin or 0),
            "tokens_out": int(tout or 0),
            "cost_usd": float(cost or 0),
            "fp_rate": round(fpm / runs, 4) if runs else None,
        }
        for name, prompt, runs, lat, conf, tin, tout, cost, fpm in model_rows
    ]

    # Estadísticas de latencia (avg/mediana/p95/máx) — alimenta el widget de rendimiento
    latency = (
        await db.execute(
            select(
                func.avg(TriageResult.latency_ms),
                func.percentile_cont(0.5).within_group(TriageResult.latency_ms),
                func.percentile_cont(0.95).within_group(TriageResult.latency_ms),
                func.max(TriageResult.latency_ms),
            ).where(TriageResult.created_at >= since, TriageResult.latency_ms.isnot(None))
        )
    ).one()

    # Uso de herramientas del agente (qué consulta realmente el LLM)
    tool_rows = (
        await db.execute(
            select(func.unnest(TriageResult.tools_used).label("tool"), func.count())
            .where(TriageResult.created_at >= since)
            .group_by("tool")
            .order_by(func.count().desc())
        )
    ).all()
    tools_usage = [{"tool": tool, "count": count} for tool, count in tool_rows]

    aggregates = (
        await db.execute(
            select(func.avg(TriageResult.confidence), func.avg(TriageResult.latency_ms),
                   func.avg(func.coalesce(TriageResult.tokens_in, 0) + func.coalesce(TriageResult.tokens_out, 0)))
            .where(TriageResult.created_at >= since)
        )
    ).one()

    human_counts = (
        await db.execute(
            select(
                func.count(case((TriageResult.human_feedback == "confirmed_tp", 1))),
                func.count(case((TriageResult.human_feedback == "confirmed_fp", 1))),
            ).where(TriageResult.created_at >= since)
        )
    ).one()
    human = (
        await db.execute(
            select(func.count(TriageResult.id)).where(
                TriageResult.created_at >= since, TriageResult.human_feedback.isnot(None)
            )
        )
    ).scalar_one()

    # Concordancia entre veredicto del modelo y etiqueta humana
    agreement = (
        await db.execute(
            select(func.count(TriageResult.id)).where(
                TriageResult.created_at >= since,
                TriageResult.human_feedback.isnot(None),
                (
                    ((TriageResult.human_feedback == "confirmed_fp") & (TriageResult.verdict == TriageVerdict.FALSE_POSITIVE))
                    | ((TriageResult.human_feedback == "confirmed_tp") & (TriageResult.verdict == TriageVerdict.TRUE_POSITIVE))
                ),
            )
        )
    ).scalar_one()

    tp = by_verdict.get("true_positive", 0)
    fp = by_verdict.get("false_positive", 0)
    precision = round(tp / (tp + fp), 4) if (tp + fp) else None
    recall = round(tp / (human_counts[0] or 1), 4) if human_counts[0] else None
    f1 = (
        round(2 * precision * recall / (precision + recall), 4)
        if precision and recall and (precision + recall) > 0
        else None
    )

    await AuditService(db).log(
        module="triage", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="triage_stats", detail=f"Consulta de estadísticas de triaje ({days} días)",
        ip_address=current.ip_address, http_method="GET", http_path="/api/v1/triage/stats", http_status=200,
    )

    return TriageStats(
        period={"from": since, "to": datetime.now(timezone.utc)},
        total_triages=total,
        total_triaged=total,
        by_verdict=by_verdict,
        verdict_distribution=by_verdict,
        by_severity=by_severity,
        by_model=[ModelUsageEntry(**entry) for entry in by_model],
        latency_ms=LatencyMetrics(
            avg=round(float(latency[0] or 0), 1),
            median=round(float(latency[1] or 0), 1),
            p95=round(float(latency[2] or 0), 1),
            max=round(float(latency[3] or 0), 1),
        ),
        tools_usage=[ToolUsageEntry(**entry) for entry in tools_usage],
        precision=precision,
        recall=recall,
        f1=f1,
        false_positive_rate=round(fp / total, 4) if total else None,
        human_confirmed_tp=human_counts[0] or 0,
        human_confirmed_fp=human_counts[1] or 0,
        agreement_with_human=round(agreement / human, 4) if human else None,
        accuracy=round(agreement / human, 4) if human else None,
        avg_confidence=round(float(aggregates[0]), 4) if aggregates[0] is not None else None,
        avg_latency_ms=round(float(aggregates[1]), 1) if aggregates[1] is not None else None,
        avg_tokens=round(float(aggregates[2]), 1) if aggregates[2] is not None else None,
    )


@router.get("/{alert_id}", response_model=TriageRead, summary="Último triaje de la alerta")
async def get_triage(alert_id: int, db: DbSession, current: TriageReader) -> TriageRead:
    triage = (
        await db.execute(
            select(TriageResult)
            .where(TriageResult.alert_id == alert_id, TriageResult.is_current.is_(True))
        )
    ).scalar_one_or_none()
    if triage is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="La alerta no tiene triaje registrado")
    await AuditService(db).log(
        module="triage", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="triage_result", entity_id=triage.id, detail=f"Consulta de triaje de la alerta #{alert_id}",
        ip_address=current.ip_address, commit=False,
    )
    return TriageRead.model_validate(triage)


@router.post("/{alert_id}/feedback", response_model=MessageResponse, summary="Retroalimentación humana del triaje")
async def submit_feedback(
    alert_id: int, body: TriageFeedback, db: DbSession, current: TriageReader
) -> MessageResponse:
    """Etiqueta humana que alimenta la métrica de precisión y la tasa de FP."""
    triage = (
        await db.execute(
            select(TriageResult).where(TriageResult.alert_id == alert_id, TriageResult.is_current.is_(True))
        )
    ).scalar_one_or_none()
    if triage is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="La alerta no tiene triaje vigente")

    before = {"human_feedback": triage.human_feedback, "verdict": triage.verdict.value}
    triage.human_feedback = "confirmed_fp" if body.is_false_positive else "confirmed_tp"
    triage.feedback_comment = body.comment
    triage.feedback_by = current.id
    triage.feedback_at = datetime.now(timezone.utc)

    alert = (await db.execute(select(Alert).where(Alert.id == alert_id))).scalar_one()
    if body.is_false_positive:
        alert.verdict = TriageVerdict.FALSE_POSITIVE
        alert.status = AlertStatus.FALSE_POSITIVE
        alert.closed_at = triage.feedback_at
        alert.mttr_seconds = int((alert.closed_at - alert.occurred_at).total_seconds())
    elif body.corrected_severity is not None:
        alert.severity = body.corrected_severity
    await db.flush()

    await AuditService(db).log(
        module="triage", action=AuditAction.TRIAGE_FEEDBACK, user_id=current.id, username=current.username,
        entity="triage_result", entity_id=triage.id,
        detail=f"Retroalimentación: {'falso positivo' if body.is_false_positive else 'verdadero positivo'}"
               + (f" · {body.comment}" if body.comment else ""),
        before=before, after={"human_feedback": triage.human_feedback},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path=f"/api/v1/triage/{alert_id}/feedback", http_status=200,
        severity="warning",
    )
    return MessageResponse(
        message="Retroalimentación registrada. Se usará para medir la precisión del modelo y ajustar el prompt.",
        detail=f"Etiqueta: {triage.human_feedback}",
    )
