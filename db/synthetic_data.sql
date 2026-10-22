-- =====================================================================
-- SOC-Lite · Generador de datos sintéticos para demo / pruebas de carga
-- Uso: psql -U soclite -d soclite -f db/synthetic_data.sql
--      SELECT soclite.generate_synthetic_alerts(5000, 30);
-- =====================================================================
BEGIN;
SET search_path TO soclite, public;

CREATE OR REPLACE FUNCTION generate_synthetic_alerts(
    p_count      INTEGER DEFAULT 5000,
    p_days_back  INTEGER DEFAULT 30
) RETURNS INTEGER AS $$
DECLARE
    v_rules   TEXT[][] := ARRAY[
        ['5710','Attempt to login using a non-existent user','high','T1110.001'],
        ['5712','SSH brute force trying to get access to the system','high','T1110.001'],
        ['60106','Multiple web server 400 error codes from same source IP','medium','T1595.002'],
        ['87105','Possible ransomware behavior detected: mass file encryption','critical','T1486'],
        ['5501','PAM: Login session opened','info',NULL],
        ['80784','Audit: Windows logon failure','medium','T1078'],
        ['92052','Persistence via new scheduled task','high','T1053.005'],
        ['31151','Multiple authentication failures followed by success','critical','T1110'],
        ['2502','Syscheck: integrity checksum changed','low','T1565.001'],
        ['100001','Suspicious PowerShell encoded command','high','T1059.001']
    ];
    v_agents  TEXT[] := ARRAY['SRV-DC01','SRV-DB01','SRV-WEB01','WKS-CONTAB01','WKS-RRHH03','SRV-MAIL01','PLC-PLANTA1'];
    v_ips     TEXT[] := ARRAY['203.0.113.44','198.51.100.77','192.0.2.55','45.155.205.233','185.220.101.7','10.0.4.21','10.0.4.55'];
    v_src     source_type[] := ARRAY['wazuh','wazuh','wazuh','opnsense','suricata']::source_type[];
    i         INTEGER;
    r         TEXT[];
    v_agent   TEXT;
    v_sip     TEXT;
    v_sev     severity_level;
    v_status  alert_status;
    v_verdict triage_verdict;
    v_fp_prob NUMERIC;
    v_occ     TIMESTAMPTZ;
    v_alert   BIGINT;
    v_risk    SMALLINT;
    v_tools   TEXT[] := ARRAY['abuseipdb_lookup','virustotal_lookup','geoip_lookup','wazuh_context'];
    v_tool_sub TEXT[];
