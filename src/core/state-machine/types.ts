/**
 * Deterministic State Machine for dental voice flows.
 *
 * The orchestrator advances through typed states.  Each state has
 * exactly one handler that determines the next transition.
 * When the machine cannot resolve the intent deterministically
 * it delegates to the LLM fallback.
 */

import type { SessionState } from "../../types/call.js";
import type { DentalFlowState } from "../../types/dental.js";

/**
 * Named states in a dental voice conversation.
 */
export type DentalState =
  | "greeting"
  | "consent_check"
  | "patient_identify"
  | "patient_register"
  | "patient_register_name"
  | "patient_register_dob"
  | "patient_register_phone"
  | "patient_register_confirm"
  | "reason_for_visit"
  | "appointment_slot_select"
  | "confirm_appointment"
  | "schedule_result"
  | "emergency_triage"
  | "general_query"
  | "fallback_llm"
  | "connection_lost"
  | "end_call";

/**
 * A transition out of the current state.
 */
export interface StateTransition {
  nextState: DentalState;
  /** Optional payload passed to the next handler. */
  payload?: Record<string, unknown>;
}

/**
 * Context available to every state handler.
 */
export interface StateContext {
  session: SessionState;
  flow: DentalFlowState;
  /** The caller's latest utterance transcript. */
  userUtterance: string;
  /** Confidence from the ASR layer. */
  confidence: number;
}

/**
 * A handler for a single state.  MUST be pure in its decision
 * logic — side-effects (TTS, PMS calls, DB writes) are dispatched
 * by the orchestrator after the transition is resolved.
 */
export type StateHandler = (ctx: StateContext) => Promise<StateTransition>;

/**
 * The state machine registry maps each DentalState to exactly
 * one handler.  Adding a new handler for a state swaps the whole
 * flow — no branches inside handlers.
 */
export type StateMachineRegistry = Record<DentalState, StateHandler>;

/**
 * Events emitted by the  machine for observability.
 */
export type StateMachineEvent =
  | { type: "state_entered"; state: DentalState; sessionId: string }
  | { type: "state_exited"; state: DentalState; sessionId: string }
  | { type: "transition"; from: DentalState; to: DentalState; sessionId: string }
  | { type: "llm_fallback_invoked"; sessionId: string; reason: string };

export type StateMachineListener = (event: StateMachineEvent) => void;
