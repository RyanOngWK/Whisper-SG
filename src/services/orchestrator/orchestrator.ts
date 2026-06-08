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
import type { DentalFlowState } from "../../types/dental.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── TTS prompts per state ───────────────────────────────────────

const STATE_PROMPTS: Partial<Record<string, string>> = {
  greeting: "Hello, thank you for calling the dental office. Before we proceed, I need to let you know this call may be recorded. Do I have your consent to continue?",
  consent_check: "I need to confirm: do you consent to having this call recorded for quality and scheduling purposes?",
  patient_identify: "Are you an existing patient with us, or is this your first visit?",
  patient_register: "Let me collect some information to register you. What is your full name?",
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
}

type SessionStore = Map<string, SessionState>;

export class Orchestrator {
  private engine: StateMachineEngine;
  /** In-memory session store (production: Redis-backed). */
  private sessions: SessionStore = new Map();

  constructor(private deps: OrchestratorDeps) {
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
    this.sessions.set(session.sessionId, session);
    safeLog("info", "Call started", { callId: callId, sessionId: session.sessionId });

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
    await this.advanceStateMachine(callId, session, "greeting");
  }

  /**
   * Called by the Twilio gateway when the call ends.
   */
  async onCallEnd(callId: CallId, sessionId: string): Promise<void> {
    safeLog("info", "Call ended", { callId: callId, sessionId });
    this.deps.tts.interrupt(callId);
    await this.deps.asr.disconnect(callId);
    await this.deps.tts.disconnect(callId);
    this.sessions.delete(sessionId);
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

    const session = this.sessions.get(callId);
    if (!session) return;

    // Append to conversation turns
    session.conversationTurns.push({
      index: session.conversationTurns.length,
      speaker: "user",
      transcript: result.transcript,
      rawTranscript: result.transcript,
      confidence: result.confidence,
      timestamp: new Date(),
    });

    await this.advanceStateMachine(
      callId,
      session,
      "patient_identify", // The caller's utterance should be processed by the *current* state
      result,
    );
  }

  /**
   * Advance the machine one step and dispatch side effects.
   */
  private async advanceStateMachine(
    callId: CallId,
    session: SessionState,
    intendedState: string,
    asrResult?: AsrResult,
  ): Promise<void> {
    // Determine the current state from the last transition or start fresh.
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
        session.conversationTurns.push({
          index: session.conversationTurns.length,
          speaker: "assistant",
          transcript: prompt,
          rawTranscript: prompt,
          confidence: 1.0,
          timestamp: new Date(),
        });
      }
    }

    // 2. PMS side effects for specific states
    if (transition.nextState === "appointment_slot_select") {
      // The orchestrator would call deps.pms.getAvailableSlots() here
      safeLog("info", "Fetching appointment slots from PMS", { callId: callId });
    }

    if (transition.nextState === "schedule_result" && transition.payload?.confirmed) {
      // The orchestrator would call deps.pms.createAppointment() here
      safeLog("info", "Booking appointment via PMS", { callId: callId });
    }

    // 3. If end_call, clean up
    if (transition.nextState === "end_call") {
      await this.onCallEnd(callId, session.sessionId);
    }
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

    try {
      decision = await this.deps.llm.resolve(llmCtx);
    } catch (err) {
      safeLog("error", "LLM fallback failed", { error: { name: "LlmError", message: String(err) } });
      return { nextState: "end_call" };
    }

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
