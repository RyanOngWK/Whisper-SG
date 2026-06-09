# ABiz — Voice AI for Dental Clinics

**Enterprise-grade conversational AI that answers phones, schedules appointments, and triages emergencies for dental practices. HIPAA-ready. Closed-source SaaS.**

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How a Call Flows](#how-a-call-flows)
- [State Machine](#state-machine)
- [Project Structure](#project-structure)
- [Key Design Decisions](#key-design-decisions)
- [Getting Started](#getting-started)
- [Production Roadmap](#production-roadmap)
- [Security & HIPAA](#security--hipaa)
- [Operational Concerns](#operational-concerns)

---

## Architecture Overview

ABiz is a **streaming voice agent** that sits between Twilio’s PSTN and a dental clinic’s Practice Management System (PMS). It receives inbound phone calls, transcribes them in real time, runs a deterministic state machine to route the conversation, falls back to an LLM when intent is ambiguous, responds via text-to-speech, and books appointments via the PMS.

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
│Deep- │ │Mach. │ │OpenAI│ │Open    │
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
| `patient_register_phone` | Collects phone number (US format regex + LLM fallback). |
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
│       └── openDentalAdapter.ts    # Open Dental v24+ REST API
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
│       └── redactor.ts            # HIPAA PII/PHI redaction + pino logger
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

Every external service (ASR, TTS, LLM, PMS) is behind an interface. Swap Deepgram for AssemblyAI, ElevenLabs for Polly, OpenAI for Claude, or Open Dental for Dentrix — without touching the state machine or orchestrator logic.

### 7. HIPAA-first logging

All logging goes through `safeLog()` which redacts PII/PHI patterns (SSN, phone, email, DOB, names) and writes structured JSON via pino to stdout. Raw transcripts never reach any log stream. Column-level encryption for PHI-bearing DB columns.

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
- Open Dental instance (v24+ with REST API enabled)

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

What follows is a prioritized list of work needed to go from prototype to production-grade SaaS. Ordered by dependency and risk.

### Phase 1 — Critical Blockers ✅ COMPLETE

*All 8 items implemented. The system can now handle a real phone call end-to-end.*

| # | Item | Implementation |
|---|---|---|
| 1.1 | Audio Normalizer | `audioNormalizer.ts` — Full G.711 μ-law decoder (ITU-T lookup table) + linear interpolation 8→16 kHz resampler producing valid 16-bit little-endian PCM. |
| 1.2 | PMS Calls | `orchestrator.ts` — `fetchAndStoreSlots()` calls `pms.getAvailableSlots()` with 2-week window; `bookAppointment()` calls `pms.createAppointment()`; `upsertPatientIfNew()` calls `pms.upsertPatient()`. |
| 1.3 | patient_register sub-flow | 4 new `DentalState` entries: `patient_register_name` → `_dob` → `_phone` → `_confirm`. Each has a pure handler with regex extraction and LLM fallback. TTS prompts templated with collected slots. |
| 1.4 | State tracking fix | Removed dead `intendedState` param from `advanceStateMachine`. `slotValues._currentState` is the single source of truth. |
| 1.5 | Database persistence | `repository.ts` — `OrchestratorRepository` with 5 write methods. Wired as fire-and-forget via `void`. `index.ts` creates a `pg.Pool` and passes to orchestrator. |
| 1.6 | Redis session store | `redisStore.ts` — `RedisSessionStore` using ioredis with JSON serialization, TTL expiry, and retry strategy. Orchestrator accepts pluggable `SessionStore` interface with `InMemorySessionStore` fallback. |
| 1.7 | Real logging | `redactor.ts` — `safeLog()` now writes via pino (structured JSON to stdout). `initLogger(level)` called at startup from `index.ts`. |
| 1.8 | Down migration | `down.sql` — Drops all tables + functions in reverse dependency order. |

---

### Phase 2 — Production Hardening (needed before GA)

#### 2.1 Tests

**Directory:** `tests/`

There are zero test files. Vitest is configured but unused. Priority order:
1. **State machine handler tests** — Pure functions, easiest to test. Every handler should have tests for happy path and edge cases (ambiguous input, empty input, conflicting slots).
2. **State machine engine tests** — Test the LLM fallback invocation path, event emission, and invalid state handling.
3. **Redaction tests** — Verify all PII patterns are caught.
4. **Adapter integration tests** — Mock the WebSocket/HTTP layer, test the adapter’s message parsing.
5. **Orchestrator integration tests** — Mock adapters, simulate full call flows.
6. **End-to-end tests** — Spin up the gateway, send synthetic Twilio events, verify state transitions and TTS output.

#### 2.2 Multiple ASR/TTS Provider Support

Create adapters for the providers declared in the type unions:
- **ASR:** `assemblyaiAdapter.ts`, `azureAdapter.ts`
- **TTS:** `pollyAdapter.ts`, `azureAdapter.ts`, `deepgramAuraAdapter.ts`

Multi-provider support is a competitive differentiator — some clinics will have existing contracts with specific vendors.

#### 2.3 Multiple LLM Provider Support

Create `anthropicAdapter.ts` and `googleAdapter.ts`. Anthropic’s Claude is popular in healthcare due to stronger safety guarantees.

#### 2.4 Multiple PMS Provider Support

Create adapters for Dentrix, Eaglesoft, and Curve. Open Dental covers ~40% of the US market. The other three cover most of the rest. PMS integration is the hardest adapter to write — every PMS has a different data model.

#### 2.5 Call Recording to S3

Implement recording upload: after call end, encode the full audio stream (or retrieve from Twilio’s recording API) and upload to the configured S3 bucket with KMS encryption. Update `call_sessions` with the S3 key.

#### 2.6 Graceful Degradation

If the LLM is down, the system should continue with deterministic routing only (no fallback — apologize and ask to rephrase). If the PMS is down, the system should queue appointment requests for later sync. If ASR is down, the call should be transferred to a human or voicemail.

#### 2.7 Health Check Endpoint

Add an HTTP health check endpoint that verifies connectivity to Postgres, Redis, and all configured adapters. Needed for Kubernetes liveness/readiness probes and load balancer health checks.

#### 2.8 Metrics & Observability

Expose Prometheus metrics:
- Call volume (total, active, completed, failed)
- State machine state distribution (a gauge per state)
- LLM fallback rate (fallbacks per call)
- ASR/TTS/LLM/PMS latency histograms
- Audio quality metrics (packet loss, jitter from Twilio)

#### 2.9 Rate Limiting & Concurrency

Implement per-clinic concurrency limits. If Clinic A has 3 phone lines and 4 calls come in simultaneously, the 4th should get a busy signal or queue — not crash the server.

---

### Phase 3 — Competitive Features (post-GA)

#### 3.1 Outbound Calling

Add support for appointment reminders, recall notices, and post-treatment follow-ups via outbound Twilio calls. This requires a new state machine flow (`outbound_reminder`, `outbound_recall`, `outbound_follow_up`) and Twilio outbound call initiation.

#### 3.2 Multi-Language Support

The config and session state already carry a `language` field. Implement TTS prompts in Spanish and other languages. The LLM system prompt should adapt based on language. ASR models should be selected per language.

#### 3.3 IVR/Self-Service Menu

Add a DTMF-driven menu for patients who prefer button-press navigation (e.g., "Press 1 for appointments, 2 for billing"). Twilio Media Streams supports DTMF events.

#### 3.4 Live Agent Handoff

Add a `transfer_to_human` state that bridges the Twilio call to a human agent via Twilio’s `<Dial>` verb or a queue system. The AI should hand off context (summary of what’s been collected so far) to the agent.

#### 3.5 Sentiment & Escalation Detection

Add sentiment analysis on transcripts. If the patient sounds angry or frustrated, escalate to a human. This can be done via the LLM or a dedicated sentiment model.

#### 3.6 Clinic Portal / Dashboard

Build a web dashboard for clinic admins to view call logs, listen to recordings, see appointment booking analytics, and configure AI behavior (prompts, office hours, appointment types).

#### 3.7 Custom Voice Cloning

Allow clinics to train a custom TTS voice that matches their brand (or a specific dentist). ElevenLabs supports professional voice cloning.

---

### Phase 4 — Enterprise Readiness

#### 4.1 SOC 2 / HITRUST Compliance

Engage a compliance auditor. Ensure all PHI data flows are documented, encrypted at rest and in transit, with audit trails for every access. Implement RBAC for the dashboard.

#### 4.2 Multi-Region Deployment

Deploy in AWS us-east-1 and us-west-2 with active-active failover. Twilio Media Streams should route to the nearest region. Redis and Postgres need cross-region replication.

#### 4.3 SLA & SLO Tracking

Define SLOs: 99.9% uptime, < 1s TTS latency from state transition to first audio byte, < 300ms ASR final result latency, < 5% LLM fallback rate. Track them via the observability stack.

#### 4.4 Penetration Testing

Engage a third-party security firm for penetration testing of the WebSocket gateway, API endpoints, and infrastructure.

---

## Security & HIPAA

### Data Classification

| Data | Classification | Storage |
|---|---|---|
| Call transcripts | PHI | Encrypted in Postgres (`conversation_turns`), purged per retention policy |
| Patient demographics | PHI | Encrypted in PMS (not stored in ABiz DB — syncs from PMS) |
| Call metadata (duration, timestamps) | PII | Postgres (`call_sessions`), purged per retention policy |
| Call recordings | PHI | S3 with KMS encryption, lifecycle policy for deletion |
| API keys / secrets | Secret | Environment variables, never logged or committed |
| ASR/TTS audio streams | PHI | Ephemeral — processed in-memory, never stored |

### Redaction Rules

All logging routes through `safeLog()` in `src/infrastructure/logging/redactor.ts`. Patterns redacted:
- SSN (###-##-####)
- Phone numbers (US formats)
- Email addresses
- Dates of birth
- Medical record numbers / patient IDs
- ZIP codes
- Name phrases ("my name is X", "I'm X")

Object keys named `transcript`, `rawTranscript`, `firstName`, `lastName`, `phone`, `email`, `ssn`, `dob`, `address`, `insurance`, `memberId` are replaced with `"[REDACTED]"` at any depth.

### Encryption

- **In transit:** All external service connections use TLS (HTTPS/WSS). Twilio WebSocket uses WSS.
- **At rest:** PHI columns in Postgres are encrypted at the application layer before insert (via KMS or pgcrypto). S3 buckets enforce `aws:kms` encryption.
- **Key management:** AWS KMS for S3 and column-level encryption keys. Secrets in env vars (in production, use AWS Secrets Manager or HashiCorp Vault).

### Retention

The `purge_expired_data(retention_days)` stored function deletes all PHI-bearing rows older than the configured retention period (default: 90 days). This should be run as a scheduled job (cron / Kubernetes CronJob).

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
