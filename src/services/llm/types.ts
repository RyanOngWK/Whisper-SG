/**
 * LLM adapter interface.
 *
 * Supports swappable LLM backends (GPT-4o, Claude 3.5, etc.) for the
 * fallback_llm meta-state.  The orchestrator calls into this adapter
 * when the deterministic state machine cannot resolve intent.
 */

import type { SessionState } from "../../types/call.js";

export type LlmProvider = "openai" | "anthropic" | "google";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  /** System prompt injected before every call. */
  systemPrompt: string;
}

/**
 * Context the LLM receives for NLU decisions.
 */
export interface LlmContext {
  session: SessionState;
  currentState: string;
  reasonForFallback: string;
  userUtterance: string;
  /** Prior turns trimmed to the last N for context window. */
  recentTurns: { speaker: "user" | "assistant"; text: string }[];
}

/**
 * The LLM returns a structured decision the orchestrator
 * can consume to jump to the correct next state.
 */
export interface LlmDecision {
  nextState: string;
  /** Slot values extracted by the LLM from the utterance. */
  extractedSlots: Record<string, string>;
  /** Natural-language response the TTS engine should speak. */
  responseText: string;
  confidence: number;
}

/**
 * LLM adapter contract.  The adapter:
 *  1. Must NOT log raw user utterances (redact before logging).
 *  2. Returns structured LlmDecision so the orchestrator
 *     doesn't need to parse free-form LLM output.
 */
export interface LlmAdapter {
  readonly provider: LlmProvider;
  readonly config: LlmConfig;

  /**
   * Called by the orchestrator when the state machine hits
   * the fallback_llm meta-state.  Context includes the reason
   * so the prompt can be targeted.
   */
  resolve(ctx: LlmContext): Promise<LlmDecision>;
}
