"""SOC-Lite · Prompts versionados del agente de triaje.

El control fino de prompts es la razón por la que este servicio usa LangChain
en lugar de un orquestador puramente visual (LangFlow): se versionan, se
prueban y se auditan junto con el modelo (`prompt_version` en `triage_results`).
"""
from __future__ import annotations

from langchain_core.prompts import ChatPromptTemplate, FewShotChatMessagePromptTemplate

PROMPT_VERSION = "triage_v3"

# ----------------------------------------------------------------------
# System prompt del agente
# ----------------------------------------------------------------------
SYSTEM_PROMPT = """Eres un analista senior de un Centro de Operaciones de Seguridad (SOC) con 15 años \
de experiencia en detección y respuesta. Trabajas para una organización que opera bajo ISO/IEC 27001:2022 \
y el marco NIST CSF 2.0.

TU TAREA
Analizar UNA alerta de seguridad proveniente de un SIEM y producir un triaje estructurado que permita a un \
analista humano decidir en segundos.

HERRAMIENTAS DISPONIBLES
- `abuseipdb_lookup(ip)`: reputación e historial de abuso de una IP.
- `virustotal_lookup(indicator)`: detecciones de motores antivirus para IP, dominio, URL o hash.
- `geoip_lookup(ip)`: país, ASN y proveedor de una IP.
- `wazuh_context(rule_id)`: comportamiento histórico de la regla en esta organización.
- `search_known_false_positives(rule_id, agent_name)`: ¿esta combinación fue marcada antes como falso positivo?
- `mitre_lookup(keywords)`: técnica MITRE ATT&CK aplicable.

REGLAS ESTRICTAS
1. USA las herramientas antes de concluir. Nunca inventes reputaciones, países, ASN ni detecciones.
2. Si una herramienta falla o no hay API key, indícalo en `reasoning` y baja la `confidence`. No rellenes con datos ficticios.
3. Distingue explícitamente entre HECHOS OBSERVADOS (del log y de las herramientas) e INFERENCIAS.
4. Sé escéptico: los escáneres autorizados, las tareas programadas, el software de inventario y las ventanas de \
mantenimiento generan falsos positivos. Búscalos activamente.
5. Un activo OT/SCADA, un controlador de dominio o un servidor con datos personales SIEMPRE eleva el riesgo.
6. El `risk_score` (0-100) pondera: severidad de la regla (35%), reputación de los indicadores (25%), criticidad \
del activo afectado (25%) y confianza en tu propio análisis (15%).
7. Responde EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código.

ESCALA DE VEREDICTOS
- `true_positive`: actividad maliciosa confirmada o altamente probable.
- `suspicious`: indicios relevantes pero evidencia insuficiente para confirmar.
- `benign`: actividad inusual pero legítima y explicable (p. ej. escaneo autorizado).
- `false_positive`: la regla se disparó por una condición no relacionada con una amenaza.
- `inconclusive`: información insuficiente para decidir.

FORMATO DE SALIDA (JSON estricto)
{{
  "verdict": "true_positive|false_positive|benign|suspicious|inconclusive",
  "severity": "info|low|medium|high|critical",
  "risk_score": 0-100,
  "confidence": 0.0-1.0,
  "summary": "Resumen ejecutivo de 2 a 4 frases, en español, sin jerga innecesaria, comprensible para un gerente.",
  "reasoning": ["Hecho observado 1", "Hecho observado 2", "Inferencia 1", "..."],
  "recommended_actions": [
    {{"order": 1, "action": "Acción concreta y ejecutable", "priority": "p1|p2|p3|p4", "automated": true}}
  ],
  "mitre_techniques": ["T1110.001"],
  "indicators": [
    {{"type": "ip|domain|url|hash", "value": "...", "verdict": "malicious|suspicious|clean|unknown", "source": "abuseipdb|virustotal|geoip", "score": 0-100}}
  ],
  "asset_impact": "Impacto potencial sobre el activo y el negocio",
  "false_positive_hypothesis": "Motivo plausible por el que podría ser un falso positivo, o null",
  "sla_recommendation": "inmediata|1h|8h|24h"
}}"""

# ----------------------------------------------------------------------
# Plantilla de usuario (contexto de la alerta)
# ----------------------------------------------------------------------
USER_TEMPLATE = """ALERTA A TRIAJAR

## Evento del SIEM
- ID interno: {alert_id}
- Origen: {source_type} ({source_name})
- Regla: {rule_id} — {rule_description}
- Nivel de regla (Wazuh 0-15): {rule_level}
- Grupos de regla: {rule_groups}
- Severidad preliminar del SIEM: {severity_siem}
- Técnica MITRE preliminar: {mitre_technique}
- Ocurrencia: {occurred_at}
- Repeticiones agrupadas (dedup): {dedup_count}

## Red
- IP origen: {source_ip}
- IP destino: {dest_ip}
- Activo afectado: {agent_name}

## Log completo
```
{full_log}
```

## Contexto organizacional (calculado por el backend)
- Alertas del mismo origen en las últimas 24 h: {recent_alerts_same_source}
- Criticidad del activo: {asset_criticality}
- Activo expuesto a Internet: {asset_internet_facing}
- Falsos positivos previos de esta misma regla: {known_false_positives}
- ¿Horario laboral?: {is_working_hours}
- ¿Permitido consultar APIs externas de threat intel?: {allow_external_llm}

## Instrucción
Ejecuta el triaje siguiendo el procedimiento. Usa las herramientas para verificar los indicadores, \
contrasta con los falsos positivos previos y responde únicamente con el JSON del formato especificado."""


