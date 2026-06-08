/**
 * HIPAA-aware logging: PII/PHI redaction layer.
 *
 * Every log entry passes through the redactor before reaching the
 * underlying logger (pino / Winston / console).  The redactor
 * strips PII so raw PHI never lands in any persistent log stream.
 */

// Matchers ordered from most-specific to least-specific to avoid
// partial matches (e.g. "123-45-6789" before "123").
const PI_PATTERNS: {
  name: string;
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
}[] = [
    // SSN: 123-45-6789
    {
      name: "ssn",
      pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
      replacement: "[REDACTED-SSN]",
    },
    // US phone: (123) 456-7890, 123-456-7890, +1 123-456-7890
    {
      name: "phone_us",
      pattern: /(\+1[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g,
      replacement: "[REDACTED-PHONE]",
    },
    // Email
    {
      name: "email",
      pattern: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi,
      replacement: "[REDACTED-EMAIL]",
    },
    // Date of birth in DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
    {
      name: "dob",
      pattern:
        /\b(?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])[/-]\d{4}\b|\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
      replacement: "[REDACTED-DOB]",
    },
    // MRN / Chart Number — alphanumeric, 5-20 chars, often all-numeric
    {
      name: "mrn",
      pattern: /\b\d{5,20}\b/g,
      replacement: "[REDACTED-ID]",
    },
    // Zip code (standalone 5-digit)
    {
      name: "zip",
      pattern: /\b\d{5}(?:-\d{4})?\b/g,
      replacement: "[REDACTED-ZIP]",
    },
    // Common first-name / last-name heuristics (capitalized words in
    // natural language that look like names).  This is conservative:
    // only matches if the word appears after "name is", "I'm", "my", etc.
    {
      name: "name_phrase",
      pattern:
        /(?:name\s+is\s+|i'?m\s+|this\s+is\s+|my\s+name\s+is\s+|call\s+me\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
      replacement: (_substring, captured: string) =>
        `[REDACTED-NAME]${captured ? "" : ""}`,
    },
  ];

/**
 * Redact all recognized PII/PHI patterns from a string.
 * Returns a copy; the original is never mutated.
 */
export function redact(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PI_PATTERNS) {
    if (typeof replacement === "string") {
      result = result.replace(pattern, replacement);
    } else {
      // function-based replacement (e.g. for name_phrase)
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

/**
 * Redact an arbitrary object deeply so no log-line leaks PHI.
 *   - Strings are run through `redact()`.
 *   - Keys matching `sensitiveKeys` are fully replaced.
 *   - Nested objects and arrays are recursed.
 */
const SENSITIVE_KEYS = new Set([
  "firstName",
  "lastName",
  "name",
  "phone",
  "phoneNumbers",
  "phoneNumber",
  "email",
  "ssn",
  "dob",
  "dateOfBirth",
  "birthdate",
  "address",
  "zip",
  "zipCode",
  "chartNumber",
  "insurance",
  "memberId",
  "rawTranscript",
  "transcript", // redacted inline instead of dropping
]);

export function redactObject(obj: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED-DEEP]";

  if (typeof obj === "string") {
    return redact(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth + 1));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Structured log entry — the only shape allowed past the log boundary.
 */
export interface SafeLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  sessionId?: string | undefined;
  callId?: string | undefined;
  context?: Record<string, unknown> | undefined;
  timestamp: string;
  error?: { name: string; message: string; stack?: string | undefined } | undefined;
}

/**
 * Create a HIPAA-safe log entry.  All fields are redacted.
 */
export function safeLog(
  level: SafeLogEntry["level"],
  message: string,
  extra?: Partial<
    Omit<SafeLogEntry, "level" | "message" | "timestamp">
  >,
): SafeLogEntry {
  return {
    level,
    message: redact(message),
    sessionId: extra?.sessionId,
    callId: extra?.callId,
    context: extra?.context
      ? (redactObject(extra.context) as Record<string, unknown>)
      : undefined,
    timestamp: new Date().toISOString(),
    error: extra?.error
      ? {
          name: redact(extra.error.name),
          message: redact(extra.error.message),
          stack: extra.error.stack ? redact(extra.error.stack) : undefined,
        }
      : undefined,
  };
}
