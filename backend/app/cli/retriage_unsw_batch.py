"""Reintenta en serie los triajes de contingencia de la última muestra UNSW-NB15."""
from __future__ import annotations

import argparse
import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db.session import AsyncSessionLocal, engine
from app.models import Alert, TriageResult
from app.models.enums import AuditAction, AuditResult
from app.services.audit_service import AuditService
from app.services.triage_service import TriageService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("soclite.unsw_retry")


async def run(limit: int) -> int:
    async with AsyncSessionLocal() as session:
        alert_ids = list(
            (
                await session.execute(
                    select(Alert.id)
                    .where(Alert.source_name == "UNSW-NB15 public dataset")
                    .order_by(Alert.id.desc())
                    .limit(limit)
                )
            ).scalars()
        )
    alert_ids.reverse()

    if not alert_ids:
        logger.info("No se encontraron alertas UNSW-NB15.")
        return 0

    retried = 0
    for alert_id in alert_ids:
        async with AsyncSessionLocal() as session:
            try:
                alert = (
                    await session.execute(
                        select(Alert)
                        .options(selectinload(Alert.asset), selectinload(Alert.triages))
                        .where(Alert.id == alert_id)
                    )
                ).scalar_one_or_none()
                if alert is None or alert.current_triage is None:
                    logger.info("Alerta #%s: sin resultado actual; omitida.", alert_id)
                    continue
                if alert.current_triage.model_name != "heuristic-fallback":
                    logger.info(
                        "Alerta #%s: ya procesada por %s; omitida.",
                        alert_id,
                        alert.current_triage.model_name,
                    )
                    continue

                logger.info("Reintentando alerta #%s de forma secuencial...", alert_id)
                result = await TriageService(session).run(alert, force=True)
                degraded = bool(result.get("degraded"))
                current_result = (
                    await session.execute(
                        select(TriageResult).where(
                            TriageResult.alert_id == alert_id,
                            TriageResult.is_current.is_(True),
                        )
                    )
                ).scalar_one()
                model_name = current_result.model_name
                await AuditService(session).log(
                    module="triage",
                    action=AuditAction.TRIAGE_RUN,
                    username="system/unsw-batch-retry",
                    entity="alert",
                    entity_id=alert_id,
                    result=AuditResult.FAILURE if degraded else AuditResult.SUCCESS,
                    detail=(
                        f"Reintento secuencial UNSW-NB15: modelo={model_name} "
                        f"veredicto={result['verdict'].value} latencia_ms={result.get('latency_ms')}"
                    ),
                    after={
                        "model": model_name,
                        "verdict": result["verdict"].value,
                        "latency_ms": result.get("latency_ms"),
                        "degraded": degraded,
                    },
                    severity="warning" if degraded else "info",
                    commit=False,
                )
                await session.commit()
                retried += 1
                logger.info(
                    "Alerta #%s: modelo=%s veredicto=%s latencia=%ss degradado=%s",
                    alert_id,
                    model_name,
                    result["verdict"].value,
                    round((result.get("latency_ms") or 0) / 1000, 1),
                    degraded,
                )
                if degraded:
                    logger.error(
                        "El modelo volvió a agotar el tiempo en #%s; se detiene el lote para no desperdiciar más ejecuciones.",
                        alert_id,
                    )
                    break
            except Exception:
                await session.rollback()
                logger.exception("Error al reintentar alerta #%s; se continúa con la siguiente.", alert_id)

    logger.info("Proceso terminado. Alertas procesadas secuencialmente: %s.", retried)
    return 0


async def async_main(limit: int) -> int:
    try:
        return await run(limit)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10, help="Revisar las primeras N alertas UNSW-NB15 por ID.")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit debe ser al menos 1")
    raise SystemExit(asyncio.run(async_main(args.limit)))


if __name__ == "__main__":
    main()
