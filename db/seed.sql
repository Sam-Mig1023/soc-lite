-- =====================================================================
-- SOC-Lite · Datos semilla (seed) — idempotente
-- Ejecutar: psql -U soclite -d soclite -f db/seed.sql
-- Credenciales demo (CAMBIAR EN PRODUCCIÓN):
--   admin / Admin123!     soc_manager / Manager123!
--   analista1 / Analyst123!   auditor1 / Audit123!   visor1 / Viewer123!
-- =====================================================================
BEGIN;
SET search_path TO soclite, public;

-- ---------------------------------------------------------------------
-- 1. PERMISOS (catálogo módulo:acción)
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, module, action, description) VALUES
 ('dashboard:read','dashboard','read','Ver dashboard y métricas'),
 ('alerts:read','alerts','read','Consultar alertas'),
 ('alerts:write','alerts','write','Actualizar/asignar alertas'),
 ('alerts:delete','alerts','delete','Eliminar alertas'),
 ('triage:read','triage','read','Ver resultados de triaje'),
 ('triage:run','triage','run','Ejecutar triaje con LLM'),
 ('incidents:read','incidents','read','Consultar incidentes'),
 ('incidents:write','incidents','write','Gestionar incidentes'),
 ('assets:read','assets','read','Consultar inventario de activos'),
 ('assets:write','assets','write','Gestionar activos'),
 ('reports:read','reports','read','Ver reportes'),
 ('reports:export','reports','export','Exportar reportes PDF/Word/Excel'),
 ('users:read','users','read','Consultar usuarios'),
 ('users:write','users','write','Crear/editar usuarios'),
 ('users:delete','users','delete','Desactivar usuarios'),
 ('roles:read','roles','read','Consultar roles y permisos'),
 ('roles:write','roles','write','Crear/editar roles'),
 ('roles:delete','roles','delete','Eliminar roles'),
 ('audit:read','audit','read','Consultar bitácora de auditoría'),
 ('audit:export','audit','export','Exportar bitácora'),
 ('settings:read','settings','read','Ver configuración e integraciones'),
 ('settings:write','settings','write','Modificar configuración e integraciones')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. ROLES
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, description, is_system) VALUES
 ('admin','Administrador','Control total del sistema y la configuración', TRUE),
 ('soc_manager','Jefe de SOC','Supervisión, métricas, reportes y gestión de incidentes', TRUE),
 ('analyst','Analista SOC','Triaje, gestión de alertas e incidentes', TRUE),
 ('auditor','Auditor','Acceso de solo lectura a bitácora y reportes', TRUE),
 ('viewer','Consulta','Solo lectura del dashboard y alertas', TRUE)
ON CONFLICT (code) DO NOTHING;

-- admin: todos los permisos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- soc_manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
 'dashboard:read','alerts:read','alerts:write','triage:read','triage:run','incidents:read',
 'incidents:write','assets:read','assets:write','reports:read','reports:export',
 'users:read','roles:read','audit:read','audit:export','settings:read')
WHERE r.code = 'soc_manager' ON CONFLICT DO NOTHING;

-- analyst
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
 'dashboard:read','alerts:read','alerts:write','triage:read','triage:run','incidents:read',
 'incidents:write','assets:read','reports:read')
WHERE r.code = 'analyst' ON CONFLICT DO NOTHING;

-- auditor
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
 'dashboard:read','alerts:read','triage:read','incidents:read','reports:read',
 'audit:read','audit:export','users:read','roles:read')
WHERE r.code = 'auditor' ON CONFLICT DO NOTHING;

-- viewer
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('dashboard:read','alerts:read','triage:read')
WHERE r.code = 'viewer' ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. USUARIOS DEMO  (bcrypt vía pgcrypto)
-- ---------------------------------------------------------------------
INSERT INTO users (username, email, full_name, hashed_password, department, phone, is_system) VALUES
 ('admin','admin@org.local','Administrador SOC-Lite', crypt('Admin123!', gen_salt('bf',12)), 'TI / Seguridad','+56 2 2345 6700', TRUE),
 ('soc_manager','manager@org.local','Rodrigo Salinas (Jefe SOC)', crypt('Manager123!', gen_salt('bf',12)), 'Ciberseguridad','+56 2 2345 6701', FALSE),
 ('analista1','analista1@org.local','Ana Torres', crypt('Analyst123!', gen_salt('bf',12)), 'Ciberseguridad','+56 2 2345 6702', FALSE),
 ('analista2','analista2@org.local','Luis Paredes', crypt('Analyst123!', gen_salt('bf',12)), 'Ciberseguridad','+56 2 2345 6703', FALSE),
 ('auditor1','auditor@org.local','Carla Méndez (Auditoría)', crypt('Audit123!', gen_salt('bf',12)), 'Auditoría Interna','+56 2 2345 6704', FALSE),
 ('visor1','visor@org.local','Diego Fuentes (Dirección)', crypt('Viewer123!', gen_salt('bf',12)), 'Gerencia','+56 2 2345 6705', FALSE)
