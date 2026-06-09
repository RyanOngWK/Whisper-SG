# Whisper — Voice AI for Singapore Clinics

**Enterprise-grade conversational AI that answers phones, schedules appointments, and triages emergencies for Singapore healthcare practices. PDPA-compliant. Closed-source SaaS.**

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How a Call Flows](#how-a-call-flows)
- [State Machine](#state-machine)
- [Project Structure](#project-structure)
- [Key Design Decisions](#key-design-decisions)
- [Getting Started](#getting-started)
- [Production Roadmap](#production-roadmap)
- [Security & PDPA](#security--pdpa)
- [Operational Concerns](#operational-concerns)

---

## Architecture Overview

ABiz is a **streaming voice agent** that sits between Twilio’s PSTN and a Singapore clinic’s Practice Management System (PMS). It receives inbound phone calls, transcribes them in real time, runs a deterministic state machine to route the conversation, falls back to an LLM when intent is ambiguous, responds via text-to-speech, and books appointments via the PMS.

```
  Patient Phone Call
        │
        ▼
  ┌─────────────┐
  │   Twilio     │  PSTN → Media Streams WebSocket (μ-law 8 kHz)
  │  <Stream>    │
  └──────┬──────┘
         │ wss://
         ▼
  ┌──────────────────┐
  │ Twilio Gateway   │  Signature validation, audio decode, per-call state
  │ (gateways/)      │
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │   Orchestrator   │  Wires ASR ↔ State Machine ↔ LLM ↔ TTS ↔ PMS
  │  (services/)     │
  └──────┬───────────┘
         │
    ┌────┴────┬─────────┬─────────┐
    ▼         ▼         ▼         ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐
│ ASR  │ │State │ │ LLM  │ │  PMS   │
│Deep- │ │Mach. │ │OpenAI│ │Plato   │
│gram  │ │(core)│ │      │ │Dental  │
└──────┘ └──────┘ └──────┘ └────────┘
    │                              │
    ▼                              ▼
┌──────┐                    ┌──────────┐
│ TTS  │                    │ Postgres │
│Eleven│                    │ + Redis  │
│Labs  │                    │(infra)   │
└──────┘                    └──────────┘
    │
    ▼
 Twilio WebSocket → PSTN → Patient hears response
```

### Layer Boundaries

| Layer | Dir | Rule |
|---|---|---|
| **Types** | `src/types/` | Domain types shared across all layers. Branded IDs — never pass raw `string`. |
| **Core** | `src/core/` | Pure business logic. No I/O, no side effects. State machine handlers return transitions only. |
| **Services** | `src/services/` | External service facades. Implement interfaces defined in core. Orchestrator coordinates them. |
| **Gateways** | `src/gateways/` | I/O boundary. Twilio WebSocket server. Audio normalization. |
| **Infrastructure** | `src/infrastructure/` | Cross-cutting: config, DB migrations, Redis, S3, logging, redaction. |

---

## How a Call Flows

1. **Patient calls** the clinic’s Twilio phone number.
2. **Twilio bridges** the call to a WebSocket using the `<Stream>` TwiML verb. Audio arrives as base64-encoded μ-law in JSON messages.
3. **TwilioGateway** validates the `X-Twilio-Signature` header, extracts `callSid` (converted to branded `CallId`), and builds a `SessionState`.
4. **Audio pipeline**: base64 μ-law → `AudioNormalizer` (decodes G.711, resamples 8→16 kHz) → 16-bit linear PCM.
5. **Orchestrator** feeds PCM to the **ASR adapter** (Deepgram WebSocket). Interim results are discarded; final results drive the state machine.
6. **State machine engine** looks up the handler for the current `DentalState`. The handler inspects the transcript and returns a `StateTransition` (`{ nextState, payload }`).
7. If the handler can’t resolve intent deterministically, it returns `fallback_llm`. The engine invokes the **LLM adapter** (OpenAI with structured JSON output), which returns a `LlmDecision` (next state + extracted slots + response text). Slots are merged into the session.
8. **Orchestrator executes side effects** after the transition resolves:
   - **TTS**: Looks up the prompt for the new state, sends it to ElevenLabs. Audio chunks stream back to Twilio via the gateway’s `onTtsAudio` callback.
   - **PMS**: Calls `getAvailableSlots()` on entering `appointment_slot_select`, `createAppointment()` on confirmed `schedule_result`, and `upsertPatient()` when new patient registration is confirmed.
   - **DB**: Persists conversation turns, state transitions, and LLM fallback events to Postgres (fire-and-forget via `void`).
9. The cycle repeats until the state machine reaches `end_call`.

---

## State Machine

The state machine is the central routing brain. It has 17 states arranged as a directed graph, with LLM fallback as a meta-state that re-routes when deterministic handlers can’t resolve intent.

```
greeting ──► consent_check ──► patient_identify ──┬──► emergency_triage ──► end_call
                                      │            │
                                      │            └──► patient_register
                                      │                      │
                                      │            ┌─────────┼──────────┐
                                      │            ▼         ▼          ▼
                                      │     patient_register patient_register patient_register
                                      │         _name            _dob          _phone
                                      │            │              │              │
                                      │            └──────────────┼──────────────┘
                                      │                           ▼
                                      │                  patient_register_confirm
                                      │                           │
                                      │                  reason_for_visit
                                      │                           │
                                      └──► (ambiguous) ──► fallback_llm ──► (rewrites to any valid state)
                                                                      │
                                              reason_for_visit ────────┤
                                                      │               │
                                              appointment_slot_select ◄┘
                                                      │
                                              confirm_appointment
                                                      │
                                              schedule_result ──► end_call

connection_lost ──► end_call
general_query   ──► fallback_llm
```

**Key states:**

| State | Purpose |
|---|---|
| `greeting` | Opens every call. Always proceeds to consent. |
| `consent_check` | Asks for consent to record/use AI. Keyword match on "yes"/"no". |
| `patient_identify` | Determines if new patient, existing patient, or emergency. Uses regex. |
| `patient_register` | Entry point for new patient registration sub-flow. |
| `patient_register_name` | Collects full name (regex extract + LLM fallback). |
| `patient_register_dob` | Collects date of birth (multi-format regex + LLM fallback). |
| `patient_register_phone` | Collects phone number (Singapore format regex + LLM fallback). |
| `patient_register_confirm` | Confirms collected info. Writes to PMS on yes, restarts on no. |
| `reason_for_visit` | Maps utterance to appointment type (cleaning, crown, extraction, etc.). |
| `appointment_slot_select` | Fetches available time slots from PMS, presents options. |
| `confirm_appointment` | Confirms booking details before committing. |
| `schedule_result` | Books via PMS, confirms success/failure. |
| `emergency_triage` | Escalates emergencies. Marks `escalated: true`. |
| `general_query` | Catch-all. Delegates entirely to LLM. |
| `fallback_llm` | Meta-state. LLM rewrites the next state when handlers are stuck. |
| `connection_lost` | WebSocket dropped. Cleanup-only transition. |
| `end_call` | Terminal state. Triggers cleanup. |

**Handlers are pure** — they receive a `StateContext` and return a `StateTransition`. The orchestrator, not the handler, executes side effects (TTS, PMS, DB writes). This keeps the state machine testable independently of any infrastructure.

---

## Project Structure

```
src/
├── types/                          # Domain types (shared everywhere)
│   ├── call.ts                     # Branded IDs, SessionState, ConversationTurn
│   └── dental.ts                   # Patient, Appointment, AppointmentSlot
│
├── core/                           # Pure business logic (no I/O)
│   └── state-machine/
│       ├── types.ts                # DentalState union, StateTransition, StateHandler
│       ├── handlers.ts             # 17 pure handler functions + registry
│       └── engine.ts               # StateMachineEngine (evented, LLM-fallback aware)
│
├── services/                       # External service facades
│   ├── orchestrator/
│   │   └── orchestrator.ts         # Wires ASR/TTS/StateMachine/LLM/PMS
│   ├── asr/
│   │   ├── types.ts                # AsrAdapter interface
│   │   └── deepgramAdapter.ts      # Deepgram WebSocket streaming ASR
│   ├── tts/
│   │   ├── types.ts                # TtsAdapter interface (barge-in via interrupt())
│   │   └── elevenlabsAdapter.ts    # ElevenLabs streaming TTS
│   ├── llm/
│   │   ├── types.ts                # LlmAdapter interface (returns structured LlmDecision)
│   │   └── openaiAdapter.ts        # OpenAI structured JSON output
│   └── pms/
│       ├── types.ts                # PmsAdapter interface
│       └── singaporePmsAdapter.ts    # Singapore PMS REST API
│
├── gateways/                       # I/O boundary
│   └── telephony/
│       ├── twilioHandler.ts        # Twilio Media Streams WebSocket server
│       └── audioNormalizer.ts      # G.711 μ-law → linear16 PCM (8→16 kHz resample)
│
├── infrastructure/                 # Cross-cutting
│   ├── config/
│   │   └── schema.ts              # Zod-validated env config
│   ├── db/
│   │   ├── migrate.ts             # Custom migration runner
│   │   └── repository.ts          # Postgres persistence layer
│   ├── session/
│   │   └── redisStore.ts          # Redis-backed session store
│   └── logging/
│       └── redactor.ts            # PDPA redaction + pino logger
│
└── index.ts                        # Entrypoint — wires everything, starts server

db/
└── migrations/
    └── 001_initial_schema/
        ├── up.sql                  # clinics, providers, operatories, call_sessions,
        │                           # conversation_turns, state_transitions,
        │                           # llm_fallback_events, appointments
        └── down.sql                # Reverse migration (drop all in dependency order)
```

---

## Key Design Decisions

### 1. Branded IDs everywhere

`CallId`, `SessionId`, `PatientId`, `AppointmentId`, `ClinicId` — all are branded types. You can’t accidentally pass a `string` where a `CallId` is expected. Compile-time safety.

### 2. Pure state machine handlers

Handlers return `StateTransition` — they never fire side effects. The orchestrator executes side effects after the transition resolves. This means the entire conversation flow can be unit-tested without mocking ASR, TTS, or the database.

### 3. LLM as a fallback, not the driver

The LLM is only invoked when deterministic handlers can’t resolve intent. This keeps costs low (LLM calls are expensive), latency predictable, and behavior auditable. The LLM returns structured JSON (`LlmDecision`), never free-form text — the orchestrator doesn’t parse LLM output.

### 4. Streaming-first audio

Both ASR and TTS use persistent WebSocket connections per call — no chunked HTTP uploads. Interim ASR results stream for real-time display; only final results drive state transitions. TTS streams audio chunks back to Twilio as they’re synthesized (latency reduction).

### 5. Barge-in support

The TTS adapter exposes `interrupt()`. If the patient starts speaking while the AI is talking, the orchestrator can cut TTS mid-stream and re-route audio to ASR. This is critical for natural conversation flow.

### 6. Adapter pattern for vendor flexibility

Every external service (ASR, TTS, LLM, PMS) is behind an interface. Swap Deepgram for AssemblyAI, ElevenLabs for Polly, OpenAI for Claude, or Plato for ClinicAssist — without touching the state machine or orchestrator logic.

### 7. PDPA-first logging

All logging goes through `safeLog()` which redacts personal data patterns (NRIC/FIN, phone, email, DOB, names) and writes structured JSON via pino to stdout. Raw transcripts never reach any log stream. Column-level encryption for personal data bearing DB columns.

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL 15+
- Redis 7+
- Twilio account with a phone number configured for Media Streams
- Deepgram API key
- ElevenLabs API key
- OpenAI API key
- Plato, Klinify, ClinicAssist, or MediSYS PMS instance

### Setup

```bash
cp .env.example .env
# Fill in all required env vars in .env
npm install
npm run build
npm run typecheck
npm run lint
```

### Database

```bash
npx tsx src/infrastructure/db/migrate.ts migrate:up
```

### Development

```bash
npm run dev
```

### Running checks

```bash
npm run typecheck    # always first
npm run lint         # then lint
npm run test         # then test
```

---

## Production Roadmap

### Phase 1 — Core Platform ✅ COMPLETE

*The system can handle a real phone call end-to-end: answer, transcribe, route via state machine, speak TTS responses, and book appointments via the Plato PMS adapter. PDPA-compliant logging and data retention are in place.*

| # | Item | Implementation |
|---|---|---|
| 1 | Audio Normalizer | `audioNormalizer.ts` — Full G.711 μ-law decoder (ITU-T lookup table) + linear interpolation 8→16 kHz resampler producing valid 16-bit little-endian PCM. |
| 2 | State Machine | 17 states in `handlers.ts` — greeting → consent → patient identify → register → schedule → end. All handlers are pure, all side effects dispatched by the orchestrator. |
| 3 | LLM Fallback | `engine.ts` — When a deterministic handler cannot resolve intent, the LLM is invoked. Returns structured `LlmDecision` (nextState + extractedSlots + responseText). |
| 4 | Singapore PMS Adapter | `singaporePmsAdapter.ts` — Vendor-agnostic REST adapter supporting Plato (current), Klinify, ClinicAssist, MediSYS. `findPatients`, `getAvailableSlots`, `createAppointment`, `upsertPatient`. |
| 5 | PDPA Logging & Redaction | `redactor.ts` — NRIC/FIN, SG phone, postal code, email, DOB, name redaction. Structured JSON logging via pino. `safeLog()` used everywhere. |
| 6 | Database Persistence | `repository.ts` — Call sessions, conversation turns, state transitions, LLM fallback events all persisted (fire-and-forget via `void`). |
| 7 | Redis Session Store | `redisStore.ts` — ioredis-backed with JSON serialization, TTL expiry, retry strategy. Falls back to `InMemorySessionStore` if Redis is unavailable. |
| 8 | Migration Runner | `migrate.ts` — Custom runner (no Knex/Drizzle/Prisma). First migration: `001_initial_schema` with clinics, providers, operatories, sessions, turns, transitions, appointments, and `purge_expired_data()` function. |

---

### Phase 2 — Production MVP (7 steps to first deployment)

| # | Item | What | File(s) |
|---|---|---|---|
| 2.1 | **SG phone regex fix** | Current `patient_register_phone` handler uses US phone pattern. Switch to SG format: `+65 9123 4567`, `81234567`. | `handlers.ts` |
| 2.2 | **State machine handler tests** | 17 handlers × happy path + edge cases. Pure functions — no mocking needed. | `tests/core/state-machine/handlers.test.ts` |
| 2.3 | **Redaction tests** | Verify NRIC/FIN (`S1234567A`), SG phone (`9123 4567`), postal code (6-digit), email, DOB, name patterns. Verify `SENSITIVE_KEYS` are stripped from objects. | `tests/infrastructure/logging/redactor.test.ts` |
| 2.4 | **State machine engine tests** | Test `advance()` for valid/invalid states, LLM fallback invocation, event emission. | `tests/core/state-machine/engine.test.ts` |
| 2.5 | **PMS adapter tests** | Mock `global.fetch` — test patient CRUD, slot queries, appointment CRUD, health check, error handling. | `tests/services/pms/singaporePmsAdapter.test.ts` |
| 2.6 | **S3 call recording** | Use Twilio's Recording API to retrieve call audio post-call, upload to S3 bucket with KMS encryption, store object key in `call_sessions.metadata`. | `src/infrastructure/storage/s3Storage.ts` + wiring in `orchestrator.ts` |
| 2.7 | **AWS SDK dependency** | Add `@aws-sdk/client-s3` for S3 uploads. | `package.json` |

---

### Phase 3 — Production Hardening

| # | Item |
|---|---|
| 3.1 | **Orchestrator integration tests** — Mock all adapters, simulate full call flows end-to-end (`tests/services/orchestrator/orchestrator.test.ts`). |
| 3.2 | **Multiple PMS provider support** — Flesh out adapters for Klinify, ClinicAssist, MediSYS once their APIs are available. |
| 3.3 | **Health check endpoint** — HTTP endpoint verifying Postgres, Redis, and all adapter connectivity. Needed for Kubernetes probes. |
| 3.4 | **Graceful degradation** — LLM unavailable → deterministic routing only. PMS down → queue appointment requests for later sync. ASR down → transfer to voicemail. |
| 3.5 | **Metrics & observability** — Prometheus metrics: call volume, state distribution, LLM fallback rate, ASR/TTS/LLM/PMS latency histograms. |
| 3.6 | **Rate limiting & concurrency** — Per-clinic concurrency caps. Clinic A has 3 lines → 4th call gets busy signal, not a crash. |

---

### Phase 4 — Competitive Features (post-GA)

| # | Item |
|---|---|
| 4.1 | **Outbound calling** — Appointment reminders, recall notices, post-treatment follow-ups via Twilio outbound. |
| 4.2 | **Multi-language** — TTS/ASR/LLM in Mandarin, Malay, Tamil (Singapore's official languages). Config already carries `language` field. |
| 4.3 | **Live agent handoff** — `transfer_to_human` state that bridges to a human agent via Twilio `<Dial>`, handing off conversation context. |
| 4.4 | **Sentiment & escalation** — Detect frustration → escalate to human via the LLM or a dedicated model. |
| 4.5 | **Clinic dashboard** — Web UI for call logs, recordings, appointment analytics, AI behavior config (prompts, office hours, appointment types). |
| 4.6 | **PDPA audit engagement** — Engage a compliance auditor for formal PDPA certification. Document all data flows, RBAC for dashboard, audit trails. |
| 4.7 | **Multi-region deployment** — AWS ap-southeast-1 (Singapore) + ap-southeast-3 (Jakarta) active-active failover. Cross-region Redis/Postgres replication. |
| 4.8 | **Penetration testing** — Third-party security firm pentest of WebSocket gateway, API endpoints, and infrastructure. |

---

## Security & PDPA

### Data Classification

| Data | Classification | Storage |
|---|---|---|
| Call transcripts | personal data | Encrypted in Postgres (`conversation_turns`), purged per retention policy |
| Patient demographics | personal data | Encrypted in PMS (not stored in ABiz DB — syncs from PMS) |
| Call metadata (duration, timestamps) | Personal data | Postgres (`call_sessions`), purged per retention policy |
| Call recordings | personal data | S3 with KMS encryption, lifecycle policy for deletion |
| API keys / secrets | Secret | Environment variables, never logged or committed |
| ASR/TTS audio streams | personal data | Ephemeral — processed in-memory, never stored |

### Redaction Rules

All logging routes through `safeLog()` in `src/infrastructure/logging/redactor.ts`. Patterns redacted:
- NRIC/FIN (S1234567A format)
- Phone numbers (Singapore formats)
- Email addresses
- Dates of birth
- Medical record numbers / patient IDs
- Postal codes
- Name phrases ("my name is X", "I'm X")

Object keys named `transcript`, `rawTranscript`, `firstName`, `lastName`, `phone`, `email`, `ssn`, `dob`, `address`, `insurance`, `memberId` are replaced with `"[REDACTED]"` at any depth.

### Encryption

- **In transit:** All external service connections use TLS (HTTPS/WSS). Twilio WebSocket uses WSS.
- **At rest:** personal data columns in Postgres are encrypted at the application layer before insert (via KMS or pgcrypto). S3 buckets enforce `aws:kms` encryption.
- **Key management:** AWS KMS for S3 and column-level encryption keys. Secrets in env vars (in production, use AWS Secrets Manager or HashiCorp Vault).

### Retention

The `purge_expired_data(retention_days)` stored function deletes all personal data bearing rows older than the configured retention period (default: 90 days). This should be run as a scheduled job (cron / Kubernetes CronJob).

---

## Operational Concerns

### Graceful Shutdown

`src/index.ts` registers `SIGTERM`/`SIGINT` handlers that sequentially call `gateway.shutdown()`, `sessionStore.disconnect()`, and `dbPool.end()` before exiting. Ensure your process manager (Docker, systemd, Kubernetes) sends SIGTERM and waits for the process to exit before SIGKILL.

### Horizontal Scaling

With Redis-backed sessions, multiple instances can run behind a load balancer. However, note that each active call is pinned to a specific WebSocket connection on a specific instance — you can’t migrate a live call between instances. Use Twilio’s routing (or a connection-aware load balancer) to distribute new calls, and accept that active calls are sticky. The `RedisSessionStore` uses TTL-based expiry to handle orphaned sessions from crashed instances.

### Monitoring Checklist

- [ ] Process health (CPU, memory, event loop lag)
- [ ] Active WebSocket connections (gauge)
- [ ] ASR/TTS/LLM/PMS error rates
- [ ] State machine fallback rate (should be < 10%)
- [ ] Audio buffer backpressure (Twilio → ASR pipeline)
- [ ] Database connection pool utilization
- [ ] Redis connection health and memory usage
- [ ] S3 upload success rate
- [ ] ALB/ELB 5xx rate

---

## License

Closed-source. Proprietary. All rights reserved.
