-- =====================================================================
-- SOC-Lite · Esquema PostgreSQL 15+  (base de datos principal)
-- Autor: Arquitectura de Soluciones · Ciberseguridad
-- Normas de referencia: ISO/IEC 27001:2022 (A.8.15, A.5.24, A.5.28),
--                        NIST CSF 2.0 (DE.AE, RS.AN, RS.MA, GV.OC)
-- Ejecutar:  psql -U soclite -d soclite -f db/schema.sql
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid(), crypt()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- búsqueda difusa (ILIKE indexado)
CREATE EXTENSION IF NOT EXISTS "btree_gin";   -- índices GIN compuestos
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"; -- observabilidad SQL (opcional)

CREATE SCHEMA IF NOT EXISTS soclite;
SET search_path TO soclite, public;

-- ---------------------------------------------------------------------
-- 1. TIPOS ENUMERADOS
-- ---------------------------------------------------------------------
CREATE TYPE severity_level  AS ENUM ('info','low','medium','high','critical');
CREATE TYPE alert_status    AS ENUM ('pending','enriching','triaged','escalated','closed','false_positive');
CREATE TYPE triage_verdict  AS ENUM ('true_positive','false_positive','benign','suspicious','inconclusive');
CREATE TYPE incident_status AS ENUM ('open','in_progress','contained','resolved','closed');
CREATE TYPE priority_level  AS ENUM ('p1','p2','p3','p4');
CREATE TYPE source_type     AS ENUM ('wazuh','opnsense','suricata','zeek','manual','api');
CREATE TYPE audit_result    AS ENUM ('success','failure','denied');
CREATE TYPE audit_action    AS ENUM ('LOGIN','LOGOUT','LOGIN_FAILED','CREATE','READ','UPDATE',
                                     'DELETE','EXPORT','TRIAGE_RUN','TRIAGE_FEEDBACK',
                                     'ROLE_ASSIGN','CONFIG_CHANGE');
CREATE TYPE report_format   AS ENUM ('pdf','docx','xlsx','csv');

