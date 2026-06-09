/**
 * Call Orchestrator — the central brain that wires together
 * the ASR, TTS, State Machine, LLM, and PMS adapters.
 *
 * Responsibility:
 *  1. Listen for ASR results (user speech).
 *  2. Advance the state machine with the transcript.
 *  3. Dispatch side effects after the transition is resolved:
 *     - TTS responses for each state
 *     - PMS lookups / bookings
 *     - DB persistence
 *     - LLM fallback for ambiguous inputs
 */

import type { AsrAdapter, AsrResult } from "../asr/types.js";
import type { TtsAdapter, TtsInput } from "../tts/types.js";
import type { LlmAdapter, LlmContext, LlmDecision } from "../llm/types.js";
import type { PmsAdapter } from "../pms/types.js";
import type { StateContext, StateTransition } from "../../core/state-machine/types.js";
import { StateMachineEngine } from "../../core/state-machine/engine.js";
import { dentalStateMachine } from "../../core/state-machine/handlers.js";
import type { SessionState, CallId } from "../../types/call.js";
import { asPatientId } from "../../types/call.js";
import type { DentalFlowState } from "../../types/dental.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";
import type { OrchestratorRepository } from "../../infrastructure/db/repository.js";

// ── Session store interface ─────────────────────────────────────

export interface SessionStore {
  get(sessionId: string): Promise<SessionState | null>;
  set(sessionId: string, session: SessionState): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** In-memory fallback when Redis is not available. */
export class InMemorySessionStore implements SessionStore {
  private map = new Map<string, SessionState>();
  async get(sessionId: string) { return this.map.get(sessionId) ?? null; }
  async set(sessionId: string, session: SessionState) { this.map.set(sessionId, session); }
  async delete(sessionId: string) { this.map.delete(sessionId); }
}

// ── TTS prompts per state ───────────────────────────────────────

const STATE_PROMPTS: Partial<Record<string, string>> = {
  greeting: "Hello, thank you for calling the dental office. Before we proceed, I need to let you know this call may be recorded. Do I have your consent to continue?",
  consent_check: "I need to confirm: do you consent to having this call recorded for quality and scheduling purposes?",
  patient_identify: "Are you an existing patient with us, or is this your first visit?",
  patient_register: "Let me collect some information to register you.",
  patient_register_name: "What is your full name?",
  patient_register_dob: "What is your date of birth?",
  patient_register_phone: "What is the best phone number to reach you?",
  patient_register_confirm: "I have {first_name} {last_name}, date of birth {date_of_birth}, and phone {phone_number}. Is that correct?",
  reason_for_visit: "What brings you in today? For example, a cleaning, a toothache, or something else?",
  appointment_slot_select: "Let me find an available time for you. When would you prefer to come in?",
  confirm_appointment: "I have an opening on {date} at {time} with Dr. {provider} in {operatory}. Shall I book that for you?",
  schedule_result: "You're all set. You'll receive a confirmation text shortly. Is there anything else I can help with?",
  emergency_triage: "This sounds like an emergency. Let me transfer you to the on-call provider. Please hold.",
  general_query: "Let me help with that.",
  end_call: "Thank you for calling. Have a great day!",
};

function promptsForState(state: string, slots: Record<string, unknown>): string {
  let text = STATE_PROMPTS[state] ?? "";
  for (const [key, value] of Object.entries(slots)) {
    text = text.replace(`{${key}}`, String(value));
  }
  return text || "How can I help you?";
}

// ── Orchestrator ─────────────────────────────────────────────────

export interface OrchestratorDeps {
  asr: AsrAdapter;
  tts: TtsAdapter;
  llm: LlmAdapter;
  pms: PmsAdapter;
  repo?: OrchestratorRepository;
  sessionStore?: SessionStore;
}

export class Orchestrator {
  private engine: StateMachineEngine;
  /** Session store (Redis-backed in production, in-memory fallback). */
  private sessions: SessionStore;

  constructor(private deps: OrchestratorDeps) {
    this.sessions = deps.sessionStore ?? new InMemorySessionStore();

    // Wire the LLM fallback into the state machine.
    this.engine = new StateMachineEngine(
      dentalStateMachine,
      this.handleLlmFallback.bind(this),
    );
  }

  // ── Call lifecycle ────────────────────────────────────────────

