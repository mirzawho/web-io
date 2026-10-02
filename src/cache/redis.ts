import { RedisClient } from "bun";

import { config } from "../helpers/config";

/**
 * The "redis" driver: a single connection to REDIS_URL, opened lazily on first use and
 * shared by every call. Caching is an optimization, never a dependency, so a missing URL or
 * an unreachable server is reported and then treated as a miss rather than thrown.
 */

// Answering from the cache is only worthwhile if Redis is reachable quickly; waiting on a
// dead connection for the client's 10s default would be worse than not caching.
const CONNECT_TIMEOUT_MS = 500;
const MAX_RETRIES = 1;

let client: RedisClient | undefined;
let missingUrlReported = false;

function redis(): RedisClient | undefined {
  if (config.redis.url === "") {
    // Reported once instead of per request: the state does not change between calls.
    if (!missingUrlReported) {
      missingUrlReported = true;
      console.error(
        '[web-io] CACHE_DRIVER is "redis" but REDIS_URL is not set; the response cache is disabled.',
      );
    }

    return undefined;
  }

  return (client ??= new RedisClient(config.redis.url, {
    connectionTimeout: CONNECT_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  }));
}

/** Forgets a connection that just failed, so the next call reconnects instead of reusing it. */
function forget(failed: RedisClient | undefined): void {
  if (failed === undefined || client !== failed) return;

  client.close();
  client = undefined;
}

export async function redisGet(key: string): Promise<string | null> {
  const active = redis();
  try {
    return (await active?.get(key)) ?? null;
  } catch (error) {
    reportFailure("read", error);
    forget(active);
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const active = redis();
  try {
    await active?.set(key, value, "EX", ttlSeconds);
  } catch (error) {
    reportFailure("write", error);
    forget(active);
  }
}

/** Closes the connection on shutdown; the next use would connect again. */
export function closeRedis(): void {
  client?.close();
  client = undefined;
}

function reportFailure(operation: string, error: unknown): void {
  console.error(`[web-io] redis cache ${operation} failed:`, error);
}