BEGIN
    FOR i IN 1..p_count LOOP
        r        := v_rules[1 + floor(random()*array_length(v_rules,1))::int];
        v_agent  := v_agents[1 + floor(random()*array_length(v_agents,1))::int];
        v_sip    := v_ips[1 + floor(random()*array_length(v_ips,1))::int];
        v_sev    := r[3]::severity_level;
        v_occ    := now() - (random() * p_days_back || ' days')::interval;
        -- Ruido realista: mezcla de estados y veredictos
        v_risk   := (CASE v_sev WHEN 'critical' THEN 80 WHEN 'high' THEN 65 WHEN 'medium' THEN 40 WHEN 'low' THEN 20 ELSE 5 END
                     + floor(random()*20))::smallint;
        v_status := CASE WHEN random() < 0.78 THEN 'closed'::alert_status
                         WHEN random() < 0.60 THEN 'triaged'::alert_status
                         WHEN random() < 0.70 THEN 'escalated'::alert_status
                         ELSE 'pending'::alert_status END;
        v_fp_prob := CASE v_sev WHEN 'info' THEN 0.92 WHEN 'low' THEN 0.80 WHEN 'medium' THEN 0.55
                                WHEN 'high' THEN 0.22 ELSE 0.08 END;
        v_verdict := CASE WHEN random() < v_fp_prob THEN 'false_positive'::triage_verdict
                          WHEN v_sev IN ('critical','high') THEN 'true_positive'::triage_verdict
                          ELSE 'benign'::triage_verdict END;
        v_tool_sub := v_tools[1:1 + floor(random()*4)::int];

        INSERT INTO alerts (alert_fingerprint, source_type, source_name, rule_id, rule_level, rule_description,
                            severity, severity_raw, status, source_ip, dest_ip, agent_name, asset_id,
                            mitre_technique, full_log, raw_payload, risk_score, verdict,
                            assigned_to, occurred_at, triaged_at)
        VALUES (
            -- fingerprint con componente aleatorio para permitir volumen en demo
            'synth:' || r[1] || ':' || v_sip || ':' || to_char(v_occ,'YYYYMMDDHH24MISS') || ':' || i,
            v_src[1 + floor(random()*array_length(v_src,1))::int], 'wazuh-manager', r[1],
            (CASE v_sev WHEN 'critical' THEN 12 WHEN 'high' THEN 10 WHEN 'medium' THEN 7 WHEN 'low' THEN 4 ELSE 2 END),
            r[2], v_sev,
            (CASE v_sev WHEN 'critical' THEN 12 WHEN 'high' THEN 10 WHEN 'medium' THEN 7 WHEN 'low' THEN 4 ELSE 2 END),
            v_status, v_sip::inet, '10.0.0.5'::inet, v_agent,
            (SELECT id FROM assets WHERE hostname = v_agent LIMIT 1),
            r[4], r[2] || ' (evento sintético para demo)', '{"synthetic": true}'::jsonb,
            v_risk, v_verdict,
            (SELECT id FROM users WHERE username IN ('analista1','analista2','soc_manager') ORDER BY random() LIMIT 1),
            v_occ,
            CASE WHEN v_status <> 'pending' THEN v_occ + (random()*900 || ' seconds')::interval ELSE NULL END
        ) RETURNING id INTO v_alert;

        IF v_status <> 'pending' THEN
            INSERT INTO triage_results (alert_id, verdict, severity, risk_score, confidence, summary,
                    reasoning, recommended_actions, mitre_techniques, model_name, prompt_version,
                    tokens_in, tokens_out, latency_ms, tools_used, is_current)
            VALUES (v_alert, v_verdict, v_sev, v_risk, round((0.55 + random()*0.44)::numeric,3),
                    'Resumen automático generado para la alerta ' || v_alert || ' (regla ' || r[1] || ').',
                    '["Análisis de reputación del indicador","Correlación con eventos previos del activo","Evaluación de criticidad del activo destino"]'::jsonb,
                    '[{"order":1,"action":"Validar evidencia en el SIEM","priority":"p3"}]'::jsonb,
                    CASE WHEN r[4] IS NULL THEN '{}'::text[] ELSE ARRAY[r[4]] END,
                    (ARRAY['llama3.1:8b','mistral:7b','qwen2.5:7b'])[1 + floor(random()*3)::int],
                    'triage_v3', 1800 + floor(random()*900)::int, 250 + floor(random()*300)::int,
                    3000 + floor(random()*6000)::int, v_tool_sub, TRUE);
        END IF;

        IF random() < 0.35 THEN
            INSERT INTO enrichment_data (alert_id, provider, indicator, indicator_type, verdict, score,
                    malicious_count, total_engines, country, asn, as_owner, raw_response, cache_hit)
            VALUES (v_alert,
                    (ARRAY['abuseipdb','virustotal','geoip'])[1 + floor(random()*3)::int],
                    v_sip, 'ip',
                    (ARRAY['malicious','suspicious','clean','unknown'])[1 + floor(random()*4)::int],
                    round((random()*100)::numeric,2),
                    floor(random()*200)::int, 70,
                    (ARRAY['CN','RU','NL','US','BR','CL','IR'])[1 + floor(random()*7)::int],
                    'AS' || (1000 + floor(random()*90000))::int, 'Proveedor sintético',
                    '{"synthetic": true}'::jsonb, random() < 0.4);
        END IF;
    END LOOP;

    -- Recalcular agregados diarios
    DELETE FROM alert_metrics_daily;
    INSERT INTO alert_metrics_daily (metric_date, source_type, severity, alerts_total, alerts_tp, alerts_fp,
                                     alerts_escalated, mttt_avg_sec, mttt_p95_sec, mttr_avg_sec, automation_rate)
    SELECT a.occurred_at::date, a.source_type, a.severity,
           count(*),
           count(*) FILTER (WHERE a.verdict='true_positive'),
           count(*) FILTER (WHERE a.verdict='false_positive'),
           count(*) FILTER (WHERE a.status='escalated'),
           round(avg(a.mttt_seconds),2),
           percentile_cont(0.95) WITHIN GROUP (ORDER BY a.mttt_seconds),
           round(avg(a.mttr_seconds),2),
           round(count(*) FILTER (WHERE a.triaged_at IS NOT NULL)::numeric / NULLIF(count(*),0), 4)
    FROM alerts a WHERE a.deleted_at IS NULL
    GROUP BY 1,2,3;

    RETURN p_count;
END; $$ LANGUAGE plpgsql;

COMMIT;

-- Ejemplo de uso:
--   SELECT soclite.generate_synthetic_alerts(5000, 30);
--   ANALYZE soclite.alerts;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY ... (si se añaden vistas materializadas)
