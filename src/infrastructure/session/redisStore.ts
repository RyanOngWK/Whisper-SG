/**
 * Redis-backed session store — replaces the in-memory Map for
 * multi-instance deployments and persistence across restarts.
 *
 * Sessions are stored as JSON with a configurable TTL.
 * On process restart, orphaned sessions expire naturally.
 */

import { Redis } from "ioredis";
import type { SessionState } from "../../types/call.js";
import { safeLog } from "../logging/redactor.js";

export interface SessionStoreConfig {
  host: string;
  port: number;
  password?: string;
  /** Session TTL in seconds (defaults to 1 hour). */
  sessionTtl: number;
}

const DEFAULT_TTL = 3600;

export class RedisSessionStore {
  private redis: Redis;
  private ttl: number;

  constructor(config: SessionStoreConfig) {
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password ?? undefined,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 10) return null; // stop retrying
        return Math.min(times * 200, 3000);
      },
    });

    this.ttl = config.sessionTtl > 0 ? config.sessionTtl : DEFAULT_TTL;
    this.redis.on("error", (err) => {
      safeLog("error", "Redis connection error", {
        error: { name: "RedisError", message: err.message },
      });
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    safeLog("info", "Redis connected");
  }

  async get(sessionId: string): Promise<SessionState | null> {
    try {
      const raw = await this.redis.get(sessionId);
      if (!raw) return null;
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      safeLog("error", "Redis get failed", {
        sessionId,
        error: { name: "RedisGetError", message: String(err) },
      });
      return null;
    }
  }

  async set(sessionId: string, session: SessionState): Promise<void> {
    try {
      await this.redis.setex(
        sessionId,
        this.ttl,
        JSON.stringify(session),
      );
    } catch (err) {
      safeLog("error", "Redis set failed", {
        sessionId,
        error: { name: "RedisSetError", message: String(err) },
      });
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.redis.del(sessionId);
    } catch (err) {
      safeLog("error", "Redis delete failed", {
        sessionId,
        error: { name: "RedisDelError", message: String(err) },
      });
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
    safeLog("info", "Redis disconnected");
  }

  get stats() {
    return {
      status: this.redis.status,
      ttl: this.ttl,
    };
  }
}
