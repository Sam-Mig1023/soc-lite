"""SOC-Lite · Servicio de reportes exportables (PDF · Word · Excel).

Genera tres tipos de reporte:
* **operational** — volumen de alertas, MTTT/MTTR, top reglas y orígenes, incidentes del periodo.
* **management**  — riesgo agregado, cumplimiento SLA, mapeo ISO 27001 / NIST CSF, tendencias.
* **audit**       — extracto de la bitácora de auditoría con encadenamiento de hashes.

Cada generación:
1. Recolecta datos desde `MetricsService` + consultas específicas.
2. Renderiza el artefacto con la librería correspondiente.
3. Persiste el registro en `generated_reports` (ruta, tamaño, checksum sha256).
4. Registra el evento `EXPORT` en la bitácora de auditoría.
"""
from __future__ import annotations

import hashlib
import io
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Alert, AuditLog, GeneratedReport, Incident, User
from app.models.enums import ReportFormat, SeverityLevel
from app.services.metrics_service import MetricsService

logger = logging.getLogger("soclite.reports")

# Paleta corporativa coherente con el frontend
COLOR_PRIMARY = "#0F172A"
COLOR_ACCENT = "#06B6D4"
COLOR_DANGER = "#DC2626"
COLOR_WARN = "#F59E0B"
COLOR_OK = "#10B981"
COLOR_MUTED = "#64748B"

SEVERITY_COLORS = {
    "critical": "#7F1D1D",
    "high": "#DC2626",
    "medium": "#F59E0B",
    "low": "#3B82F6",
    "info": "#64748B",
}

CONTROL_MAPPING = [
    ("MTTT < 15 min en alertas críticas", "A.5.24 · A.8.16", "DE.AE-04 · RS.AN-03"),
    ("Bitácora de auditoría inmutable (usuario, fecha, hora, acción, módulo)", "A.8.15 · A.5.28", "DE.AE-03 · GV.OC-03"),
    ("Triaje y clasificación automatizada de eventos", "A.8.16 · A.5.25", "DE.AE-02 · DE.AE-06"),
    ("Registro y gestión de incidentes con trazabilidad", "A.5.24 · A.5.26", "RS.MA-01 · RS.AN-06"),
    ("Enriquecimiento con inteligencia de amenazas", "A.5.7 · A.8.16", "ID.RA-05 · DE.AE-02"),
    ("Control de acceso basado en roles (RBAC) y mínimo privilegio", "A.5.15 · A.8.2 · A.8.3", "PR.AA-01 · PR.AA-05"),
    ("Retención y protección de registros (inmutabilidad + hash chain)", "A.8.15 · A.8.10", "PR.DS-01 · DE.AE-03"),
]


