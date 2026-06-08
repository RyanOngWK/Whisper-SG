/**
 * Twilio Media Stream WebSocket Gateway.
 *
 * Accepts inbound Twilio Media Streams WebSocket connections,
 * validates them via X-Twilio-Signature, and bridges audio
 * between Twilio and the Orchestrator.
 *
 * WebSocket protocol: Twilio sends JSON events — "connected",
 * "start", "media", "stop". The gateway decodes inbound μ-law
 * audio, feeds it to the ASR adapter via the Orchestrator,
 * and relays TTS output back to Twilio as base64-encoded
 * outbound audio.
 */

import * as http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Orchestrator } from "../../services/orchestrator/orchestrator.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";
import {
  asCallId,
  asSessionId,
  asClinicId,
  type SessionState,
} from "../../types/call.js";
import { AudioNormalizer } from "./audioNormalizer.js";
import twilio from "twilio";

// ── Twilio Media Stream JSON event types ────────────────────────

interface TwilioConnectedEvent {
  event: "connected";
  protocol: string;
  version: string;
}

interface TwilioStartEvent {
  event: "start";
  sequenceNumber: string;
  streamSid: string;
  start: {
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
}

interface TwilioMediaEvent {
  event: "media";
  sequenceNumber: string;
  streamSid: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
}

interface TwilioStopEvent {
  event: "stop";
  sequenceNumber: string;
  streamSid: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

type TwilioEvent =
  | TwilioConnectedEvent
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent;

// ── Outbound media message sent to Twilio ────────────────────────

interface TwilioOutboundMedia {
  event: "media";
  streamSid: string;
  media: {
    payload: string;
  };
}

// ── Per-stream state tracked in-memory ──────────────────────────

interface StreamState {
  callSid: string;
  streamSid: string;
  session: SessionState;
}

// ── Gateway configuration ────────────────────────────────────────

export interface TwilioGatewayConfig {
  authToken: string;
  /** Host as seen by Twilio (used in signature validation). */
  publicHost: string;
}

// ── TwilioMediaGateway ──────────────────────────────────────────

export class TwilioMediaGateway {
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private normalizer = new AudioNormalizer();

  /** Map streamSid → StreamState */
  private streams = new Map<string, StreamState>();

  /** Idempotency guard: prevents duplicate start processing. */
  private startedCallSids = new Set<string>();

  constructor(
    private orchestrator: Orchestrator,
    private config: TwilioGatewayConfig,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Start listening for Twilio Media Stream connections.
   */
  listen(port: number): void {
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade — validate Twilio signature here.
    this.server.on(
      "upgrade",
      (request, socket, head) => {
        if (!this.verifyTwilioRequest(request)) {
          safeLog("warn", "Unauthorized WebSocket upgrade rejected");
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const wss = this.wss!;
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      },
    );

    this.wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.server.listen(port, () => {
      safeLog("info", "Twilio Media Gateway listening", {
        context: { port },
      });
    });
  }

  /**
   * Shut down the gateway.
   */
  async shutdown(): Promise<void> {
    for (const [streamSid] of this.streams) {
      await this.cleanupStream(streamSid);
    }
    this.wss?.close();
    this.server?.close();
  }

  // ── WebSocket handling ─────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let streamSid: string | null = null;

    ws.on("message", (data: RawData) => {
      const text =
        Buffer.isBuffer(data) ? data.toString() :
        data instanceof ArrayBuffer ? new TextDecoder().decode(data) :
        String(data);
      streamSid = this.handleMessage(ws, text, streamSid);
    });

    ws.on("close", () => {
      if (streamSid) {
        safeLog("info", "WebSocket closed", {
          context: { streamSid },
        });
        this.handleStreamClose(streamSid);
      }
    });

    ws.on("error", (err) => {
      safeLog("error", "WebSocket error", {
        error: { name: "WebSocketError", message: err.message },
      });
      if (streamSid) {
        this.handleStreamClose(streamSid);
      }
    });
  }

  /**
   * Parse and dispatch a single Twilio JSON event.
   * Returns the streamSid extracted from a start event,
   * or the previously-known streamSid for media/stop events.
   */
  private handleMessage(
    ws: WebSocket,
    text: string,
    currentStreamSid: string | null,
  ): string | null {
    let event: TwilioEvent;
    try {
      event = JSON.parse(text) as TwilioEvent;
    } catch {
      safeLog("warn", "Invalid JSON from Twilio", {
        context: { raw: text.slice(0, 100) },
      });
      return currentStreamSid;
    }

    switch (event.event) {
      case "connected":
        safeLog("debug", "Twilio stream connected", {
          context: {
            protocol: event.protocol,
            version: event.version,
          },
        });
        return currentStreamSid;

      case "start":
        return this.handleStart(ws, event);

      case "media":
        return this.handleMedia(ws, event, currentStreamSid);

      case "stop":
        this.handleStopEvent(event, currentStreamSid);
        return currentStreamSid;

      default:
        safeLog("warn", "Unknown Twilio event", {
          context: {
            eventType: (event as { event: string }).event,
          },
        });
        return currentStreamSid;
    }
  }

  // ── Event handlers ─────────────────────────────────────────────

  private handleStart(ws: WebSocket, event: TwilioStartEvent): string | null {
    const { callSid, accountSid } = event.start;

    // Idempotency: prevent duplicate start for the same callSid.
    if (this.startedCallSids.has(callSid)) {
      safeLog("warn", "Duplicate start event ignored", {
        context: { callSid, streamSid: event.streamSid },
      });
      return event.streamSid;
    }
    this.startedCallSids.add(callSid);

    const streamId = event.streamSid;

    // Build branded types and session state.
    const callId = asCallId(callSid);
    const sessionId = asSessionId(callId);
    const clinicId = asClinicId(
      event.start.customParameters?.clinicId ??
      accountSid,
    );

    const session: SessionState = {
      sessionId,
      callId,
      clinicId,
      patientId: null,
      consent: "pending",
      conversationTurns: [],
      slotValues: {
        language:
          event.start.customParameters?.language ?? "en-US",
      },
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };

    // Register this stream.
    const state: StreamState = {
      callSid,
      streamSid: event.streamSid,
      session,
    };
    this.streams.set(streamId, state);

    safeLog("info", "Media stream started", {
      callId: callId,
      context: { callSid, streamSid: streamId },
    });

    // Kick off the orchestrator — pass a TTS audio forwarder that
    // writes audio chunks back to Twilio.
    this.orchestrator.onCallStart(callId, session, (_cid, chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: TwilioOutboundMedia = {
          event: "media",
          streamSid: streamId,
          media: {
            payload: chunk.toString("base64"),
          },
        };
        ws.send(JSON.stringify(msg));
      }
    }).catch((err: unknown) => {
      safeLog("error", "onCallStart failed", {
        callId: callId,
        error: { name: "CallStartError", message: String(err) },
      });
    });

    return streamId;
  }