  /**
   * Called by the Twilio gateway when a new media stream opens.
   * onTtsAudio is a callback the gateway provides to receive TTS
   * audio chunks (so it can relay them to Twilio).
   */
  async onCallStart(
    callId: CallId,
    session: SessionState,
    onTtsAudio?: (callId: CallId, chunk: Buffer) => void,
  ): Promise<void> {
    await this.sessions.set(session.sessionId, session);
    safeLog("info", "Call started", { callId: callId, sessionId: session.sessionId });

    // Persist the call session to Postgres (fire-and-forget).
    void this.deps.repo?.insertCallSession(session);

    // Start the ASR stream
    await this.deps.asr.connect(callId, {
      language: (session.slotValues.language as string | undefined) ?? "en-US",
    }, {
      onResult: (result) => { void this.onAsrResult(callId, result); },
      onError: (err) => safeLog("error", "ASR error", { callId: callId, error: { name: err.code, message: err.message } }),
      onStateChange: (state) => safeLog("debug", `ASR state: ${state}`, { callId: callId }),
    });

    // Connect TTS — relay audio chunks to the gateway if provided
    await this.deps.tts.connect(callId, {
      onAudio: (cid, chunk) => {
        if (onTtsAudio) onTtsAudio(cid, chunk);
      },
      onComplete: (_cid) => {
        safeLog("debug", "TTS complete", { callId: callId });
      },
      onError: (_cid, err) => safeLog("error", "TTS error", { callId: callId, error: { name: err.code, message: err.message } }),
      onStateChange: (_state) => { /* no-op */ },
    });

    // Kick off the state machine from greeting
    await this.advanceStateMachine(callId, session);
  }

  /**
   * Called by the Twilio gateway when the call ends.
   */
  async onCallEnd(callId: CallId, sessionId: string): Promise<void> {
    safeLog("info", "Call ended", { callId: callId, sessionId });
    void this.deps.repo?.updateCallSessionEnd(sessionId, new Date());
    this.deps.tts.interrupt(callId);
    await this.deps.asr.disconnect(callId);
    await this.deps.tts.disconnect(callId);
    await this.sessions.delete(sessionId);
  }

  /**
   * Called by the Twilio gateway to feed normalized PCM audio
   * into the ASR adapter for transcription.
   */
  sendAudioToAsr(callId: CallId, pcmBuffer: Buffer): void {
    this.deps.asr.sendAudio(callId, pcmBuffer);
  }

  // ── ASR → State Machine bridge ────────────────────────────────

  private async onAsrResult(callId: CallId, result: AsrResult): Promise<void> {
    // Ignore interim results for state transitions — only react to finals.
    if (result.type !== "final") return;

    const session = await this.sessions.get(callId);
    if (!session) return;

    // Append to conversation turns
    const turn = {
      index: session.conversationTurns.length,
      speaker: "user" as const,
      transcript: result.transcript,
      rawTranscript: result.transcript,
      confidence: result.confidence,
      timestamp: new Date(),
    };
    session.conversationTurns.push(turn);

    // Persist the turn to Postgres (fire-and-forget).
    void this.deps.repo?.insertConversationTurn(
      session.sessionId,
      turn.index,
      turn.speaker,
      turn.transcript,
      turn.rawTranscript,
      turn.confidence,
    );

    await this.advanceStateMachine(callId, session, result);
  }

