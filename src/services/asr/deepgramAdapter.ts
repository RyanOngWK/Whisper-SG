/**
 * Deepgram ASR adapter — streaming speech recognition via WebSocket.
 *
 * Implements the AsrAdapter interface. Each call opens a dedicated
 * WebSocket to Deepgram's streaming endpoint. Binary audio frames
 * are written directly to the socket; JSON results are parsed and
 * dispatched through the onResult/onError callbacks.
 */

import WebSocket from "ws";
import {
  type AsrAdapter,
  type AsrConfig,
  type AsrCallbacks,
  type AsrResult,
  type AsrState,
  type AsrProvider,
} from "./types.js";
import type { CallId } from "../../types/call.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── Deepgram JSON response shapes ────────────────────────────────

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?: { word: string; start: number; end: number }[];
}

interface DeepgramResult {
  type: "Results";
  channel_index: number[];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  channel: { alternatives: DeepgramAlternative[] };
}

type DeepgramMessage = DeepgramResult | { type: string };

// ── Per-call stream state ────────────────────────────────────────

interface DeepgramStream {
  ws: WebSocket;
  callbacks: AsrCallbacks;
  callId: CallId;
  state: AsrState;
}

// ── Adapter ──────────────────────────────────────────────────────

export class DeepgramAdapter implements AsrAdapter {
  readonly provider: AsrProvider = "deepgram";
  readonly config: AsrConfig;

  /** Map callId (as string) → active stream */
  private streams = new Map<string, DeepgramStream>();

  constructor(private apiKey: string, configOverrides: Partial<AsrConfig> = {}) {
    this.config = {
      provider: "deepgram",
      language: "en-US",
      model: "nova-2-general",
      interimResults: true,
      punctuate: true,
      diarize: false,
      profanityFilter: true,
      keywords: [],
      encoding: "linear16",
      sampleRate: 16000,
      ...configOverrides,
    };
  }

  // ── Connection lifecycle ──────────────────────────────────────

  async connect(
    callId: CallId,
    configOverride: Partial<AsrConfig>,
    callbacks: AsrCallbacks,
  ): Promise<void> {
    const merged: AsrConfig = { ...this.config, ...configOverride };

    const params = new URLSearchParams();
    params.set("encoding", merged.encoding);
    params.set("sample_rate", String(merged.sampleRate));
    params.set("language", merged.language);
    params.set("model", merged.model);
    params.set("punctuate", String(merged.punctuate));
    params.set("diarize", String(merged.diarize));
    params.set("interim_results", String(merged.interimResults));
    params.set("profanity_filter", String(merged.profanityFilter));
    if (merged.keywords.length > 0) {
      params.set("keywords", merged.keywords.join(","));
    }

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    callbacks.onStateChange("connecting");

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    const stream: DeepgramStream = {
      ws,
      callbacks,
      callId,
      state: "connecting",
    };

    this.streams.set(callId, stream);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deepgram connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(timeout);
        stream.state = "listening";
        callbacks.onStateChange("listening");
        safeLog("debug", "Deepgram stream open", { callId });
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(callId, data);
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        stream.state = "error";
        callbacks.onStateChange("error");
        callbacks.onError({
          callId,
          code: "DEEPGRAM_WEBSOCKET_ERROR",
          message: err.message,
          recoverable: false,
        });
        safeLog("error", "Deepgram WebSocket error", {
          callId,
          error: { name: "DeepgramWsError", message: err.message },
        });
        reject(err);
      });

      ws.on("close", (code) => {
        stream.state = "closed";
        callbacks.onStateChange("closed");
        safeLog("debug", "Deepgram stream closed", {
          callId,
          context: { code },
        });
      });
    });
  }

  sendAudio(callId: CallId, payload: Buffer): void {
    const stream = this.streams.get(callId);
    if (stream?.ws.readyState !== WebSocket.OPEN) return;
    stream.ws.send(payload);
  }

  endUtterance(callId: CallId): void {
    // Deepgram's keepalive / end-of-utterance: send a zero-byte
    // binary frame or send a JSON CloseStream message.
    const stream = this.streams.get(callId);
    if (stream?.ws.readyState !== WebSocket.OPEN) return;
    stream.ws.send(JSON.stringify({ type: "CloseStream" }));
  }

  async disconnect(callId: CallId): Promise<void> {
    const stream = this.streams.get(callId);
    if (!stream) return;

    if (stream.ws.readyState === WebSocket.OPEN) {
      stream.ws.close(1000, "Client disconnect");
    }
    this.streams.delete(callId);
  }

  async destroy(): Promise<void> {
    for (const [callId] of this.streams) {
      await this.disconnect(callId as CallId);
    }
  }

  // ── Message parsing ───────────────────────────────────────────

  private handleMessage(callId: CallId, data: WebSocket.Data): void {
    const stream = this.streams.get(callId);
    if (!stream) return;

    const text = Buffer.isBuffer(data)
      ? data.toString()
      : Array.isArray(data)
        ? Buffer.concat(data).toString()
        : new TextDecoder().decode(data as ArrayBuffer);

    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(text) as DeepgramMessage;
    } catch {
      return;
    }

    if (msg.type !== "Results") return;

    const result = msg as DeepgramResult;
    const channel = result.channel;
    const alt = channel.alternatives[0];
    if (!alt) return;

    const asrResult: AsrResult = {
      callId,
      type: result.is_final ? "final" : "interim",
      transcript: alt.transcript,
      confidence: result.is_final ? alt.confidence : 0,
      speaker: null,
      startTime: result.start,
      endTime: result.start + result.duration,
    };

    stream.callbacks.onResult(asrResult);
  }
}
