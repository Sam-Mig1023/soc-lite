-- SOC-Lite: evaluation snapshot for labeled UNSW-NB15 alerts.
-- Run from PowerShell with:
-- Get-Content -Raw scripts/evaluate_unsw_triage.sql | docker compose exec -T postgres psql -U soclite -d soclite
-- Labels: UNSW label 1 = attack; label 0 = normal.
-- Prediction mapping: true_positive/suspicious = attack; benign/false_positive = normal.
-- Inconclusive predictions are excluded from accuracy/precision/recall, but counted for coverage.
-- Only the hybrid evaluation protocol is included: label/category/id are stored
-- for scoring, while the model receives only the feature columns. The classifier
-- verdict is the measured prediction; LangChain supplies contextual explanation.

WITH labeled AS (
    SELECT
        a.id AS alert_id,
        a.raw_payload #>> '{dataset_ground_truth,label}' AS label,
        t.verdict::text AS verdict,
        t.model_name,
        t.prompt_version,
        t.latency_ms,
        CASE a.raw_payload #>> '{dataset_ground_truth,label}'
            WHEN '1' THEN TRUE
            WHEN '0' THEN FALSE
            ELSE NULL
        END AS actual_attack,
        CASE t.verdict::text
            WHEN 'true_positive' THEN TRUE
            WHEN 'suspicious' THEN TRUE
            WHEN 'benign' THEN FALSE
            WHEN 'false_positive' THEN FALSE
            ELSE NULL
        END AS predicted_attack
    FROM soclite.alerts AS a
    JOIN soclite.triage_results AS t ON t.alert_id = a.id AND t.is_current
    WHERE a.raw_payload ->> 'dataset' = 'UNSW-NB15'
      AND a.raw_payload ->> 'evaluation_protocol' = 'unsw-nb15-hybrid-v3'
      AND a.raw_payload #>> '{dataset_ground_truth,label}' IN ('0', '1')
      AND t.model_provider = 'hybrid'
), counts AS (
    SELECT
        count(*) AS total_labeled,
        count(*) FILTER (WHERE predicted_attack IS NOT NULL) AS classified,
        count(*) FILTER (WHERE predicted_attack IS NULL) AS inconclusive,
        count(*) FILTER (WHERE actual_attack AND predicted_attack) AS true_positive,
        count(*) FILTER (WHERE NOT actual_attack AND predicted_attack) AS false_positive,
        count(*) FILTER (WHERE NOT actual_attack AND NOT predicted_attack) AS true_negative,
        count(*) FILTER (WHERE actual_attack AND NOT predicted_attack) AS false_negative,
        round(avg(latency_ms) FILTER (WHERE predicted_attack IS NOT NULL) / 1000.0, 1) AS avg_latency_seconds
    FROM labeled
    WHERE actual_attack IS NOT NULL
)
SELECT
    total_labeled,
    classified,
    inconclusive,
    round(100.0 * classified / NULLIF(total_labeled, 0), 1) AS coverage_pct,
    true_positive,
    false_positive,
    true_negative,
    false_negative,
    round(100.0 * (true_positive + true_negative) / NULLIF(classified, 0), 1) AS accuracy_pct,
    round(100.0 * true_positive / NULLIF(true_positive + false_positive, 0), 1) AS precision_pct,
    round(100.0 * true_positive / NULLIF(true_positive + false_negative, 0), 1) AS recall_pct,
    avg_latency_seconds
FROM counts;

-- Per-alert evidence for the article and manual review.
SELECT
    a.id AS alert_id,
    a.raw_payload #>> '{dataset_ground_truth,label}' AS dataset_label,
    a.raw_payload #>> '{dataset_ground_truth,attack_category}' AS attack_category,
    t.verdict,
    t.model_name,
    t.prompt_version,
    t.confidence,
    t.risk_score,
    t.latency_ms,
    t.created_at
FROM soclite.alerts AS a
JOIN soclite.triage_results AS t ON t.alert_id = a.id AND t.is_current
WHERE a.raw_payload ->> 'dataset' = 'UNSW-NB15'
  AND a.raw_payload ->> 'evaluation_protocol' = 'unsw-nb15-hybrid-v3'
  AND t.model_provider = 'hybrid'
ORDER BY a.id;
