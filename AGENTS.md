# AGENTS.md

## Commands

```
npm run typecheck    # tsc --noEmit (always run before test/lint)
npm run lint         # ESLint src/
npm run format:check # Prettier check
npm run test         # Vitest run (single pass)
npm run dev          # tsx watch src/index.ts (entrypoint exists — adapters are no-ops)
npm run build        # tsc -> dist/
```

Order: `typecheck` first, then `lint`, then `test`.

## Architecture

### Directory boundaries

| Dir | Purpose | Rules |
|---|---|---|
| `src/types/` | Domain types shared across layers | Branded types for IDs (CallId, SessionId, PatientId, etc.) — never pass raw `string` |
| `src/core/` | Pure business logic | No I/O, no side effects. State machine handlers, intent detection, dental flows |
| `src/services/` | External service facades | Orchestrator, LLM/ASR/TTS adapters, PMS bridges. Implements the interfaces from `src/core/` |
| `src/gateways/` | I/O boundary | Twilio media streams (telephony), HTTP API. The entrypoint to the outside world |
| `src/infrastructure/` | Cross-cutting plumbing | DB migrations, Redis, S3, logging, config |

### Key conventions

- **State machine handlers must be pure** — they return a `StateTransition`, never fire side effects. The orchestrator executes side effects after the transition is resolved.
- **All domain IDs use branded types** (`src/types/call.ts:6-11`). Use `asCallId()`, `asSessionId()`, etc. to cast — never use raw strings.
- **ASR adapter** (`src/services/asr/types.ts`): streaming callback-based (`onResult` fires for both interim and final transcripts). Each adapter manages its own WebSocket/gRPC lifecycle via `connect`/`disconnect`/`destroy`.
- **TTS adapter** (`src/services/tts/types.ts`): audio chunks via `onAudio` callback. Must support barge-in via `interrupt()`.
- **PMS adapter** (`src/services/pms/types.ts`): interface for bridging clinic PMS (Open Dental, Dentrix, etc.). Methods: `findPatients`, `getAvailableSlots`, `createAppointment`, `upsertPatient`.
- **The `fallback_llm` state** is a meta-state: when a handler cannot resolve the intent deterministically, it transitions to `fallback_llm`. The orchestrator invokes the LLM and rewrites the next state.
- **LLM adapter** (`src/services/llm/types.ts`): returns structured `LlmDecision` (nextState + extractedSlots + responseText) — the orchestrator never parses free-form LLM output.
- **HIPAA redaction** (`src/infrastructure/logging/redactor.ts`): `redact()` for strings, `redactObject()` for structured data. Use `safeLog()` to emit any log entry — it scrubs PII/PHI before any log stream. Raw transcripts must never reach the log layer unredacted.
- **Twilio gateway** (`src/gateways/telephony/twilioHandler.ts`): WebSocket server using `ws` library. Validates `X-Twilio-Signature` on upgrade. Bridges inbound μ-law audio → Orchestrator → ASR, and TTS output → base64 → Twilio. Uses discriminated union `TwilioEvent` for message dispatch. Per-callSid idempotency guard prevents duplicate start processing.
- **Audio normalizer** (`src/gateways/telephony/audioNormalizer.ts`): stub class for Twilio 8 kHz μ-law → 16 kHz linear PCM conversion. Production needs G.711 decoding + resampling.
- **`connection_lost` state** (`src/core/state-machine/`): a clean-up transition for dropped WebSocket connections. Handler returns `{ nextState: "end_call", payload: { reason: "connection_lost" } }`.
- **TTS audio forwarder**: `Orchestrator.onCallStart()` accepts an optional `onTtsAudio` callback. The Twilio gateway passes it this callback to relay synthesized speech back to the WebSocket.

### Config

- `src/infrastructure/config/schema.ts` — Zod-validated config loaded from env at startup via `loadConfig()`. No hardcoded secrets. Copy `.env.example` to `.env` and fill in values.
- All env vars are prefixed by service (`DB_`, `REDIS_`, `TWILIO_`, `ASR_`, `TTS_`, `LLM_`, `PMS_`, `AWS_`).

### Database

- Postgres via `pg` driver. Migration runner is a custom script (`migrate.ts`), not a third-party tool (no Knex, no Drizzle, no Prisma).
- Redis via `ioredis` for session state.
- Migration files live in `db/migrations/`. First migration: `001_initial_schema` — creates clinics, providers, operatories, call_sessions, conversation_turns, state_transitions, llm_fallback_events, appointments, plus a `purge_expired_data()` function for retention enforcement.
- Column-level encryption for PHI-bearing columns (transcripts in `conversation_turns`, metadata in `call_sessions`) — encrypted before insert via app-level KMS or pgcrypto.

### Entrypoints

- `src/index.ts` — main server entrypoint (stub — adapters are no-ops, Twilio gateway not yet mounted)
- `src/infrastructure/db/migrate.ts` — migration runner

### Known gaps

- `npm install` must be run before typecheck/lint/test (no node_modules checked in).
- No `.prettierignore` exists.