class ReportService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.metrics = MetricsService(db)

    # ==================================================================
    # Recolección de datos
    # ==================================================================
    async def _collect(self, report_type: str, date_from: datetime, date_to: datetime) -> dict[str, Any]:
        summary = await self.metrics.summary(date_from, date_to)
        top = await self.metrics.top_sources(date_from, date_to, limit=10)
        fp = await self.metrics.fp_rate(date_from, date_to)
        sla = await self.metrics.sla_detail(date_from, date_to)
        trend = await self.metrics.mttt_trend(days=max(1, (date_to - date_from).days), severity=None)
        workload = await self.metrics.analyst_workload()

        incidents = (
            await self.db.execute(
                select(Incident)
                .where(Incident.detected_at >= date_from, Incident.detected_at <= date_to)
                .order_by(Incident.detected_at.desc())
                .limit(100)
            )
        ).scalars().all()

        critical_alerts = (
            await self.db.execute(
                select(Alert)
                .where(
                    Alert.occurred_at >= date_from,
                    Alert.occurred_at <= date_to,
                    Alert.severity.in_([SeverityLevel.CRITICAL, SeverityLevel.HIGH]),
                    Alert.deleted_at.is_(None),
                )
                .order_by(Alert.risk_score.desc().nullslast())
                .limit(50)
            )
        ).scalars().all()

        audit_rows: list[AuditLog] = []
        if report_type == "audit":
            audit_rows = list(
                (
                    await self.db.execute(
                        select(AuditLog)
                        .where(AuditLog.occurred_at >= date_from, AuditLog.occurred_at <= date_to)
                        .order_by(AuditLog.occurred_at.desc())
                        .limit(5000)
                    )
                ).scalars().all()
            )

        audit_summary = (
            await self.db.execute(
                select(AuditLog.module, AuditLog.action, func.count(AuditLog.id))
                .where(AuditLog.occurred_at >= date_from, AuditLog.occurred_at <= date_to)
                .group_by(AuditLog.module, AuditLog.action)
                .order_by(func.count(AuditLog.id).desc())
            )
        ).all()

        users_total = (await self.db.execute(select(func.count(User.id)).where(User.deleted_at.is_(None)))).scalar_one()

        return {
            "report_type": report_type,
            "generated_at": datetime.now(timezone.utc),
            "period": {"from": date_from, "to": date_to},
            "summary": summary,
            "top": top,
            "fp": fp,
            "sla": sla,
            "trend": trend,
            "workload": workload,
            "incidents": incidents,
            "critical_alerts": critical_alerts,
            "audit_rows": audit_rows,
            "audit_summary": audit_summary,
            "users_total": users_total,
        }

    # ==================================================================
    # Utilidades
    # ==================================================================
    @staticmethod
    def _fmt_dt(value: datetime | None) -> str:
        if value is None:
            return "—"
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    @staticmethod
    def _fmt_secs(value: float | None) -> str:
        if not value:
            return "—"
        value = float(value)
        if value < 60:
            return f"{value:.0f} s"
        if value < 3600:
            return f"{value / 60:.1f} min"
        return f"{value / 3600:.2f} h"

    @staticmethod
    def _fmt_pct(value: float | None) -> str:
        if value is None:
            return "—"
        return f"{float(value) * 100:.1f}%"

    def _report_title(self, data: dict[str, Any]) -> str:
        titles = {
            "operational": "Reporte Operativo SOC",
            "management": "Reporte de Gestión y Cumplimiento SOC",
            "audit": "Extracto de Bitácora de Auditoría",
        }
        return f"{titles.get(data['report_type'], 'Reporte SOC')} · {self._fmt_dt(data['period']['from'])[:10]} a {self._fmt_dt(data['period']['to'])[:10]}"

    # ==================================================================
    # PDF (ReportLab)
    # ==================================================================
    def _build_pdf(self, data: dict[str, Any]) -> bytes:
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=landscape(A4),
            leftMargin=1.5 * cm,
            rightMargin=1.5 * cm,
            topMargin=1.5 * cm,
            bottomMargin=1.5 * cm,
            title=self._report_title(data),
            author=settings.COMPANY_NAME,
            subject="Reporte de ciberseguridad SOC-Lite",
        )
        styles = getSampleStyleSheet()
        h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=18, textColor=colors.HexColor(COLOR_PRIMARY), spaceAfter=6)
        h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=13, textColor=colors.HexColor(COLOR_ACCENT), spaceBefore=14, spaceAfter=6)
        body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9, leading=12)
        small = ParagraphStyle("small", parent=styles["BodyText"], fontSize=7.5, textColor=colors.HexColor(COLOR_MUTED))
        cell = ParagraphStyle("cell", parent=styles["BodyText"], fontSize=8, leading=10)

        summary = data["summary"]
        elements: list[Any] = []

        # Portada / encabezado
        elements.append(Paragraph(settings.COMPANY_NAME, small))
        elements.append(Paragraph(self._report_title(data), h1))
        elements.append(
            Paragraph(
                f"Periodo analizado: <b>{self._fmt_dt(data['period']['from'])}</b> → <b>{self._fmt_dt(data['period']['to'])}</b> "
                f"&nbsp;·&nbsp; Generado: {self._fmt_dt(data['generated_at'])} &nbsp;·&nbsp; SOC-Lite v{settings.APP_VERSION}",
                small,
            )
        )
        elements.append(Spacer(1, 10))

        def table(header: list[str], rows: list[list[Any]], widths: list[float] | None = None) -> Table:
            t = Table([header] + rows, colWidths=widths, repeatRows=1)
            t.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_PRIMARY)),
                        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                        ("FONTSIZE", (0, 0), (-1, -1), 8),
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F1F5F9")]),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 5),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]
                )
            )
            return t

        # 1. Indicadores clave
        elements.append(Paragraph("1. Indicadores clave del periodo", h2))
        kpis = [
            ["Alertas totales", f"{summary['alerts_total']:,}", "Pendientes de triaje", f"{summary['alerts_pending']:,}"],
            ["MTTT promedio", self._fmt_secs(summary["mttt_seconds"]["avg"]), "MTTT mediana", self._fmt_secs(summary["mttt_seconds"]["median"])],
            ["MTTT P95", self._fmt_secs(summary["mttt_seconds"]["p95"]), "MTTR promedio", self._fmt_secs(summary["mttr_seconds"]["avg"])],
            ["Tasa de falsos positivos", self._fmt_pct(summary["false_positive_rate"]), "Automatización", self._fmt_pct(summary["automation_rate"])],
            ["Reducción de ruido", self._fmt_pct(summary["noise_reduction"]), "Incidentes abiertos", str(summary["incidents_open"])],
            ["SLA incumplido (abierto)", str(summary["sla_breached"]), "Alertas hoy", str(summary["alerts_today"])],
        ]
        elements.append(table(["Indicador", "Valor", "Indicador", "Valor"], kpis, [6 * cm, 4 * cm, 6 * cm, 4 * cm]))
        elements.append(Spacer(1, 6))
        elements.append(
            Paragraph(
                f"Variación de volumen respecto al periodo anterior: <b>{summary['trend_pct']:+.1f}%</b> "
                f"({summary['alerts_prev_period']:,} alertas previas).",
                body,
            )
        )

        # 2. Distribución por severidad y estado
        elements.append(Paragraph("2. Distribución por severidad y estado", h2))
        sev_rows = [
            [k.capitalize(), f"{v:,}", self._fmt_pct(v / summary["alerts_total"] if summary["alerts_total"] else 0)]
            for k, v in summary["by_severity"].items()
        ]
        elements.append(table(["Severidad", "Alertas", "% del total"], sev_rows, [6 * cm, 4 * cm, 4 * cm]))
        elements.append(Spacer(1, 8))
        st_rows = [[k.replace("_", " ").capitalize(), f"{v:,}"] for k, v in summary["by_status"].items()]
        elements.append(table(["Estado", "Alertas"], st_rows, [6 * cm, 4 * cm]))

        # 3. Cumplimiento de SLA
        elements.append(Paragraph("3. Cumplimiento de SLA por severidad", h2))
        sla_rows = [
            [
                s["severity"].capitalize(),
                f"{s['target_minutes']} min",
                str(s["compliant"]),
                str(s["breached"]),
                self._fmt_pct(s["compliance_rate"]),
            ]
            for s in data["sla"]
        ]
        elements.append(table(["Severidad", "Objetivo", "Cumplidas", "Incumplidas", "Cumplimiento"], sla_rows, [4 * cm, 3 * cm, 3 * cm, 3 * cm, 4 * cm]))

        # 4. Top orígenes
        elements.append(Paragraph("4. Principales orígenes de alertas", h2))
        for label, key in (("Direcciones IP origen", "source_ips"), ("Activos afectados", "agents"), ("Reglas más disparadas", "rules")):
            rows = [[r["key"], f"{r['count']:,}", str(r["extra"].get("avg_risk") or "—")] for r in data["top"][key][:10]]
            if rows:
                elements.append(Paragraph(label, body))
                elements.append(table(["Origen", "Alertas", "Riesgo medio"], rows, [10 * cm, 3 * cm, 3 * cm]))
                elements.append(Spacer(1, 6))

        # 5. Precisión del triaje
        elements.append(Paragraph("5. Precisión del triaje automatizado", h2))
        fp = data["fp"]
        elements.append(
            Paragraph(
                f"Triajes ejecutados: <b>{fp['total_triaged']:,}</b> · Falsos positivos detectados: <b>{fp['total_fp']:,}</b> "
                f"· Tasa global de FP: <b>{self._fmt_pct(fp['global_rate'])}</b> "
                f"· Concordancia con validación humana: <b>{self._fmt_pct(fp['human_agreement_rate'])}</b>",
                body,
            )
        )
        fp_rows = [
            [r["key"], f"{r['count']:,}", f"{r['extra'].get('fp', 0):,}", self._fmt_pct(r["extra"].get("fp_pct"))]
            for r in fp["by_rule"][:12]
        ]
        elements.append(Spacer(1, 4))
        elements.append(table(["Regla", "Triajes", "Falsos positivos", "% FP"], fp_rows, [6 * cm, 3 * cm, 4 * cm, 3 * cm]))

        # 6. Incidentes
        elements.append(PageBreak())
        elements.append(Paragraph("6. Incidentes del periodo", h2))
        if data["incidents"]:
            inc_rows = [
                [
                    i.incident_code,
                    Paragraph((i.title or "")[:90], cell),
                    i.severity.value if hasattr(i.severity, "value") else str(i.severity),
                    i.priority.value if hasattr(i.priority, "value") else str(i.priority),
                    i.status.value if hasattr(i.status, "value") else str(i.status),
                    self._fmt_dt(i.detected_at),
                    self._fmt_secs(i.mttr_seconds),
                ]
                for i in data["incidents"][:40]
            ]
            elements.append(
                table(["Código", "Título", "Severidad", "Prioridad", "Estado", "Detectado", "MTTR"], inc_rows,
                      [2.4 * cm, 8 * cm, 2.2 * cm, 2.2 * cm, 2.4 * cm, 3.4 * cm, 2 * cm])
            )
        else:
            elements.append(Paragraph("No se registraron incidentes en el periodo.", body))

        # 7. Alertas críticas / altas
        elements.append(Paragraph("7. Alertas de mayor riesgo", h2))
        crit_rows = [
            [
                f"#{a.id}",
                a.rule_id or "—",
                Paragraph((a.rule_description or "")[:110], cell),
                str(a.risk_score or "—"),
                (a.verdict.value if hasattr(a.verdict, "value") else str(a.verdict or "—")),
                str(a.source_ip or "—"),
                self._fmt_dt(a.occurred_at),
            ]
            for a in data["critical_alerts"][:40]
        ]
        if crit_rows:
            elements.append(
                table(["ID", "Regla", "Descripción", "Riesgo", "Veredicto", "IP origen", "Ocurrencia"], crit_rows,
                      [1.6 * cm, 1.8 * cm, 8.6 * cm, 1.8 * cm, 2.6 * cm, 3 * cm, 4 * cm])
            )
        else:
            elements.append(Paragraph("Sin alertas críticas o altas en el periodo.", body))

        # 8. Cumplimiento normativo
        if data["report_type"] in ("management", "audit"):
            elements.append(PageBreak())
            elements.append(Paragraph("8. Mapeo de controles ISO/IEC 27001:2022 y NIST CSF 2.0", h2))
            ctrl_rows = [[Paragraph(c[0], cell), c[1], c[2]] for c in CONTROL_MAPPING]
            elements.append(table(["Control implementado", "ISO 27001:2022", "NIST CSF 2.0"], ctrl_rows, [13 * cm, 5 * cm, 5 * cm]))

        # 9. Carga del equipo
        elements.append(Paragraph("9. Carga de trabajo del equipo de análisis", h2))
        wl_rows = [
            [w["full_name"], w["username"], str(w["open_alerts"]), str(w["escalated"]), str(w["closed"]), self._fmt_secs(w["avg_mttt_seconds"])]
            for w in data["workload"]
        ]
        elements.append(table(["Analista", "Usuario", "Abiertas", "Escaladas", "Cerradas", "MTTT promedio"], wl_rows, [6 * cm, 4 * cm, 2.6 * cm, 2.6 * cm, 2.6 * cm, 4 * cm]))

        # 10. Bitácora (solo reporte de auditoría)
        if data["report_type"] == "audit":
            elements.append(PageBreak())
            elements.append(Paragraph("10. Bitácora de auditoría (extracto)", h2))
            elements.append(
                Paragraph(
                    f"Eventos registrados en el periodo: <b>{len(data['audit_rows']):,}</b> · Usuarios en el sistema: "
                    f"<b>{data['users_total']}</b> · Registro inmutable con encadenamiento sha256.",
                    body,
                )
            )
            a_rows = [
                [
                    self._fmt_dt(r.occurred_at),
                    r.username or "—",
                    r.module,
                    r.action.value if hasattr(r.action, "value") else str(r.action),
                    r.result.value if hasattr(r.result, "value") else str(r.result),
                    (r.entity or "—") + (f"#{r.entity_id}" if r.entity_id else ""),
                    (r.detail or "")[:70],
                ]
                for r in data["audit_rows"][:400]
            ]
            elements.append(
                table(["Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad", "Detalle"], a_rows,
                      [3.4 * cm, 2.4 * cm, 2 * cm, 2.4 * cm, 2 * cm, 3.4 * cm, 8.4 * cm])
            )
            if data["audit_summary"]:
                elements.append(Spacer(1, 8))
                elements.append(Paragraph("Resumen de eventos por módulo y acción", body))
                agg_rows = [[m, a.value if hasattr(a, "value") else str(a), f"{n:,}"] for m, a, n in data["audit_summary"][:40]]
                elements.append(table(["Módulo", "Acción", "Eventos"], agg_rows, [6 * cm, 6 * cm, 4 * cm]))

        elements.append(Spacer(1, 14))
        elements.append(
            Paragraph(
                f"Documento generado automáticamente por SOC-Lite v{settings.APP_VERSION}. "
                "Contiene información clasificada de seguridad — distribución restringida. "
                "Trazabilidad: este reporte quedó registrado en la bitácora de auditoría con acción EXPORT.",
                small,
            )
        )

        doc.build(elements)
        return buffer.getvalue()

    # ==================================================================
    # DOCX (python-docx)
    # ==================================================================
    def _build_docx(self, data: dict[str, Any]) -> bytes:
        document = Document()
        styles = document.styles
        styles["Normal"].font.name = "Calibri"
        styles["Normal"].font.size = Pt(10)

        def heading(text: str, level: int = 1) -> None:
            h = document.add_heading(text, level=level)
            for run in h.runs:
                run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A) if level == 1 else RGBColor(0x06, 0xB6, 0xD4)

        def add_table(headers: list[str], rows: list[list[Any]]) -> None:
            t = document.add_table(rows=1, cols=len(headers))
            t.style = "Light Grid Accent 1"
            for i, h in enumerate(headers):
                cellp = t.rows[0].cells[i]
                cellp.text = str(h)
                for p in cellp.paragraphs:
                    for r in p.runs:
                        r.font.bold = True
            for row in rows:
                cells = t.add_row().cells
                for i, value in enumerate(row):
                    cells[i].text = "" if value is None else str(value)
            document.add_paragraph()

        # Portada
        title = document.add_heading(settings.COMPANY_NAME, level=0)
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub = document.add_paragraph(self._report_title(data))
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in sub.runs:
            run.font.size = Pt(13)
            run.font.bold = True
        meta = document.add_paragraph(
            f"Periodo: {self._fmt_dt(data['period']['from'])} → {self._fmt_dt(data['period']['to'])}\n"
            f"Generado: {self._fmt_dt(data['generated_at'])} · SOC-Lite v{settings.APP_VERSION}\n"
            f"Clasificación: Uso interno — Información de seguridad"
        )
        meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
        document.add_page_break()

        summary = data["summary"]
        heading("1. Resumen ejecutivo")
        document.add_paragraph(
            f"En el periodo analizado se procesaron {summary['alerts_total']:,} alertas de seguridad, de las cuales "
            f"{summary['automation_rate'] * 100:.1f}% fueron triadas automáticamente por el motor de razonamiento LLM. "
            f"El tiempo medio de triaje (MTTT) fue de {self._fmt_secs(summary['mttt_seconds']['avg'])} "
            f"(mediana {self._fmt_secs(summary['mttt_seconds']['median'])}, P95 {self._fmt_secs(summary['mttt_seconds']['p95'])}), "
            f"con una tasa de falsos positivos de {self._fmt_pct(summary['false_positive_rate'])}. "
            f"Se registraron {summary['incidents_open']} incidentes abiertos, {summary['incidents_critical']} de ellos críticos. "
            f"El porcentaje de reducción de ruido operativo (alertas descartadas sin intervención humana) alcanzó "
            f"{self._fmt_pct(summary['noise_reduction'])}."
        )

        heading("2. Indicadores clave", 2)
        add_table(
            ["Indicador", "Valor", "Objetivo", "Cumple"],
            [
                ["Alertas procesadas", f"{summary['alerts_total']:,}", "—", "—"],
                ["MTTT promedio", self._fmt_secs(summary["mttt_seconds"]["avg"]), "≤ 15 min (críticas)", "sí" if summary["mttt_seconds"]["avg"] <= 900 else "no"],
                ["Tasa de falsos positivos", self._fmt_pct(summary["false_positive_rate"]), "≤ 30%", "sí" if summary["false_positive_rate"] <= 0.30 else "no"],
                ["Automatización del triaje", self._fmt_pct(summary["automation_rate"]), "≥ 85%", "sí" if summary["automation_rate"] >= 0.85 else "no"],
                ["Reducción de ruido", self._fmt_pct(summary["noise_reduction"]), "≥ 70%", "sí" if summary["noise_reduction"] >= 0.70 else "no"],
                ["Incidentes abiertos", str(summary["incidents_open"]), "—", "—"],
                ["SLA vencido sin cerrar", str(summary["sla_breached"]), "0", "sí" if summary["sla_breached"] == 0 else "no"],
            ],
        )

        heading("3. Distribución por severidad", 2)
        add_table(
            ["Severidad", "Alertas", "% del total"],
            [[k.capitalize(), f"{v:,}", self._fmt_pct(v / summary["alerts_total"] if summary["alerts_total"] else 0)]
             for k, v in summary["by_severity"].items()],
        )

        heading("4. Cumplimiento de SLA", 2)
        add_table(
            ["Severidad", "Objetivo", "Cumplidas", "Incumplidas", "Cumplimiento"],
            [[s["severity"].capitalize(), f"{s['target_minutes']} min", s["compliant"], s["breached"], self._fmt_pct(s["compliance_rate"])] for s in data["sla"]],
        )

        heading("5. Top orígenes de alertas", 2)
        add_table(["IP origen", "Alertas"], [[r["key"], f"{r['count']:,}"] for r in data["top"]["source_ips"][:10]])
        add_table(["Activo", "Alertas"], [[r["key"], f"{r['count']:,}"] for r in data["top"]["agents"][:10]])
        add_table(["Regla", "Alertas", "% FP"],
                  [[r["key"], f"{r['count']:,}", self._fmt_pct(r["extra"].get("fp_pct"))] for r in data["fp"]["by_rule"][:12]])

        heading("6. Incidentes del periodo", 2)
        if data["incidents"]:
            add_table(
                ["Código", "Título", "Severidad", "Prioridad", "Estado", "MTTR"],
                [[i.incident_code, (i.title or "")[:80], i.severity.value if hasattr(i.severity, "value") else i.severity,
                  i.priority.value if hasattr(i.priority, "value") else i.priority,
                  i.status.value if hasattr(i.status, "value") else i.status, self._fmt_secs(i.mttr_seconds)]
                 for i in data["incidents"][:30]],
            )
        else:
            document.add_paragraph("No se registraron incidentes en el periodo.")

        if data["report_type"] in ("management", "audit"):
            heading("7. Cumplimiento normativo (ISO/IEC 27001:2022 · NIST CSF 2.0)", 2)
            add_table(["Control implementado", "ISO 27001:2022", "NIST CSF 2.0"], [list(c) for c in CONTROL_MAPPING])

        heading("8. Carga del equipo", 2)
        add_table(
            ["Analista", "Usuario", "Abiertas", "Escaladas", "Cerradas", "MTTT promedio"],
            [[w["full_name"], w["username"], w["open_alerts"], w["escalated"], w["closed"], self._fmt_secs(w["avg_mttt_seconds"])] for w in data["workload"]],
        )

        if data["report_type"] == "audit":
            heading("9. Bitácora de auditoría (extracto)", 2)
            document.add_paragraph(
                f"Se registraron {len(data['audit_rows']):,} eventos. Cada registro incluye usuario, fecha, hora, "
                "módulo, acción y resultado, y se encuentra encadenado mediante hash sha256 para garantizar su integridad."
            )
            add_table(
                ["Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad", "Detalle"],
                [[self._fmt_dt(r.occurred_at), r.username or "—", r.module,
                  r.action.value if hasattr(r.action, "value") else r.action,
                  r.result.value if hasattr(r.result, "value") else r.result,
                  (r.entity or "—") + (f"#{r.entity_id}" if r.entity_id else ""), (r.detail or "")[:60]]
                 for r in data["audit_rows"][:300]],
            )

        footer = document.add_paragraph(
            f"Generado automáticamente por SOC-Lite v{settings.APP_VERSION} · "
            f"{self._fmt_dt(data['generated_at'])} · Documento de uso interno."
        )
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in footer.runs:
            run.font.size = Pt(8)
            run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)

        buffer = io.BytesIO()
        document.save(buffer)
        return buffer.getvalue()

    # ==================================================================
    # XLSX (openpyxl)
    # ==================================================================
    def _build_xlsx(self, data: dict[str, Any]) -> bytes:
        wb = Workbook()
        header_fill = PatternFill("solid", fgColor="0F172A")
        header_font = Font(color="FFFFFF", bold=True, size=11)
        thin = Side(style="thin", color="CBD5E1")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        title_font = Font(bold=True, size=14, color="0F172A")

        def style_sheet(ws, headers: list[str], widths: list[int]) -> None:
            for idx, (h, w) in enumerate(zip(headers, widths), start=1):
                cell = ws.cell(row=1, column=idx, value=h)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                cell.border = border
                ws.column_dimensions[get_column_letter(idx)].width = w
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{ws.max_row}"

        summary = data["summary"]

        # --- Hoja Resumen ---
        ws = wb.active
        ws.title = "Resumen"
        ws["A1"] = self._report_title(data)
        ws["A1"].font = title_font
        ws["A2"] = f"Periodo: {self._fmt_dt(data['period']['from'])} → {self._fmt_dt(data['period']['to'])}"
        ws["A3"] = f"Generado: {self._fmt_dt(data['generated_at'])} · SOC-Lite v{settings.APP_VERSION}"
        rows = [
            ("Alertas totales", summary["alerts_total"]),
            ("Alertas pendientes", summary["alerts_pending"]),
            ("Alertas abiertas", summary["alerts_open"]),
            ("MTTT promedio (s)", summary["mttt_seconds"]["avg"]),
            ("MTTT mediana (s)", summary["mttt_seconds"]["median"]),
            ("MTTT P95 (s)", summary["mttt_seconds"]["p95"]),
            ("MTTR promedio (s)", summary["mttr_seconds"]["avg"]),
            ("Tasa de falsos positivos", summary["false_positive_rate"]),
            ("Tasa de automatización", summary["automation_rate"]),
            ("Reducción de ruido", summary["noise_reduction"]),
            ("Incidentes abiertos", summary["incidents_open"]),
            ("Incidentes críticos abiertos", summary["incidents_critical"]),
            ("SLA vencido sin cerrar", summary["sla_breached"]),
            ("Alertas hoy", summary["alerts_today"]),
            ("Variación vs periodo anterior (%)", summary["trend_pct"]),
        ]
        ws["A5"] = "Indicador"
        ws["B5"] = "Valor"
        for c in ("A5", "B5"):
            ws[c].fill = header_fill
            ws[c].font = header_font
        for i, (k, v) in enumerate(rows, start=6):
            ws.cell(row=i, column=1, value=k).border = border
            cell = ws.cell(row=i, column=2, value=v)
            cell.border = border
            if isinstance(v, float) and k.startswith(("Tasa", "Reducción")):
                cell.number_format = "0.0%"
        ws.column_dimensions["A"].width = 36
        ws.column_dimensions["B"].width = 20

        # --- Hoja Severidad + gráfico ---
        ws2 = wb.create_sheet("Severidad")
        ws2.append(["Severidad", "Alertas"])
        for k, v in summary["by_severity"].items():
            ws2.append([k, v])
        style_sheet(ws2, ["Severidad", "Alertas"], [18, 14])
        chart = BarChart()
        chart.title = "Alertas por severidad"
        chart.y_axis.title = "Alertas"
        chart.add_data(Reference(ws2, min_col=2, min_row=1, max_row=ws2.max_row), titles_from_data=True)
        chart.set_categories(Reference(ws2, min_col=1, min_row=2, max_row=ws2.max_row))
        ws2.add_chart(chart, "D2")

        # --- Hoja MTTT diario ---
        ws3 = wb.create_sheet("MTTT_diario")
        ws3.append(["Fecha", "MTTT promedio (s)", "MTTT P95 (s)", "Objetivo (s)", "Alertas"])
        for p in data["trend"]:
            ws3.append([p["period"][:10], p["mttt_avg"], p["mttt_p95"], p["target_seconds"], p["alerts"]])
        style_sheet(ws3, ["Fecha", "MTTT promedio (s)", "MTTT P95 (s)", "Objetivo (s)", "Alertas"], [14, 18, 16, 14, 12])
        if ws3.max_row > 1:
            line = LineChart()
            line.title = "Evolución del MTTT vs objetivo SLA"
            line.add_data(Reference(ws3, min_col=2, max_col=4, min_row=1, max_row=ws3.max_row), titles_from_data=True)
            line.set_categories(Reference(ws3, min_col=1, min_row=2, max_row=ws3.max_row))
            ws3.add_chart(line, "G2")

        # --- Hoja Top orígenes ---
        ws4 = wb.create_sheet("Top_origenes")
        ws4.append(["Tipo", "Origen", "Alertas", "Riesgo medio"])
        for kind, label in (("source_ips", "IP origen"), ("agents", "Activo"), ("rules", "Regla"), ("mitre", "Técnica MITRE")):
            for r in data["top"][kind]:
                ws4.append([label, r["key"], r["count"], r["extra"].get("avg_risk")])
        style_sheet(ws4, ["Tipo", "Origen", "Alertas", "Riesgo medio"], [16, 34, 12, 14])

        # --- Hoja Precisión del triaje ---
        ws5 = wb.create_sheet("Triaje")
        ws5.append(["Regla", "Triajes", "Falsos positivos", "% FP"])
        for r in data["fp"]["by_rule"]:
            ws5.append([r["key"], r["count"], r["extra"].get("fp", 0), r["extra"].get("fp_pct")])
        ws5.append([])
        ws5.append(["Modelo", "Triajes", "Confianza media"])
        for r in data["fp"]["by_model"]:
            ws5.append([r["key"], r["count"], r["extra"].get("avg_confidence")])
        style_sheet(ws5, ["Regla", "Triajes", "Falsos positivos", "% FP"], [18, 12, 18, 12])
        for row in ws5.iter_rows(min_row=2):
            for cell in row:
                if isinstance(cell.value, float) and cell.value is not None and cell.column == 4:
                    cell.number_format = "0.0%"

        # --- Hoja Incidentes ---
        ws6 = wb.create_sheet("Incidentes")
        ws6.append(["Código", "Título", "Severidad", "Prioridad", "Estado", "Categoría", "Detectado", "Resuelto", "MTTR (s)", "Responsable"])
        for i in data["incidents"]:
            ws6.append([
                i.incident_code, i.title,
                i.severity.value if hasattr(i.severity, "value") else i.severity,
                i.priority.value if hasattr(i.priority, "value") else i.priority,
                i.status.value if hasattr(i.status, "value") else i.status,
                i.category, self._fmt_dt(i.detected_at), self._fmt_dt(i.resolved_at), i.mttr_seconds, i.owner_id,
            ])
        style_sheet(ws6, ["Código", "Título", "Severidad", "Prioridad", "Estado", "Categoría", "Detectado", "Resuelto", "MTTR (s)", "Responsable"],
                    [14, 50, 12, 12, 14, 14, 22, 22, 12, 12])

        # --- Hoja SLA ---
        ws7 = wb.create_sheet("SLA")
        ws7.append(["Severidad", "Objetivo (min)", "Cumplidas", "Incumplidas", "Cumplimiento"])
        for s in data["sla"]:
            ws7.append([s["severity"], s["target_minutes"], s["compliant"], s["breached"], s["compliance_rate"]])
        style_sheet(ws7, ["Severidad", "Objetivo (min)", "Cumplidas", "Incumplidas", "Cumplimiento"], [16, 16, 14, 14, 16])
        for row in ws7.iter_rows(min_row=2, min_col=5, max_col=5):
            for cell in row:
                cell.number_format = "0.0%"

        # --- Hoja Carga del equipo ---
        ws8 = wb.create_sheet("Equipo")
        ws8.append(["Analista", "Usuario", "Abiertas", "Escaladas", "Cerradas", "MTTT promedio (s)"])
        for w in data["workload"]:
            ws8.append([w["full_name"], w["username"], w["open_alerts"], w["escalated"], w["closed"], w["avg_mttt_seconds"]])
        style_sheet(ws8, ["Analista", "Usuario", "Abiertas", "Escaladas", "Cerradas", "MTTT promedio (s)"], [28, 16, 12, 12, 12, 20])

        # --- Hoja Bitácora (solo reporte de auditoría) ---
        if data["report_type"] == "audit":
            ws9 = wb.create_sheet("Bitacora")
            ws9.append(["ID", "Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad", "ID entidad", "IP", "Detalle", "Hash"])
            for r in data["audit_rows"]:
                ws9.append([
                    r.id, self._fmt_dt(r.occurred_at), r.username, r.module,
                    r.action.value if hasattr(r.action, "value") else r.action,
                    r.result.value if hasattr(r.result, "value") else r.result,
                    r.entity, r.entity_id, r.ip_address, r.detail, r.hash_self,
                ])
            style_sheet(ws9, ["ID", "Fecha y hora", "Usuario", "Módulo", "Acción", "Resultado", "Entidad", "ID entidad", "IP", "Detalle", "Hash"],
                        [10, 22, 16, 14, 16, 12, 14, 14, 16, 60, 68])

            ws10 = wb.create_sheet("Auditoria_resumen")
            ws10.append(["Módulo", "Acción", "Eventos"])
            for module, action, n in data["audit_summary"]:
                ws10.append([module, action.value if hasattr(action, "value") else str(action), n])
            style_sheet(ws10, ["Módulo", "Acción", "Eventos"], [20, 20, 14])

        # --- Hoja Cumplimiento ---
        ws11 = wb.create_sheet("Cumplimiento")
        ws11.append(["Control implementado", "ISO/IEC 27001:2022", "NIST CSF 2.0"])
        for c in CONTROL_MAPPING:
            ws11.append(list(c))
        style_sheet(ws11, ["Control implementado", "ISO/IEC 27001:2022", "NIST CSF 2.0"], [62, 28, 28])

        buffer = io.BytesIO()
        wb.save(buffer)
        return buffer.getvalue()

    # ==================================================================
    # Orquestación
    # ==================================================================
    async def generate(
        self,
        report_type: str,
        report_format: ReportFormat,
        date_from: datetime,
        date_to: datetime,
        user: Any = None,
        parameters: dict[str, Any] | None = None,
    ) -> GeneratedReport:
        data = await self._collect(report_type, date_from, date_to)
        title = self._report_title(data)

        if report_format == ReportFormat.PDF:
            content = self._build_pdf(data)
            media_ext = "pdf"
        elif report_format == ReportFormat.DOCX:
            content = self._build_docx(data)
            media_ext = "docx"
        elif report_format == ReportFormat.XLSX:
            content = self._build_xlsx(data)
            media_ext = "xlsx"
        else:  # CSV: sólo la tabla de alertas del periodo
            import csv

            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(["ID", "Regla", "Descripción", "Severidad", "Estado", "Riesgo", "Veredicto", "IP origen", "Activo", "Ocurrencia", "MTTT (s)"])
            for a in data["critical_alerts"]:
                writer.writerow([a.id, a.rule_id, a.rule_description, a.severity.value if hasattr(a.severity, "value") else a.severity,
                                 a.status.value if hasattr(a.status, "value") else a.status, a.risk_score,
                                 a.verdict.value if hasattr(a.verdict, "value") else a.verdict, a.source_ip, a.agent_name,
                                 self._fmt_dt(a.occurred_at), a.mttt_seconds])
            content = buf.getvalue().encode("utf-8-sig")
            media_ext = "csv"

        # Persistencia del artefacto
        directory = Path(settings.REPORTS_DIR) / report_type / datetime.now(timezone.utc).strftime("%Y/%m")
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"{report_type}_{date_from:%Y%m%d}_{date_to:%Y%m%d}_{datetime.now(timezone.utc):%H%M%S}.{media_ext}"
        filepath = directory / filename
        filepath.write_bytes(content)

        record = GeneratedReport(
            report_type=report_type,
            report_format=report_format,
            title=title,
            period_from=date_from,
            period_to=date_to,
            file_path=str(filepath),
            file_size=len(content),
            checksum_sha256=hashlib.sha256(content).hexdigest(),
            parameters=parameters or {},
            requested_by=getattr(user, "id", None),
            status="completed",
        )
        self.db.add(record)
        await self.db.flush()
        logger.info("Reporte generado", extra={"type": report_type, "format": media_ext, "path": str(filepath)})
        return record