  private handleMedia(
    _ws: WebSocket,
    event: TwilioMediaEvent,
    currentStreamSid: string | null,
  ): string | null {
    // Only process inbound audio.
    if (event.media.track !== "inbound") return currentStreamSid;

    const streamId = currentStreamSid ?? event.streamSid;
    const stream = this.streams.get(streamId);
    if (!stream) {
      safeLog("warn", "Media for unknown stream", {
        context: { streamSid: streamId },
      });
      return currentStreamSid;
    }

    const base64Chunk = event.media.payload || event.media.chunk;
    if (!base64Chunk) return currentStreamSid;

    try {
      const pcmBuffer =
        this.normalizer.convertMuLawToLinear16(base64Chunk);
      this.orchestrator.sendAudioToAsr(stream.session.callId, pcmBuffer);
    } catch (err) {
      safeLog("error", "Audio normalization failed", {
        callId: stream.session.callId,
        error: { name: "NormalizeError", message: String(err) },
      });
    }

    return currentStreamSid;
  }

  private handleStopEvent(
    event: TwilioStopEvent,
    currentStreamSid: string | null,
  ): void {
    const streamId = currentStreamSid ?? event.streamSid;
    safeLog("info", "Media stream stop event", {
      context: { streamSid: streamId },
    });
    this.handleStreamClose(streamId);
  }

  /**
   * Tear-down a stream — called on "stop" event, WebSocket close,
   * or WebSocket error.
   */
  private handleStreamClose(streamSid: string): void {
    this.cleanupStream(streamSid).catch((err: unknown) => {
      safeLog("error", "Stream cleanup failed", {
        context: { streamSid },
        error: { name: "CleanupError", message: String(err) },
      });
    });
  }

  private async cleanupStream(streamSid: string): Promise<void> {
    const stream = this.streams.get(streamSid);
    if (!stream) return;

    this.streams.delete(streamSid);
    this.startedCallSids.delete(stream.callSid);

    await this.orchestrator.onCallEnd(
      stream.session.callId,
      stream.session.sessionId,
    );
  }

  // ── Twilio signature validation ────────────────────────────────

  /**
   * Validate an incoming WebSocket upgrade request using
   * Twilio's X-Twilio-Signature header.
   */
  private verifyTwilioRequest(req: http.IncomingMessage): boolean {
    // In development, skip validation for testing convenience.
    if (process.env.NODE_ENV === "development" && !process.env.TWILIO_ENFORCE_AUTH) {
      safeLog("debug", "Skipping Twilio auth in development");
      return true;
    }

    const signature = req.headers["x-twilio-signature"] as
      | string
      | undefined;
    if (!signature) {
      safeLog("warn", "Missing X-Twilio-Signature header");
      return false;
    }

    // Build the full URL Twilio used to reach this endpoint.
    const url = `https://${this.config.publicHost}${req.url ?? "/media-stream"}`;

    // Collect query params — Twilio passes CallSid etc. in the URL.
    const urlObj = new URL(url);
    const params: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    let isValid: boolean;
    try {
      isValid = twilio.validateRequest(
        this.config.authToken,
        signature,
        url,
        params,
      );
    } catch {
      safeLog("warn", "Twilio SDK not available, rejecting auth");
      return false;
    }

    if (!isValid) {
      safeLog("warn", "Invalid Twilio signature", {
        context: { url },
      });
    }
    return isValid;
  }
}
