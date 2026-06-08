/**
 * Application entrypoint.
 *
 * Initializes all adapters, creates the orchestrator, and
 * mounts the Twilio media-stream gateway.
 */

import { loadConfig } from "./infrastructure/config/schema.js";
import { safeLog } from "./infrastructure/logging/redactor.js";
import { DeepgramAdapter } from "./services/asr/deepgramAdapter.js";
import { ElevenLabsAdapter } from "./services/tts/elevenlabsAdapter.js";
import { OpenAIAdapter } from "./services/llm/openaiAdapter.js";
import { OpenDentalAdapter } from "./services/pms/openDentalAdapter.js";
import { Orchestrator } from "./services/orchestrator/orchestrator.js";
import { TwilioMediaGateway } from "./gateways/telephony/twilioHandler.js";

function main(): void {
  const config = loadConfig();

  safeLog("info", "Starting ABiz Voice AI", {
    context: {
      env: config.nodeEnv,
      port: config.port,
      asrProvider: config.asr.provider,
      ttsProvider: config.tts.provider,
      llmProvider: config.llm.provider,
      pmsProvider: config.pms.provider,
    },
  });

  // ── Instantiate concrete adapters ──────────────────────────

  const asr = new DeepgramAdapter(config.asr.apiKey, {
    model: config.asr.model,
    language: config.asr.language,
    interimResults: config.asr.interimResults,
    diarize: config.asr.diarize,
    encoding: "linear16",
    sampleRate: 16000,
  });

  const tts = new ElevenLabsAdapter(config.tts.apiKey, {
    voiceId: config.tts.voiceId,
    model: config.tts.model,
    speed: config.tts.speed,
    streamingLatency: config.tts.streamingLatency,
  });

  const llm = new OpenAIAdapter(config.llm.apiKey, {
    model: config.llm.model,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    systemPrompt: config.llm.systemPrompt,
  });

  const pms = new OpenDentalAdapter(
    config.pms.apiUrl ?? "http://localhost:3023",
    config.pms.apiKey ?? "",
  );

  // ── Create the orchestrator ──────────────────────────────────

  const orchestrator = new Orchestrator({ asr, tts, llm, pms });

  // ── Mount the Twilio media-stream gateway ────────────────────

  const twilioGateway = new TwilioMediaGateway(orchestrator, {
    authToken: config.twilio.authToken,
    publicHost: process.env.TWILIO_PUBLIC_HOST ?? "localhost",
  });

  twilioGateway.listen(config.port);

  safeLog("info", "Server ready — Twilio Media Gateway active");

  // ── Graceful shutdown ───────────────────────────────────────

  const shutdown = (signal: string) => {
    safeLog("info", `${signal} received, shutting down`);
    twilioGateway.shutdown().catch((err: unknown) => {
      safeLog("error", "Shutdown error", {
        error: { name: "ShutdownError", message: String(err) },
      });
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Error";
  safeLog("error", "Fatal startup error", {
    error: { name, message },
  });
  process.exit(1);
}
