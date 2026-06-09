/**
 * Database repository — persistence layer for call sessions,
 * conversation turns, state transitions, and LLM fallback events.
 *
 * All writes are async fire-and-forget from the orchestrator's
 * perspective — DB failures are logged but never block the call flow.
 */

import type pg from "pg";
import type { SessionState } from "../../types/call.js";
import { safeLog } from "../logging/redactor.js";

export class OrchestratorRepository {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ── Call Sessions ─────────────────────────────────────────────

  async insertCallSession(session: SessionState): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO call_sessions
           (session_id, clinic_id, call_sid, direction, from_number, to_number,
            status, patient_id, consent_status, started_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          session.sessionId,
          session.clinicId,
          String(session.callId),
          "inbound",
          "", // from_number: redacted for PDPA compliance
          "", // to_number: redacted for PDPA compliance
          "active",
          session.patientId ?? null,
          session.consent,
          session.createdAt,
          JSON.stringify({}),
        ],
      );
    } catch (err) {
      safeLog("error", "DB: insertCallSession failed", {
        sessionId: session.sessionId,
        error: { name: "DbError", message: String(err) },
      });
    }
  }

  async updateCallSessionEnd(
    sessionId: string,
    endedAt: Date,
    status = "completed",
  ): Promise<void> {
    try {
      const result = await this.pool.query(
        `UPDATE call_sessions
         SET status = $1, ended_at = $2,
             duration_secs = EXTRACT(EPOCH FROM ($2::timestamptz - started_at))::int,
             updated_at = now()
         WHERE session_id = $3`,
        [status, endedAt, sessionId],
      );
      if (result.rowCount === 0) {
        safeLog("warn", "DB: updateCallSessionEnd — no matching session", {
          sessionId,
        });
      }
    } catch (err) {
      safeLog("error", "DB: updateCallSessionEnd failed", {
        sessionId,
        error: { name: "DbError", message: String(err) },
      });
    }
  }

  // ── Conversation Turns ────────────────────────────────────────

  async insertConversationTurn(
    sessionId: string,
    turnIndex: number,
    speaker: "user" | "assistant",
    transcript: string,
    rawTranscript: string,
    confidence: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO conversation_turns
           (session_id, turn_index, speaker, transcript, raw_transcript, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, turn_index) DO NOTHING`,
        [sessionId, turnIndex, speaker, transcript, rawTranscript, confidence],
      );
    } catch (err) {
      safeLog("error", "DB: insertConversationTurn failed", {
        sessionId,
        error: { name: "DbError", message: String(err) },
      });
    }
  }

  // ── State Transitions ─────────────────────────────────────────

  async insertStateTransition(
    sessionId: string,
    fromState: string,
    toState: string,
    reason: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO state_transitions
           (session_id, from_state, to_state, reason, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sessionId,
          fromState,
          toState,
          reason,
          payload ? JSON.stringify(payload) : null,
        ],
      );
    } catch (err) {
      safeLog("error", "DB: insertStateTransition failed", {
        sessionId,
        error: { name: "DbError", message: String(err) },
      });
    }
  }

  // ── LLM Fallback Events ───────────────────────────────────────

  async insertLlmFallbackEvent(
    sessionId: string,
    currentState: string,
    reason: string,
    llmProvider: string,
    llmModel: string,
    llmDecision: Record<string, unknown>,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO llm_fallback_events
           (session_id, current_state, reason, llm_provider, llm_model,
            llm_decision, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          currentState,
          reason,
          llmProvider,
          llmModel,
          JSON.stringify(llmDecision),
          latencyMs,
        ],
      );
    } catch (err) {
      safeLog("error", "DB: insertLlmFallbackEvent failed", {
        sessionId,
        error: { name: "DbError", message: String(err) },
      });
    }
  }
}