-- ---------------------------------------------------------------------
-- 2. RBAC: usuarios, roles, permisos
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                BIGSERIAL PRIMARY KEY,
    username          VARCHAR(64)  NOT NULL UNIQUE,
    email             VARCHAR(255) NOT NULL UNIQUE,
    full_name         VARCHAR(160) NOT NULL,
    hashed_password   TEXT         NOT NULL,
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    is_system         BOOLEAN      NOT NULL DEFAULT FALSE,
    must_change_pwd   BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_enabled       BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_secret        TEXT,
    failed_attempts   SMALLINT     NOT NULL DEFAULT 0,
    locked_until      TIMESTAMPTZ,
    last_login_at     TIMESTAMPTZ,
    last_login_ip     INET,
    phone             VARCHAR(32),
    department        VARCHAR(120),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    CONSTRAINT users_username_len CHECK (char_length(username) >= 3)
);
CREATE INDEX idx_users_active  ON users (is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email_l ON users (lower(email));

CREATE TABLE roles (
    id           BIGSERIAL PRIMARY KEY,
    code         VARCHAR(48)  NOT NULL UNIQUE,   -- admin, soc_manager, analyst, auditor, viewer
    name         VARCHAR(96)  NOT NULL,
    description  TEXT,
    is_system    BOOLEAN      NOT NULL DEFAULT FALSE, -- no borrable
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id       BIGSERIAL PRIMARY KEY,
    code     VARCHAR(64) NOT NULL UNIQUE,   -- alerts:read
    module   VARCHAR(48) NOT NULL,          -- alerts
    action   VARCHAR(48) NOT NULL,          -- read
    description TEXT
);
CREATE INDEX idx_permissions_module ON permissions (module);

CREATE TABLE user_roles (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    granted_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
    role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jti         UUID   NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    token_hash  TEXT   NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    ip_address  INET,
    user_agent  TEXT
);
CREATE INDEX idx_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. INVENTARIO DE ACTIVOS (contexto para el triaje)
-- ---------------------------------------------------------------------
CREATE TABLE assets (
    id             BIGSERIAL PRIMARY KEY,
    hostname       VARCHAR(160) NOT NULL,
    ip_address     INET,
    mac_address    MACADDR,
    asset_type     VARCHAR(48)  NOT NULL DEFAULT 'server', -- server|workstation|firewall|ot|cloud|mobile
    criticality    VARCHAR(16)  NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low','medium','high','critical')),
    business_owner VARCHAR(160),
    location       VARCHAR(120),
    os_family      VARCHAR(64),
    tags           TEXT[]       NOT NULL DEFAULT '{}',
    is_internet_facing BOOLEAN  NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (hostname)
);
CREATE INDEX idx_assets_ip ON assets (ip_address);

-- ---------------------------------------------------------------------
-- 4. ALERTAS (núcleo)
-- ---------------------------------------------------------------------
CREATE TABLE alerts (
    id                 BIGSERIAL PRIMARY KEY,
    alert_fingerprint  VARCHAR(255) NOT NULL UNIQUE,   -- clave de idempotencia
    external_id        VARCHAR(160),
    source_type        source_type  NOT NULL DEFAULT 'wazuh',
    source_name        VARCHAR(120),
    rule_id            VARCHAR(64),
    rule_level         SMALLINT,                       -- nivel crudo del SIEM (0-15 Wazuh)
    rule_description   TEXT,
    rule_groups        TEXT[] NOT NULL DEFAULT '{}',
    severity           severity_level NOT NULL DEFAULT 'medium',
    severity_raw       SMALLINT,
    status             alert_status NOT NULL DEFAULT 'pending',
    source_ip          INET,
    source_port        INTEGER,
    dest_ip            INET,
    dest_port          INTEGER,
    protocol           VARCHAR(16),
    agent_id           VARCHAR(64),
    agent_name         VARCHAR(160),
    asset_id           BIGINT REFERENCES assets(id) ON DELETE SET NULL,
    mitre_technique    VARCHAR(24),
    mitre_tactic       VARCHAR(48),
    full_log           TEXT,
    raw_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    risk_score         SMALLINT CHECK (risk_score BETWEEN 0 AND 100),
    verdict            triage_verdict,
    dedup_count        INTEGER NOT NULL DEFAULT 1,
    is_suppressed      BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_to        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    occurred_at        TIMESTAMPTZ NOT NULL,
    ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    triaged_at         TIMESTAMPTZ,
    closed_at          TIMESTAMPTZ,
    mttt_seconds       INTEGER,                        -- Mean Time To Triage
    mttr_seconds       INTEGER,                        -- Mean Time To Respond
    sla_due_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ
);
CREATE INDEX idx_alerts_occurred   ON alerts (occurred_at DESC);
CREATE INDEX idx_alerts_status_sev ON alerts (status, severity, occurred_at DESC);
CREATE INDEX idx_alerts_source_ip  ON alerts (source_ip);
CREATE INDEX idx_alerts_agent      ON alerts (agent_name);
CREATE INDEX idx_alerts_rule       ON alerts (rule_id);
CREATE INDEX idx_alerts_assigned   ON alerts (assigned_to) WHERE status NOT IN ('closed','false_positive');
CREATE INDEX idx_alerts_risk       ON alerts (risk_score DESC NULLS LAST);
CREATE INDEX idx_alerts_raw_gin    ON alerts USING GIN (raw_payload jsonb_path_ops);
CREATE INDEX idx_alerts_groups_gin ON alerts USING GIN (rule_groups);
CREATE INDEX idx_alerts_desc_trgm  ON alerts USING GIN (rule_description gin_trgm_ops);

COMMENT ON COLUMN alerts.alert_fingerprint IS 'sha256(source_type|rule_id|source_ip|bucket temporal) — deduplicación';

-- ---------------------------------------------------------------------
-- 5. ENRIQUECIMIENTO (IOC externos)
-- ---------------------------------------------------------------------
CREATE TABLE enrichment_data (
    id            BIGSERIAL PRIMARY KEY,
    alert_id      BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    provider      VARCHAR(48) NOT NULL,      -- virustotal|abuseipdb|geoip|shodan|otx|misp|whois
    indicator     VARCHAR(512) NOT NULL,
    indicator_type VARCHAR(24) NOT NULL,     -- ip|domain|url|hash|email|cve
    verdict       VARCHAR(24),               -- malicious|suspicious|clean|unknown
    score         NUMERIC(6,2),              -- 0-100 o ratio del proveedor
    malicious_count INTEGER,
    total_engines  INTEGER,
    country       VARCHAR(64),
    asn           VARCHAR(64),
    as_owner      VARCHAR(160),
    raw_response  JSONB NOT NULL DEFAULT '{}'::jsonb,
    cache_hit     BOOLEAN NOT NULL DEFAULT FALSE,
    queried_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    UNIQUE (alert_id, provider, indicator, indicator_type)
);
CREATE INDEX idx_enrich_alert    ON enrichment_data (alert_id);
CREATE INDEX idx_enrich_indicator ON enrichment_data (indicator, indicator_type);
CREATE INDEX idx_enrich_verdict  ON enrichment_data (verdict);

-- ---------------------------------------------------------------------
-- 6. RESULTADOS DE TRIAJE (salida LLM)
-- ---------------------------------------------------------------------
CREATE TABLE triage_results (
    id                  BIGSERIAL PRIMARY KEY,
    alert_id            BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    verdict             triage_verdict NOT NULL,
    severity            severity_level NOT NULL,
    risk_score          SMALLINT CHECK (risk_score BETWEEN 0 AND 100),
    confidence          NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
    summary             TEXT NOT NULL,
    reasoning           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- cadena de razonamiento
    recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{order,action,priority}]
    mitre_techniques    TEXT[] NOT NULL DEFAULT '{}',
    iocs                JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_name          VARCHAR(96) NOT NULL,
    model_provider      VARCHAR(32) NOT NULL DEFAULT 'ollama', -- ollama|openai|azure
    prompt_version      VARCHAR(24) NOT NULL DEFAULT 'triage_v1',
    temperature         NUMERIC(3,2) DEFAULT 0.1,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    cost_usd            NUMERIC(10,6) DEFAULT 0,
    latency_ms          INTEGER,
    tools_used          TEXT[] NOT NULL DEFAULT '{}',
    langsmith_run_id    VARCHAR(96),
    trace_id            UUID,
    human_feedback      VARCHAR(24),                          -- confirmed_tp|confirmed_fp|unknown
    feedback_comment    TEXT,
    feedback_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    feedback_at         TIMESTAMPTZ,
    is_current          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_triage_alert   ON triage_results (alert_id, created_at DESC);
CREATE INDEX idx_triage_verdict ON triage_results (verdict, created_at DESC);
CREATE INDEX idx_triage_model   ON triage_results (model_name, prompt_version);
CREATE UNIQUE INDEX uq_triage_current ON triage_results (alert_id) WHERE is_current;

-- ---------------------------------------------------------------------
-- 7. INCIDENTES
-- ---------------------------------------------------------------------
CREATE TABLE incidents (
    id             BIGSERIAL PRIMARY KEY,
    incident_code  VARCHAR(32) NOT NULL UNIQUE,   -- INC-2025-00088
    title          VARCHAR(255) NOT NULL,
    description    TEXT,
    status         incident_status NOT NULL DEFAULT 'open',
    priority       priority_level  NOT NULL DEFAULT 'p3',
    severity       severity_level  NOT NULL DEFAULT 'medium',
    category       VARCHAR(64),                   -- malware|intrusion|phishing|dos|insider|other
    mitre_tactics  TEXT[] NOT NULL DEFAULT '{}',
    detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    contained_at   TIMESTAMPTZ,
    resolved_at    TIMESTAMPTZ,
    closed_at      TIMESTAMPTZ,
    owner_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    external_ticket_id VARCHAR(64),
    external_ticket_url TEXT,
    impact         TEXT,
    root_cause     TEXT,
    lessons_learned TEXT,
    created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_incidents_status ON incidents (status, priority, detected_at DESC);

CREATE TABLE incident_alerts (
    incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    alert_id    BIGINT NOT NULL REFERENCES alerts(id)    ON DELETE CASCADE,
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    linked_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (incident_id, alert_id)
);

CREATE TABLE incident_actions (
    id           BIGSERIAL PRIMARY KEY,
    incident_id  BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    action_type  VARCHAR(48) NOT NULL,   -- isolate_host|block_ip|reset_credentials|ticket|notify|forensics
    description  TEXT NOT NULL,
    status       VARCHAR(24) NOT NULL DEFAULT 'pending', -- pending|running|done|failed
    automated    BOOLEAN NOT NULL DEFAULT FALSE,
    performed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    result       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_incident_actions ON incident_actions (incident_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. BITÁCORA DE AUDITORÍA (rastro inmutable)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    id           BIGSERIAL PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    username     VARCHAR(64),                     -- desnormalizado: sobrevive al borrado
    module       VARCHAR(48) NOT NULL,            -- auth|users|roles|alerts|triage|incidents|dashboard|reports|audit|settings
    action       audit_action NOT NULL,
    entity       VARCHAR(48),
    entity_id    VARCHAR(64),
    result       audit_result NOT NULL DEFAULT 'success',
    detail       TEXT,
    before_data  JSONB,
    after_data   JSONB,
    changes      JSONB,                           -- diff calculado
    ip_address   INET,
    user_agent   TEXT,
    http_method  VARCHAR(10),
    http_path    TEXT,
    http_status  SMALLINT,
    duration_ms  INTEGER,
    trace_id     UUID,
    session_id   VARCHAR(64),
    severity     VARCHAR(16) NOT NULL DEFAULT 'info',   -- info|warning|critical (para SIEM interno)
    hash_prev    CHAR(64),
    hash_self    CHAR(64)
);
CREATE INDEX idx_audit_occurred ON audit_log (occurred_at DESC);
CREATE INDEX idx_audit_user     ON audit_log (user_id, occurred_at DESC);
CREATE INDEX idx_audit_module   ON audit_log (module, action, occurred_at DESC);
CREATE INDEX idx_audit_entity   ON audit_log (entity, entity_id);
CREATE INDEX idx_audit_result   ON audit_log (result) WHERE result <> 'success';

-- Regla de negocio: la bitácora no se modifica ni se borra (ISO 27001 A.8.15)
CREATE OR REPLACE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- Función de encadenamiento de hashes (evidencia a prueba de manipulación)
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER AS $$
DECLARE prev_hash CHAR(64);
BEGIN
    SELECT hash_self INTO prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
    NEW.hash_prev := COALESCE(prev_hash, repeat('0', 64));
    NEW.hash_self := encode(digest(
        NEW.hash_prev || NEW.occurred_at::text || COALESCE(NEW.username,'') ||
        NEW.module || NEW.action::text || COALESCE(NEW.entity_id,'') || NEW.result::text, 'sha256'), 'hex');
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- ---------------------------------------------------------------------
-- 9. AGREGADOS PARA DASHBOARD (refresco por job nocturno / n8n)
-- ---------------------------------------------------------------------
CREATE TABLE alert_metrics_daily (
    metric_date    DATE NOT NULL,
    source_type    source_type NOT NULL,
    severity       severity_level NOT NULL,
    alerts_total   INTEGER NOT NULL DEFAULT 0,
    alerts_tp      INTEGER NOT NULL DEFAULT 0,
    alerts_fp      INTEGER NOT NULL DEFAULT 0,
    alerts_escalated INTEGER NOT NULL DEFAULT 0,
    mttt_avg_sec   NUMERIC(10,2),
    mttt_p95_sec   NUMERIC(10,2),
    mttr_avg_sec   NUMERIC(10,2),
    automation_rate NUMERIC(5,4),
    PRIMARY KEY (metric_date, source_type, severity)
);
CREATE INDEX idx_metrics_date ON alert_metrics_daily (metric_date DESC);

CREATE TABLE kpi_targets (
    id           BIGSERIAL PRIMARY KEY,
    kpi_code     VARCHAR(48) NOT NULL UNIQUE,   -- mttt_critical, fp_rate, sla_high
    description  TEXT NOT NULL,
    target_value NUMERIC(12,4) NOT NULL,
    unit         VARCHAR(24) NOT NULL,          -- seconds|percent|count
    direction    VARCHAR(16) NOT NULL DEFAULT 'lower_is_better',
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------
-- 10. INTEGRACIONES, NOTIFICACIONES Y REPORTES
-- ---------------------------------------------------------------------
CREATE TABLE integrations (
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(48) NOT NULL UNIQUE,  -- wazuh|virustotal|abuseipdb|slack|osticket|ollama
    name          VARCHAR(120) NOT NULL,
    category      VARCHAR(48) NOT NULL,         -- siem|ti|notification|ticketing|llm
    base_url      TEXT,
    is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    config        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- sin secretos en claro
    secret_ref    VARCHAR(120),                          -- referencia a Vault/.env
    last_ok_at    TIMESTAMPTZ,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id           BIGSERIAL PRIMARY KEY,
    alert_id     BIGINT REFERENCES alerts(id) ON DELETE CASCADE,
    incident_id  BIGINT REFERENCES incidents(id) ON DELETE CASCADE,
    channel      VARCHAR(24) NOT NULL,          -- slack|telegram|email|teams
    target       VARCHAR(160),
    severity     severity_level,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       VARCHAR(24) NOT NULL DEFAULT 'queued', -- queued|sent|failed
    attempts     SMALLINT NOT NULL DEFAULT 0,
    sent_at      TIMESTAMPTZ,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_status ON notifications (status, created_at DESC);

CREATE TABLE generated_reports (
    id            BIGSERIAL PRIMARY KEY,
    report_type   VARCHAR(48) NOT NULL,        -- operational|management|audit
    report_format report_format NOT NULL,
    title         VARCHAR(255) NOT NULL,
    period_from   TIMESTAMPTZ,
    period_to     TIMESTAMPTZ,
    file_path     TEXT NOT NULL,
    file_size     BIGINT,
    checksum_sha256 CHAR(64),
    parameters    JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    status        VARCHAR(24) NOT NULL DEFAULT 'completed',
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ
);
CREATE INDEX idx_reports_type ON generated_reports (report_type, created_at DESC);

-- ---------------------------------------------------------------------
-- 11. VISTAS DE APOYO (dashboard y reportes)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_alert_triage AS
SELECT a.id, a.alert_fingerprint, a.source_type, a.rule_id, a.rule_description,
       a.severity AS severity_siem, t.severity AS severity_llm, a.status, a.risk_score,
       t.verdict, t.confidence, t.summary, t.model_name, t.prompt_version,
       a.source_ip, a.agent_name, a.occurred_at, a.triaged_at, a.mttt_seconds,
       a.assigned_to, t.human_feedback
FROM alerts a
LEFT JOIN triage_results t ON t.alert_id = a.id AND t.is_current
WHERE a.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_fp_rate_by_rule AS
SELECT a.rule_id,
       a.rule_description,
       count(*)                                             AS total,
       count(*) FILTER (WHERE t.verdict = 'false_positive')  AS fp,
       round(100.0 * count(*) FILTER (WHERE t.verdict = 'false_positive') / NULLIF(count(*),0), 2) AS fp_pct,
       round(avg(a.mttt_seconds), 1)                        AS mttt_avg_sec
FROM alerts a
JOIN triage_results t ON t.alert_id = a.id AND t.is_current
WHERE a.deleted_at IS NULL
GROUP BY a.rule_id, a.rule_description
ORDER BY total DESC;

CREATE OR REPLACE VIEW v_mttt_daily AS
SELECT date_trunc('day', occurred_at)::date AS dia,
       severity,
       count(*)                     AS n,
       round(avg(mttt_seconds))     AS mttt_avg_sec,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY mttt_seconds) AS mttt_p95_sec
FROM alerts
WHERE deleted_at IS NULL AND mttt_seconds IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_analyst_workload AS
SELECT u.id AS user_id, u.username, u.full_name,
       count(a.id) FILTER (WHERE a.status IN ('pending','enriching','triaged')) AS abiertas,
       count(a.id) FILTER (WHERE a.status = 'escalated') AS escaladas,
       count(a.id) FILTER (WHERE a.status IN ('closed','false_positive')) AS cerradas,
       round(avg(a.mttt_seconds)) AS mttt_promedio
FROM users u
LEFT JOIN alerts a ON a.assigned_to = u.id AND a.deleted_at IS NULL
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.username, u.full_name
ORDER BY abiertas DESC;

-- ---------------------------------------------------------------------
-- 12. TRIGGERS DE MANTENIMIENTO
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','assets','alerts','incidents'] LOOP
    EXECUTE format('CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t);
  END LOOP;
END $$;

-- Cálculo automático de MTTT y SLA al pasar a estado triaged
CREATE OR REPLACE FUNCTION compute_mttt() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('triaged','escalated','closed','false_positive') AND NEW.mttt_seconds IS NULL THEN
        NEW.mttt_seconds := GREATEST(0, EXTRACT(EPOCH FROM (now() - NEW.occurred_at))::int);
    END IF;
    IF NEW.status IN ('closed','false_positive') AND NEW.closed_at IS NULL THEN
        NEW.closed_at  := now();
        NEW.mttr_seconds := GREATEST(0, EXTRACT(EPOCH FROM (now() - NEW.occurred_at))::int);
    END IF;
    -- SLA por severidad: crítica 15 min, alta 1 h, media 8 h, baja 24 h
    IF NEW.sla_due_at IS NULL THEN
        NEW.sla_due_at := NEW.occurred_at + CASE NEW.severity
            WHEN 'critical' THEN INTERVAL '15 minutes'
            WHEN 'high'     THEN INTERVAL '1 hour'
            WHEN 'medium'   THEN INTERVAL '8 hours'
            ELSE INTERVAL '24 hours' END;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alerts_mttt BEFORE INSERT OR UPDATE ON alerts
FOR EACH ROW EXECUTE FUNCTION compute_mttt();

COMMIT;
