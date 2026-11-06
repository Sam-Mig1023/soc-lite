# Resultados observados del clasificador UNSW-NB15

## Protocolo

Se entrenó un clasificador binario Random Forest con el split oficial
`UNSW_NB15_training-set.csv` y se midió una sola vez sobre el split oficial
`UNSW_NB15_testing-set.csv`. Se excluyeron `id`, `label` y `attack_cat` de las
características; la etiqueta binaria se usó únicamente como objetivo de entrenamiento
y evaluación. Se emplearon 42 características, codificación one-hot para `proto`,
`service` y `state`, imputación mediana para valores numéricos. El umbral se calibró
con predicciones *out-of-bag* del entrenamiento para alcanzar un recall de 95 % y se
aplicó sin cambios al conjunto de prueba oficial.

La implementación reproducible está en [`scripts/evaluate_unsw_classifier.py`](../scripts/evaluate_unsw_classifier.py).
La configuración exacta, versiones de bibliotecas y conteos de clase están en
[`research/unsw-nb15/classifier-evaluation.json`](../research/unsw-nb15/classifier-evaluation.json);
las predicciones por registro están en
[`research/unsw-nb15/classifier-predictions.csv`](../research/unsw-nb15/classifier-predictions.csv).
El modelo serializado se conserva localmente bajo `data/models/unsw-nb15/` y se excluye
de Git junto con los CSV originales.

## Resultados en el conjunto de prueba

| Métrica | Resultado observado |
|---|---:|
| Registros de prueba | 82 332 |
| Umbral aplicado | 0,5572 |
| Exactitud | 90,92 % |
| Exactitud balanceada | 90,26 % |
| Precisión | 87,97 % |
| Recall de ataques | 96,74 % |
| Especificidad | 83,79 % |
| F1 | 92,14 % |
| ROC-AUC | 98,47 % |
| Falsos positivos | 5 997 |
| Falsos negativos | 1 480 |
| Entrenamiento | 54,531 s |
| Inferencia de los 82 332 registros | 0,773 s |

La latencia medida corresponde a inferencia por lotes en el entorno de desarrollo usado
para esta corrida, no a la latencia de extremo a extremo del sistema ni a un equipo de
producción. Se deben registrar CPU, memoria y configuración de Docker al repetirla.

## Interpretación y límites

El clasificador detectó 43 852 de 45 332 ataques y clasificó correctamente 31 003 de
37 000 registros normales; produjo 5 997 falsos positivos. El umbral 0,5572 se eligió
con el objetivo de 95 % de recall en predicciones *out-of-bag* del entrenamiento; el
resultado de prueba quedó en 96,74 % de recall. El resultado implica un compromiso:
se redujeron los falsos positivos frente al umbral 0,5, a costa de más falsos negativos.
La categoría Fuzzers tuvo 77,53 % de recall y requiere análisis específico. La tabla
por categoría dentro del JSON debe interpretarse con cuidado: para
la clase `Normal`, `attack_recall` equivale a la tasa de falsos positivos; para las
categorías de ataque, representa el recall de esa categoría.

Estos números evalúan el clasificador supervisado sobre el benchmark, no el rendimiento
de extremo a extremo de LangChain/Ollama. El triaje híbrido v2 presenta la predicción
del clasificador junto con una explicación del LLM. Debe evaluarse por separado con
alertas ciegas ingresadas por n8n, contrastadas después con sus etiquetas reales. La
latencia por lotes no es comparable con los 1–4 minutos de inferencia individual del
LLM local.

## Verificación integrada preliminar por n8n

Se envió una fila del conjunto de prueba (ID 64043, categoría real `Fuzzers`, etiqueta
1) por el workflow n8n de ingesta. SOC-Lite registró la alerta **#29** y el triaje
híbrido v2 devolvió `suspicious` (acierto para esa fila), con riesgo 75, confianza
0,746 y latencia 267 733 ms (267,7 s). La consulta reproducible es
[`scripts/evaluate_unsw_triage.sql`](../scripts/evaluate_unsw_triage.sql).

Esta verificación extremo a extremo es una sola observación (`n=1`), no una estimación
de precisión del workflow. La latencia incluye el LLM local y no es comparable con la
inferencia por lotes del clasificador. Para un resultado de sistema se debe procesar un
lote ciego amplio, guardar sus métricas y reportar cobertura, falsos positivos,
falsos negativos y latencia de extremo a extremo por separado.
