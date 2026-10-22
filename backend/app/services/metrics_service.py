"""SOC-Lite · Servicio de métricas para el dashboard.

Todas las agregaciones se resuelven en PostgreSQL (no en Python) para
aprovechar los índices de `alerts` y mantener latencias < 300 ms incluso
con millones de filas. Los periodos se calculan en la zona horaria del SOC.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Numeric, case, cast, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Alert, Incident, TriageResult, User
from app.models.enums import AlertStatus, SeverityLevel, TriageVerdict

SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]


class MetricsService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def default_period(days: int = 30) -> tuple[datetime, datetime]:
        to = datetime.now(timezone.utc)
        return to - timedelta(days=days), to

    @staticmethod
    def _base_filters(date_from: datetime, date_to: datetime, source_type: str | None = None) -> list:
        filters = [Alert.deleted_at.is_(None), Alert.occurred_at >= date_from, Alert.occurred_at <= date_to]
        if source_type:
            filters.append(Alert.source_type == source_type)
        return filters

    # ------------------------------------------------------------------
    # 1. Resumen (KPIs)
    # ------------------------------------------------------------------
    async def summary(
        self, date_from: datetime | None = None, date_to: datetime | None = None, source_type: str | None = None
    ) -> dict[str, Any]:
        if date_from is None or date_to is None:
            date_from, date_to = self.default_period(30)
        filters = self._base_filters(date_from, date_to, source_type)

        # Conteo por severidad
        sev_rows = (
            await self.db.execute(
                select(Alert.severity, func.count(Alert.id)).where(*filters).group_by(Alert.severity)
            )
        ).all()
        by_severity = {s.value: 0 for s in SeverityLevel}
        for sev, count in sev_rows:
            by_severity[sev.value if hasattr(sev, "value") else str(sev)] = count

        status_rows = (
            await self.db.execute(
                select(Alert.status, func.count(Alert.id)).where(*filters).group_by(Alert.status)
            )
        ).all()
        by_status = {s.value: 0 for s in AlertStatus}
        for st, count in status_rows:
            by_status[st.value if hasattr(st, "value") else str(st)] = count

        verdict_rows = (
            await self.db.execute(
                select(TriageResult.verdict, func.count(TriageResult.id))
                .join(Alert, Alert.id == TriageResult.alert_id)
                .where(*filters, TriageResult.is_current.is_(True))
                .group_by(TriageResult.verdict)
            )
        ).all()
        by_verdict = {v.value: 0 for v in TriageVerdict}
        for verdict, count in verdict_rows:
            by_verdict[verdict.value if hasattr(verdict, "value") else str(verdict)] = count

        # MTTT / MTTR
        mttt = (
            await self.db.execute(
                select(
                    func.avg(Alert.mttt_seconds),
                    func.percentile_cont(0.5).within_group(Alert.mttt_seconds),
                    func.percentile_cont(0.95).within_group(Alert.mttt_seconds),
                ).where(*filters, Alert.mttt_seconds.isnot(None))
            )
        ).one()
        mttr = (
            await self.db.execute(
                select(
                    func.avg(Alert.mttr_seconds),
                    func.percentile_cont(0.5).within_group(Alert.mttr_seconds),
                    func.percentile_cont(0.95).within_group(Alert.mttr_seconds),
                ).where(*filters, Alert.mttr_seconds.isnot(None))
            )
        ).one()

        total = sum(by_severity.values())
        triaged = sum(by_verdict.values())
        fp = by_verdict.get("false_positive", 0)

        # Alertas del periodo anterior (para tendencia)
        span = date_to - date_from
        prev_total = (
            await self.db.execute(
                select(func.count(Alert.id)).where(
                    Alert.deleted_at.is_(None),
                    Alert.occurred_at >= date_from - span,
                    Alert.occurred_at < date_from,
                )
            )
        ).scalar_one()

        # Incidentes
        incidents_open = (
            await self.db.execute(
                select(func.count(Incident.id)).where(Incident.status.in_(["open", "in_progress", "contained"]))
            )
        ).scalar_one()
        incidents_critical = (
            await self.db.execute(
                select(func.count(Incident.id)).where(
                    Incident.severity == SeverityLevel.CRITICAL,
                    Incident.status.in_(["open", "in_progress", "contained"]),
                )
            )
        ).scalar_one()

        # SLA
        sla = await self.sla_compliance(date_from, date_to)

        # Reducción de ruido: % de alertas que NO escalaron a incidente ni a severidad alta
        noisy = by_severity.get("low", 0) + by_severity.get("info", 0) + fp
        noise_reduction = round(noisy / total, 4) if total else 0.0

        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        alerts_today = (
            await self.db.execute(
                select(func.count(Alert.id)).where(Alert.deleted_at.is_(None), Alert.occurred_at >= today_start)
            )
        ).scalar_one()

        # Alertas que incumplen SLA ahora mismo
        sla_breached = (
            await self.db.execute(
                select(func.count(Alert.id)).where(
                    Alert.deleted_at.is_(None),
                    Alert.closed_at.is_(None),
                    Alert.sla_due_at.isnot(None),
                    Alert.sla_due_at < datetime.now(timezone.utc),
                )
            )
        ).scalar_one()

        return {
            "period": {"from": date_from, "to": date_to},
            "alerts_total": total,
            "alerts_pending": by_status.get("pending", 0),
            "alerts_open": by_status.get("pending", 0) + by_status.get("enriching", 0) + by_status.get("triaged", 0) + by_status.get("escalated", 0),
            "by_severity": by_severity,
            "by_status": by_status,
            "by_verdict": by_verdict,
            "mttt_seconds": {
                "avg": round(float(mttt[0] or 0), 1),
                "median": round(float(mttt[1] or 0), 1),
                "p95": round(float(mttt[2] or 0), 1),
                "unit": "seconds",
            },
            "mttr_seconds": {
                "avg": round(float(mttr[0] or 0), 1),
                "median": round(float(mttr[1] or 0), 1),
                "p95": round(float(mttr[2] or 0), 1),
                "unit": "seconds",
            },
            "false_positive_rate": round(fp / triaged, 4) if triaged else 0.0,
            "automation_rate": round(triaged / total, 4) if total else 0.0,
            "noise_reduction": noise_reduction,
            "incidents_open": incidents_open,
            "incidents_critical": incidents_critical,
            "sla_compliance": sla,
            "sla_breached": sla_breached,
            "alerts_today": alerts_today,
            "alerts_prev_period": prev_total,
            "trend_pct": round((total - prev_total) / prev_total * 100, 2) if prev_total else 0.0,
        }

    # ------------------------------------------------------------------
    # 2. Serie temporal por severidad
    # ------------------------------------------------------------------
    async def alerts_by_severity(
        self, date_from: datetime, date_to: datetime, granularity: str = "day"
    ) -> list[dict[str, Any]]:
        bucket = {"hour": "hour", "day": "day", "week": "week", "month": "month"}.get(granularity, "day")
        rows = (
            await self.db.execute(
                select(
                    func.date_trunc(bucket, Alert.occurred_at).label("period"),
                    Alert.severity,
                    func.count(Alert.id),
                )
                .where(*self._base_filters(date_from, date_to))
                .group_by("period", Alert.severity)
                .order_by("period")
            )
        ).all()

        series: dict[str, dict[str, Any]] = {}
        for period, severity, count in rows:
            key = period.isoformat()
            entry = series.setdefault(
                key, {"period": key, "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0, "total": 0}
            )
            sev = severity.value if hasattr(severity, "value") else str(severity)
            entry[sev] = count
            entry["total"] += count
        return list(series.values())

    # ------------------------------------------------------------------
    # 3. Tendencia de MTTT vs objetivo
    # ------------------------------------------------------------------
    async def mttt_trend(self, days: int = 30, severity: str | None = None) -> list[dict[str, Any]]:
        date_from = datetime.now(timezone.utc) - timedelta(days=days)
        target = settings.SLA_MINUTES.get(severity or "high", 60) * 60
        filters = [Alert.deleted_at.is_(None), Alert.occurred_at >= date_from, Alert.mttt_seconds.isnot(None)]
        if severity:
            filters.append(Alert.severity == severity)

        rows = (
            await self.db.execute(
                select(
                    func.date_trunc("day", Alert.occurred_at).label("period"),
                    func.avg(Alert.mttt_seconds),
                    func.percentile_cont(0.95).within_group(Alert.mttt_seconds),
                    func.count(Alert.id),
                )
                .where(*filters)
                .group_by("period")
                .order_by("period")
            )
        ).all()
        return [
            {
                "period": period.isoformat(),
                "mttt_avg": round(float(avg or 0), 1),
                "mttt_p95": round(float(p95 or 0), 1),
                "target_seconds": target,
                "alerts": count,
                # Alias normalizados que consume el gráfico del dashboard
                "date": period.date().isoformat(),
                "mttt_avg_sec": round(float(avg or 0), 1),
                "mttt_p95_sec": round(float(p95 or 0), 1),
                "target_sec": target,
                "target_sla_sec": target,
            }
            for period, avg, p95, count in rows
        ]

    # ------------------------------------------------------------------
    # 4. Top orígenes
    # ------------------------------------------------------------------
    async def top_sources(self, date_from: datetime, date_to: datetime, limit: int = 10) -> dict[str, list]:
        filters = self._base_filters(date_from, date_to)

        async def _top(column, label: str | None = None, extra_labels: list[tuple[str, Any]] | None = None):
            """`extra_labels` adjunta columnas descriptivas (p. ej. la descripción de la regla)."""
            columns = [column, func.count(Alert.id).label("n"), func.avg(Alert.risk_score)]
            for _, col in extra_labels or []:
                columns.append(func.max(col))
            rows = (
                await self.db.execute(
                    select(*columns)
                    .where(*filters, column.isnot(None))
                    .group_by(column)
                    .order_by(func.count(Alert.id).desc())
                    .limit(limit)
                )
            ).all()

            items: list[dict[str, Any]] = []
            for row in rows:
                key, count, avg = row[0], row[1], row[2]
                extras = {name: row[3 + idx] for idx, (name, _) in enumerate(extra_labels or [])}
                avg_risk = round(float(avg), 1) if avg is not None else None
                item: dict[str, Any] = {
                    "key": str(key),
                    "label": label or str(key),
                    "count": count,
                    "extra": {"avg_risk": avg_risk},
                    # Alias consumidos por los widgets
                    "value": str(key),
                    "name": str(key),
                    "avg_risk_score": avg_risk,
                }
                item.update(extras)
                if label == "rule":
                    item["rule_id"] = str(key)
                    item["rule_description"] = extras.get("rule_description")
                if label == "agent":
                    item["agent_name"] = str(key)
                items.append(item)
            return items

        return {
            "source_ips": await _top(Alert.source_ip, "ip"),
            "agents": await _top(Alert.agent_name, "agent"),
            "rules": await _top(Alert.rule_id, "rule", [("rule_description", Alert.rule_description)]),
            "mitre": await _top(Alert.mitre_technique, "mitre"),
        }

    # ------------------------------------------------------------------
    # 5. Tasa de falsos positivos
    # ------------------------------------------------------------------
    async def fp_rate(self, date_from: datetime | None = None, date_to: datetime | None = None) -> dict[str, Any]:
        if date_from is None or date_to is None:
            date_from, date_to = self.default_period(30)
        filters = self._base_filters(date_from, date_to)

        total, fp = (
            await self.db.execute(
                select(
                    func.count(TriageResult.id),
                    func.count(case((TriageResult.verdict == TriageVerdict.FALSE_POSITIVE, 1))),
                )
                .join(Alert, Alert.id == TriageResult.alert_id)
                .where(*filters, TriageResult.is_current.is_(True))
            )
        ).one()

        by_rule = (
            await self.db.execute(
                select(
                    Alert.rule_id,
                    func.max(Alert.rule_description).label("description"),
                    func.count(TriageResult.id).label("n"),
                    func.count(case((TriageResult.verdict == TriageVerdict.FALSE_POSITIVE, 1))).label("fp"),
                )
                .join(Alert, Alert.id == TriageResult.alert_id)
                .where(*filters, TriageResult.is_current.is_(True), Alert.rule_id.isnot(None))
                .group_by(Alert.rule_id)
                .order_by(func.count(TriageResult.id).desc())
                .limit(15)
            )
        ).all()

        by_model = (
            await self.db.execute(
                select(
                    TriageResult.model_name,
                    func.max(TriageResult.prompt_version),
                    func.count(TriageResult.id).label("n"),
                    func.count(case((TriageResult.verdict == TriageVerdict.FALSE_POSITIVE, 1))).label("fp"),
                    func.avg(TriageResult.confidence),
                )
                .where(TriageResult.created_at >= date_from)
                .group_by(TriageResult.model_name)
            )
        ).all()

        human = (
            await self.db.execute(
                select(
                    func.count(TriageResult.id),
                    func.count(
                        case(
                            (
                                (TriageResult.human_feedback == "confirmed_fp")
                                & (TriageResult.verdict == TriageVerdict.FALSE_POSITIVE),
                                1,
                            )
                        )
                    ),
                )
                .where(TriageResult.human_feedback.isnot(None), TriageResult.created_at >= date_from)
            )
        ).one()

        return {
            "global_rate": round(fp / total, 4) if total else 0.0,
            "total_triaged": total,
            "total_fp": fp,
            "false_positives": fp,
            "by_rule": [
                {
                    "key": r,
                    "label": r,
                    "count": n,
                    "extra": {"fp": f, "fp_pct": round(f / n, 4) if n else 0, "description": desc},
                    "rule_id": r,
                    "rule_description": desc,
                    "total": n,
                    "fp": f,
                    "fp_pct": round(f / n, 4) if n else 0,
                }
                for r, desc, n, f in by_rule
            ],
            "by_model": [
                {
                    "key": m,
                    "label": m,
                    "count": n,
                    "extra": {"avg_confidence": round(float(c or 0), 3), "fp": f},
                    "model_name": m,
                    "prompt_version": pv,
                    "total": n,
                    "fp": f,
                    "fp_pct": round(f / n, 4) if n else 0,
                }
                for m, pv, n, f, c in by_model
            ],
            "human_agreement_rate": round(human[1] / human[0], 4) if human[0] else None,
        }

    # ------------------------------------------------------------------
    # 6. Cumplimiento de SLA
    # ------------------------------------------------------------------
    async def sla_compliance(self, date_from: datetime, date_to: datetime) -> dict[str, float]:
        rows = (
            await self.db.execute(
                select(
                    Alert.severity,
                    func.count(Alert.id),
                    func.count(case((Alert.sla_due_at >= Alert.closed_at, 1))),
                    func.count(case((Alert.closed_at.is_(None) & (Alert.sla_due_at < func.now()), 1))),
                )
                .where(*self._base_filters(date_from, date_to))
                .group_by(Alert.severity)
            )
        ).all()
        result: dict[str, float] = {}
        for severity, total, compliant, breached_open in rows:
            sev = severity.value if hasattr(severity, "value") else str(severity)
            ok = compliant or 0
            result[sev] = round(ok / total, 4) if total else 0.0
        return result

    async def sla_detail(self, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        rows = (
            await self.db.execute(
                select(
                    Alert.severity,
                    func.count(Alert.id),
                    func.count(case((Alert.closed_at.isnot(None) & (Alert.closed_at <= Alert.sla_due_at), 1))),
                    func.count(case((Alert.closed_at.is_(None) & (Alert.sla_due_at < func.now()), 1))),
                    func.avg(Alert.mttt_seconds),
                )
                .where(*self._base_filters(date_from, date_to))
                .group_by(Alert.severity)
            )
        ).all()
        out = []
        for severity, total, compliant, breached, avg_sec in rows:
            sev = severity.value if hasattr(severity, "value") else str(severity)
            target_minutes = settings.SLA_MINUTES.get(sev, 480)
            rate = round((compliant or 0) / total, 4) if total else 0.0
            out.append(
                {
                    "severity": sev,
                    "target_minutes": target_minutes,
                    "compliant": compliant or 0,
                    "breached": breached or 0,
                    "compliance_rate": rate,
                    # Alias consumidos por el widget de SLA
                    "total": total or 0,
                    "compliance": rate,
                    "target": target_minutes * 60,
                    "avg_seconds": round(float(avg_sec), 1) if avg_sec is not None else None,
                }
            )
        # Orden por severidad descendente para una lectura natural del widget
        order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
        return sorted(out, key=lambda item: order.get(str(item["severity"]), 9))

    # ------------------------------------------------------------------
    # 7. Carga por analista
    # ------------------------------------------------------------------
    async def analyst_workload(self) -> list[dict[str, Any]]:
        rows = (
            await self.db.execute(
                select(
                    User.id,
                    User.username,
                    User.full_name,
                    func.count(case((Alert.status.in_([AlertStatus.PENDING, AlertStatus.ENRICHING, AlertStatus.TRIAGED]), 1))),
                    func.count(case((Alert.status == AlertStatus.ESCALATED, 1))),
                    func.count(case((Alert.status.in_([AlertStatus.CLOSED, AlertStatus.FALSE_POSITIVE]), 1))),
                    func.avg(Alert.mttt_seconds),
                )
                .select_from(User)
                .outerjoin(Alert, (Alert.assigned_to == User.id) & Alert.deleted_at.is_(None))
                .where(User.deleted_at.is_(None), User.is_active.is_(True))
                .group_by(User.id, User.username, User.full_name)
                .order_by(func.count(case((Alert.status.in_([AlertStatus.PENDING, AlertStatus.ENRICHING, AlertStatus.TRIAGED]), 1))).desc())
            )
        ).all()
        return [
            {
                "user_id": uid,
                "username": username,
                "full_name": full_name,
                "open_alerts": open_n,
                "escalated": esc,
                "closed": closed,
                "avg_mttt_seconds": round(float(avg), 1) if avg is not None else None,
                # Alias del frontend (nomenclatura de la vista v_analyst_workload)
                "abiertas": open_n,
                "escaladas": esc,
                "cerradas": closed,
                "mttt_promedio": round(float(avg), 1) if avg is not None else None,
                "total": (open_n or 0) + (esc or 0) + (closed or 0),
            }
            for uid, username, full_name, open_n, esc, closed, avg in rows
        ]

    # ------------------------------------------------------------------
    # 8. Distribución de veredictos (para el gráfico circular)
    # ------------------------------------------------------------------
    async def verdict_distribution(self, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        rows = (
            await self.db.execute(
                select(TriageResult.verdict, func.count(TriageResult.id))
                .join(Alert, Alert.id == TriageResult.alert_id)
                .where(*self._base_filters(date_from, date_to), TriageResult.is_current.is_(True))
                .group_by(TriageResult.verdict)
            )
        ).all()
        return [
            {
                "key": (v.value if hasattr(v, "value") else str(v)),
                "verdict": (v.value if hasattr(v, "value") else str(v)),
                "value": n,
                "count": n,
            }
            for v, n in rows
        ]

    # ------------------------------------------------------------------
    # 9. Recalcular agregados diarios (invocado por n8n o Celery beat)
    # ------------------------------------------------------------------
    async def refresh_daily_metrics(self) -> int:
        sql = text(
            """
            DELETE FROM soclite.alert_metrics_daily;
            INSERT INTO soclite.alert_metrics_daily
                (metric_date, source_type, severity, alerts_total, alerts_tp, alerts_fp,
                 alerts_escalated, mttt_avg_sec, mttt_p95_sec, mttr_avg_sec, automation_rate)
            SELECT a.occurred_at::date, a.source_type, a.severity,
                   count(*),
                   count(*) FILTER (WHERE a.verdict = 'true_positive'),
                   count(*) FILTER (WHERE a.verdict = 'false_positive'),
                   count(*) FILTER (WHERE a.status = 'escalated'),
                   round(avg(a.mttt_seconds), 2),
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY a.mttt_seconds),
                   round(avg(a.mttr_seconds), 2),
                   round(count(*) FILTER (WHERE a.triaged_at IS NOT NULL)::numeric / NULLIF(count(*),0), 4)
            FROM soclite.alerts a
            WHERE a.deleted_at IS NULL
            GROUP BY 1,2,3;
            ANALYZE soclite.alerts;
            """
        )
        await self.db.execute(sql)
        await self.db.commit()
        row = (await self.db.execute(text("SELECT count(*) FROM soclite.alert_metrics_daily"))).scalar_one()
        return int(row)
