/**
 * OpenAI LLM adapter — structured intent resolution via Chat Completions.
 *
 * Implements the LlmAdapter interface. Sends a system prompt plus
 * conversation history to OpenAI and parses a structured JSON response
 * into an LlmDecision.
 */

import {
  type LlmAdapter,
  type LlmConfig,
  type LlmProvider,
  type LlmContext,
  type LlmDecision,
} from "./types.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── OpenAI API types ─────────────────────────────────────────────

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiResponse {
  choices: {
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ── Valid dental states for LLM routing ──────────────────────────

const VALID_STATES = new Set([
  "greeting",
  "consent_check",
  "patient_identify",
  "patient_register",
  "patient_register_name",
  "patient_register_dob",
  "patient_register_phone",
  "patient_register_confirm",
  "reason_for_visit",
  "appointment_slot_select",
  "confirm_appointment",
  "schedule_result",
  "emergency_triage",
  "general_query",
  "end_call",
]);

// ── Prompt template ──────────────────────────────────────────────

function buildSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

You MUST respond with a single JSON object — no markdown, no extra text.
The JSON must have exactly these fields:
{
  "nextState": "<valid state name>",
  "extractedSlots": { "slotName": "value", ... },
  "responseText": "<what the assistant should say next>",
  "confidence": <number 0.0–1.0>
}

Valid nextState values:
${[...VALID_STATES].join(", ")}

Extracted slots may include:
- patient_name, date_of_birth, phone_number, appointment_type,
  appointment_date, appointment_time, reason_for_visit,
  is_emergency ("true"/"false"), is_new_patient ("true"/"false"),
  preferred_provider

Current state: {current_state}
Reason for fallback: {reason}
`;
}

// ── Adapter ──────────────────────────────────────────────────────

export class OpenAIAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "openai";
  readonly config: LlmConfig;

  constructor(private apiKey: string, configOverrides: Partial<LlmConfig> = {}) {
    this.config = {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      maxTokens: 1024,
      systemPrompt:
        "You are a clinic voice assistant for a Singapore healthcare practice. Help patients book appointments, answer questions, and triage emergencies. Be polite, concise, and professional.",
      ...configOverrides,
    };
  }

  async resolve(ctx: LlmContext): Promise<LlmDecision> {
    const systemPrompt = buildSystemPrompt(this.config.systemPrompt)
      .replace("{current_state}", ctx.currentState)
      .replace("{reason}", ctx.reasonForFallback);

    const messages: OpenAiMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add recent conversation turns as context.
    for (const turn of ctx.recentTurns) {
      messages.push({
        role: turn.speaker === "user" ? "user" : "assistant",
        content: turn.text,
      });
    }

    // Add the current utterance.
    if (ctx.userUtterance) {
      messages.push({ role: "user", content: ctx.userUtterance });
    }

    safeLog("debug", "OpenAI LLM request", {
      callId: ctx.session.callId,
      context: {
        currentState: ctx.currentState,
        reason: ctx.reasonForFallback,
        turns: ctx.recentTurns.length,
      },
    });

    let rawContent: string;

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          messages,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const json = (await response.json()) as OpenAiResponse;
      rawContent = json.choices[0]?.message.content ?? "{}";
    } catch (err) {
      safeLog("error", "OpenAI request failed", {
        error: { name: "OpenAIError", message: String(err) },
      });
      return this.fallbackDecision(ctx);
    }

    // Parse structured JSON from the LLM response.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>;
    } catch {
      safeLog("warn", "OpenAI returned invalid JSON", {
        context: { raw: rawContent.slice(0, 200) },
      });
      return this.fallbackDecision(ctx);
    }

    const nextState =
      typeof parsed.nextState === "string" && VALID_STATES.has(parsed.nextState)
        ? parsed.nextState
        : "end_call";

    const extractedSlots: Record<string, string> = {};
    if (parsed.extractedSlots && typeof parsed.extractedSlots === "object") {
      for (const [k, v] of Object.entries(
        parsed.extractedSlots as Record<string, unknown>,
      )) {
        extractedSlots[k] = typeof v === "string" ? v : String(v);
      }
    }

    const responseText =
      typeof parsed.responseText === "string"
        ? parsed.responseText
        : "I'm sorry, I didn't understand. Could you please repeat that?";

    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    return { nextState, extractedSlots, responseText, confidence };
  }

  /**
   * Safe fallback when the LLM is unreachable or returns invalid output.
   * Routes to end_call with an apology.
   */
  private fallbackDecision(_ctx: LlmContext): LlmDecision {
    return {
      nextState: "end_call",
      extractedSlots: {},
      responseText:
        "I'm having trouble understanding right now. Please call back or hold for a staff member.",
      confidence: 0,
    };
  }
}
