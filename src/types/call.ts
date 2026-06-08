/**
 * Shared domain types for call session state.
 * These travel across the ASR/TTS/Orchestrator boundary.
 */

export type CallId = string & { readonly __brand: "CallId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type ClinicId = string & { readonly __brand: "ClinicId" };
export type PatientId = string & { readonly __brand: "PatientId" };
export type AppointmentId = string & { readonly __brand: "AppointmentId" };
export type CallSid = string & { readonly __brand: "CallSid" };

export type ConsentStatus = "pending" | "granted" | "declined";

export interface CallMetadata {
  callId: CallId;
  callSid: CallSid;
  clinicId: ClinicId;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  startedAt: Date;
}

export interface SessionState {
  sessionId: SessionId;
  callId: CallId;
  clinicId: ClinicId;
  patientId: PatientId | null;
  consent: ConsentStatus;
  conversationTurns: ConversationTurn[];
  slotValues: Record<string, unknown>;
  createdAt: Date;
  lastActiveAt: Date;
}

export interface ConversationTurn {
  index: number;
  speaker: "user" | "assistant";
  transcript: string;
  rawTranscript: string;
  confidence: number;
  timestamp: Date;
}

export function asCallId(id: string): CallId {
  return id as CallId;
}

export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

export function asClinicId(id: string): ClinicId {
  return id as ClinicId;
}

export function asPatientId(id: string): PatientId {
  return id as PatientId;
}
