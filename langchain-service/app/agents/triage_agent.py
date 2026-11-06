"""SOC-Lite · Agente de triaje (LangChain + LangGraph).

Diseño:
  * **LLM local (Ollama)** por defecto → las alertas no salen de la infraestructura.
  * **Agente ReAct con herramientas** (`create_react_agent` de LangGraph) → el modelo
    decide qué consultar (AbuseIPDB, VirusTotal, GeoIP, contexto histórico, memoria
    de falsos positivos, MITRE).
  * **Salida estructurada forzada** (`response_format=TriageOutput`) → el backend
    recibe siempre un objeto validado, nunca texto libre.
  * **Memoria de incidentes** vía `search_known_false_positives` + resumen histórico
    inyectado en el prompt.
  * **Degradación controlada**: si el LLM no responde, se devuelve un triaje
    heurístico marcado como `degraded=True` (operación 24/7 sin punto único de fallo).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from app.chains.prompts import PROMPT_VERSION, TRIAGE_PROMPT
from app.core.config import settings
from app.schemas import (
    Indicator,
    RecommendedAction,
    TriageOutput,
    TriageRequest,
    TriageResponse,
)
from app.tools.threat_intel import get_tools

logger = logging.getLogger("soclite.agent")


# ======================================================================
# Construcción del LLM
# ======================================================================
def build_llm():
    """Crea el modelo de lenguaje según la política configurada."""
    if settings.LLM_PROVIDER == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(
            base_url=settings.OLLAMA_BASE_URL,
            model=settings.OLLAMA_MODEL,
            temperature=settings.OLLAMA_TEMPERATURE,
            num_ctx=settings.OLLAMA_NUM_CTX,
            format="json",  # fuerza salida JSON en el propio servidor de inferencia
        )
    if settings.LLM_PROVIDER == "openai":
        if not settings.ALLOW_EXTERNAL_LLM:
            raise RuntimeError(
                "LLM_PROVIDER=openai requiere ALLOW_EXTERNAL_LLM=true. "
                "Los datos de las alertas saldrían de la organización: revise la política de datos antes de habilitarlo."
            )
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=settings.OPENAI_MODEL,
            temperature=settings.OPENAI_TEMPERATURE,
            api_key=settings.OPENAI_API_KEY,
        )
    raise RuntimeError(f"Proveedor LLM no soportado: {settings.LLM_PROVIDER}")


# ======================================================================
# Prompt efectivo
# ======================================================================
def build_prompt_values(request: TriageRequest) -> dict[str, Any]:
    alert = request.alert
    ctx = request.context
    return {
        "alert_id": request.alert_id,
        "source_type": "SIEM",
        "source_name": "Wazuh/OPNsense",
        "rule_id": alert.rule_id or "N/D",
        "rule_description": alert.rule_description or "Sin descripción",
        "rule_level": alert.rule_level if alert.rule_level is not None else "N/D",
        "rule_groups": ", ".join(alert.rule_groups) or "N/D",
        "severity_siem": alert.severity_siem,
        "mitre_technique": alert.mitre_technique or "N/D",
        "occurred_at": alert.occurred_at or "N/D",
        "dedup_count": alert.dedup_count,
        "source_ip": alert.source_ip or "N/D",
        "dest_ip": alert.dest_ip or "N/D",
        "agent_name": alert.agent_name or ctx.asset_hostname or "N/D",
        "full_log": (alert.full_log or "Sin log disponible")[:4000],
        "dataset_classifier_evidence": "No aplica: esta alerta no pertenece al protocolo UNSW-NB15.",
        "recent_alerts_same_source": ctx.recent_alerts_same_source,
        "asset_criticality": ctx.asset_criticality,
        "asset_internet_facing": ctx.asset_internet_facing,
        "known_false_positives": ctx.known_false_positives,
        "is_working_hours": ctx.is_working_hours,
        "allow_external_llm": ctx.policy.get("allow_external_llm", settings.ALLOW_EXTERNAL_LLM),
    }


def predict_dataset_flow(request: TriageRequest) -> dict[str, Any] | None:
    """Classify an UNSW sample when its locally trained artifact is installed."""
    try:
        payload = json.loads(request.alert.full_log or "{}")
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("dataset") != "UNSW-NB15":
        return None
    features = payload.get("features")
    if not isinstance(features, dict):
        return None
    try:
        from app.ml.unsw_classifier import predict_unsw_flow

        return predict_unsw_flow(features)
    except Exception as exc:
        logger.warning("Clasificador UNSW-NB15 no disponible; se mantiene triaje LLM: %s", exc)
        return None


# ======================================================================
# Extracción robusta de JSON (los modelos locales a veces añaden preámbulo)
# ======================================================================
def extract_json(text: str) -> dict[str, Any]:
    if not text:
        raise ValueError("Respuesta vacía del modelo")
    cleaned = text.strip()
    # Quitar fences de Markdown
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.MULTILINE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    # Buscar el primer objeto JSON balanceado
    start = cleaned.find("{")
    if start == -1:
        raise ValueError("No se encontró un objeto JSON en la respuesta del modelo")
    depth = 0
    for idx, char in enumerate(cleaned[start:], start=start):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start : idx + 1])
    raise ValueError("JSON incompleto en la respuesta del modelo")


def normalize_output_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Coerce common Ollama phrasing into the strict SOC-Lite response contract."""
    normalized = dict(payload)
    reasoning = normalized.get("reasoning")
    reasoning_items = list(reasoning) if isinstance(reasoning, list) else []

    # A network service/protocol is useful context, but it is not an IOC type.
    raw_indicators = normalized.get("indicators", [])
    raw_indicators = raw_indicators if isinstance(raw_indicators, list) else []
    allowed_indicator_types = {"ip", "domain", "url", "hash", "email", "cve"}
    valid_indicators: list[dict[str, Any]] = []
    for indicator in raw_indicators:
        if not isinstance(indicator, dict):
            continue
        indicator_type = str(indicator.get("type", "")).strip().lower()
        if indicator_type in allowed_indicator_types:
            value = str(indicator.get("value", "")).strip().lower()
            if value in {"n/d", "nd", "n/a", "unknown", "none", "null", ""}:
                continue
            valid_indicators.append(indicator)
            continue
        value = str(indicator.get("value", "")).strip()
        if value:
            reasoning_items.append(
                f"Servicio/protocolo observado (no es un IOC): {value} ({indicator_type or 'tipo no especificado'})."
            )
    normalized["indicators"] = valid_indicators

    # Keep the SLA enum stable while retaining the model's continuous-monitoring note.
    sla = str(normalized.get("sla_recommendation", "8h")).strip().lower()
    if sla in {"continuamente", "continua", "continuous", "continuously", "ongoing"}:
        normalized["sla_recommendation"] = "24h"
        reasoning_items.append(
            "La recomendación de supervisión continua se normalizó al SLA permitido de 24h."
        )
    elif sla not in {"inmediata", "1h", "8h", "24h"}:
        normalized["sla_recommendation"] = "8h"
        reasoning_items.append(f"SLA no reconocido ({sla}); se aplicó el valor permitido de 8h.")

    normalized["reasoning"] = reasoning_items
    return normalized


