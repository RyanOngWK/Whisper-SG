/**
 * TTS (Text-to-Speech) adapter interface.
 *
 * Swappable vendor implementations (ElevenLabs, Deepgram Aura,
 * Amazon Polly, etc.) isolate the orchestrator from vendor lock-in.
 */

import type { CallId } from "../../types/call.js";

export type TtsProvider = "elevenlabs" | "deepgram" | "polly" | "azure";

export type TtsState = "idle" | "connecting" | "speaking" | "error" | "closed";

export interface TtsConfig {
  provider: TtsProvider;
  voiceId: string;
  model: string;
  language: string;
  speed: number;
  pitch: number;
  outputFormat: AudioEncoding;
  sampleRate: number;
  /** Optimise latency at the expense of quality. */
  streamingLatency: number;
}

export type AudioEncoding = "mulaw" | "linear16" | "opus";

export interface TtsInput {
  text: string;
  ssml?: string;
}

export interface TtsCallbacks {
  onAudio: (callId: CallId, chunk: Buffer) => void;
  onComplete: (callId: CallId) => void;
  onError: (callId: CallId, error: TtsError) => void;
  onStateChange: (state: TtsState) => void;
}

export interface TtsError {
  code: string;
  message: string;
  recoverable: boolean;
}

/**
 * TTS adapter contract.  The adapter:
 *  1. Streams synthesized audio chunks via onAudio.
 *  2. Signals completion with onComplete.
 *  3. Must be interruptible (cancel current utterance)
 *     to support barge-in (speaker interrupts the bot).
 */
export interface TtsAdapter {
  readonly provider: TtsProvider;
  readonly config: TtsConfig;

  connect(callId: CallId, callbacks: TtsCallbacks): Promise<void>;

  /** Start synthesizing text.  Multiple calls queue sequentially. */
  speak(callId: CallId, input: TtsInput): void;

  /** Cancel in-progress TTS immediately (barge-in). */
  interrupt(callId: CallId): void;

  disconnect(callId: CallId): Promise<void>;

  destroy(): Promise<void>;
}