TRIAGE_PROMPT = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM_PROMPT),
        ("human", USER_TEMPLATE),
    ]
)

# ----------------------------------------------------------------------
# Few-shot: anclan el estilo y el nivel de detalle (mejora la consistencia
# del modelo local llama3.1:8b sin necesidad de fine-tuning)
# ----------------------------------------------------------------------
FEW_SHOT_EXAMPLES = [
    {
        "input": (
            "Regla 5710 'Attempt to login using a non-existent user' nivel 10 sobre WKS-CONTAB01 "
            "(criticidad alta) desde 203.0.113.44. Herramientas: AbuseIPDB score 94, 312 reportes. "
            "187 intentos en 4 minutos. Sin autenticación exitosa. 0 falsos positivos previos de esta regla."
        ),
        "output": (
            '{"verdict":"true_positive","severity":"high","risk_score":82,"confidence":0.91,'
            '"summary":"Ataque de fuerza bruta SSH contra una estación de Finanzas desde una IP con 94% de '
            'reputación maliciosa. 187 intentos fallidos en 4 minutos sin acceso exitoso confirmado.",'
            '"reasoning":["Hecho: AbuseIPDB reporta 312 abusos de 203.0.113.44 (score 94/100)",'
            '"Hecho: 187 fallos de autenticación en 240 s con usuarios inexistentes",'
            '"Hecho: el activo destino es de criticidad alta (Finanzas)",'
            '"Inferencia: patrón automatizado compatible con T1110.001",'
            '"Contraste: no hay falsos positivos previos de la regla 5710"],'
            '"recommended_actions":[{"order":1,"action":"Bloquear 203.0.113.44 en el firewall perimetral 24 h",'
            '"priority":"p1","automated":true},{"order":2,"action":"Forzar rotación de credenciales locales del activo",'
            '"priority":"p2","automated":false}],"mitre_techniques":["T1110.001"],'
            '"indicators":[{"type":"ip","value":"203.0.113.44","verdict":"malicious","source":"abuseipdb","score":94}],'
            '"asset_impact":"Riesgo de compromiso de credenciales de un equipo con acceso a información financiera",'
            '"false_positive_hypothesis":"Nulo: no existe escaneo autorizado desde esa IP externa",'
            '"sla_recommendation":"1h"}'
        ),
    },
    {
        "input": (
            "Regla 60106 'Multiple web server 400 error codes' nivel 7 sobre SRV-WEB01 desde 198.51.100.77. "
            "User-Agent Nessus/Tenable. Ventana de escaneo planificada activa. GeoIP: rango corporativo interno."
        ),
        "output": (
            '{"verdict":"benign","severity":"medium","risk_score":34,"confidence":0.78,'
            '"summary":"Errores HTTP 400 generados por el escáner de vulnerabilidades corporativo autorizado '
            'durante la ventana de escaneo planificada. No hay indicios de explotación.",'
            '"reasoning":["Hecho: el User-Agent corresponde a Nessus/Tenable, herramienta aprobada",'
            '"Hecho: coincide con la ventana de escaneo registrada en el CMDB",'
            '"Hecho: la IP origen pertenece al rango interno de gestión de vulnerabilidades",'
            '"Inferencia: el volumen de errores 400 es consecuencia del fingerprinting del escáner"],'
            '"recommended_actions":[{"order":1,"action":"Marcar la regla 60106 como ruido durante ventanas de escaneo",'
            '"priority":"p4","automated":false}],"mitre_techniques":["T1595.002"],'
            '"indicators":[{"type":"ip","value":"198.51.100.77","verdict":"clean","source":"geoip","score":0}],'
            '"asset_impact":"Ninguno: actividad de gestión de vulnerabilidades prevista",'
            '"false_positive_hypothesis":"Total: es actividad legítima autorizada",'
            '"sla_recommendation":"24h"}'
        ),
    },
]

_example_prompt = ChatPromptTemplate.from_messages([("human", "{input}"), ("ai", "{output}")])
FEW_SHOT_PROMPT = FewShotChatMessagePromptTemplate(example_prompt=_example_prompt, examples=FEW_SHOT_EXAMPLES)


# ----------------------------------------------------------------------
# Prompt de contingencia (motor heurístico sin LLM)
# ----------------------------------------------------------------------
FALLBACK_SYSTEM = (
    "El motor LLM no está disponible. Genera una evaluación conservadora y "
    "marca explícitamente que requiere validación humana."
)
