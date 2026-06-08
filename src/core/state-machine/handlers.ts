/**
 * Concrete state handlers for the dental booking state machine.
 *
 * Each handler is a pure decision function: it inspects the context
 * and returns the next transition.  The orchestrator executes the
 * side effects (TTS, PMS, DB) after the transition is resolved.
 */

import type {
  StateHandler,
  StateContext,
} from "./types.js";
import type { ConsentStatus } from "../../types/call.js";

/**
 * Holds current flow status in the session slot values so downstream
 * handlers can inspect decisions made by earlier states.
 */
const SLOT = {
  CONSENT: "consent_status",
  IS_EXISTING_PATIENT: "is_existing_patient",
  PATIENT_ID: "patient_id",
  APPOINTMENT_TYPE: "appointment_type",
  APPOINTMENT_DATE: "appointment_date",
  APPOINTMENT_TIME: "appointment_time",
  APPOINTMENT_ID: "appointment_id",
  OPERATORY_ID: "operatory_id",
  PROVIDER_ID: "provider_id",
  EMERGENCY_LEVEL: "emergency_level",
} as const;

// ── Greeting ────────────────────────────────────────────────────

export const greetingHandler: StateHandler = async (_ctx: StateContext) => {
  return { nextState: "consent_check" };
};

// ── Consent ─────────────────────────────────────────────────────

const CONSENT_AFFIRMATIVE = [
  "yes", "sure", "okay", "fine", "go ahead", "i agree",
  "you may", "proceed", "go on", "alright",
];

const CONSENT_NEGATIVE = [
  "no", "stop", "don't", "do not", "not okay", "never mind",
];

function detectConsent(utterance: string): ConsentStatus {
  const cleaned = utterance.toLowerCase().trim();
  for (const word of CONSENT_NEGATIVE) {
    if (cleaned.includes(word)) return "declined";
  }
  for (const word of CONSENT_AFFIRMATIVE) {
    if (cleaned.includes(word)) return "granted";
  }
  return "pending";
}

export const consentCheckHandler: StateHandler = async (ctx: StateContext) => {
  const consent = detectConsent(ctx.userUtterance);
  ctx.session.slotValues[SLOT.CONSENT] = consent;

  if (consent === "declined") {
    return { nextState: "end_call" };
  }

  if (consent === "granted") {
    return { nextState: "patient_identify" };
  }

  // pending — ask again (orchestrator will re-enter this state)
  return { nextState: "consent_check" };
};

// ── Patient Identification ──────────────────────────────────────

export const patientIdentifyHandler: StateHandler = async (
  ctx: StateContext,
) => {
  // If the caller provided a name (Naive keyword match; real intent
  // extraction belongs in the intent layer which feeds slot values).
  const utterance = ctx.userUtterance.toLowerCase().trim();

  const isExistingPatient =
    ctx.session.slotValues[SLOT.IS_EXISTING_PATIENT] === true ||
    /existing patient|been here before|i have an appointment/i.test(utterance);

  const isNewPatient =
    /new patient|first time|never been/i.test(utterance);

  const isEmergency =
    /emergency|pain|bleeding|broken tooth|swelling|urgent/i.test(utterance);

  if (isEmergency) {
    ctx.session.slotValues[SLOT.EMERGENCY_LEVEL] = "high";
    return { nextState: "emergency_triage" };
  }

  if (isNewPatient) {
    ctx.session.slotValues[SLOT.IS_EXISTING_PATIENT] = false;
    return { nextState: "patient_register" };
  }

  if (isExistingPatient) {
    ctx.session.slotValues[SLOT.IS_EXISTING_PATIENT] = true;
    return { nextState: "reason_for_visit" };
  }

  // Ambiguous — delegate to LLM for natural-language NLU
  return { nextState: "fallback_llm", payload: { reason: "identify_patient" } };
};

// ── Patient Registration ( new patient) ────────────────────────

export const patientRegisterHandler: StateHandler = async (
  _ctx: StateContext,
) => {
  // The orchestrator collects PII through a structured sub-flow
  // and writes it directly to the PMS via the PMS adapter.
  // This handler signals completion.
  return { nextState: "reason_for_visit" };
};

// ── Reason for Visit ────────────────────────────────────────────

