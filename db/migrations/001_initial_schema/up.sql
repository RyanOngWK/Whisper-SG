-- Migration: 001_initial_schema
-- Core tables for the Voice AI SaaS platform.
-- Designed for session-based auditing with strict data retention.

-- ── Clinics (multi-tenant) ────────────────────────────────────

CREATE TABLE clinics (
    clinic_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    external_id TEXT UNIQUE,   -- PMS-side identifier (e.g. Plato clinic number)
    timezone    TEXT NOT NULL DEFAULT 'Asia/Singapore',
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Providers (doctors / dentists / hygienists) ──────────────

CREATE TABLE providers (
    provider_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id   UUID NOT NULL REFERENCES clinics(clinic_id),
    external_id TEXT,          -- PMS-side provider ID
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    mcr         TEXT,          -- Singapore Medical Council registration number
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_providers_clinic ON providers(clinic_id);

-- ── Operatories ───────────────────────────────────────────────

CREATE TABLE operatories (
    operatory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id    UUID NOT NULL REFERENCES clinics(clinic_id),
    name         TEXT NOT NULL,
    external_id  TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_operatories_clinic ON operatories(clinic_id);

-- ── Call Sessions (audit root) ────────────────────────────────

CREATE TABLE call_sessions (
    session_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id      UUID NOT NULL REFERENCES clinics(clinic_id),
    call_sid       TEXT NOT NULL,                 -- Twilio Call SID
    direction      TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_number    TEXT NOT NULL,                 -- caller's number (redacted before log)
    to_number      TEXT NOT NULL,                 -- clinic's Twilio number
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'completed', 'failed', 'transferred')),
    patient_id     UUID,                          -- resolved after patient_identify
    consent_status TEXT NOT NULL DEFAULT 'pending'
                   CHECK (consent_status IN ('pending', 'granted', 'declined')),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at       TIMESTAMPTZ,
    duration_secs  INT,                           -- denormalized from ended_at - started_at

    -- Encrypted JSONB for call metadata (Twilio raw events, etc.)
    -- Column-level encryption via pgcrypto or app-level KMS before insert.
    metadata       JSONB NOT NULL DEFAULT '{}',

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_clinic   ON call_sessions(clinic_id);
CREATE INDEX idx_sessions_status   ON call_sessions(status);
CREATE INDEX idx_sessions_started  ON call_sessions(started_at);
CREATE INDEX idx_sessions_patient  ON call_sessions(patient_id);

-- ── Conversation Turns (one row per user or assistant utterance) ─

CREATE TABLE conversation_turns (
    turn_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES call_sessions(session_id) ON DELETE CASCADE,
    turn_index     INT NOT NULL,
    speaker        TEXT NOT NULL CHECK (speaker IN ('user', 'assistant')),
    transcript     TEXT NOT NULL,                 -- personal data — must be encrypted
    raw_transcript TEXT NOT NULL,                 -- ASR raw output (pre-redaction)
    confidence     REAL NOT NULL DEFAULT 0.0,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(session_id, turn_index)
);

CREATE INDEX idx_turns_session ON conversation_turns(session_id);
CREATE INDEX idx_turns_time    ON conversation_turns(recorded_at);

-- ── State Transitions (deterministic audit log) ───────────────

CREATE TABLE state_transitions (
    transition_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES call_sessions(session_id) ON DELETE CASCADE,
    from_state    TEXT NOT NULL,
    to_state      TEXT NOT NULL,
    reason        TEXT,                           -- e.g. "deterministic", "llm_fallback", "consent_declined"
    payload       JSONB,                          -- additional context (no PII)
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transitions_session ON state_transitions(session_id);
CREATE INDEX idx_transitions_time    ON state_transitions(transitioned_at);

-- ── LLM Fallback Log ──────────────────────────────────────────

CREATE TABLE llm_fallback_events (
    event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES call_sessions(session_id) ON DELETE CASCADE,
    current_state  TEXT NOT NULL,
    reason         TEXT NOT NULL,                 -- why the deterministic handler failed
    llm_provider   TEXT NOT NULL,
    llm_model      TEXT NOT NULL,
    llm_decision   JSONB NOT NULL,                -- the LlmDecision struct
    latency_ms     INT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_events_session ON llm_fallback_events(session_id);

-- ── Appointments (synced from PMS) ────────────────────────────

CREATE TABLE appointments (
    appointment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL REFERENCES clinics(clinic_id),
    session_id      UUID REFERENCES call_sessions(session_id),
    patient_id      UUID NOT NULL,
    provider_id     UUID NOT NULL REFERENCES providers(provider_id),
    operatory_id    UUID NOT NULL REFERENCES operatories(operatory_id),
    pms_id          TEXT,                        -- PMS-side appointment ID
    appointment_type TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end   TIMESTAMPTZ NOT NULL,
    duration_mins   INT NOT NULL,
    reason          TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_appts_clinic  ON appointments(clinic_id);
CREATE INDEX idx_appts_patient ON appointments(patient_id);
CREATE INDEX idx_appts_start   ON appointments(scheduled_start);

-- ── Data Retention: scheduled purge for personal data ─────────
-- This function is called by a cron job or pg_cron.
-- All personal-data-bearing tables are truncated after retention_days.

CREATE OR REPLACE FUNCTION purge_expired_data(retention_days INT)
RETURNS void AS $$
DECLARE
    cutoff TIMESTAMPTZ := now() - (retention_days || ' days')::INTERVAL;
BEGIN
    DELETE FROM conversation_turns WHERE recorded_at < cutoff;
    DELETE FROM state_transitions WHERE transitioned_at < cutoff;
    DELETE FROM llm_fallback_events WHERE created_at < cutoff;
    DELETE FROM call_sessions WHERE created_at < cutoff;
END;
$$ LANGUAGE plpgsql;