  /**
   * Advance the machine one step and dispatch side effects.
   * Current state is always sourced from session.slotValues._currentState
   * (set after each transition), defaulting to "greeting" on first call.
   */
  private async advanceStateMachine(
    callId: CallId,
    session: SessionState,
    asrResult?: AsrResult,
  ): Promise<void> {
    const currentState =
      (session.slotValues._currentState as string | undefined) ?? "greeting";

    const flow: DentalFlowState = {
      flowType: "scheduling",
      turnIndex: session.conversationTurns.length,
      confirmations: [],
      collectedSlots: {},
    };

    const ctx: StateContext = {
      session,
      flow,
      userUtterance: asrResult?.transcript ?? "",
      confidence: asrResult?.confidence ?? 0,
    };

    let transition: StateTransition;

    try {
      transition = await this.engine.advance(currentState, ctx);

      // Handle the LLM fallback meta-state externally
      if (transition.nextState === "fallback_llm") {
        const reason =
          (transition.payload?.reason as string | undefined) ?? "unknown";
        const llmTransition = await this.handleLlmFallback({
          ...ctx,
          currentState,
          reasonForFallback: reason,
        });
        transition = llmTransition;
      }
    } catch (err) {
      safeLog("error", "State machine error", { callId: callId, error: { name: "StateMachineError", message: String(err) } });
      transition = { nextState: "end_call" };
    }

    session.slotValues._currentState = transition.nextState;

    // Persist the state transition to Postgres (fire-and-forget).
    void this.deps.repo?.insertStateTransition(
      session.sessionId,
      currentState,
      transition.nextState,
      (transition.payload?.reason as string | undefined) ?? "deterministic",
      transition.payload,
    );

    // ── Side effects after transition resolved ─────────────────

    // 1. TTS: speak the prompt for the new state
    if (transition.nextState !== "end_call") {
      const prompt = promptsForState(
        transition.nextState,
        transition.payload ?? session.slotValues,
      );
      if (prompt) {
        const ttsInput: TtsInput = { text: prompt };
        this.deps.tts.speak(callId, ttsInput);

        // Record the assistant's turn
        const assistantTurn = {
          index: session.conversationTurns.length,
          speaker: "assistant" as const,
          transcript: prompt,
          rawTranscript: prompt,
          confidence: 1.0,
          timestamp: new Date(),
        };
        session.conversationTurns.push(assistantTurn);

        void this.deps.repo?.insertConversationTurn(
          session.sessionId,
          assistantTurn.index,
          assistantTurn.speaker,
          assistantTurn.transcript,
          assistantTurn.rawTranscript,
          assistantTurn.confidence,
        );
      }
    }

    // 2. PMS side effects for specific states
    if (transition.nextState === "reason_for_visit" && session.slotValues.first_name) {
      await this.upsertPatientIfNew(callId, session);
    }

    if (transition.nextState === "appointment_slot_select") {
      await this.fetchAndStoreSlots(callId, session);
    }

    if (transition.nextState === "schedule_result" && transition.payload?.confirmed) {
      await this.bookAppointment(callId, session);
    }

    // 3. If end_call, clean up
    if (transition.nextState === "end_call") {
      await this.onCallEnd(callId, session.sessionId);
    }
  }

  // ── PMS Integration ───────────────────────────────────────────

