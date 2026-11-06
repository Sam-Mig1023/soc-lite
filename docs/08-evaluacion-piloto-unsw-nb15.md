# Evaluación piloto de SOC-Lite con UNSW-NB15

> **Registro histórico:** estos resultados pertenecen a la corrida LLM-only de diez
> registros `unsw-nb15-blind-v1`. El protocolo vigente es híbrido y su evaluación
> cuantitativa está documentada en [`09-resultados-unsw-nb15.md`](09-resultados-unsw-nb15.md).

## Propósito

Registrar el protocolo y los resultados observados en una primera evaluación ciega del
triaje de SOC-Lite con registros del conjunto público UNSW-NB15. Este documento es una
base reproducible para el artículo; no presenta la prueba piloto como validación final.

## Datos y muestra

- **Conjunto:** UNSW-NB15, archivo `UNSW_NB15_testing-set.csv`.
- **Selección:** 10 registros, balanceados en 5 normales (`label=0`) y 5 ataques
  (`label=1`), seleccionados con semilla `2027`.
- **Adaptación:** las filas se convierten en alertas mediante
  `scripts/send_unsw_sample.py` y el workflow 07 de n8n.
- **Ceguera:** `label` y `attack_cat` se conservan en `raw_payload` para la evaluación
  posterior; no se incluyen en los campos enviados al triaje. Se usa una regla,
  descripción, grupo y severidad comunes a ambas clases. `rule_level=7` es una
  adaptación de SOC-Lite y no una característica del dataset.
- **Modelo registrado:** `llama3.2:3b`, prompt `triage_v4`.

El protocolo reduce la filtración directa de la etiqueta, pero el tamaño de muestra es
pequeño. La muestra balanceada permite observar ambas clases, pero no reproduce la
prevalencia de ataques de un entorno real. Los resultados no deben generalizarse al
conjunto completo ni a tráfico operativo.

## Regla de evaluación

Para la matriz binaria de esta prueba, `suspicious` y `true_positive` cuentan como
predicción positiva (ataque); `benign` y `false_positive` cuentan como predicción
negativa (normal). Los veredictos inconclusos se excluyen de exactitud, precisión y
recall, pero se reflejan en cobertura. Los resultados de `heuristic-fallback` se
excluyen para medir el triaje del LLM.

## Resultado observado

| Métrica | Resultado |
|---|---:|
| Registros etiquetados | 10 |
| Triajes clasificados | 10 (cobertura 100 %) |
| Verdaderos positivos (TP) | 5 |
| Falsos positivos (FP) | 5 |
| Verdaderos negativos (TN) | 0 |
| Falsos negativos (FN) | 0 |
| Exactitud | 50 % |
| Precisión | 50 % |
| Recall | 100 % |
| Latencia media | 128,2 s |

El modelo emitió el veredicto `suspicious` en los 10 casos, incluidos los cinco
registros normales. Así, no omitió ataques en esta muestra, pero generó cinco falsas
alarmas y no distinguió los casos normales. La exactitud de 50 % coincide con la
clasificación de todos los ejemplos como positivos en una muestra balanceada; no debe
interpretarse como buen desempeño operativo.

## Reproducción

La evaluación actual usa el clasificador entrenado con el split oficial y está
documentada en [`09-resultados-unsw-nb15.md`](09-resultados-unsw-nb15.md). Esta sección
se conserva únicamente para transparentar el piloto histórico; no reutilizar sus
métricas como estimación del desempeño del protocolo híbrido vigente.

## Límites y trabajo pendiente

1. Ampliar el tamaño de muestra y documentar cómo se seleccionan los registros.
2. Revisar el umbral y el prompt para reducir falsos positivos sin ocultar ataques.
3. Repetir varias corridas y reportar variabilidad, no solo un promedio.
4. Registrar hardware, recursos Docker, versión exacta del modelo y condiciones de
   ejecución para contextualizar la latencia.
5. Evaluar por categoría de ataque y conservar un conjunto independiente para evitar
   ajustar y evaluar con las mismas muestras.

La consulta de origen de las métricas es `scripts/evaluate_unsw_triage.sql`; la
automatización de ingesta es `n8n/soc_lite_unsw_dataset_ingest_workflow.json`.
