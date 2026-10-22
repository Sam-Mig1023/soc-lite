"""SOC-Lite · Servicio de triaje: orquesta el microservicio LangChain.

Flujo:
  1. Carga la alerta y su contexto (histórico, criticidad del activo, FPs conocidos).
  2. Invoca `POST /triage` del microservicio LangChain (Ollama local por defecto).
  3. Persiste el resultado en `triage_results` (marcando `is_current`).
  4. Actualiza la alerta (`verdict`, `risk_score`, `severity`, `status`, `triaged_at`).
  5. Decide respuesta: crear incidente (crítico), notificar (alto/crítico),
     crear ticket y registrar bitácora.

El enriquecimiento externo (VirusTotal/AbuseIPDB/GeoIP) lo ejecutan las *tools*
del agente LLM; el backend sólo consume los indicadores resultantes.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import calculate_risk_score
from app.models import Alert, EnrichmentData, Incident, IncidentAlert, Notification, TriageResult
from app.models.enums import AlertStatus, SeverityLevel, TriageVerdict

logger = logging.getLogger("soclite.triage")


class TriageServiceError(RuntimeError):
    pass


class TriageService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Contexto
    # ------------------------------------------------------------------
    async def build_context(self, alert: Alert) -> dict[str, Any]:
        """Contexto que se envía al agente: reduce alucinaciones y mejora el veredicto."""
        recent_same_source = 0
        if alert.source_ip is not None:
            since = alert.occurred_at - timedelta(hours=24)
            recent_same_source = (
                await self.db.execute(
                    select(func.count(Alert.id)).where(
                        Alert.source_ip == alert.source_ip,
                        Alert.occurred_at >= since,
                        Alert.id != alert.id,
                    )
                )
            ).scalar_one()

        known_fp = (
            await self.db.execute(
                select(func.count(TriageResult.id))
                .join(Alert, Alert.id == TriageResult.alert_id)
                .where(
                    Alert.rule_id == alert.rule_id,
                    TriageResult.verdict == TriageVerdict.FALSE_POSITIVE,
                    TriageResult.is_current.is_(True),
                )
            )
        ).scalar_one()

        asset_criticality = alert.asset.criticality if alert.asset else "medium"
        return {
            "recent_alerts_same_source": recent_same_source,
            "asset_criticality": asset_criticality,
            "asset_hostname": alert.asset.hostname if alert.asset else alert.agent_name,
            "asset_internet_facing": alert.asset.is_internet_facing if alert.asset else False,
            "known_false_positives": known_fp,
            "is_working_hours": datetime.now(timezone.utc).hour in range(12, 22),
            "policy": {
                "allow_external_llm": settings.ALLOW_EXTERNAL_LLM,
                "max_severity_auto_close": "low",
            },
        }

    # ------------------------------------------------------------------
    # Invocación del microservicio
    # ------------------------------------------------------------------
    async def call_langchain(self, alert: Alert, trace_id: str) -> dict[str, Any]:
        payload = {
            "alert_id": alert.id,
            "trace_id": trace_id,
            "alert": {
                "rule_id": alert.rule_id,
                "rule_description": alert.rule_description,
                "rule_level": alert.rule_level,
                "rule_groups": alert.rule_groups,
                "severity_siem": alert.severity.value,
                "source_ip": str(alert.source_ip) if alert.source_ip else None,
                "dest_ip": str(alert.dest_ip) if alert.dest_ip else None,
                "agent_name": alert.agent_name,
                "full_log": alert.full_log,
                "mitre_technique": alert.mitre_technique,
                "occurred_at": alert.occurred_at.isoformat(),
                "dedup_count": alert.dedup_count,
            },
            "context": await self.build_context(alert),
        }
        url = f"{settings.LANGCHAIN_SERVICE_URL.rstrip('/')}/triage"
        headers = {"X-Service-Token": settings.INTERNAL_SERVICE_TOKEN, "X-Trace-Id": trace_id}

        last_error: Exception | None = None
        for attempt in range(1, settings.LANGCHAIN_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=settings.LANGCHAIN_TIMEOUT_SECONDS) as client:
                    response = await client.post(url, json=payload, headers=headers)
                    response.raise_for_status()
                    return response.json()
            except (httpx.HTTPError, ValueError) as exc:
                last_error = exc
                logger.warning("Intento %s/%s de triaje fallido: %s", attempt, settings.LANGCHAIN_MAX_RETRIES, exc)
                if attempt < settings.LANGCHAIN_MAX_RETRIES:
                    await asyncio.sleep(min(2 ** attempt, 8))

        raise TriageServiceError(f"Microservicio de triaje no disponible: {last_error}")

    # ------------------------------------------------------------------
    # Fallback heurístico (garantiza operación 24/7 si el LLM cae)
    # ------------------------------------------------------------------
    @staticmethod
    def heuristic_triage(alert: Alert, reason: str) -> dict[str, Any]:
        level = alert.rule_level or 0
        severity = alert.severity.value
        verdict = "true_positive" if level >= 9 else ("suspicious" if level >= 6 else "inconclusive")
        risk = calculate_risk_score(severity, level, alert.asset.criticality if alert.asset else "medium")
        return {
            "verdict": verdict,
            "severity": severity,
            "risk_score": risk,
            "confidence": 0.4,
            "summary": (
                f"Triaje heurístico de contingencia (motor LLM no disponible: {reason}). "
                f"Regla {alert.rule_id} nivel {level} sobre {alert.agent_name or alert.dest_ip}. "
                "Requiere validación manual por analista."
            ),
            "reasoning": [
                "Motor LLM no disponible: se aplicó el motor de reglas de contingencia",
                f"Nivel de regla Wazuh {level} → veredicto {verdict}",
                "Priorización basada en severidad del SIEM y criticidad del activo",
            ],
            "recommended_actions": [
                {"order": 1, "action": "Revisión manual de la alerta por un analista", "priority": "p2"},
                {"order": 2, "action": "Verificar reputación de la IP origen en AbuseIPDB/VirusTotal", "priority": "p3"},
            ],
            "mitre_techniques": [alert.mitre_technique] if alert.mitre_technique else [],
            "indicators": [],
            "model": "heuristic-fallback",
            "prompt_version": settings.TRIAGE_PROMPT_VERSION,
            "tokens_in": 0,
            "tokens_out": 0,
            "latency_ms": 0,
            "tools_used": [],
        }

    # ------------------------------------------------------------------
    # Persistencia
    # ------------------------------------------------------------------
    async def persist(self, alert: Alert, result: dict[str, Any], trace_id: str) -> TriageResult:
        await self.db.execute(
            update(TriageResult).where(TriageResult.alert_id == alert.id).values(is_current=False)
        )

        verdict = TriageVerdict(str(result.get("verdict", "inconclusive")))
        severity = SeverityLevel(str(result.get("severity", alert.severity.value)))
        risk = int(result.get("risk_score") or calculate_risk_score(
            severity.value, alert.rule_level, alert.asset.criticality if alert.asset else "medium"
        ))

        triage = TriageResult(
            alert_id=alert.id,
            verdict=verdict,
            severity=severity,
            risk_score=risk,
            confidence=Decimal(str(round(float(result.get("confidence", 0.5)), 3))),
            summary=result.get("summary") or "Sin resumen generado",
            reasoning=result.get("reasoning") or [],
            recommended_actions=result.get("recommended_actions") or [],
            mitre_techniques=result.get("mitre_techniques") or [],
            iocs=result.get("indicators") or result.get("iocs") or [],
            model_name=str(result.get("model", settings.OLLAMA_MODEL)),
            model_provider=str(result.get("provider", settings.LLM_PROVIDER)),
            prompt_version=str(result.get("prompt_version", settings.TRIAGE_PROMPT_VERSION)),
            tokens_in=int(result.get("tokens_in") or 0),
            tokens_out=int(result.get("tokens_out") or 0),
            latency_ms=int(result.get("latency_ms") or 0),
            tools_used=result.get("tools_used") or [],
            trace_id=trace_id,
            is_current=True,
        )
        self.db.add(triage)
        await self.db.flush()

        # Persistir indicadores de enriquecimiento devueltos por las tools del agente
        for indicator in triage.iocs or []:
            if not isinstance(indicator, dict) or not indicator.get("value"):
                continue
            exists = (
                await self.db.execute(
                    select(EnrichmentData.id).where(
                        EnrichmentData.alert_id == alert.id,
                        EnrichmentData.provider == str(indicator.get("source", "llm_tool")),
                        EnrichmentData.indicator == str(indicator["value"]),
                        EnrichmentData.indicator_type == str(indicator.get("type", "ip")),
                    )
                )
            ).scalar_one_or_none()
            if exists:
                continue
            self.db.add(
                EnrichmentData(
                    alert_id=alert.id,
                    provider=str(indicator.get("source", "llm_tool"))[:48],
                    indicator=str(indicator["value"])[:512],
                    indicator_type=str(indicator.get("type", "ip"))[:24],
                    verdict=str(indicator.get("verdict", "unknown"))[:24],
                    score=Decimal(str(indicator["score"])) if indicator.get("score") is not None else None,
                    raw_response=indicator,
                    cache_hit=bool(indicator.get("cache_hit", False)),
                )
            )

        # Actualizar la alerta con el resultado del triaje
        new_status = AlertStatus.TRIAGED
        if verdict == TriageVerdict.FALSE_POSITIVE and float(triage.confidence or 0) >= settings.AUTO_CLOSE_FP_CONFIDENCE:
            new_status = AlertStatus.FALSE_POSITIVE
        elif severity in (SeverityLevel.CRITICAL, SeverityLevel.HIGH) or risk >= settings.RISK_SCORE_ESCALATION_THRESHOLD:
            new_status = AlertStatus.ESCALATED

        alert.verdict = verdict
        alert.severity = severity
        alert.risk_score = risk
        alert.status = new_status
        alert.triaged_at = datetime.now(timezone.utc)
        if new_status in (AlertStatus.ESCALATED,):
            alert.mttt_seconds = alert.mttt_seconds or int(
                (alert.triaged_at - alert.occurred_at).total_seconds()
            )
        if new_status == AlertStatus.FALSE_POSITIVE:
            alert.closed_at = alert.triaged_at
            alert.mttr_seconds = int((alert.closed_at - alert.occurred_at).total_seconds())
        if alert.sla_due_at is None:
            alert.sla_due_at = alert.occurred_at + timedelta(
                minutes=settings.SLA_MINUTES.get(severity.value, 480)
            )

        await self.db.flush()
        return triage

    # ------------------------------------------------------------------
    # Respuesta automatizada
    # ------------------------------------------------------------------
    async def maybe_create_incident(self, alert: Alert, triage: TriageResult) -> Incident | None:
        if triage.severity != SeverityLevel.CRITICAL and (triage.risk_score or 0) < 90:
            return None
        if triage.verdict in (TriageVerdict.FALSE_POSITIVE, TriageVerdict.BENIGN):
            return None

        existing = (
            await self.db.execute(
                select(Incident)
                .join(IncidentAlert, IncidentAlert.incident_id == Incident.id)
                .where(IncidentAlert.alert_id == alert.id)
            )
        ).scalar_one_or_none()
        if existing:
            return existing

        year = datetime.now(timezone.utc).year
        count = (await self.db.execute(select(func.count(Incident.id)))).scalar_one()
        actions = triage.recommended_actions or []
        incident = Incident(
            incident_code=f"INC-{year}-{count + 1:05d}",
            title=(triage.summary[:250] if triage.summary else f"Alerta crítica {alert.rule_id}")[:255],
            description=(
                f"Incidente generado automáticamente por SOC-Lite a partir de la alerta #{alert.id} "
                f"(regla {alert.rule_id}, veredicto {triage.verdict.value}, confianza {triage.confidence}).\n\n"
                f"Resumen LLM: {triage.summary}"
            ),
            status="open",
            priority="p1" if triage.severity == SeverityLevel.CRITICAL else "p2",
            severity=triage.severity,
            category="intrusion",
            mitre_tactics=[t.get("technique", "") for t in actions if isinstance(t, dict)] or [],
            detected_at=alert.occurred_at,
            owner_id=alert.assigned_to,
            created_by=None,
        )
        self.db.add(incident)
        await self.db.flush()
        self.db.add(IncidentAlert(incident_id=incident.id, alert_id=alert.id))
        await self.db.flush()
        return incident

    async def queue_notification(self, alert: Alert, triage: TriageResult) -> bool:
        """Encola la notificación (Slack/Telegram/email) para severidad alta o crítica."""
        if triage.severity not in (SeverityLevel.CRITICAL, SeverityLevel.HIGH):
            return False
        channels = []
        if settings.SLACK_WEBHOOK_URL:
            channels.append(("slack", settings.SLACK_CHANNEL))
        if settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID:
            channels.append(("telegram", settings.TELEGRAM_CHAT_ID))
        if settings.SMTP_HOST:
            channels.append(("email", settings.SMTP_FROM))
        if not channels:
            channels.append(("slack", settings.SLACK_CHANNEL))  # queda en cola para revisión

        for channel, target in channels:
            self.db.add(
                Notification(
                    alert_id=alert.id,
                    channel=channel,
                    target=target,
                    severity=triage.severity,
                    payload={
                        "alert_id": alert.id,
                        "rule_id": alert.rule_id,
                        "agent": alert.agent_name,
                        "source_ip": str(alert.source_ip) if alert.source_ip else None,
                        "severity": triage.severity.value,
                        "verdict": triage.verdict.value,
                        "risk_score": triage.risk_score,
                        "summary": triage.summary,
                        "dashboard_url": f"{settings.FRONTEND_URL}/alerts/{alert.id}",
                    },
                    status="queued",
                )
            )
        await self.db.flush()
        return True

    # ------------------------------------------------------------------
    # Orquestación completa
    # ------------------------------------------------------------------
    async def run(self, alert: Alert, force: bool = False) -> dict[str, Any]:
        if alert.status == AlertStatus.FALSE_POSITIVE and not force:
            raise TriageServiceError("La alerta está marcada como falso positivo; use force=true para re-triar")

        trace_id = str(uuid4())
        alert.status = AlertStatus.ENRICHING
        await self.db.flush()

        started = time.perf_counter()
        degraded = False
        try:
            result = await self.call_langchain(alert, trace_id)
        except TriageServiceError as exc:
            degraded = True
            result = self.heuristic_triage(alert, str(exc))
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        result.setdefault("latency_ms", elapsed_ms)

        triage = await self.persist(alert, result, trace_id)
        incident = await self.maybe_create_incident(alert, triage)
        notified = await self.queue_notification(alert, triage)

        return {
            "alert_id": alert.id,
            "triage_id": triage.id,
            "verdict": triage.verdict,
            "severity": triage.severity,
            "risk_score": triage.risk_score or 0,
            "confidence": float(triage.confidence or 0),
            "summary": triage.summary,
            "recommended_actions": triage.recommended_actions,
            "incident_id": incident.id if incident else None,
            "ticket_id": None,
            "notified": notified,
            "latency_ms": triage.latency_ms,
            "degraded": degraded,
            "trace_id": trace_id,
        }