ON CONFLICT (username) DO NOTHING;

INSERT INTO user_roles (user_id, role_id, granted_by)
SELECT u.id, r.id, (SELECT id FROM users WHERE username='admin')
FROM users u JOIN roles r ON
  (u.username = 'admin'      AND r.code = 'admin')      OR
  (u.username = 'soc_manager' AND r.code = 'soc_manager') OR
  (u.username IN ('analista1','analista2') AND r.code = 'analyst') OR
  (u.username = 'auditor1'   AND r.code = 'auditor')    OR
  (u.username = 'visor1'     AND r.code = 'viewer')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. INVENTARIO DE ACTIVOS
-- ---------------------------------------------------------------------
INSERT INTO assets (hostname, ip_address, asset_type, criticality, business_owner, location, os_family, tags, is_internet_facing) VALUES
 ('SRV-DC01','10.0.0.5','server','critical','TI','Datacenter principal','Windows Server 2022','{dominio,ad}','f'),
 ('SRV-DB01','10.0.0.9','server','critical','TI','Datacenter principal','Ubuntu 22.04','{postgres,datos}','f'),
 ('SRV-WEB01','10.0.1.10','server','high','Marketing','DMZ','Ubuntu 22.04','{nginx,publico}','t'),
 ('FW-EDGE01','10.0.0.1','firewall','critical','TI','Borde perimetral','OPNsense 24.1','{perimetro,vpn}','t'),
 ('WKS-CONTAB01','10.0.4.21','workstation','high','Finanzas','Oficina central','Windows 11','{finanzas}','f'),
 ('WKS-RRHH03','10.0.4.55','workstation','medium','RRHH','Oficina central','Windows 11','{rrhh}','f'),
 ('SRV-MAIL01','10.0.2.20','server','high','TI','DMZ','Debian 12','{correo,smtp}','t'),
 ('PLC-PLANTA1','10.0.9.31','ot','critical','Operaciones','Planta industrial','Windows 10 IoT','{ot,scada}','f')
ON CONFLICT (hostname) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. OBJETIVOS KPI (baseline de gestión)
-- ---------------------------------------------------------------------
INSERT INTO kpi_targets (kpi_code, description, target_value, unit, direction) VALUES
 ('mttt_critical','MTTT para alertas críticas','900','seconds','lower_is_better'),
 ('mttt_high','MTTT para alertas altas','3600','seconds','lower_is_better'),
 ('fp_rate','Tasa de falsos positivos tolerada','0.30','percent','lower_is_better'),
 ('sla_compliance_critical','Cumplimiento SLA crítico','0.95','percent','higher_is_better'),
 ('automation_rate','Porcentaje de alertas triadas automáticamente','0.85','percent','higher_is_better'),
 ('noise_reduction','Reducción de ruido respecto al SIEM','0.70','percent','higher_is_better')
