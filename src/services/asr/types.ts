/**
 * ASR (Automatic Speech Recognition) adapter interface.
 *
 * All vendor implementations (Deepgram, AssemblyAI, Azure, etc.)
 * must conform to this contract so the orchestrator never couples
 * to a specific provider.
 */

import type { CallId } from "../../types/call.js";

export type AsrProvider = "deepgram" | "assemblyai" | "azure";

export type AsrState = "idle" | "connecting" | "listening" | "error" | "closed";

export interface AsrConfig {
  provider: AsrProvider;
  language: string;
  model: string;
  interimResults: boolean;
  punctuate: boolean;
  diarize: boolean;
  profanityFilter: boolean;
  keywords: string[];
  encoding: AudioEncoding;
  sampleRate: number;
}

export type AudioEncoding = "mulaw" | "linear16" | "opus";

/**
 * Streaming result from the ASR.  Interim results give partial
 * transcripts; final results include a confidence score and
 * speaker label when diarization is enabled.
 */
export interface AsrResult {
  callId: CallId;
  type: "interim" | "final";
  transcript: string;
  confidence: number;
  speaker: string | null;
  startTime: number;
  endTime: number;
}

export interface AsrError {
  callId: CallId;
  code: string;
  message: string;
  recoverable: boolean;
}

/**
 * Callbacks the adapter fires during a stream.
 */
export interface AsrCallbacks {
  onResult: (result: AsrResult) => void;
  onError: (error: AsrError) => void;
  onStateChange: (state: AsrState) => void;
}

/**
 * The ASR adapter contract.  Every provider adapter must:
 *  1. Accept raw audio buffers from the telephony gateway.
 *  2. Return AsrResult objects through the onResult callback.
 *  3. Be disposable to clean up WebSocket / gRPC resources.
 */
export interface AsrAdapter {
  readonly provider: AsrProvider;
  readonly config: AsrConfig;

  /** Open the streaming connection to the ASR vendor. */
  connect(
    callId: CallId,
    config: Partial<AsrConfig>,
    callbacks: AsrCallbacks,
  ): Promise<void>;

  /** Feed a raw audio buffer into the stream. */
  sendAudio(callId: CallId, payload: Buffer): void;

  /** Signal end-of-utterance so the vendor returns a final result. */
  endUtterance(callId: CallId): void;

  /** Close the stream for a given call. */
  disconnect(callId: CallId): Promise<void>;

  /** Release all resources (e.g. WebSocket connections). */
  destroy(): Promise<void>;
}