  /**
   * Register a new patient in the PMS if registration data was collected
   * during the patient_register sub-flow.
   */
  private async upsertPatientIfNew(
    callId: CallId,
    session: SessionState,
  ): Promise<void> {
    try {
      const firstName = (session.slotValues.first_name as string | undefined) ?? "";
      const lastName = (session.slotValues.last_name as string | undefined) ?? "";
      const dateOfBirth = (session.slotValues.date_of_birth as string | undefined) ?? "";
      const phone = (session.slotValues.phone_number as string | undefined) ?? "";

      if (!firstName) return;

      const patient = await this.deps.pms.upsertPatient({
        patientId: asPatientId(session.sessionId),
        clinicId: session.clinicId,
        firstName,
        lastName,
        dateOfBirth,
        phoneNumbers: phone ? [phone] : [],
        email: null,
        insurance: null,
        chartNumber: null,
        preferredLanguage: (session.slotValues.language as string | undefined) ?? "en",
        lastVisitAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      session.patientId = patient.patientId;
      session.slotValues.patient_id = patient.patientId;
      safeLog("info", "Patient registered in PMS", {
        callId,
        context: { patientId: patient.patientId },
      });
    } catch (err) {
      safeLog("error", "PMS patient registration failed", {
        callId,
        error: { name: "PmsRegisterError", message: String(err) },
      });
    }
  }

  /**
   * Fetch available appointment slots from the PMS and store them
   * in the session for downstream use by the slot-select handler.
   */
  private async fetchAndStoreSlots(
    callId: CallId,
    session: SessionState,
  ): Promise<void> {
    try {
      const appointmentType = (session.slotValues.appointment_type as string | undefined) ?? "cleaning";
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 14); // 2-week window

      const query: Parameters<typeof this.deps.pms.getAvailableSlots>[0] = {
        clinicId: session.clinicId,
        appointmentType: appointmentType as never,
        startDate: today.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        durationMinutes: 60,
      };
      const providerId = session.slotValues.provider_id as string | undefined;
      if (providerId) query.providerId = providerId;

      const slots = await this.deps.pms.getAvailableSlots(query);

      session.slotValues._availableSlots = slots;
      safeLog("info", "PMS slots fetched", {
        callId,
        context: { count: slots.length },
      });
    } catch (err) {
      safeLog("error", "PMS slot fetch failed", {
        callId,
        error: { name: "PmsSlotError", message: String(err) },
      });
    }
  }

  /**
   * Book a confirmed appointment via the PMS and store the result.
   */
  private async bookAppointment(
    callId: CallId,
    session: SessionState,
  ): Promise<void> {
    try {
      const appointmentType =
        (session.slotValues.appointment_type as string | undefined) ?? "consultation";
      const date = (session.slotValues.appointment_date as string | undefined) ?? "";
      const time = (session.slotValues.appointment_time as string | undefined) ?? "";

      // Build the appointment from collected slots.
      const appointment = await this.deps.pms.createAppointment({
        clinicId: session.clinicId,
        patientId: (session.patientId ?? session.sessionId) as never,
        providerId: (session.slotValues.provider_id as string | undefined) ?? "0",
        operatoryId: (session.slotValues.operatory_id as string | undefined) ?? "0",
        type: appointmentType as never,
        startTime: date && time ? `${date}T${time}:00` : new Date().toISOString(),
        endTime: date && time
          ? `${date}T${this.addMinutes(time, 60)}:00`
          : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: (session.slotValues.reason_for_visit as string | undefined) ?? "",
      });

      session.slotValues.appointment_id = appointment.appointmentId;
      session.slotValues.appointment_status = appointment.status;
      safeLog("info", "Appointment booked via PMS", {
        callId,
        context: {
          appointmentId: appointment.appointmentId,
          status: appointment.status,
        },
      });
    } catch (err) {
      safeLog("error", "PMS appointment booking failed", {
        callId,
        error: { name: "PmsBookingError", message: String(err) },
      });
    }
  }

  private addMinutes(time: string, minutes: number): string {
    const [h, m] = time.split(":").map(Number) as [number, number];
    const total = h * 60 + m + minutes;
    const nh = Math.floor(total / 60) % 24;
    const nm = total % 60;
    return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
  }

  // ── LLM Fallback ──────────────────────────────────────────────

  private async handleLlmFallback(ctx: StateContext & { currentState?: string; reasonForFallback?: string }): Promise<StateTransition> {
    safeLog("info", "LLM fallback invoked", {
      callId: ctx.session.callId,
      context: { reason: ctx.reasonForFallback },
    });

    const recentTurns = ctx.session.conversationTurns
      .slice(-6)
      .map((t) => ({ speaker: t.speaker, text: t.transcript }));

    const llmCtx: LlmContext = {
      session: ctx.session,
      currentState: ctx.currentState ?? "fallback_llm",
      reasonForFallback: ctx.reasonForFallback ?? "unknown",
      userUtterance: ctx.userUtterance,
      recentTurns,
    };

    let decision: LlmDecision;
    const llmStart = Date.now();

    try {
      decision = await this.deps.llm.resolve(llmCtx);
    } catch (err) {
      safeLog("error", "LLM fallback failed", { error: { name: "LlmError", message: String(err) } });
      return { nextState: "end_call" };
    }

    const latencyMs = Date.now() - llmStart;

    // Persist the LLM fallback event to Postgres (fire-and-forget).
    void this.deps.repo?.insertLlmFallbackEvent(
      ctx.session.sessionId,
      ctx.currentState ?? "fallback_llm",
      ctx.reasonForFallback ?? "unknown",
      this.deps.llm.provider,
      this.deps.llm.config.model,
      decision as unknown as Record<string, unknown>,
      latencyMs,
    );

    // Merge LLM-extracted slots into the session state
    if (Object.keys(decision.extractedSlots).length > 0) {
      Object.assign(ctx.session.slotValues, decision.extractedSlots);
    }

    safeLog("info", "LLM resolved", {
      callId: ctx.session.callId,
      context: { nextState: decision.nextState, confidence: decision.confidence },
    });

    return {
      nextState: decision.nextState as StateTransition["nextState"],
      payload: { llmResponse: decision.responseText },
    };
  }
}
