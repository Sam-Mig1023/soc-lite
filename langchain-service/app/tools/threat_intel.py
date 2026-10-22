"""SOC-Lite · Herramientas (tools) del agente de triaje.

Cada herramienta es una función LangChain (`@tool`) con docstring explícito:
el agente decide cuándo invocarla a partir de la descripción. Todas las
respuestas se cachean en Redis (TTL configurable) para respetar los límites
de cuota de las APIs gratuitas y reducir la latencia del triaje.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from langchain_core.tools import tool
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings

logger = logging.getLogger("soclite.tools")

# ----------------------------------------------------------------------
# Caché (Redis con degradación graciosa a memoria local)
# ----------------------------------------------------------------------
_memory_cache: dict[str, tuple[float, str]] = {}


def _cache_get(key: str) -> str | None:
    import time

    try:
        import redis

        client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)
        value = client.get(key)
        if value:
            return value
    except Exception:  # pragma: no cover
        pass
    entry = _memory_cache.get(key)
    if entry and entry[0] > time.time():
        return entry[1]
    return None


def _cache_set(key: str, value: str, ttl: int | None = None) -> None:
    import time

    ttl = ttl or settings.TI_CACHE_TTL_SECONDS
    try:
        import redis

        client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)
        client.setex(key, ttl, value)
        return
    except Exception:  # pragma: no cover
        pass
    _memory_cache[key] = (time.time() + ttl, value)


def _error(tool_name: str, reason: str) -> str:
    """Devuelve un JSON de error explícito; el prompt exige declararlo y bajar la confianza."""
    return json.dumps(
        {"tool": tool_name, "status": "error", "reason": reason, "data": None}, ensure_ascii=False
    )


def _ok(tool_name: str, data: dict[str, Any], cache_hit: bool = False) -> str:
    return json.dumps(
        {"tool": tool_name, "status": "ok", "cache_hit": cache_hit, "data": data}, ensure_ascii=False
    )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6), reraise=True)
async def _get_json(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=settings.TI_HTTP_TIMEOUT) as client:
        response = await client.get(url, params=params, headers=headers)
        response.raise_for_status()
        return response.json()


# ======================================================================
# 1. AbuseIPDB
# ======================================================================
@tool
async def abuseipdb_lookup(ip: str) -> str:
    """Consulta la reputación de una dirección IP en AbuseIPDB.

    Devuelve el puntaje de confianza de abuso (0-100), el número de reportes,
    el país, el ISP y si la IP es de tipo Tor o abuso conocido.

    Args:
        ip: Dirección IPv4 o IPv6 a consultar (p. ej. "203.0.113.44").
    """
    if not settings.ABUSEIPDB_API_KEY:
        return _error("abuseipdb_lookup", "API key de AbuseIPDB no configurada (ABUSEIPDB_API_KEY)")
    key = f"ti:abuseipdb:{ip}"
    if (cached := _cache_get(key)) is not None:
        return cached
    try:
        payload = await _get_json(
            "https://api.abuseipdb.com/api/v2/check",
            {"ipAddress": ip, "maxAgeInDays": 90, "verbose": "true"},
            {"Key": settings.ABUSEIPDB_API_KEY, "Accept": "application/json"},
        )
        d = payload.get("data", {})
        result = _ok(
            "abuseipdb_lookup",
            {
                "ip": d.get("ipAddress"),
                "abuse_confidence_score": d.get("abuseConfidenceScore"),
                "total_reports": d.get("totalReports"),
                "num_distinct_users": d.get("numDistinctUsers"),
                "last_reported_at": d.get("lastReportedAt"),
                "country_code": d.get("countryCode"),
                "isp": d.get("isp"),
                "domain": d.get("domain"),
                "usage_type": d.get("usageType"),
                "is_tor": d.get("isTor"),
                "is_whitelisted": d.get("isWhitelisted"),
                "verdict": (
                    "malicious" if (d.get("abuseConfidenceScore") or 0) >= 75
                    else "suspicious" if (d.get("abuseConfidenceScore") or 0) >= 25
                    else "clean"
                ),
            },
        )
        _cache_set(key, result)
        return result
    except Exception as exc:
        logger.warning("abuseipdb_lookup falló para %s: %s", ip, exc)
        return _error("abuseipdb_lookup", f"Error consultando AbuseIPDB: {exc}")


# ======================================================================
# 2. VirusTotal
# ======================================================================
@tool
async def virustotal_lookup(indicator: str) -> str:
    """Consulta VirusTotal para una IP, dominio, URL o hash de fichero.

    Devuelve cuántos motores antivirus lo detectan como malicioso, la
    reputación agregada y, si aplica, el nombre del malware detectado.

    Args:
        indicator: IP, dominio, URL o hash (MD5/SHA1/SHA256) a analizar.
    """
    if not settings.VIRUSTOTAL_API_KEY:
        return _error("virustotal_lookup", "API key de VirusTotal no configurada (VIRUSTOTAL_API_KEY)")
    key = f"ti:vt:{indicator}"
    if (cached := _cache_get(key)) is not None:
        return cached

    base = "https://www.virustotal.com/api/v3"
    headers = {"x-apikey": settings.VIRUSTOTAL_API_KEY}
    try:
        if _is_ip(indicator):
            url, params = f"{base}/ip_addresses/{indicator}", {}
        elif _is_hash(indicator):
            url, params = f"{base}/files/{indicator}", {}
        elif indicator.startswith("http"):
            import base64

            url_id = base64.urlsafe_b64encode(indicator.encode()).decode().strip("=")
            url, params = f"{base}/urls/{url_id}", {}
        else:
            url, params = f"{base}/domains/{indicator}", {}

        payload = await _get_json(url, params, headers)
        attrs = payload.get("data", {}).get("attributes", {})
        stats = attrs.get("last_analysis_stats", {})
        malicious = stats.get("malicious", 0)
        suspicious = stats.get("suspicious", 0)
        total = sum(v for v in stats.values() if isinstance(v, int)) or 1

        result = _ok(
            "virustotal_lookup",
            {
                "indicator": indicator,
                "malicious_engines": malicious,
                "suspicious_engines": suspicious,
                "total_engines": total,
                "reputation": attrs.get("reputation"),
                "country": attrs.get("country"),
                "asn": attrs.get("asn"),
                "as_owner": attrs.get("as_owner"),
                "network": attrs.get("network"),
                "threat_names": list(attrs.get("popular_threat_classification", {}).values())[:3]
                if isinstance(attrs.get("popular_threat_classification"), dict) else [],
                "verdict": "malicious" if malicious >= 5 else "suspicious" if (malicious + suspicious) >= 2 else "clean",
                "detection_ratio": f"{malicious}/{total}",
            },
        )
        _cache_set(key, result)
        return result
    except Exception as exc:
        logger.warning("virustotal_lookup falló para %s: %s", indicator, exc)
        return _error("virustotal_lookup", f"Error consultando VirusTotal: {exc}")


def _is_ip(value: str) -> bool:
    import ipaddress

    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _is_hash(value: str) -> bool:
    return len(value) in (32, 40, 64) and all(c in "0123456789abcdefABCDEF" for c in value)


# ======================================================================
# 3. GeoIP / ASN
# ======================================================================
@tool
async def geoip_lookup(ip: str) -> str:
    """Obtiene la geolocalización, el ASN y el proveedor de una IP usando la base local MaxMind.

    Nunca envía la IP a un tercero: la consulta es 100% local (requisito de
    no exfiltración de datos de alertas).

    Args:
        ip: Dirección IP a geolocalizar.
    """
    key = f"ti:geoip:{ip}"
    if (cached := _cache_get(key)) is not None:
        return cached
    try:
        import geoip2.database

        with geoip2.database.Reader(settings.GEOIP_DB_PATH) as reader:
            city = reader.city(ip)
            result = _ok(
                "geoip_lookup",
                {
                    "ip": ip,
                    "country": city.country.name,
                    "country_iso": city.country.iso_code,
                    "city": city.city.name,
                    "latitude": city.location.latitude,
                    "longitude": city.location.longitude,
                    "timezone": city.location.time_zone,
                    "source": "maxmind_local",
                },
            )
        _cache_set(key, result, ttl=604800)  # 7 días: los datos geográficos cambian poco
        return result
    except FileNotFoundError:
        return _error("geoip_lookup", f"Base GeoLite2 no encontrada en {settings.GEOIP_DB_PATH}")
    except Exception as exc:
        logger.warning("geoip_lookup falló para %s: %s", ip, exc)
        return _error("geoip_lookup", f"Error en la consulta GeoIP local: {exc}")


# ======================================================================
# 4. Contexto histórico de Wazuh (consulta al backend)
# ======================================================================
@tool
async def wazuh_context(rule_id: str) -> str:
    """Recupera el comportamiento histórico de una regla del SIEM en esta organización.

    Devuelve cuántas veces se ha disparado en los últimos 30 días, su tasa de
    falsos positivos y las IPs origen más frecuentes. Es clave para calibrar
    si una alerta es ruido crónico o una anomalía.

    Args:
        rule_id: Identificador de la regla del SIEM (p. ej. "5710").
    """
    key = f"ti:wazuh_ctx:{rule_id}"
    if (cached := _cache_get(key)) is not None:
        return cached
    try:
        async with httpx.AsyncClient(timeout=settings.TI_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{settings.BACKEND_URL}/api/v1/dashboard/fp-rate",
                headers={"X-Service-Token": settings.INTERNAL_SERVICE_TOKEN},
            )
            response.raise_for_status()
            data = response.json()
        rule_stats = next((r for r in data.get("by_rule", []) if r.get("key") == rule_id), None)
        result = _ok(
            "wazuh_context",
            {
                "rule_id": rule_id,
                "occurrences_period": rule_stats.get("count") if rule_stats else 0,
                "false_positives": rule_stats.get("extra", {}).get("fp") if rule_stats else 0,
                "fp_rate": rule_stats.get("extra", {}).get("fp_pct") if rule_stats else None,
                "interpretation": (
                    "regla de ruido crónico" if rule_stats and (rule_stats.get("extra", {}).get("fp_pct") or 0) > 0.7
                    else "regla con historial de verdaderos positivos" if rule_stats and (rule_stats.get("extra", {}).get("fp_pct") or 1) < 0.3
                    else "regla con historial mixto"
                ),
            },
        )
        _cache_set(key, result, ttl=3600)
        return result
    except Exception as exc:
        logger.warning("wazuh_context falló para la regla %s: %s", rule_id, exc)
        return _error("wazuh_context", f"No se pudo obtener el contexto histórico: {exc}")


# ======================================================================
# 5. Memoria de incidentes: falsos positivos conocidos
# ======================================================================
@tool
async def search_known_false_positives(rule_id: str, agent_name: str = "") -> str:
    """Busca si esta regla (y opcionalmente este activo) fue marcada antes como falso positivo.

    Es la memoria de incidentes del agente: evita repetir el análisis de
    detecciones que un analista humano ya descartó.

    Args:
        rule_id: Identificador de la regla del SIEM.
        agent_name: Nombre del activo afectado (opcional, mejora la precisión).
    """
    try:
        async with httpx.AsyncClient(timeout=settings.TI_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{settings.BACKEND_URL}/api/v1/alerts",
                params={"status": "false_positive", "q": rule_id, "page_size": 50},
                headers={"X-Service-Token": settings.INTERNAL_SERVICE_TOKEN},
            )
            response.raise_for_status()
            data = response.json()
        items = data.get("items", [])
        matches = [i for i in items if i.get("rule_id") == rule_id]
        if agent_name:
            matches.sort(key=lambda i: 0 if i.get("agent_name") == agent_name else 1)
        return _ok(
            "search_known_false_positives",
            {
                "rule_id": rule_id,
                "agent_name": agent_name or None,
                "matches": len(matches),
                "recent_examples": [
                    {"alert_id": m.get("id"), "agent": m.get("agent_name"),
                     "date": m.get("occurred_at"), "summary": (m.get("rule_description") or "")[:160]}
                    for m in matches[:5]
                ],
                "conclusion": (
                    "Existen falsos positivos previos de esta regla: evalúa si el patrón se repite"
                    if matches else "Sin falsos positivos previos registrados para esta regla"
                ),
            },
        )
    except Exception as exc:
        logger.warning("search_known_false_positives falló: %s", exc)
        return _error("search_known_false_positives", f"No se pudo consultar la memoria de incidentes: {exc}")


# ======================================================================
# 6. MITRE ATT&CK (base local embebida; ampliable con STIX oficial)
# ======================================================================
MITRE_MINI: dict[str, dict[str, str]] = {
    "T1110": {"name": "Brute Force", "tactic": "Credential Access",
              "desc": "Intentos repetidos de autenticación para obtener credenciales válidas."},
    "T1110.001": {"name": "Brute Force: Password Guessing", "tactic": "Credential Access",
                  "desc": "Adivinación de contraseñas habituales contra cuentas conocidas o inexistentes."},
    "T1078": {"name": "Valid Accounts", "tactic": "Defense Evasion, Persistence, Privilege Escalation, Initial Access",
              "desc": "Uso de cuentas legítimas para acceder al entorno."},
    "T1486": {"name": "Data Encrypted for Impact", "tactic": "Impact",
              "desc": "Cifrado de datos para interrumpir la operación (ransomware)."},
    "T1059.001": {"name": "Command and Scripting Interpreter: PowerShell", "tactic": "Execution",
                  "desc": "Ejecución de comandos mediante PowerShell, frecuente en intrusiones."},
    "T1053.005": {"name": "Scheduled Task/Job: Scheduled Task", "tactic": "Persistence, Privilege Escalation",
                  "desc": "Creación de tareas programadas para persistencia."},
    "T1071.001": {"name": "Application Layer Protocol: Web Protocols", "tactic": "Command and Control",
                  "desc": "Uso de HTTP/HTTPS para comunicación con infraestructura C2."},
    "T1595.002": {"name": "Active Scanning: Vulnerability Scanning", "tactic": "Reconnaissance",
                  "desc": "Escaneo activo de vulnerabilidades contra servicios expuestos."},
    "T1565.001": {"name": "Data Manipulation: Stored Data Manipulation", "tactic": "Impact",
                  "desc": "Modificación de datos almacenados para afectar su integridad."},
    "T1021": {"name": "Remote Services", "tactic": "Lateral Movement",
              "desc": "Uso de servicios remotos legítimos para moverse lateralmente."},
    "T1105": {"name": "Ingress Tool Transfer", "tactic": "Command and Control",
              "desc": "Transferencia de herramientas o payloads al entorno comprometido."},
}


@tool
def mitre_lookup(keywords: str) -> str:
    """Busca la técnica MITRE ATT&CK aplicable a partir de palabras clave del evento.

    Úsala para etiquetar la alerta con la técnica correcta y alinear el
    reporte con el marco NIST CSF (DE.AE) y los controles ISO 27001.

    Args:
        keywords: Descripción del comportamiento observado (p. ej. "brute force ssh login").
    """
    tokens = {t.strip().lower() for t in keywords.replace(",", " ").split() if len(t) > 3}
    scored: list[tuple[int, str, dict[str, str]]] = []
    for tech_id, info in MITRE_MINI.items():
        haystack = f"{info['name']} {info['desc']} {info['tactic']}".lower()
        score = sum(1 for t in tokens if t in haystack)
        if score:
            scored.append((score, tech_id, info))
    scored.sort(reverse=True)
    return _ok(
        "mitre_lookup",
        {
            "query": keywords,
            "matches": [
                {"technique_id": tid, "name": info["name"], "tactic": info["tactic"], "description": info["desc"],
                 "confidence": round(min(0.95, 0.5 + 0.15 * score), 2)}
                for score, tid, info in scored[:5]
            ],
            "note": "Catálogo local reducido. Ampliar con el STIX oficial de MITRE ATT&CK (enterprise-attack.json).",
        },
    )


# ======================================================================
# Registro de herramientas del agente
# ======================================================================
def get_tools() -> list:
    """Herramientas disponibles para el agente de triaje.

    Se filtran según la configuración: si `THREAT_INTEL_ENABLED` es falso o no
    hay claves de API, las herramientas correspondientes quedan fuera para que
    el modelo no pierda iteraciones invocándolas en vano.
    """
    tools = [geoip_lookup, wazuh_context, search_known_false_positives, mitre_lookup]
    if settings.THREAT_INTEL_ENABLED:
        if settings.ABUSEIPDB_API_KEY:
            tools.append(abuseipdb_lookup)
        if settings.VIRUSTOTAL_API_KEY:
            tools.append(virustotal_lookup)
    return tools