export const reasonForVisitHandler: StateHandler = async (
  ctx: StateContext,
) => {
  const utterance = ctx.userUtterance.toLowerCase();

  const typeMap: { pattern: RegExp; type: string }[] = [
    { pattern: /cleaning|hygiene|check.?up|exam/i, type: "cleaning" },
    { pattern: /filling|cavity/i, type: "filling" },
    { pattern: /crown|cap/i, type: "crown" },
    { pattern: /root canal/i, type: "root_canal" },
    { pattern: /extraction|pull.*tooth|remove.*tooth/i, type: "extraction" },
    { pattern: /consult/i, type: "consultation" },
  ];

  for (const { pattern, type } of typeMap) {
    if (pattern.test(utterance)) {
      ctx.session.slotValues[SLOT.APPOINTMENT_TYPE] = type;
      return { nextState: "appointment_slot_select" };
    }
  }

  return { nextState: "fallback_llm", payload: { reason: "reason_for_visit" } };
};

// ── Slot Selection ──────────────────────────────────────────────

export const appointmentSlotSelectHandler: StateHandler = async (
  ctx: StateContext,
) => {
  // Date/time parsing should happen in the intent layer.
  // This handler checks whether we have enough slots filled.
  if (ctx.session.slotValues[SLOT.APPOINTMENT_DATE]) {
    return { nextState: "confirm_appointment" };
  }

  return {
    nextState: "fallback_llm",
    payload: { reason: "slot_selection" },
  };
};

// ── Confirmation ────────────────────────────────────────────────

export const confirmAppointmentHandler: StateHandler = async (
  ctx: StateContext,
) => {
  const confirmed =
    /yes|correct|confirm|sounds good|okay|perfect|that works/i.test(
      ctx.userUtterance,
    );
  const denied = /no|wrong|change|not that|different/i.test(ctx.userUtterance);

  if (confirmed) {
    return {
      nextState: "schedule_result",
      payload: { confirmed: true },
    };
  }

  if (denied) {
    return { nextState: "appointment_slot_select" };
  }

  return { nextState: "fallback_llm", payload: { reason: "confirm" } };
};

// ── Schedule Result ─────────────────────────────────────────────

export const scheduleResultHandler: StateHandler = async (
  _ctx: StateContext,
) => {
  return { nextState: "end_call" };
};

// ── Emergency Triage ────────────────────────────────────────────

export const emergencyTriageHandler: StateHandler = async (
  _ctx: StateContext,
) => {
  return {
    nextState: "end_call",
    payload: { escalated: true },
  };
};

// ── General Query ───────────────────────────────────────────────

export const generalQueryHandler: StateHandler = async (_ctx: StateContext) => {
  return { nextState: "fallback_llm", payload: { reason: "general_query" } };
};

// ── LLM Fallback ────────────────────────────────────────────────

export const fallbackLlmHandler: StateHandler = async (_ctx: StateContext) => {
  // The orchestrator invokes the LLM and rewrites the nextState.
  // This handler just passes through.
  return { nextState: "end_call" };
};

// ── Connection Lost ─────────────────────────────────────────────

export const connectionLostHandler: StateHandler = async (
  _ctx: StateContext,
) => {
  return {
    nextState: "end_call",
    payload: { reason: "connection_lost" },
  };
};

// ── End Call ────────────────────────────────────────────────────

export const endCallHandler: StateHandler = async (_ctx: StateContext) => {
  return { nextState: "end_call" };
};

// ── Registry ────────────────────────────────────────────────────

import type { StateMachineRegistry } from "./types.js";

export const dentalStateMachine: StateMachineRegistry = {
  greeting: greetingHandler,
  consent_check: consentCheckHandler,
  patient_identify: patientIdentifyHandler,
  patient_register: patientRegisterHandler,
  reason_for_visit: reasonForVisitHandler,
  appointment_slot_select: appointmentSlotSelectHandler,
  confirm_appointment: confirmAppointmentHandler,
  schedule_result: scheduleResultHandler,
  emergency_triage: emergencyTriageHandler,
  general_query: generalQueryHandler,
  fallback_llm: fallbackLlmHandler,
  connection_lost: connectionLostHandler,
  end_call: endCallHandler,
};
