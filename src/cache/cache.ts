import type { Request } from "express";

import { config } from "../helpers/config";
import { memoryGet, memorySet } from "./memory";
import { closeRedis, redisGet, redisSet } from "./redis";

/**
 * The response cache the middleware talks to. CACHE_DRIVER decides what answers: "memory"
 * keeps entries in this process, "redis" uses REDIS_URL, and "none" (the default) does
 * nothing. `get`/`set` is the whole surface, so the middleware never learns which backend
 * it is using, and only the "redis" driver ever opens a connection.
 *
 * Caching is an optimization, never a dependency: a request is always answered, and every
 * backend failure is logged and swallowed.
 */
export const cache = {
  /** The stored response body for `key`, or null on a miss or when caching is off. */
  async get(key: string): Promise<string | null> {
    if (config.cache.driver === "memory") return memoryGet(key);
    if (config.cache.driver === "redis") return redisGet(key);

    return null;
  },

  /** Stores a response body under `key` for `ttlSeconds` seconds. Never throws. */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (config.cache.driver === "memory") {
      memorySet(key, value, ttlSeconds);
      return;
    }
    if (config.cache.driver === "redis") await redisSet(key, value, ttlSeconds);
  },

  /** Closes the Redis connection on shutdown; the next use would connect again. */
  close(): void {
    closeRedis();
  },
};

/**
 * Deterministic key from the HTTP method, the full request path and the request
 * parameters, so two requests that differ only in, say, parameter order share one entry.
 * Headers, cookies and timestamps are deliberately absent: they would fragment the cache
 * without describing the answer.
 */
export function cacheKey(req: Request): string {
  const parameters = { ...asRecord(req.query), ...asRecord(req.params), ...asRecord(req.body) };

  return `cache:${req.method.toUpperCase()}:${req.baseUrl}${req.path}:${stableStringify(parameters)}`;
}

/** Anything that is not a plain object carries no parameters. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  return value as Record<string, unknown>;
}

/** JSON with object keys sorted at every level, so the same input always serializes alike. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;

  const entries = Object.entries(value as Record<string, unknown>)
    // A field sent as `null` means the same as leaving it out - both reach the service as
    // "nothing was chosen" - so the two requests have to share one entry. `undefined` is
    // dropped by JSON.stringify anyway.
    .filter(([, entry]) => entry !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}
