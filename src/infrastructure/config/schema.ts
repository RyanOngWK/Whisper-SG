/**
 * Application configuration schema — Zod-validated at startup.
 *
 * Every config value is sourced from process.env and validated
 * before the server starts.  No hardcoded defaults for secrets.
 */

import { z } from "zod";

export const configSchema = z.object({
  // ── Server ─────────────────────────────────────────────────
  port: z.coerce.number().int().default(8080),
  nodeEnv: z
    .enum(["development", "staging", "production"])
    .default("development"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ── Postgres ────────────────────────────────────────────────
  db: z.object({
    host: z.string(),
    port: z.coerce.number().int().default(5432),
    database: z.string(),
    user: z.string(),
    password: z.string(),
    ssl: z.coerce.boolean().default(false),
    maxConnections: z.coerce.number().int().default(20),
    /** Days to retain PHI-bearing rows before automated purge. */
    retentionDays: z.coerce.number().int().default(90),
  }),

  // ── Redis ───────────────────────────────────────────────────
  redis: z.object({
    host: z.string(),
    port: z.coerce.number().int().default(6379),
    password: z.string().optional(),
    /** Session TTL in seconds. */
    sessionTtl: z.coerce.number().int().default(3600),
  }),

  // ── AWS / S3 ────────────────────────────────────────────────
  aws: z.object({
    region: z.string().default("us-east-1"),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    s3: z.object({
      bucket: z.string(),
      encryption: z.enum(["AES256", "aws:kms"]).default("aws:kms"),
      kmsKeyId: z.string().optional(),
    }),
  }),

  // ── Twilio ──────────────────────────────────────────────────
  twilio: z.object({
    accountSid: z.string(),
    authToken: z.string(),
  }),

  // ── ASR ─────────────────────────────────────────────────────
  asr: z.object({
    provider: z.enum(["deepgram", "assemblyai", "azure"]),
    apiKey: z.string(),
    model: z.string(),
    language: z.string().default("en-US"),
    interimResults: z.coerce.boolean().default(true),
    diarize: z.coerce.boolean().default(false),
  }),

  // ── TTS ─────────────────────────────────────────────────────
  tts: z.object({
    provider: z.enum(["elevenlabs", "deepgram", "polly", "azure"]),
    apiKey: z.string(),
    voiceId: z.string(),
    model: z.string(),
    speed: z.coerce.number().min(0.5).max(2.0).default(1.0),
    streamingLatency: z.coerce.number().int().default(1),
  }),

  // ── LLM ─────────────────────────────────────────────────────
  llm: z.object({
    provider: z.enum(["openai", "anthropic", "google"]),
    apiKey: z.string(),
    model: z.string(),
    temperature: z.coerce.number().min(0).max(2).default(0.3),
    maxTokens: z.coerce.number().int().default(1024),
    systemPrompt: z.string().default(
      "You are a dental clinic voice assistant. Your job is to understand the caller's intent and extract structured information from their speech. Never ask for or store SSNs. Always be polite and professional.",
    ),
  }),

  // ── PMS ─────────────────────────────────────────────────────
  pms: z.object({
    provider: z.enum(["open_dental", "dentrix", "eaglesoft", "curve"]),
    apiUrl: z.string().optional(),
    apiKey: z.string().optional(),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables.
 * Throws if required fields are missing or invalid.
 */
export function loadConfig(): AppConfig {
  const raw = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    db: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL,
      maxConnections: process.env.DB_MAX_CONNECTIONS,
      retentionDays: process.env.DB_RETENTION_DAYS,
    },
    redis: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
      sessionTtl: process.env.REDIS_SESSION_TTL,
    },
    aws: {
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      s3: {
        bucket: process.env.AWS_S3_BUCKET,
        encryption: process.env.AWS_S3_ENCRYPTION,
        kmsKeyId: process.env.AWS_S3_KMS_KEY_ID,
      },
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
    },
    asr: {
      provider: process.env.ASR_PROVIDER,
      apiKey: process.env.ASR_API_KEY,
      model: process.env.ASR_MODEL,
      language: process.env.ASR_LANGUAGE,
      interimResults: process.env.ASR_INTERIM_RESULTS,
      diarize: process.env.ASR_DIARIZE,
    },
    tts: {
      provider: process.env.TTS_PROVIDER,
      apiKey: process.env.TTS_API_KEY,
      voiceId: process.env.TTS_VOICE_ID,
      model: process.env.TTS_MODEL,
      speed: process.env.TTS_SPEED,
      streamingLatency: process.env.TTS_STREAMING_LATENCY,
    },
    llm: {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      temperature: process.env.LLM_TEMPERATURE,
      maxTokens: process.env.LLM_MAX_TOKENS,
      systemPrompt: process.env.LLM_SYSTEM_PROMPT,
    },
    pms: {
      provider: process.env.PMS_PROVIDER,
      apiUrl: process.env.PMS_API_URL,
      apiKey: process.env.PMS_API_KEY,
    },
  };

  return configSchema.parse(raw);
}