# ======================================================================
# Agente
# ======================================================================
class TriageAgent:
    """Agente de triaje con herramientas, memoria y salida estructurada."""

    def __init__(self) -> None:
        self._agent = None
        self._llm = None
        self._tools = get_tools()

    def _ensure_agent(self):
        if self._agent is not None:
            return self._agent

        self._llm = build_llm()
        try:
            from langgraph.prebuilt import create_react_agent

            self._agent = create_react_agent(
                model=self._llm,
                tools=self._tools,
                prompt=TRIAGE_PROMPT.messages[0].prompt.template if hasattr(TRIAGE_PROMPT.messages[0], "prompt") else None,
                response_format=TriageOutput,
            )
            logger.info("Agente LangGraph inicializado con %d herramientas", len(self._tools))
        except Exception as exc:  # pragma: no cover - compatibilidad de versiones
            logger.warning("No se pudo crear el agente LangGraph (%s); se usará la cadena simple", exc)
            self._agent = "simple"
        return self._agent

    async def triage(self, request: TriageRequest) -> TriageResponse:
        started = time.perf_counter()
        tools_used: list[str] = []
        tokens_in = tokens_out = 0
        dataset_prediction: dict[str, Any] | None = None

        try:
            dataset_prediction = predict_dataset_flow(request)
            agent = self._ensure_agent()
            prompt_values = build_prompt_values(request)
            if dataset_prediction:
                prompt_values["dataset_classifier_evidence"] = (
                    f"Modelo: {dataset_prediction['model_name']}; clase predicha: "
                    f"{dataset_prediction['predicted_class']}; probabilidad de ataque: "
                    f"{dataset_prediction['attack_probability']:.4f}. Esta salida procede de un "
                    "clasificador entrenado solo con UNSW_NB15_training-set.csv; no se expuso "
                    "la etiqueta real de esta fila. Usa este resultado como señal cuantitativa, "
                    "sin afirmar que equivale a confirmación humana."
                )
            messages = TRIAGE_PROMPT.format_messages(**prompt_values)

            if dataset_prediction or agent == "simple":
                raw = await asyncio.wait_for(
                    self._llm.ainvoke(messages), timeout=settings.AGENT_TIMEOUT_SECONDS
                )
                payload = normalize_output_payload(extract_json(getattr(raw, "content", str(raw))))
                output = TriageOutput.model_validate(payload)
                usage = getattr(raw, "usage_metadata", {}) or {}
                tokens_in = usage.get("input_tokens", 0)
                tokens_out = usage.get("output_tokens", 0)
                tools_used = []
            else:
                # El agente ReAct ejecuta el bucle razonamiento → herramienta → observación
                state = await asyncio.wait_for(
                    agent.ainvoke(
                        {"messages": messages},
                        config={
                            "recursion_limit": settings.MAX_AGENT_ITERATIONS * 2,
                            "configurable": {"thread_id": request.trace_id},
                        },
                    ),
                    timeout=settings.AGENT_TIMEOUT_SECONDS,
                )
                structured = state.get("structured_response")
                if structured is not None:
                    output = structured if isinstance(structured, TriageOutput) else TriageOutput.model_validate(structured)
                else:
                    last = state["messages"][-1]
                    payload = normalize_output_payload(extract_json(getattr(last, "content", str(last))))
                    output = TriageOutput.model_validate(payload)

                # Trazas de uso: qué herramientas se invocaron realmente
                for message in state.get("messages", []):
                    for call in getattr(message, "tool_calls", None) or []:
                        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
                        if name and name not in tools_used:
                            tools_used.append(name)
                    usage = getattr(message, "usage_metadata", None)
                    if usage:
                        tokens_in += usage.get("input_tokens", 0)
                        tokens_out += usage.get("output_tokens", 0)

                if not isinstance(output, TriageOutput):
                    output = TriageOutput.model_validate(output)

            latency = int((time.perf_counter() - started) * 1000)
            # Ajuste de coherencia: veredicto benigno/FP no puede tener riesgo crítico
            output = self._post_process(output, request)
            if dataset_prediction:
                output = self._apply_dataset_prediction(output, dataset_prediction)

            return TriageResponse(
                **output.model_dump(),
                trace_id=request.trace_id,
                model=(
                    f"UNSW-RF-v2+{settings.OLLAMA_MODEL if settings.LLM_PROVIDER == 'ollama' else settings.OPENAI_MODEL}"
                    if dataset_prediction
                    else settings.OLLAMA_MODEL if settings.LLM_PROVIDER == "ollama" else settings.OPENAI_MODEL
                ),
                provider="hybrid" if dataset_prediction else settings.LLM_PROVIDER,
                prompt_version="triage_v5_unsw_rf_v2" if dataset_prediction else PROMPT_VERSION,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                latency_ms=latency,
                tools_used=tools_used,
                degraded=False,
            )

        except Exception as exc:
            logger.exception("Fallo del agente de triaje para la alerta %s: %s", request.alert_id, exc)
            latency = int((time.perf_counter() - started) * 1000)
            fallback = self._heuristic(request, str(exc), latency)
            if dataset_prediction:
                self._apply_dataset_prediction(fallback, dataset_prediction)
                fallback.model = "UNSW-RF-v2+heuristic-fallback"
                fallback.provider = "hybrid"
                fallback.prompt_version = "triage_v5_unsw_rf_v2"
            return fallback

    # ------------------------------------------------------------------
    # Coherencia post-LLM (guardarraíles deterministas sobre la salida del modelo)
    # ------------------------------------------------------------------
    @staticmethod
    def _post_process(output: TriageOutput, request: TriageRequest) -> TriageOutput:
        if output.verdict in ("false_positive", "benign"):
            output.risk_score = min(output.risk_score, 40)
            if output.verdict == "false_positive":
                output.severity = "info" if output.severity in ("critical", "high") else output.severity
        if output.verdict == "true_positive" and output.risk_score < 50:
            output.risk_score = 50
        if request.context.asset_criticality == "critical" and output.verdict == "true_positive":
            output.risk_score = max(output.risk_score, 75)
        # Deduplicación alta = probable ruido repetitivo: penaliza ligeramente la confianza
        if request.alert.dedup_count and request.alert.dedup_count > 20:
            output.confidence = round(output.confidence * 0.9, 3)
        if not output.recommended_actions:
            output.recommended_actions = [
                RecommendedAction(order=1, action="Validar manualmente la alerta en el SIEM", priority="p3")
            ]
        return output

    @staticmethod
    def _apply_dataset_prediction(output: TriageOutput, prediction: dict[str, Any]) -> TriageOutput:
        """Use the supervised classifier for the dataset verdict; retain LLM explanation/actions."""
        label = int(prediction["predicted_label"])
        probability = float(prediction["attack_probability"])
        predicted_class = "attack" if label == 1 else "normal"
        output.verdict = "suspicious" if label == 1 else "benign"
        output.risk_score = int(round(probability * 100)) if label == 1 else min(40, int(round(probability * 100)))
        output.confidence = round(max(probability, 1.0 - probability), 3)
        if label == 0:
            output.severity = "info" if probability < 0.15 else "low"
        else:
            output.severity = "critical" if probability >= 0.95 else "high" if probability >= 0.80 else "medium"
        output.reasoning.insert(
            0,
            f"UNSW-NB15 Random Forest predijo {predicted_class} con probabilidad de ataque {probability:.3f}; la etiqueta real no se usó como entrada.",
        )
        output.summary = (
            f"Clasificador supervisado: predicción {predicted_class} "
            f"(probabilidad de ataque {probability:.1%}). Análisis contextual del agente: {output.summary}"
        )
        return output

    # ------------------------------------------------------------------
    # Contingencia heurística (sin LLM)
    # ------------------------------------------------------------------
    @staticmethod
    def _heuristic(request: TriageRequest, error: str, latency: int) -> TriageResponse:
        alert = request.alert
        level = alert.rule_level or 0
        crit = request.context.asset_criticality
        verdict = "true_positive" if level >= 9 else ("suspicious" if level >= 6 else "inconclusive")
        base = {"critical": 100, "high": 80, "medium": 55, "low": 30, "info": 10}.get(alert.severity_siem, 50)
        crit_w = {"critical": 100, "high": 75, "medium": 50, "low": 25}.get(crit, 50)
        risk = int(min(100, round(base * 0.5 + min(100, level / 15 * 100) * 0.2 + crit_w * 0.3)))
        severity = alert.severity_siem

        return TriageResponse(
            trace_id=request.trace_id,
            verdict=verdict,
            severity=severity,
            risk_score=risk,
            confidence=0.35,
            summary=(
                f"Triaje heurístico de contingencia (motor LLM no disponible: {error[:180]}). "
                f"Regla {alert.rule_id} de nivel {level} sobre el activo {alert.agent_name or 'desconocido'} "
                f"(criticidad {crit}). Requiere validación manual de un analista."
            ),
            reasoning=[
                "El motor LLM no respondió: se aplicó el motor de reglas de contingencia",
                f"Nivel de regla del SIEM: {level}",
                f"Criticidad del activo afectado: {crit}",
                f"Alertas previas del mismo origen en 24 h: {request.context.recent_alerts_same_source}",
                "La confianza se reduce deliberadamente por ausencia de enriquecimiento externo",
            ],
            recommended_actions=[
                RecommendedAction(order=1, action="Revisión manual inmediata de la alerta por un analista SOC", priority="p2"),
                RecommendedAction(order=2, action="Verificar reputación de la IP origen en AbuseIPDB y VirusTotal", priority="p3"),
                RecommendedAction(order=3, action="Comprobar conectividad y estado del servicio de triaje", priority="p3"),
            ],
            mitre_techniques=[alert.mitre_technique] if alert.mitre_technique else [],
            indicators=[
                Indicator(type="ip", value=alert.source_ip, verdict="unknown", source="heuristic")
            ] if alert.source_ip else [],
            asset_impact="No evaluado por el motor LLM; revisar manualmente.",
            false_positive_hypothesis="No evaluada por el motor LLM.",
            sla_recommendation="1h" if severity in ("critical", "high") else "8h",
            model="heuristic-fallback",
            provider="internal",
            prompt_version=PROMPT_VERSION,
            latency_ms=latency,
            tools_used=[],
            degraded=True,
            error=error[:500],
        )


# Instancia única (el agente mantiene la conexión con Ollama y el estado del grafo)
_agent_singleton: TriageAgent | None = None


def get_agent() -> TriageAgent:
    global _agent_singleton
    if _agent_singleton is None:
        _agent_singleton = TriageAgent()
    return _agent_singleton
