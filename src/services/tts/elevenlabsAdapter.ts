/**
 * ElevenLabs TTS adapter — streaming text-to-speech via WebSocket.
 *
 * Implements the TtsAdapter interface. Each call opens a dedicated
 * WebSocket to ElevenLabs' streaming TTS endpoint. Text chunks are
 * sent as JSON; binary audio chunks are dispatched through the
 * onAudio callback. Supports barge-in via interrupt().
 */

import WebSocket from "ws";
import {
  type TtsAdapter,
  type TtsConfig,
  type TtsCallbacks,
  type TtsState,
  type TtsProvider,
  type TtsInput,
} from "./types.js";
import type { CallId } from "../../types/call.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── ElevenLabs WebSocket protocol messages ───────────────────────

interface ElsTextInput {
  text: string;
  try_trigger_generation?: boolean;
  generation_config?: {
    chunk_length_schedule: number[];
  };
}

interface ElsFlush {
  text: " ";
  try_trigger_generation: true;
}

interface ElsError {
  code: number;
  message: string;
}

// ── Per-call stream state ────────────────────────────────────────

interface ElsStream {
  ws: WebSocket;
  callbacks: TtsCallbacks;
  callId: CallId;
  state: TtsState;
  /** Pending text inputs queued before connection opens. */
  pendingInputs: TtsInput[];
  /** Flag set by interrupt() to cancel current generation. */
  interrupted: boolean;
}

// ── Adapter ──────────────────────────────────────────────────────

export class ElevenLabsAdapter implements TtsAdapter {
  readonly provider: TtsProvider = "elevenlabs";
  readonly config: TtsConfig;

  private streams = new Map<string, ElsStream>();

  constructor(private apiKey: string, configOverrides: Partial<TtsConfig> = {}) {
    this.config = {
      provider: "elevenlabs",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      model: "eleven_turbo_v2_5",
      language: "en",
      speed: 1.0,
      pitch: 1.0,
      outputFormat: "mulaw",
      sampleRate: 8000,
      streamingLatency: 1,
      ...configOverrides,
    };
  }

  // ── Connection lifecycle ──────────────────────────────────────

  async connect(callId: CallId, callbacks: TtsCallbacks): Promise<void> {
    callbacks.onStateChange("connecting");

    const params = new URLSearchParams();
    params.set("model_id", this.config.model);
    params.set("output_format", "pcm_16000");
    params.set("optimize_streaming_latency", String(this.config.streamingLatency));

    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}/stream-input?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: { "xi-api-key": this.apiKey },
    });

    const stream: ElsStream = {
      ws,
      callbacks,
      callId,
      state: "connecting",
      pendingInputs: [],
      interrupted: false,
    };

    this.streams.set(callId, stream);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ElevenLabs connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(timeout);
        stream.state = "speaking";
        callbacks.onStateChange("speaking");
        safeLog("debug", "ElevenLabs stream open", { callId });

        // Flush any queued inputs.
        for (const input of stream.pendingInputs) {
          this.sendText(stream, input);
        }
        stream.pendingInputs = [];
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(stream, data);
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        stream.state = "error";
        callbacks.onStateChange("error");
        callbacks.onError(callId, {
          code: "ELEVENLABS_WEBSOCKET_ERROR",
          message: err.message,
          recoverable: false,
        });
        safeLog("error", "ElevenLabs WebSocket error", {
          callId,
          error: { name: "ElsWsError", message: err.message },
        });
        reject(err);
      });

      ws.on("close", (code) => {
        stream.state = "closed";
        callbacks.onStateChange("closed");
        callbacks.onComplete(callId);
        safeLog("debug", "ElevenLabs stream closed", {
          callId,
          context: { code },
        });
      });
    });
  }

  speak(callId: CallId, input: TtsInput): void {
    const stream = this.streams.get(callId);
    if (!stream) return;

    if (stream.ws.readyState !== WebSocket.OPEN) {
      stream.pendingInputs.push(input);
      return;
    }

    this.sendText(stream, input);
  }

  interrupt(callId: CallId): void {
    const stream = this.streams.get(callId);
    if (!stream) return;
    stream.interrupted = true;

    // ElevenLabs supports clearing queued inputs by sending
    // a flush message — but the simplest reliable barge-in
    // is to close and reopen the WebSocket.
    if (stream.ws.readyState === WebSocket.OPEN) {
      stream.ws.close(1000, "barge-in");
    }
    safeLog("debug", "TTS interrupted (barge-in)", { callId });
  }

  async disconnect(callId: CallId): Promise<void> {
    const stream = this.streams.get(callId);
    if (!stream) return;

    // Send flush to end generation cleanly.
    if (stream.ws.readyState === WebSocket.OPEN) {
      const flush: ElsFlush = { text: " ", try_trigger_generation: true };
      stream.ws.send(JSON.stringify(flush));
      stream.ws.close(1000, "Client disconnect");
    }
    this.streams.delete(callId);
  }

  async destroy(): Promise<void> {
    for (const [callId] of this.streams) {
      await this.disconnect(callId as CallId);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────

  private sendText(stream: ElsStream, input: TtsInput): void {
    if (stream.interrupted) return;

    const msg: ElsTextInput = {
      text: `${input.text} `,
      try_trigger_generation: true,
      generation_config: {
        chunk_length_schedule: [50],
      },
    };
    stream.ws.send(JSON.stringify(msg));
  }

  private handleMessage(stream: ElsStream, data: WebSocket.Data): void {
    // ElevenLabs streams raw PCM audio as binary chunks.
    // Text messages are JSON with error info.
    if (typeof data === "string") {
      try {
        const err = JSON.parse(data) as ElsError;
        if (err.code) {
          stream.callbacks.onError(stream.callId, {
            code: `ELEVENLABS_${err.code}`,
            message: err.message,
            recoverable: true,
          });
        }
      } catch {
        // Not JSON — ignore.
      }
      return;
    }

    if (Buffer.isBuffer(data) && data.length > 0 && !stream.interrupted) {
      stream.callbacks.onAudio(stream.callId, data);
    }
  }
}