ON CONFLICT (kpi_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. INTEGRACIONES
-- ---------------------------------------------------------------------
INSERT INTO integrations (code, name, category, base_url, config, secret_ref) VALUES
 ('wazuh','Wazuh Manager','siem','https://wazuh.org.local:55000','{"verify_tls": true, "poll_interval_sec": 0}','WAZUH_API_TOKEN'),
 ('opnsense','OPNsense IDS','siem','https://fw.org.local','{"verify_tls": false}','OPNSENSE_API_KEY'),
 ('virustotal','VirusTotal','ti','https://www.virustotal.com/api/v3','{"rate_limit_per_min": 4}','VIRUSTOTAL_API_KEY'),
 ('abuseipdb','AbuseIPDB','ti','https://api.abuseipdb.com/api/v2','{"max_age_days": 90}','ABUSEIPDB_API_KEY'),
 ('geoip','MaxMind GeoLite2 / ip-api','ti','http://geoip:8080','{"local_db": true}','GEOIP_LICENSE_KEY'),
 ('slack','Slack SOC','notification','https://hooks.slack.com','{"channel": "#soc-alertas"}','SLACK_WEBHOOK_URL'),
 ('telegram','Telegram SOC','notification','https://api.telegram.org','{"chat_id": "-100123456"}','TELEGRAM_BOT_TOKEN'),
 ('osticket','osTicket','ticketing','https://soporte.org.local/api','{"default_dept": "Seguridad"}','OSTICKET_API_KEY'),
 ('ollama','Ollama (LLM local)','llm','http://ollama:11434','{"model": "llama3.1:8b", "timeout_sec": 120}','OLLAMA_HOST'),
 ('langchain','Microservicio de triaje','llm','http://langchain:8001','{"prompt_version": "triage_v3"}','INTERNAL_SERVICE_TOKEN')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. ALERTAS DE DEMOSTRACIÓN
-- ---------------------------------------------------------------------
INSERT INTO alerts (alert_fingerprint, source_type, source_name, rule_id, rule_level, rule_description,
                    rule_groups, severity, severity_raw, status, source_ip, dest_ip, agent_name, asset_id,
                    mitre_technique, full_log, raw_payload, risk_score, verdict, assigned_to, occurred_at, triaged_at)
VALUES
 ('wazuh:5710:10.0.4.21:2025-01-31T14:20Z','wazuh','wazuh-manager','5710',10,
  'Attempt to login using a non-existent user','{authentication_failed,sshd}', 'high',10,'triaged',
  '203.0.113.44','10.0.4.21','WKS-CONTAB01',(SELECT id FROM assets WHERE hostname='WKS-CONTAB01'),
  'T1110.001','sshd: Failed password for invalid user admin from 203.0.113.44',
  '{"decoder":"sshd","location":"/var/log/auth.log"}',82,'true_positive',(SELECT id FROM users WHERE username='analista1'),
  now() - INTERVAL '2 hours', now() - INTERVAL '2 hours' + INTERVAL '3 minutes'),

 ('wazuh:60106:10.0.1.10:2025-01-31T13:05Z','wazuh','wazuh-manager','60106',7,
  'Multiple web server 400 error codes from same source IP','{web,appsec}', 'medium',7,'triaged',
  '198.51.100.77','10.0.1.10','SRV-WEB01',(SELECT id FROM assets WHERE hostname='SRV-WEB01'),
  'T1595.002','nginx: 42 requests with status 400 in 60s','{"decoder":"web-accesslog"}',34,'benign',
  (SELECT id FROM users WHERE username='analista2'), now() - INTERVAL '5 hours', now() - INTERVAL '5 hours' + INTERVAL '8 minutes'),

 ('opnsense:ids_alert:10.0.9.31:2025-01-31T11:40Z','opnsense','opnsense-ids','IDS-9001',12,
  'ET MALWARE Possible Cobalt Strike Beacon','{ids,et_malware}', 'critical',12,'escalated',
  '10.0.9.31','192.0.2.55','PLC-PLANTA1',(SELECT id FROM assets WHERE hostname='PLC-PLANTA1'),
  'T1071.001','Suricata: ET MALWARE Cobalt Strike Malleable C2','{"sid":"2019141"}',95,'true_positive',
  (SELECT id FROM users WHERE username='soc_manager'), now() - INTERVAL '1 day', now() - INTERVAL '1 day' + INTERVAL '2 minutes'),

 ('wazuh:5501:10.0.0.9:2025-01-30T09:12Z','wazuh','wazuh-manager','5501',5,
  'PAM: Login session opened','{pam,syslog}', 'info',5,'false_positive',
  '10.0.4.21','10.0.0.9','SRV-DB01',(SELECT id FROM assets WHERE hostname='SRV-DB01'),
  NULL,'pam_unix(cron:session): session opened for user postgres','{"decoder":"pam"}',5,'false_positive',
  (SELECT id FROM users WHERE username='analista1'), now() - INTERVAL '2 days', now() - INTERVAL '2 days' + INTERVAL '1 minute'),

 ('wazuh:87105:10.0.0.5:2025-01-31T16:02Z','wazuh','wazuh-manager','87105',12,
  'Possible ransomware behavior detected: mass file encryption','{ransomware,sysmon}', 'critical',12,'pending',
  '10.0.4.55','10.0.0.5','SRV-DC01',(SELECT id FROM assets WHERE hostname='SRV-DC01'),
  'T1486','sysmon: 1200 file writes with extension .locked in 30s','{"decoder":"sysmon"}',NULL,NULL,
  NULL, now() - INTERVAL '12 minutes', NULL)
ON CONFLICT (alert_fingerprint) DO NOTHING;

-- Triajes (resultados LLM) para las alertas demo
INSERT INTO triage_results (alert_id, verdict, severity, risk_score, confidence, summary, reasoning,
       recommended_actions, mitre_techniques, iocs, model_name, model_provider, prompt_version,
       tokens_in, tokens_out, latency_ms, tools_used, human_feedback, feedback_by, feedback_at, is_current)
SELECT a.id, v.verdict::triage_verdict, v.severity::severity_level, v.risk_score, v.confidence,
       v.summary, v.reasoning::jsonb, v.actions::jsonb, v.mitre::text[], v.iocs::jsonb,
       'llama3.1:8b','ollama','triage_v3', 2140, 372, 6180,
       ARRAY['abuseipdb_lookup','geoip_lookup','wazuh_context'], v.feedback,
       (SELECT id FROM users WHERE username='analista1'), now() - INTERVAL '1 hour', TRUE
FROM alerts a
JOIN (VALUES
 ('wazuh:5710:10.0.4.21:2025-01-31T14:20Z','true_positive','high',82,0.91,
  'Ataque de fuerza bruta SSH contra WKS-CONTAB01 desde IP con 94% de reputación maliciosa en AbuseIPDB (312 reportes). 187 intentos en 4 minutos con usuarios inexistentes; no se observa autenticación exitosa.',
  '["La IP origen 203.0.113.44 aparece con 312 reportes de abuso en AbuseIPDB (score 94/100)","El patrón de 187 fallos de autenticación en 240 s corresponde a fuerza bruta automatizada (T1110.001)","El activo destino tiene criticidad alta (estación de Finanzas)","No hay eventos de autenticación exitosa posteriores al ataque","Regla Wazuh 5710 con nivel 10 es consistente con el comportamiento observado"]',
  '[{"order":1,"action":"Bloquear IP 203.0.113.44 en FW-EDGE01 durante 24 h","priority":"p1"},{"order":2,"action":"Forzar cambio de contraseña de cuentas locales del activo","priority":"p2"},{"order":3,"action":"Verificar integridad y ausencia de persistencia en WKS-CONTAB01","priority":"p2"}]',
  '{T1110.001,T1078}','[{"type":"ip","value":"203.0.113.44","verdict":"malicious","source":"abuseipdb","score":94}]','confirmed_tp'),

 ('wazuh:60106:10.0.1.10:2025-01-31T13:05Z','benign','medium',34,0.78,
  'Errores 400 generados por escáner de vulnerabilidades corporativo autorizado (Tenable) según rango de fechas de la ventana de escaneo; el User-Agent coincide con la herramienta aprobada.',
  '["El User-Agent corresponde a Nessus/Tenable, herramienta autorizada en el CMDB","La ventana horaria coincide con el escaneo planificado de la semana","No hay payloads de explotación ni respuestas 200 anómalas","La IP origen pertenece al rango interno de gestión de vulnerabilidades"]',
  '[{"order":1,"action":"Marcar regla 60106 como ruido durante ventanas de escaneo","priority":"p4"},{"order":2,"action":"Añadir exclusión temporal en la política de correlación","priority":"p4"}]',
  '{T1595.002}','[{"type":"ip","value":"198.51.100.77","verdict":"clean","source":"geoip","score":0}]','confirmed_fp'),

 ('opnsense:ids_alert:10.0.9.31:2025-01-31T11:40Z','true_positive','critical',95,0.94,
  'Posible baliza Cobalt Strike desde un PLC en red OT hacia 192.0.2.55, con periodicidad de 60 s y JA3 anómalo. Riesgo de compromiso de red industrial y movimiento lateral hacia SCADA.',
  '["Firma Suricata 2019141 (ET MALWARE Cobalt Strike Malleable C2) con confianza alta","La comunicación tiene periodicidad fija de 60 s (±2 s), patrón típico de beaconing","El origen es un activo OT/SCADA con criticidad crítica y sin tráfico a Internet esperado","El destino 192.0.2.55 no figura en ningún inventario ni allowlist de la organización","Ausencia de ventana de mantenimiento autorizada en ese horario"]',
  '[{"order":1,"action":"Aislar PLC-PLANTA1 a nivel de red (microsegmentación) de inmediato","priority":"p1"},{"order":2,"action":"Bloquear 192.0.2.55 en el perímetro y en el IDS","priority":"p1"},{"order":3,"action":"Activar protocolo de respuesta a incidentes OT y notificar a Operaciones","priority":"p1"},{"order":4,"action":"Capturar memoria y tráfico para análisis forense","priority":"p2"}]',
  '{T1071.001,T1021,T1105}','[{"type":"ip","value":"192.0.2.55","verdict":"malicious","source":"virustotal","score":88}]','confirmed_tp'),

 ('wazuh:5501:10.0.0.9:2025-01-30T09:12Z','false_positive','info',5,0.96,
  'Apertura de sesión PAM por tarea programada (cron) del usuario postgres; comportamiento esperado y documentado en la línea base.',
  '["El proceso padre es cron, no una sesión interactiva","El usuario postgres ejecuta tareas de mantenimiento diarias a esa hora","El origen es una IP interna del segmento de base de datos","Regla 5501 tiene nivel informativo y no indica anomalía"]',
  '[{"order":1,"action":"Añadir supresión para la regla 5501 cuando el proceso padre sea cron","priority":"p4"}]',
  '{}','[]','confirmed_fp')
) AS v(fp, verdict, severity, risk_score, confidence, summary, reasoning, actions, mitre, iocs, feedback)
  ON a.alert_fingerprint = v.fp
WHERE NOT EXISTS (SELECT 1 FROM triage_results t WHERE t.alert_id = a.id);

-- Enriquecimiento de ejemplo
INSERT INTO enrichment_data (alert_id, provider, indicator, indicator_type, verdict, score, malicious_count, total_engines, country, asn, as_owner, raw_response, cache_hit)
SELECT a.id, 'abuseipdb', '203.0.113.44','ip','malicious',94,312,NULL,'CN','AS4134','CHINANET-BACKBONE','{"abuseConfidenceScore":94,"totalReports":312}', FALSE
FROM alerts a WHERE a.alert_fingerprint='wazuh:5710:10.0.4.21:2025-01-31T14:20Z'
ON CONFLICT DO NOTHING;

INSERT INTO enrichment_data (alert_id, provider, indicator, indicator_type, verdict, score, malicious_count, total_engines, country, asn, as_owner, raw_response, cache_hit)
SELECT a.id, 'virustotal', '192.0.2.55','ip','malicious',88,52,72,'NL','AS9009','M247 Europe','{"last_analysis_stats":{"malicious":52,"suspicious":4,"harmless":16}}', FALSE
FROM alerts a WHERE a.alert_fingerprint='opnsense:ids_alert:10.0.9.31:2025-01-31T11:40Z'
ON CONFLICT DO NOTHING;

INSERT INTO enrichment_data (alert_id, provider, indicator, indicator_type, verdict, score, country, asn, as_owner, raw_response, cache_hit)
SELECT a.id, 'geoip', '198.51.100.77','ip','clean',0,'CL','AS27651','ENTEL CHILE','{"city":"Santiago","country":"CL"}', TRUE
FROM alerts a WHERE a.alert_fingerprint='wazuh:60106:10.0.1.10:2025-01-31T13:05Z'
ON CONFLICT DO NOTHING;

-- Incidente de demostración (caso OT)
INSERT INTO incidents (incident_code, title, description, status, priority, severity, category,
                       mitre_tactics, detected_at, owner_id, impact, created_by)
VALUES ('INC-2025-00088','Posible compromiso de PLC en red OT (baliza Cobalt Strike)',
        'Detección de beaconing hacia infraestructura C2 desde activo OT PLC-PLANTA1. Aislado preventivamente.',
        'contained','p1','critical','intrusion','{Command and Control,Lateral Movement}',
        now() - INTERVAL '1 day', (SELECT id FROM users WHERE username='soc_manager'),
        'Potencial interrupción de línea de producción y riesgo de movimiento lateral hacia SCADA.',
        (SELECT id FROM users WHERE username='analista1'))
ON CONFLICT (incident_code) DO NOTHING;

INSERT INTO incident_alerts (incident_id, alert_id, linked_by)
SELECT i.id, a.id, (SELECT id FROM users WHERE username='soc_manager')
FROM incidents i, alerts a
WHERE i.incident_code='INC-2025-00088'
  AND a.alert_fingerprint='opnsense:ids_alert:10.0.9.31:2025-01-31T11:40Z'
ON CONFLICT DO NOTHING;

INSERT INTO incident_actions (incident_id, action_type, description, status, automated, performed_by, started_at, finished_at)
SELECT i.id, 'isolate_host', 'Aislamiento de red de PLC-PLANTA1 (microsegmentación)', 'done', TRUE,
       (SELECT id FROM users WHERE username='soc_manager'), now() - INTERVAL '23 hours', now() - INTERVAL '23 hours' + INTERVAL '2 minutes'
FROM incidents i WHERE i.incident_code='INC-2025-00088'
ON CONFLICT DO NOTHING;

INSERT INTO incident_actions (incident_id, action_type, description, status, automated, performed_by, started_at, finished_at)
SELECT i.id, 'block_ip', 'Bloqueo de 192.0.2.55 en perímetro e IDS', 'done', FALSE,
       (SELECT id FROM users WHERE username='soc_manager'), now() - INTERVAL '22 hours', now() - INTERVAL '22 hours' + INTERVAL '6 minutes'
FROM incidents i WHERE i.incident_code='INC-2025-00088'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 8. BITÁCORA DE AUDITORÍA (eventos de ejemplo con entrada/salida por módulo)
-- ---------------------------------------------------------------------
INSERT INTO audit_log (occurred_at, user_id, username, module, action, entity, entity_id, result,
                       detail, ip_address, user_agent, http_method, http_path, http_status, duration_ms, severity)
VALUES
 (now() - INTERVAL '3 hours','3','analista1','auth','LOGIN','session',NULL,'success','Inicio de sesión exitoso','10.10.2.44','Mozilla/5.0','POST','/api/v1/auth/login',200,142,'info'),
 (now() - INTERVAL '3 hours','3','analista1','alerts','READ','alert','1','success','Consulta de listado de alertas severidad=high','10.10.2.44','Mozilla/5.0','GET','/api/v1/alerts',200,88,'info'),
 (now() - INTERVAL '3 hours','3','analista1','triage','TRIAGE_RUN','alert','1','success','Triaje LLM ejecutado (llama3.1:8b)','10.10.2.44','Mozilla/5.0','POST','/api/v1/triage/1/run',200,6210,'info'),
 (now() - INTERVAL '3 hours','3','analista1','alerts','UPDATE','alert','1','success','Cambio de estado pending → triaged','10.10.2.44','Mozilla/5.0','PATCH','/api/v1/alerts/1',200,64,'info'),
 (now() - INTERVAL '2 hours','2','soc_manager','incidents','CREATE','incident','88','success','Creación de incidente INC-2025-00088','10.10.2.10','Mozilla/5.0','POST','/api/v1/incidents',201,210,'warning'),
 (now() - INTERVAL '2 hours','2','soc_manager','reports','EXPORT','report','12','success','Reporte gerencial exportado en PDF','10.10.2.10','Mozilla/5.0','GET','/api/v1/reports/management',200,1840,'info'),
 (now() - INTERVAL '1 hour','5','auditor1','audit','READ','audit_log',NULL,'success','Consulta de bitácora (rango 24 h)','10.10.3.7','Mozilla/5.0','GET','/api/v1/audit/logs',200,120,'info'),
 (now() - INTERVAL '40 minutes',NULL,'desconocido','auth','LOGIN_FAILED','session',NULL,'failure','Credenciales inválidas para usuario admin','203.0.113.44','curl/8.4.0','POST','/api/v1/auth/login',401,95,'critical'),
 (now() - INTERVAL '30 minutes','3','analista1','triage','TRIAGE_FEEDBACK','alert','2','success','Etiquetado humano: confirmed_fp','10.10.2.44','Mozilla/5.0','POST','/api/v1/triage/2/feedback',200,72,'info'),
 (now() - INTERVAL '10 minutes','1','admin','roles','ROLE_ASSIGN','user','4','success','Asignación de rol analyst a analista2','10.10.2.2','Mozilla/5.0','POST','/api/v1/users/4/roles',200,110,'warning');

COMMIT;

-- Verificación rápida
-- SELECT 'users' t, count(*) FROM soclite.users UNION ALL
-- SELECT 'alerts', count(*) FROM soclite.alerts UNION ALL
-- SELECT 'triage_results', count(*) FROM soclite.triage_results UNION ALL
-- SELECT 'audit_log', count(*) FROM soclite.audit_log;
