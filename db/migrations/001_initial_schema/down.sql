-- Migration: 001_initial_schema (rollback)
-- Drops all tables and functions in reverse dependency order.

DROP FUNCTION IF EXISTS purge_expired_data(INT);

DROP TABLE IF EXISTS appointments CASCADE;
DROP TABLE IF EXISTS llm_fallback_events CASCADE;
DROP TABLE IF EXISTS state_transitions CASCADE;
DROP TABLE IF EXISTS conversation_turns CASCADE;
DROP TABLE IF EXISTS call_sessions CASCADE;
DROP TABLE IF EXISTS operatories CASCADE;
DROP TABLE IF EXISTS providers CASCADE;
DROP TABLE IF EXISTS clinics CASCADE;

DROP TABLE IF EXISTS _migrations CASCADE;
